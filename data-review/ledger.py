"""
Vetting ledger -- the persistent store of "this flag was reviewed and
found to be X" decisions.

Architecture:
  vetting.jsonl   -- append-only JSONL, ONE RECORD PER LINE, committed to git.
                     Source of truth. Every save, edit, and revoke is a line.
  audit.db        -- SQLite cache derived from vetting.jsonl. Gitignored.
                     Replay the JSONL to rebuild. Indexed for suppression queries.

Schema (vetted_cells; the only table you usually need to read):

  iso3            TEXT    NOT NULL
  year            INTEGER NULL     NULL = applies to every year of the pair
  variable        TEXT    NOT NULL
  source          TEXT    NULL     NULL = applies to every source publishing this var
  reason_type     TEXT    NOT NULL 'all' | one of {outlier, corr, discrep, implaus,
                                                    lvl10, break, Mordering, realrate,
                                                    forecastleak, share, govdef,
                                                    cgovlargergengov, inflCPIdiscrp,
                                                    GDPaccounting, GDPcompcorr}
  status          TEXT    NOT NULL 'vetted-correct' | 'known-limitation' | 'pending-fix'
  justification   TEXT    NOT NULL Why this decision was made
  source_evidence TEXT    NULL     e.g. "Mitchell 1998 IHS Latin America Table B1 p.842"
  refs            TEXT    NULL     JSON array of URLs / commit shas
  approved_by     TEXT    NOT NULL email or handle
  approved_at     TEXT    NOT NULL ISO-8601 UTC
  expires_at      TEXT    NULL     auto-revoke after this date (ISO-8601) or never
  superseded_by   INTEGER NULL     rowid of replacement, NULL if active
  rev             INTEGER NOT NULL monotone rev counter for this composite key
  value           REAL    NULL     the flagged cell's value at vetting time;
                                   suppression re-surfaces the flag if the
                                   current value no longer matches this.
                                   NULL on legacy/blanket records -> suppress
                                   regardless of value (old behavior).

A second table `vetting_log` mirrors the JSONL one-to-one so SQLite can
also serve audit-trail queries without re-parsing the file.

This module never writes to vetting.jsonl without ALSO updating audit.db,
and vice versa. The JSONL is canonical; audit.db is regenerable.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import sqlite3
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
JSONL_PATH = ROOT / "vetting.jsonl"
DB_PATH = ROOT / "audit.db"

VALID_STATUS = {"vetted-correct", "known-limitation", "pending-fix"}

# serve.py is a ThreadingTCPServer, so concurrent POST /comment requests can
# call append() in parallel. Each append reads MAX(rev) then inserts rev+1;
# two threads racing on the same cell compute the same rev and collide on the
# unique index. Serialize all ledger writes with a process-wide lock.
_WRITE_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS vetted_cells (
    iso3            TEXT    NOT NULL,
    year            INTEGER,
    variable        TEXT    NOT NULL,
    source          TEXT,
    reason_type     TEXT    NOT NULL,
    status          TEXT    NOT NULL,
    justification   TEXT    NOT NULL,
    source_evidence TEXT,
    refs            TEXT,
    approved_by     TEXT    NOT NULL,
    approved_at     TEXT    NOT NULL,
    expires_at      TEXT,
    superseded_by   INTEGER,
    rev             INTEGER NOT NULL,
    value           REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vetted_active ON vetted_cells(
    iso3, COALESCE(year, -1), variable, COALESCE(source, ''), reason_type, rev
);
CREATE INDEX IF NOT EXISTS idx_vetted_pair ON vetted_cells(iso3, variable);
CREATE INDEX IF NOT EXISTS idx_vetted_active_only ON vetted_cells(iso3, variable)
    WHERE superseded_by IS NULL;

CREATE TABLE IF NOT EXISTS vetting_log (
    line_no   INTEGER PRIMARY KEY,
    op        TEXT    NOT NULL,
    payload   TEXT    NOT NULL,
    at_ts     TEXT    NOT NULL
);
"""


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _key(rec: dict) -> tuple:
    """The composite key on which supersede happens."""
    return (rec["iso3"], rec.get("year"), rec["variable"],
            rec.get("source"), rec["reason_type"])


