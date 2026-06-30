"""
Pending-fix worklist generator.

Reads `audit_dashboard/vetting.jsonl` for the latest `pending-fix`
records still flagged in `audit_dashboard/flags.parquet`, classifies
them by rollup pattern (source-systemic / variable-systemic /
country-systemic / idiosyncratic), and emits a grouped markdown worklist
to `docs/PENDING_FIXES.md`.

Phase 1 (current): no LLM calls. Each item gets a placeholder
"Likely cause" section and a checklist of sibling items in the same
bucket. Useful as-is for the fixer to triage by root cause.

Phase 2 (pending API-key + model confirmation): plug an Anthropic
call into _llm_diagnose() to fill the "Likely cause" + "Suggested
investigation" sections. Responses cached on (comment, data, flag)
hash so re-runs are free.

Run:
    python3 audit_dashboard/diagnose.py
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
# Input data root (a GMD/WED checkout), same resolution as build_data.py/flags.py:
# DATA_REVIEW_DATA_ROOT env -> gitignored .data_root file -> parents[1]. Outputs stay
# next to this script (data-review/), never the host repo.
def _resolve_data_root() -> Path:
    env = os.environ.get("DATA_REVIEW_DATA_ROOT")
    if env:
        return Path(env).resolve()
    local = ROOT / ".data_root"
    if local.exists():
        return Path(local.read_text().strip()).resolve()
    return Path(__file__).resolve().parents[1]

DATA_ROOT = _resolve_data_root()
VETTING_PATH = ROOT / "vetting.jsonl"
FLAGS_PATH = ROOT / "flags.parquet"
FINAL_DIR = DATA_ROOT / "data" / "final"
CACHE_PATH = ROOT / "diagnose_cache.json"
OUT = ROOT / "PENDING_FIXES.md"   # embed: write next to the app, not the host repo's docs/
FINDINGS_OUT = ROOT / "findings.json"   # machine-readable feed for the dashboard "Findings" tab

# Anthropic model. claude-opus-4-7 is the default; override with the
# DQR_DIAGNOSE_MODEL env var (e.g. claude-sonnet-4-6 to cut cost).
LLM_MODEL = os.environ.get("DQR_DIAGNOSE_MODEL", "claude-opus-4-7")

sys.path.insert(0, str(ROOT))
import rollups  # noqa: E402
try:
    import ledger  # Mongo-aware vetting store -- same backend serve.py writes to
except Exception as _e:  # pragma: no cover
    print(f"[diagnose] ledger import failed ({_e}); will replay vetting.jsonl",
          file=sys.stderr)
    ledger = None


def _now_iso() -> str:
    import datetime as _dt
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _replay_jsonl_active() -> list[dict]:
    """Fallback when the ledger module / Mongo is unavailable: replay
    vetting.jsonl into the active per-cell record bodies (vet sets, revoke
    clears, re-vet overwrites) -- same shape ledger.active_vettings() returns."""
    if not VETTING_PATH.exists():
        return []
    active: dict[tuple, dict] = {}
    with open(VETTING_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            body = rec.get("body", {})
            key = (body.get("iso3"), body.get("year"), body.get("variable"),
                   body.get("source"), body.get("reason_type"))
            if rec.get("op") == "revoke":
                active.pop(key, None)
            else:
                active[key] = body  # vet / edit: latest wins
    return list(active.values())


def load_open_pending() -> list[dict]:
    """Return active status='pending-fix' vettings collapsed to one item per
    (iso3, variable) pair. Reads via ledger.active_vettings() so it sees the
    SAME backend serve.py writes to -- Mongo when MONGODB_URI is set
    (deployment), else audit.db replayed from vetting.jsonl (local dev). The
    ledger may hold many per-cell records per pair; we collapse them so the
    fixer sees one actionable entry per pair."""
    if ledger is not None:
        try:
            active = ledger.active_vettings()
        except Exception as e:
            print(f"[diagnose] ledger query failed ({e}); replaying vetting.jsonl",
                  file=sys.stderr)
            active = _replay_jsonl_active()
    else:
        active = _replay_jsonl_active()
    by_pair: dict[tuple[str, str], dict] = {}
    for rec in active:
        if rec.get("status") != "pending-fix":
            continue
        iso3, var = rec.get("iso3"), rec.get("variable")
        if not iso3 or not var:
            continue
        pair_key = (iso3, var)
        if pair_key in by_pair:
            by_pair[pair_key]["n_cells"] += 1
            src = rec.get("source")
            if src and src not in by_pair[pair_key]["sources"]:
                by_pair[pair_key]["sources"].append(src)
            continue
        by_pair[pair_key] = {
            "key": f"{iso3}_{var}",
            "iso3": iso3,
            "variable": var,
            "comment": rec.get("justification") or "",
            "sources": [rec["source"]] if rec.get("source") else [],
            "approved_at": rec.get("approved_at"),
            "approved_by": rec.get("approved_by"),
            "n_cells": 1,
        }
    return sorted(by_pair.values(), key=lambda r: (r["iso3"], r["variable"]))


def items_still_flagged(items: list[dict]) -> list[dict]:
    """Keep only the items whose pair still has at least one row in
    the current flags.parquet -- a pair fully cleared by an engine
    rerun drops off the worklist automatically."""
    if not FLAGS_PATH.exists():
        return items  # no flag data; can't filter, return as-is
    df = pd.read_parquet(FLAGS_PATH)
    flagged_pairs = set(
        zip(df["ISO3"].astype(str), df["variables"].astype(str))
    )
    out = []
    for it in items:
        if (it["iso3"], it["variable"]) in flagged_pairs:
            out.append(it)
    return out


def load_pair_series(iso3: str, var: str, max_points: int = 60) -> dict:
    """Return {source: [[year, value], ...]} for one (iso3, var) pair,
    read from chainlinked_<var>.dta. Down-samples each series to the
    most recent `max_points` years so the LLM prompt stays compact."""
    path = FINAL_DIR / f"chainlinked_{var}.dta"
    if not path.exists():
        return {}
    try:
        df = pd.read_stata(path, convert_categoricals=False)
    except Exception:
        return {}
    df = df[df["ISO3"] == iso3]
    if df.empty:
        return {}
    out = {}
    src_cols = [c for c in df.columns if c.endswith(f"_{var}") and c != var]
    if var in df.columns:
        src_cols.append(var)  # the spliced GMD value
    for sc in src_cols:
        sub = df.loc[df[sc].notna(), ["year", sc]].sort_values("year")
        if sub.empty:
            continue
        name = "GMD" if sc == var else sc[: -len(f"_{var}")]
        rows = [[int(r.year), round(float(getattr(r, sc)), 4)]
                for r in sub.itertuples(index=False)]
        if len(rows) > max_points:
            rows = rows[-max_points:]
        out[name] = rows
    return out


_LLM_CLIENT = None
_LLM_CACHE = None
_LLM_DISABLED = False

_DIAGNOSE_SYSTEM = """\
You are a data-quality forensics assistant for the Global Macro Database \
(GMD), a harmonized panel of macroeconomic time series spliced from dozens \
of sources (IMF, World Bank, Mitchell, Maddison, JST, BORDO, national \
statistics offices, ...).

