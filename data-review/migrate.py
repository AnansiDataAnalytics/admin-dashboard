"""
One-shot migration: recover the dashboard comments from the archived
MITCHELL_AUDIT_LOG.md and write audit_dashboard/comments.json.

Originally (pre-2026-05-21) this script also appended a `_Mitchell` source
suffix to every key, anticipating per-source dashboard UI. That was
reverted: the dashboard's natural key is the pair-level `ISO3_VAR`, and
the per-source dimension lives in the vetting ledger (fanned out by the
server). So comments.json keys stay `ISO3_VAR` -- exactly the shape the
existing index.html already reads.

Sources of truth on the branch:
  - docs/archive/MITCHELL_AUDIT_LOG.md  174 approved + 3 commented entries
  - docs/mitchell_audit_notes.yaml      1,984-line investigation ledger

After migration:
  - audit_dashboard/comments.json       regenerated locally (gitignored)
  - docs/gmd_audit_notes.yaml           every yaml entry gains `source: Mitchell`

Idempotent: re-runs no-op if outputs already exist.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
MD_PATH = REPO / "docs" / "archive" / "MITCHELL_AUDIT_LOG.md"
# Fall back to the pre-archive path if the file hasn't moved yet (helps when
# running migrate.py against an older checkout).
if not MD_PATH.exists():
    _legacy = REPO / "docs" / "MITCHELL_AUDIT_LOG.md"
    if _legacy.exists():
        MD_PATH = _legacy
COMMENTS_PATH = ROOT / "comments.json"
YAML_IN = REPO / "docs" / "mitchell_audit_notes.yaml"
YAML_OUT = REPO / "docs" / "gmd_audit_notes.yaml"

MITCHELL_SRC = "Mitchell"

# Same regex used by the recovery snippet at the bottom of MITCHELL_AUDIT_LOG.md.
BLOCK_RE = re.compile(
    r"### ([✓⚠]) `([^`]+)`\s*\n(?:_[^\n]*\n)?(.*?)(?=\n### |\n## |\Z)",
    re.S,
)
TS_RE = re.compile(r"<sub>saved ([^<]+)</sub>")


def parse_md(md_text: str) -> dict[str, dict]:
    entries: dict[str, dict] = {}
    for marker, key, body in BLOCK_RE.findall(md_text):
        quoted = "\n".join(line[2:] for line in body.split("\n") if line.startswith("> "))
        ts_match = TS_RE.search(body)
        entries[key] = {
            "comment": quoted.strip(),
            "approved": marker == "✓",
            "ts": ts_match.group(1) if ts_match else "",
        }
    return entries


def sha_keys(keys) -> str:
    return hashlib.sha256("\n".join(sorted(keys)).encode()).hexdigest()[:12]


def migrate_comments() -> None:
    if not MD_PATH.exists():
        sys.exit(f"missing {MD_PATH}")

    md_text = MD_PATH.read_text()
    entries = parse_md(md_text)

    if COMMENTS_PATH.exists():
        existing = json.loads(COMMENTS_PATH.read_text())
        # Idempotency: if every entry we want to write is already there,
        # no-op. Compare key sets (lenient on extra entries that were
        # added by hand or by the dashboard).
        if set(entries) <= set(existing):
            print(f"comments.json already has all {len(entries)} migration entries -- no-op")
            return

    COMMENTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    COMMENTS_PATH.write_text(json.dumps(entries, indent=2, sort_keys=True))

    print(f"comments.json: {len(entries)} entries written")
    print(f"  key sha:    {sha_keys(entries.keys())}")
    print(f"  written to: {COMMENTS_PATH}")


def migrate_yaml() -> None:
    if not YAML_IN.exists():
        print(f"skip yaml migration: {YAML_IN} not found")
        return
    if YAML_OUT.exists():
        print(f"gmd_audit_notes.yaml already exists -- no-op")
        return

    # Pure text rewrite -- preserves the file's comments, ordering, and exact
    # formatting. Every `- country: XXX` block gets a `source: Mitchell` line
    # inserted directly after, at the same indent.
    text = YAML_IN.read_text()
    new_lines = []
    for line in text.splitlines(keepends=True):
        new_lines.append(line)
        m = re.match(r"^(\s*)- country: ", line)
        if m:
            indent = m.group(1) + "  "
            new_lines.append(f"{indent}source: {MITCHELL_SRC}\n")

    # Update the schema docstring at the top to reflect the new field.
    header_old = "#     fix_years: optional list"
    header_new = (
        "#     source: source whose values prompted the entry "
        '(e.g. "Mitchell"; required)\n'
        "#     fix_years: optional list"
    )
    out = "".join(new_lines).replace(header_old, header_new, 1)

    YAML_OUT.write_text(out)
    n_country = sum(1 for line in text.splitlines() if re.match(r"^\s*- country: ", line))
    print(f"gmd_audit_notes.yaml: {n_country} entries gained `source: Mitchell`")
    print(f"  written to: {YAML_OUT}")


def main() -> None:
    migrate_comments()
    migrate_yaml()


if __name__ == "__main__":
    main()