def open_db(rebuild_if_missing: bool = True) -> sqlite3.Connection:
    """Return a connection to audit.db, replaying vetting.jsonl if the DB
    is missing or empty. The JSONL is the source of truth; the DB is
    just an indexed cache."""
    need_rebuild = rebuild_if_missing and (
        not DB_PATH.exists() or DB_PATH.stat().st_size == 0
    )
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    _migrate(conn)
    if need_rebuild and JSONL_PATH.exists():
        rebuild_from_jsonl(conn)
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns introduced after the initial schema. CREATE TABLE IF NOT
    EXISTS won't alter an existing table, so backfill missing columns here."""
    have = {r[1] for r in conn.execute("PRAGMA table_info(vetted_cells)")}
    if "value" not in have:
        conn.execute("ALTER TABLE vetted_cells ADD COLUMN value REAL")
        conn.commit()


def rebuild_from_jsonl(conn: sqlite3.Connection) -> int:
    """Drop and replay every record in vetting.jsonl. Returns the number
    of records replayed."""
    conn.execute("DELETE FROM vetted_cells")
    conn.execute("DELETE FROM vetting_log")
    n = 0
    if not JSONL_PATH.exists():
        return 0
    with open(JSONL_PATH) as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"[ledger] skipping malformed line {line_no}: {e}",
                      file=sys.stderr)
                continue
            _apply(conn, rec, line_no=line_no)
            n += 1
    conn.commit()
    return n


def _apply(conn: sqlite3.Connection, rec: dict, *, line_no: int) -> None:
    """Apply one JSONL record to the DB. Three ops:
      - 'vet'    : insert a new active record; supersedes any prior active row
                   sharing the same key.
      - 'revoke' : mark the active row for that key superseded_by=-1 (tombstone)
      - 'edit'   : same as 'vet' -- the rev counter handles it
    """
    op = rec.get("op", "vet")
    body = rec.get("body", {})
    if op not in ("vet", "revoke", "edit"):
        print(f"[ledger] unknown op {op!r} at line {line_no}", file=sys.stderr)
        return
    # NOTE: vetting_log table is no longer written. It used to mirror the
    # JSONL line-by-line but never got queried for anything, and the
    # `line_no` PK collided whenever JSONL was reset to a shorter state
    # (e.g., `git reset --hard` after local appends). The JSONL file is
    # the actual append-only audit trail; rebuild from there if needed.

    if op == "revoke":
        # Find current active row, mark it superseded_by=-1
        conn.execute(
            """UPDATE vetted_cells SET superseded_by = -1
               WHERE iso3 = ? AND COALESCE(year, -1) = COALESCE(?, -1)
                 AND variable = ? AND COALESCE(source, '') = COALESCE(?, '')
                 AND reason_type = ? AND superseded_by IS NULL""",
            (body["iso3"], body.get("year"), body["variable"],
             body.get("source"), body["reason_type"]),
        )
        return

    # vet / edit -- insert new active row at incremented rev
    row = conn.execute(
        """SELECT MAX(rev) FROM vetted_cells
           WHERE iso3 = ? AND COALESCE(year, -1) = COALESCE(?, -1)
             AND variable = ? AND COALESCE(source, '') = COALESCE(?, '')
             AND reason_type = ?""",
        (body["iso3"], body.get("year"), body["variable"],
         body.get("source"), body["reason_type"]),
    ).fetchone()
    next_rev = (row[0] or 0) + 1
    # Mark prior rows superseded_by = -2 (means "replaced by a newer rev")
    conn.execute(
        """UPDATE vetted_cells SET superseded_by = -2
           WHERE iso3 = ? AND COALESCE(year, -1) = COALESCE(?, -1)
             AND variable = ? AND COALESCE(source, '') = COALESCE(?, '')
             AND reason_type = ? AND superseded_by IS NULL""",
        (body["iso3"], body.get("year"), body["variable"],
         body.get("source"), body["reason_type"]),
    )
    refs = body.get("refs")
    if isinstance(refs, list):
        refs = json.dumps(refs)
    conn.execute(
        """INSERT INTO vetted_cells(
             iso3, year, variable, source, reason_type, status, justification,
             source_evidence, refs, approved_by, approved_at, expires_at,
             superseded_by, rev, value)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?, NULL, ?, ?)""",
        (body["iso3"], body.get("year"), body["variable"], body.get("source"),
         body["reason_type"], body["status"], body["justification"],
         body.get("source_evidence"), refs,
         body["approved_by"], body.get("approved_at", rec.get("at_ts", _now_iso())),
         body.get("expires_at"), next_rev, body.get("value")),
    )