A reviewer has flagged a (country, variable) series as having a likely data \
error and left a short comment. Your job is to read the comment, inspect the \
source values, and state the SINGLE most likely root cause -- with attention \
to whether the problem is:
  - source-systemic   (the same source is wrong across many countries/vars \
-> probably a bug in that source's clean script)
  - variable-systemic (the same variable is wrong across many countries \
-> probably a derivation/splice bug)
  - country-systemic  (one country is wrong across many variables \
-> probably a country-specific unit/currency/historical issue)
  - idiosyncratic     (a single cell -> probably a transcription typo or \
a one-off unit slip)

Common GMD error classes: missing/partial currency-reform conversions \
(off by 10^n), base-year mismatches in index series, LCU-vs-USD aliasing, \
decimal-place transcription errors, column-shift typos in source \
spreadsheets, splice priority bugs.

After diagnosing the cause, propose the SINGLE most promising potential \
solution, scaled to the classification: for source-/variable-/country-systemic \
issues prefer a one-shot fix at the right altitude (correct the source's clean \
script, the derivation/splice step, or a country-level unit/currency \
conversion) that clears the whole cluster at once, NOT per-cell edits; for an \
idiosyncratic single cell, a targeted correction. Name concrete files/series \
to inspect. Don't write code; be specific and concise."""


def _get_llm():
    """Lazy-init the Anthropic client + response cache. Returns (client,
    cache) or (None, cache) when the SDK or API key is unavailable."""
    global _LLM_CLIENT, _LLM_CACHE, _LLM_DISABLED
    if _LLM_CACHE is None:
        try:
            _LLM_CACHE = json.loads(CACHE_PATH.read_text()) if CACHE_PATH.exists() else {}
        except Exception:
            _LLM_CACHE = {}
    if _LLM_DISABLED:
        return None, _LLM_CACHE
    if _LLM_CLIENT is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("  (ANTHROPIC_API_KEY not set -- emitting placeholders, no LLM calls)",
                  file=sys.stderr)
            _LLM_DISABLED = True
            return None, _LLM_CACHE
        try:
            import anthropic
            _LLM_CLIENT = anthropic.Anthropic()
        except ImportError:
            print("  (anthropic SDK not installed -- `pip install anthropic`)",
                  file=sys.stderr)
            _LLM_DISABLED = True
            return None, _LLM_CACHE
    return _LLM_CLIENT, _LLM_CACHE


_DIAGNOSE_SCHEMA = {
    "type": "object",
    "properties": {
        "likely_cause": {"type": "string"},
        "potential_solution": {"type": "string"},
        "suggested_investigation": {"type": "array", "items": {"type": "string"}},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["likely_cause", "potential_solution", "suggested_investigation", "confidence"],
    "additionalProperties": False,
}


def _llm_diagnose(item: dict, classification: dict, allow_api: bool = True) -> dict:
    """Ask Claude for a likely-cause diagnosis + cluster-aware potential
    solution. Cached on a hash of the comment + classification + data so
    re-runs don't re-pay. Degrades to a placeholder when no API key / SDK is
    available. With allow_api=False it is cache-only and never calls the API --
    used by build_findings() so the /findings GET never blocks on the model."""
    series = load_pair_series(item["iso3"], item["variable"])
    payload = {
        "iso3": item["iso3"],
        "variable": item["variable"],
        "comment": item["comment"],
        "sources_flagged": item["sources"],
        "classification": classification["label"],
        "bucket": classification["bucket"],
        "sibling_pairs": [s["key"] for s in classification["siblings"][:25]],
        "series": series,
    }
    cache_key = hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]

    client, cache = _get_llm()
    if cache_key in cache:
        return cache[cache_key]
    if client is None or not allow_api:
        return {
            "likely_cause": "*(awaiting LLM analysis — run diagnose.py with ANTHROPIC_API_KEY set)*",
            "potential_solution": "",
            "suggested_investigation": [],
            "confidence": "—",
        }

    user_text = (
        f"Flagged series: {item['iso3']} {item['variable']}\n"
        f"Classification: {classification['label']}"
        + (f" (bucket: {classification['bucket']})" if classification['bucket'] else "")
        + "\n"
        f"Sources the reviewer tagged: {', '.join(item['sources']) or '(none)'}\n"
        f"Sibling open items in the same bucket: "
        f"{', '.join(s['key'] for s in classification['siblings'][:25]) or '(none)'}\n\n"
        f"Reviewer comment:\n{item['comment']}\n\n"
        f"Source values (year, value) per source:\n"
        f"{json.dumps(series, indent=1)}\n\n"
        "Diagnose the single most likely root cause, propose the most promising "
        "cluster-aware potential solution, and list concrete files/series to inspect."
    )
    try:
        resp = client.messages.create(
            model=LLM_MODEL,
            max_tokens=1500,
            thinking={"type": "adaptive"},
            system=[{
                "type": "text",
                "text": _DIAGNOSE_SYSTEM,
                "cache_control": {"type": "ephemeral"},
            }],
            output_config={"format": {"type": "json_schema", "schema": _DIAGNOSE_SCHEMA}},
            messages=[{"role": "user", "content": user_text}],
        )
        text = "".join(b.text for b in resp.content if b.type == "text")
        result = json.loads(text)
    except Exception as e:
        print(f"  LLM diagnosis failed for {item['key']}: {e}", file=sys.stderr)
        return {
            "likely_cause": f"*(LLM error: {e})*",
            "potential_solution": "",
            "suggested_investigation": [],
            "confidence": "—",
        }

    cache[cache_key] = result
    try:
        CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True))
    except Exception:
        pass
    return result


def _flag_index() -> dict:
    """Map (iso3, variable) -> {flags, year_min, year_max, flagged_sources}
    from flags.parquet, so each finding can show its affected year span and
    which checks fired without the dashboard re-reading the parquet."""
    if not FLAGS_PATH.exists():
        return {}
    df = pd.read_parquet(FLAGS_PATH)
    reason_cols = [c for c in df.columns if c.startswith("reason_")]
    out: dict[tuple[str, str], dict] = {}
    for (iso3, var), g in df.groupby(["ISO3", "variables"]):
        flags = sorted(c.removeprefix("reason_")
                       for c in reason_cols if (g[c] == 1.0).any())
        yrs = g["year"].dropna()
        srcs = sorted({str(s) for s in g["source"]
                       if pd.notna(s) and str(s) not in ("", "nan")})
        out[(str(iso3), str(var))] = {
            "flags": flags,
            "year_min": int(yrs.min()) if len(yrs) else None,
            "year_max": int(yrs.max()) if len(yrs) else None,
            "flagged_sources": srcs,
        }
    return out


def build_findings() -> dict:
    """Build the machine-readable findings feed: every still-flagged open
    pending-fix item, attributed to its likely source (explicit [ISSUE-<src>]
    tags first, then the ledger's flagged-cell sources) and classified into a
    root-cause bucket. Consumed by serve.py's /findings endpoint."""
    items = items_still_flagged(load_open_pending())
    rollup_data = rollups.build_rollups(items)
    fidx = _flag_index()
    findings = []
    for it in items:
        cl = rollups.classify(it, rollup_data)
        comment = it.get("comment") or ""
        issue_tags = rollups.attribute_issue(comment)   # explicit [ISSUE-<src>]
        fi = fidx.get((it["iso3"], it["variable"]), {})
        findings.append({
            "key": it["key"],
            "iso3": it["iso3"],
            "variable": it["variable"],
            "comment": comment,
            "comment_clean": rollups.ISSUE_TAG_RE.sub("", comment).strip(),
            "issue_tags": issue_tags,                    # reviewer's explicit attribution
            "flagged_sources": it.get("sources") or [],  # every flagged source in the pair
            "likely_source": (issue_tags[0] if issue_tags else cl["bucket"]),
            "label": cl["label"],
            "bucket": cl["bucket"],
            "n_siblings": len(cl["siblings"]),
            "sibling_keys": [s.get("key") for s in cl["siblings"] if s.get("key")],
            "flags": fi.get("flags", []),
            "year_min": fi.get("year_min"),
            "year_max": fi.get("year_max"),
            "n_cells": it.get("n_cells", 1),
            "approved_by": it.get("approved_by"),
            "approved_at": it.get("approved_at"),
            # Cache-only: shows the LLM cluster-aware cause+solution once a full
            # `diagnose.py` run (with ANTHROPIC_API_KEY) has populated the cache;
            # never triggers a live model call on the /findings GET path.
            "diagnosis": _llm_diagnose(it, cl, allow_api=False),
        })
    # Source-systemic clusters first, biggest clusters first, so the likely
    # shared root causes float to the top of the tab.
    label_rank = {"source-systemic": 0, "variable-systemic": 1,
                  "country-systemic": 2, "idiosyncratic": 3}
    findings.sort(key=lambda f: (label_rank.get(f["label"], 9),
                                 -f["n_siblings"], f["iso3"], f["variable"]))
    return {"generated": _now_iso(), "n": len(findings), "findings": findings}


def write_findings() -> dict:
    data = build_findings()
    FINDINGS_OUT.write_text(json.dumps(data, indent=1))
    return data


def render_markdown(items: list[dict], rollup_data: dict) -> str:
    """Group items by classification, then by bucket, into a markdown
    worklist."""
    classified = []
    for it in items:
        cl = rollups.classify(it, rollup_data)
        classified.append((it, cl))

    by_label: dict[str, list] = defaultdict(list)
    for it, cl in classified:
        by_label[cl["label"]].append((it, cl))

    parts = [
        f"# Pending fixes — {len(items)} open items\n",
        f"_Auto-generated by `audit_dashboard/diagnose.py` on **{_now_iso()}**._  ",
        f"_Source: latest non-superseded `pending-fix` records in "
        f"`audit_dashboard/vetting.jsonl` that still flag in "
        f"`audit_dashboard/flags.parquet`._\n",
        "Items are grouped by likely root-cause pattern. Fix one shared "
        "root cause and the engine's next rerun automatically clears "
        "every item in the bucket.\n",
        "## Contents",
    ]
    label_order = ["source-systemic", "variable-systemic", "country-systemic", "idiosyncratic"]
    pretty = {
        "source-systemic":   "Source-systemic",
        "variable-systemic": "Variable-systemic",
        "country-systemic":  "Country-systemic",
        "idiosyncratic":     "Idiosyncratic",
    }
    for lab in label_order:
        bucket_items = by_label.get(lab, [])
        if bucket_items:
            parts.append(f"- [{pretty[lab]}](#{lab}) ({len(bucket_items)})")
    parts.append("")

    for lab in label_order:
        bucket_items = by_label.get(lab, [])
        if not bucket_items:
            continue
        parts.append(f"\n## <a id='{lab}'></a>{pretty[lab]} ({len(bucket_items)} items)\n")
        # Sub-group by bucket (the source / variable / iso3 they share).
        by_bucket: dict[str, list] = defaultdict(list)
        for it, cl in bucket_items:
            by_bucket[cl["bucket"] or "(none)"].append((it, cl))
        for bucket, group in sorted(by_bucket.items(),
                                    key=lambda kv: (-len(kv[1]), kv[0])):
            label = pretty[lab].lower().split("-")[0]
            n = len(group)
            parts.append(f"### {bucket} — {n} item{'s' if n != 1 else ''} ({label})\n")
            for it, cl in group:
                diag = _llm_diagnose(it, cl)
                parts.append(f"- [ ] **{it['iso3']} {it['variable']}** "
                            f"({it['n_cells']} flagged cell{'s' if it['n_cells'] != 1 else ''})")
                if it["sources"]:
                    parts.append(f"  - Sources flagged: {', '.join(it['sources'])}")
                if it["comment"].strip():
                    # First 240 chars; collapse whitespace
                    c = " ".join(it["comment"].split())
                    if len(c) > 240:
                        c = c[:240] + "…"
                    parts.append(f"  - Reviewer comment: _{c}_")
                parts.append(f"  - Likely cause: {diag['likely_cause']}")
                if diag["suggested_investigation"]:
                    parts.append(f"  - Suggested investigation:")
                    for s in diag["suggested_investigation"]:
                        parts.append(f"    - {s}")
                parts.append("")
        parts.append("")

    return "\n".join(parts)


def main() -> int:
    # Fast path for serve.py: only (re)write findings.json, skip the markdown
    # worklist + any LLM diagnosis. Keeps the /findings endpoint snappy.
    if "--json" in sys.argv:
        data = write_findings()
        print(f"wrote {FINDINGS_OUT} ({data['n']} findings)")
        return 0
    items = load_open_pending()
    if not items:
        print("no open pending-fix items in vetting.jsonl")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(f"# Pending fixes — 0 open items\n\n_Generated {_now_iso()}._\n")
        write_findings()
        return 0
    print(f"loaded {len(items)} pair-level pending-fix items from vetting.jsonl")
    before = len(items)
    items = items_still_flagged(items)
    if before != len(items):
        print(f"  dropped {before - len(items)} pairs no longer flagged by the engine")
    rollup_data = rollups.build_rollups(items)
    md = render_markdown(items, rollup_data)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(md)
    print(f"wrote {OUT} ({len(md):,} bytes)")
    data = write_findings()
    print(f"wrote {FINDINGS_OUT} ({data['n']} findings)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
