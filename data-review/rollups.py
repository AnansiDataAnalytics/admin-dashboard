"""
Shared rollup classification logic.

Used by both `build_audit_log.py` (markdown rollups by source / iso3 /
variable for the audit-log archaeology) and `diagnose.py` (the
pending-fix worklist generator).

The classifier inspects every OPEN item and decides whether the
collection is dominated by a shared source, variable, or country.
That label flows through to the LLM prompt so the diagnosis can
either look for a single systemic bug or focus on one idiosyncratic
cell.
"""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Iterable

ISSUE_TAG_RE = re.compile(r"\[ISSUE-([A-Za-z0-9_]+)\]")


def attribute_issue(comment: str) -> list[str]:
    """Source(s) flagged in a comment via [ISSUE-<SRC>] tags. If no tags
    are present, returns []."""
    if not comment or not comment.strip():
        return []
    tags = ISSUE_TAG_RE.findall(comment)
    if not tags:
        return []
    seen: list[str] = []
    for t in tags:
        if t not in seen:
            seen.append(t)
    return seen


def split_key(key: str) -> tuple[str, str] | None:
    """ISO3_VAR (e.g. 'ARG_rGDP') -> (iso3, variable). Returns None when
    the key doesn't conform."""
    m = re.match(r"^([A-Z]{3})_(.+)$", key)
    if not m:
        return None
    return m.group(1), m.group(2)


def build_rollups(items: Iterable[dict]) -> dict:
    """Group items by source / iso3 / variable / (iso3, source).

    `items` is an iterable of dicts with at least:
      key            "ISO3_VAR"
      comment        text the reviewer left
      [sources]      pre-extracted list of attributed sources (optional;
                     computed via attribute_issue() if absent)

    Returns a dict with four maps:
      by_source[src]               -> list[item]
      by_iso3[iso3]                -> list[item]
      by_var[var]                  -> list[item]
      by_iso3_src[(iso3, src)]     -> list[item]
    """
    by_source: dict[str, list[dict]] = defaultdict(list)
    by_iso3: dict[str, list[dict]] = defaultdict(list)
    by_var: dict[str, list[dict]] = defaultdict(list)
    by_iso3_src: dict[tuple[str, str], list[dict]] = defaultdict(list)

    for item in items:
        key = item.get("key", "")
        parsed = split_key(key)
        iso3, var = (parsed if parsed else ("", ""))
        sources = item.get("sources")
        if sources is None:
            sources = attribute_issue(item.get("comment", ""))
        if iso3:
            by_iso3[iso3].append(item)
        if var:
            by_var[var].append(item)
        for s in sources:
            by_source[s].append(item)
            if iso3:
                by_iso3_src[(iso3, s)].append(item)
    return {
        "by_source": dict(by_source),
        "by_iso3": dict(by_iso3),
        "by_var": dict(by_var),
        "by_iso3_src": dict(by_iso3_src),
    }


# Thresholds for "systemic" labels. Tuned so a single cell can't claim a
# pattern; require multiple distinct (iso3, var) tuples to call a source
# or variable systemic.
THRESH_SOURCE_N      = 5    # >=5 items share a source ...
THRESH_SOURCE_DISTINCT = 3  # ... AND >=3 distinct (iso3, var) tuples
THRESH_VAR_N         = 5
THRESH_VAR_DISTINCT  = 3    # >=3 distinct countries
THRESH_COUNTRY_N     = 3
THRESH_COUNTRY_DISTINCT = 2 # >=2 distinct variables


def classify(item: dict, rollups: dict) -> dict:
    """Return a classification dict for `item`:
        label: one of "source-systemic" | "variable-systemic"
                       | "country-systemic" | "idiosyncratic"
        bucket: identifier of the bucket (source name / variable code /
                iso3 / None for idiosyncratic)
        siblings: list of OTHER items in the same bucket
    """
    parsed = split_key(item.get("key", ""))
    iso3, var = (parsed if parsed else ("", ""))
    sources = item.get("sources") or attribute_issue(item.get("comment", ""))

    # Prefer the most specific label that meets its threshold.
    # Source-systemic check: each attributed source might satisfy this.
    for s in sources:
        bucket = rollups["by_source"].get(s) or []
        distinct = len({split_key(it.get("key", "")) for it in bucket
                        if split_key(it.get("key", ""))})
        if len(bucket) >= THRESH_SOURCE_N and distinct >= THRESH_SOURCE_DISTINCT:
            return {
                "label": "source-systemic",
                "bucket": s,
                "siblings": [it for it in bucket if it is not item],
            }

    if var:
        bucket = rollups["by_var"].get(var) or []
        distinct = len({split_key(it.get("key", ""))[0] for it in bucket
                        if split_key(it.get("key", ""))})
        if len(bucket) >= THRESH_VAR_N and distinct >= THRESH_VAR_DISTINCT:
            return {
                "label": "variable-systemic",
                "bucket": var,
                "siblings": [it for it in bucket if it is not item],
            }

    if iso3:
        bucket = rollups["by_iso3"].get(iso3) or []
        distinct = len({split_key(it.get("key", ""))[1] for it in bucket
                        if split_key(it.get("key", ""))})
        if len(bucket) >= THRESH_COUNTRY_N and distinct >= THRESH_COUNTRY_DISTINCT:
            return {
                "label": "country-systemic",
                "bucket": iso3,
                "siblings": [it for it in bucket if it is not item],
            }

    return {"label": "idiosyncratic", "bucket": None, "siblings": []}