def append(op: str, body: dict, *, by_user: str | None = None) -> None:
    """Append a record to vetting.jsonl AND update audit.db atomically
    enough for the single-writer dashboard. Raises ValueError on a bad
    payload."""
    if op not in ("vet", "revoke", "edit"):
        raise ValueError(f"unknown op {op!r}")
    required = {"iso3", "variable", "reason_type"}
    if op != "revoke":
        required |= {"status", "justification", "approved_by"}
    missing = required - set(body)
    if missing:
        raise ValueError(f"missing required fields: {sorted(missing)}")
    if op != "revoke" and body["status"] not in VALID_STATUS:
        raise ValueError(f"bad status {body['status']!r}; expected one of {VALID_STATUS}")

    # Keep `value` JSON-safe for the append-only source of truth: numpy floats
    # aren't serializable and NaN serializes to invalid JSON (rejected on
    # rebuild). Coerce to a plain float, mapping NaN/non-numeric to None.
    if body.get("value") is not None:
        try:
            v = float(body["value"])
            body = {**body, "value": (None if v != v else v)}
        except (TypeError, ValueError):
            body = {**body, "value": None}

    rec = {
        "op": op,
        "at_ts": _now_iso(),
        "by_user": by_user or body.get("approved_by", "?"),
        "body": body,
    }
    # Serialize the JSONL append + DB read-modify-write so concurrent
    # requests can't race on the per-cell rev counter.
    with _WRITE_LOCK:
        JSONL_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(JSONL_PATH, "a") as f:
            f.write(json.dumps(rec, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())
        conn = open_db(rebuild_if_missing=False)
        try:
            line_no = sum(1 for _ in open(JSONL_PATH))
            _apply(conn, rec, line_no=line_no)
            conn.commit()
        finally:
            conn.close()


def active_vettings() -> list[dict]:
    """Return every currently-active (not superseded, not expired) record."""
    conn = open_db()
    now = _now_iso()
    cur = conn.execute(
        """SELECT iso3, year, variable, source, reason_type, status,
                  justification, source_evidence, refs, approved_by,
                  approved_at, expires_at, rev, value
           FROM vetted_cells
           WHERE superseded_by IS NULL
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY iso3, variable, year""",
        (now,),
    )
    cols = [d[0] for d in cur.description]
    out = [dict(zip(cols, row)) for row in cur.fetchall()]
    conn.close()
    return out


def matches_active(iso3: str, year: int | None, variable: str,
                   source: str | None, reason_type: str,
                   active: list[dict] | None = None) -> dict | None:
    """Return the matching active vetting record, or None. A vetting
    record with year=NULL matches every year of the pair; source=NULL
    matches every source; reason_type='all' matches every reason. Used
    by flags.py to suppress flag rows."""
    if active is None:
        active = active_vettings()
    for v in active:
        if v["iso3"] != iso3:
            continue
        if v["variable"] != variable:
            continue
        if v["year"] is not None and v["year"] != year:
            continue
        if v["source"] is not None and v["source"] != source:
            continue
        if v["reason_type"] != "all" and v["reason_type"] != reason_type:
            continue
        return v
    return None


if __name__ == "__main__":
    # Smoke test: open / rebuild / count
    conn = open_db()
    n_cells = conn.execute("SELECT COUNT(*) FROM vetted_cells").fetchone()[0]
    n_active = conn.execute(
        "SELECT COUNT(*) FROM vetted_cells WHERE superseded_by IS NULL"
    ).fetchone()[0]
    n_log = conn.execute("SELECT COUNT(*) FROM vetting_log").fetchone()[0]
    print(f"vetting.jsonl : {JSONL_PATH}  ({JSONL_PATH.stat().st_size if JSONL_PATH.exists() else 0} bytes)")
    print(f"audit.db      : {DB_PATH}")
    print(f"  vetted_cells rows         : {n_cells}")
    print(f"  vetted_cells active rows  : {n_active}")
    print(f"  vetting_log  rows         : {n_log}")
    conn.close()
