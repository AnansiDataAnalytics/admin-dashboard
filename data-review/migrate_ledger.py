"""
One-shot import: take the migrated audit_dashboard/comments.json (post-
step-1 schema, keys ISO3_VAR_SOURCE) and replay every entry into
vetting.jsonl + audit.db as a vetting record.

Mapping:
  comments.json entry                          ->  vetting.jsonl line
  ---------------------------------------------------------------------
  approved=true, comment=""                    ->  status=vetted-correct
                                                   justification="(blank-approval)"
  approved=true, comment="..."                 ->  status=vetted-correct
                                                   justification=<comment>
  approved=false, comment="..."                ->  status=pending-fix
                                                   justification=<comment>

For each entry:
  iso3, variable, source = parsed from the key "ISO3_VAR_SOURCE"
  year = NULL    (blanket vetting -- all years of the pair)
  reason_type = 'all'  (covers every reason_*)
  approved_by = 'migrated'
  approved_at = entry.ts

Idempotent: if vetting.jsonl already has entries for the migrated keys,
they're skipped. Re-running won't double-add.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import ledger

ROOT = Path(__file__).resolve().parent
COMMENTS_PATH = ROOT / "comments.json"


def parse_key(key: str) -> tuple[str, str, str] | None:
    """Key shape after step-1 migration: ISO3_VAR_SOURCE. ISO3 is 3 letters,
    SOURCE is the trailing token, VAR is everything in between (e.g.
    'gen_govdebt_GDP'). Splitting on '_' isn't enough because VAR has
    underscores too -- we split on the LEADING ISO3 and TRAILING SOURCE."""
    m = re.match(r"^([A-Z]{3})_(.+)_([A-Za-z0-9]+)$", key)
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3)


def main() -> int:
    if not COMMENTS_PATH.exists():
        print(f"missing {COMMENTS_PATH} -- run migrate.py first", file=sys.stderr)
        return 2
    with open(COMMENTS_PATH) as f:
        comments = json.load(f)

    # Build set of already-imported keys (iso3, variable, source) from active records
    active = ledger.active_vettings()
    seen = {(v["iso3"], v["variable"], v["source"]) for v in active
            if v["year"] is None and v["reason_type"] == "all"}

    n_skipped = n_imported = n_unparsable = 0
    for key, entry in sorted(comments.items()):
        parsed = parse_key(key)
        if parsed is None:
            print(f"  WARN: unparseable key {key!r}", file=sys.stderr)
            n_unparsable += 1
            continue
        iso3, variable, source = parsed
        if (iso3, variable, source) in seen:
            n_skipped += 1
            continue
        approved = bool(entry.get("approved"))
        comment = str(entry.get("comment") or "").strip()
        ts = entry.get("ts") or ""
        status = "vetted-correct" if approved else "pending-fix"
        justification = comment or (
            "(blank-approval; no comment supplied)" if approved
            else "(commented-only, no decision yet)"
        )
        body = {
            "iso3": iso3,
            "year": None,
            "variable": variable,
            "source": source,
            "reason_type": "all",
            "status": status,
            "justification": justification,
            "approved_by": "migrated",
            "approved_at": ts,
        }
        ledger.append("vet", body, by_user="migrated")
        n_imported += 1

    print(f"imported: {n_imported}")
    print(f"skipped (already present): {n_skipped}")
    if n_unparsable:
        print(f"unparsable keys: {n_unparsable}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
