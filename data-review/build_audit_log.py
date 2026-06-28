#!/usr/bin/env python3
"""Generate `docs/GMD_AUDIT_LOG.md` — the single recoverable record of
the entire Mitchell IHS audit effort.

Pulls together:
  1. Committed fixes on the audit branch (parsed from `git log` since the
     point where the cleanup started).
  2. Every approval / comment left in the dashboard (`audit_dashboard/comments.json`).
  3. Heuristic flags from `data.json` (top suspects by severity).
  4. Hand-curated KNOWN-LIMITATION list (in this script).
  5. Recovery instructions: how to rebuild `comments.json` from the markdown
     if everything else is lost.

Run manually:
    python build_audit_log.py
or set `AUTO_REBUILD = True` in serve.py to regenerate after every save.
"""
from __future__ import annotations
import datetime as _dt
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DASH = ROOT / "audit_dashboard"
DOCS = ROOT / "docs"
OUT = DOCS / "GMD_AUDIT_LOG.md"
OUT_PEER = DOCS / "SOURCE_ISSUES.md"
OUT_CONS = DOCS / "AUDIT_CONSOLIDATED.md"

# Stop words for phrase extraction. Kept minimal — we want phrases like
# "wrong scale", "currency reform", "1986 break" to survive.
_STOPWORDS = set((
    "a an the and or but is are was were be been being of in on at to for from "
    "with by as it this that these those if then so not no do does did has have "
    "had can could should would will may might must shall i you he she we they "
    "me him her us them my your his hers our their there here also just only "
    "very still already always sometimes more most some any all each every both "
    "either neither very much many few several into onto upon out over under "
    "than then which who whom what when where why how"
).split())

# Pattern for source-issue tags inserted by the dashboard's source buttons.
# Source names allowed = letters, digits, underscore (matches Mitchell, IMF_IFS,
# WDI, AFDB, BORDO, etc.).
ISSUE_TAG_RE = re.compile(r"\[ISSUE-([A-Za-z0-9_]+)\]")

# The first commit AFTER which the current Mitchell-only audit cleanup began.
# Everything since this SHA on the branch is in scope. Adjust if you reset
# the branch — `git log --oneline mitchell-comprehensive-audit` shows it.
AUDIT_BASE_SHA = "0b974634d0"  # "audit: regen red_cells/status after non-Mitchell revert batch"

# Hand-curated KNOWN-LIMITATION items (things we deliberately did NOT fix because
# they're out-of-scope or irrecoverable). Mirror the project memory file.
KNOWN_LIMITATIONS = [
    ("PAN exports ÷10 vs 5 peers (1950–2010)",
     "Methodology: Mitchell captures merchandise exports only, peers include Canal services + Colón Free Zone re-exports. Mitchell 1985 = 333 mn matches actual goods exports of ~$334mn. NOT a unit bug."),
    ("SLV trade /8.5 vs Tena/HFS",
     "Methodology: Mitchell expresses post-2001 SLV in USD per GMD canonical (current LCU = USD post-dollarization), peers stay in colones. Minor 8.5 vs 8.75 inconsistency in the conversion factor but not a unit bug."),
    ("NLD cgovtax post-1999",
     "Mitchell only captures the Excise subcategory (raw 2005 = 13.604 = Excise; other tax subcategories show '—' in source). NOT a 'Total tax' series for NLD post-EUR — methodology limitation."),
    ("NZL CPI 1938 internal break (3.25× drop) + HTI/GHA/LBY/NGA CPI ×10",
     "All trace to `gmd_adjust_breaks_CPI` (notes==100 placeholder produces no-op chainlink) + `gmd_rebase` r(max)−1 off-by-one. Affects ~50+ Mitchell-CPI countries. **Out-of-scope for the Mitchell-only audit** (general infrastructure fix in `code/functions/gmd_mitchell.ado` + `gmd_rebase.ado`)."),
    ("cgovdef '30-40× too small' cluster (THA 1946, NOR 1956, AUS 1963, …)",
     "NOT a derivation bug. Mitchell_cgovdef = cgovrev − cgovexp identity holds in 99.98% of obs. Flagged years are real near-balanced-budget years (10.4% of all cgovdef obs have |def|/rev < 2% — natural fiscal distribution). Audit metric over-flagged."),
    ("PRY 1937 cgovrev = cgovexp = 18.89",
     "Mitchell IHS source row coincidentally has the value 1889 in both fields — strongly suggests a transcription error where the 'year' header bled into the value cells. Right value is unrecoverable without the source PDF."),
    ("HND cgovrev 1956 = 17",
     "Total < Customs subcategory (= 22), which is impossible. Cannot determine the right value without an authoritative external source. Mitchell IHS source error; surfaced as KNOWN-LIMITATION."),
    ("SGP cgovexp 1907 = 39,489",
     "4× spike vs trend ~11,000. No external reference available; KNOWN-LIMITATION."),
    ("BGR M0 1880s",
     "Entire decade volatile (raw values jump 49 → 1036 → 183 → 402 → 1958 → 1303 etc.). Cannot fix individual years without authoritative early-Bulgarian monetary statistics."),
    ("RUS pre-1992 monetary data",
     "Sits at 1e-7 to 1e-13 scale due to /10^12 cumulative-reform conversion that conflates Tsarist gold rubles with current fiat rubles. Conceptually broken but smooth in log space; documented as fundamental limitation."),
    ("PRY cgovexp 1919 vs 1920 (22× jump)",
     "Latam_govexp.do applies /1.75 for year ≤ 1919 (gold-paper peso ratio). Agent investigation suggests the /1.75 may be in wrong direction (×1.75 would be more correct), but the underlying gold→paper exchange isn't pinned tightly enough to commit a clean fix. Documented as historical-economic-realism limitation."),
    ("HTI trade 1916–1917 residual",
     "After the 1900–1921 ×5 USD→gourdes fix, 1916–1917 still sit at ratio 0.24 vs Tena (vs ~1.0 elsewhere). Smaller separate Mitchell IHS source anomaly within the USD scale."),
]

# Real economic events confirmed by parallel agents (NOT bugs)
REAL_EVENTS = [
    ("KWT exports 1991 = 309 mn dinars (vs ~2000-3000 surrounding)",
     "Iraq invasion + Gulf War oil-export collapse. WDI/IMF_WEO confirm same ~78% YoY drop. Mitchell cgovrev shows parallel collapse. Recovery to pre-war levels by 1993."),
    ("MDG imports/exports 1942 = 11.4 / 25 (vs ~84/141)",
     "Battle of Madagascar (Operation Ironclad May–Nov 1942) + Vichy → Free French handover + Royal Navy blockade. CogneauDupraz confirms identical Mitchell values (ratio 1.000); both sources share INSEE/Annuaire Statistique provenance."),
    ("JPN exports/imports 1866 treaty-port-only collapse",
     "Bakumatsu political turmoil (Second Choshu Expedition June–Sept 1866 + June 1866 Tariff Convention). Mitchell IHS Asia_trade FN 9 explicitly notes 'Statistics to 1867 are for Yokohama, Nagasaki, and Hakodate only.' No alternative source for cross-validation pre-1870."),
]


def run(cmd: list[str], cwd: Path = ROOT) -> str:
    return subprocess.run(cmd, cwd=str(cwd), check=True, capture_output=True, text=True).stdout


def git_log_since(base_sha: str) -> list[dict]:
    """Return list of substantive fix commits since base_sha, oldest first.

    Filters out ``audit:`` and ``audit dashboard:`` prefixed commits — those
    are the dashboard's own self-updates (sync commits, infrastructure tweaks)
    and don't represent Mitchell-data fixes. Including them would also create
    a self-reference cycle: every sync commit would land in the next regen,
    bumping the "N fix commits since base" line, which in turn would dirty
    the diff and trigger another sync."""
    try:
        sep = "\x1f"
        rec_sep = "\x1e"
        fmt = f"%H{sep}%s{sep}%b{rec_sep}"
        raw = run([
            "git", "log",
            f"{base_sha}..HEAD",
            "--reverse",
            "--no-merges",
            f"--pretty=format:{fmt}",
        ])
    except subprocess.CalledProcessError:
        return []
    commits = []
    for entry in raw.split(rec_sep):
        entry = entry.strip("\n")
        if not entry:
            continue
        parts = entry.split(sep)
        if len(parts) < 2:
            continue
        sha, subject = parts[0], parts[1]
        # Skip dashboard/audit infrastructure commits
        if subject.startswith("audit:") or subject.startswith("audit dashboard:"):
            continue
        body = parts[2].strip() if len(parts) > 2 else ""
        commits.append({"sha": sha, "subject": subject, "body": body})
    return commits


def head_sha() -> str:
    try:
        return run(["git", "rev-parse", "HEAD"]).strip()
    except subprocess.CalledProcessError:
        return "(unknown)"


def last_fix_sha(commits: list[dict]) -> str:
    """SHA of the most recent NON-audit-sync commit. Used in the header
    so the displayed branch tip stays stable across consecutive sync
    commits (otherwise the SHA would change every time the dashboard
    syncs, dirtying the diff)."""
    return commits[-1]["sha"] if commits else "(no fix commits yet)"


def branch_name() -> str:
    try:
        return run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).strip()
    except subprocess.CalledProcessError:
        return "(unknown)"


def load_comments() -> dict:
    p = DASH / "comments.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text() or "{}")
    except json.JSONDecodeError:
        return {}


def load_data_pairs() -> list[dict]:
    p = DASH / "data.json"
    if not p.exists():
        return []
    try:
        d = json.loads(p.read_text())
        return d.get("pairs", [])
    except json.JSONDecodeError:
        return []


def attribute_issue(comment: str) -> list[str]:
    """Extract the source(s) flagged by [ISSUE-<SRC>] tags in the comment.

    If no explicit tags are present but the comment is non-empty, fall back to
    ``["Mitchell"]`` — the implicit default for this Mitchell-focused dashboard.
    Returns ``[]`` for empty comments (no issue noted).
    """
    if not comment or not comment.strip():
        return []
    tags = ISSUE_TAG_RE.findall(comment)
    if tags:
        # de-dupe while preserving first-seen order
        seen = []
        for t in tags:
            if t not in seen:
                seen.append(t)
        return seen
    return ["Mitchell"]


def strip_issue_tags(comment: str) -> str:
    """Remove [ISSUE-X] tags from a comment so the prose reads cleanly."""
    return ISSUE_TAG_RE.sub("", comment).strip()


def write_peer_source_issues(comments: dict, pair_index: dict) -> int:
    """Write `docs/SOURCE_ISSUES.md` — issues organised by which source
    the user thinks they're in. Returns total issue rows written."""
    by_source: dict[str, list[tuple[str, dict]]] = defaultdict(list)
    for key, entry in comments.items():
        sources = attribute_issue(entry.get("comment", ""))
        for s in sources:
            by_source[s].append((key, entry))

    lines: list[str] = []
    add = lines.append
    now = _dt.datetime.now().isoformat(timespec="seconds")
    add(f"# Per-source issues flagged during data-quality review\n")
    add(f"_Auto-generated by `audit_dashboard/build_audit_log.py` on **{now}**._  ")
    add(f"_Companion to [`GMD_AUDIT_LOG.md`](GMD_AUDIT_LOG.md). "
        f"Each entry is one (ISO3, var) pair where the reviewer marked the "
        f"named source as potentially problematic, either via an explicit "
        f"`[ISSUE-<src>]` tag in the dashboard or — for legacy comments without "
        f"tags — by default attribution to Mitchell._\n")
    total = sum(len(v) for v in by_source.values())
    if not total:
        add("_No source-attributed issues yet._\n")
        OUT_PEER.write_text("\n".join(lines))
        return 0
    add(f"**Total issues:** {total}, across **{len(by_source)} sources**.\n")
    add("---\n")
    # List sources by issue count, descending (Mitchell will dominate this list
    # for now; non-Mitchell sources are the actionable "fix in some other clean
    # file" items).
    for src in sorted(by_source.keys(), key=lambda s: (-len(by_source[s]), s)):
        rows = by_source[src]
        # Mitchell heading is special: this is everything still to fix in the
        # Mitchell pipeline. Non-Mitchell headings are spinout work.
        suffix = " (default attribution)" if src == "Mitchell" else ""
        add(f"## `{src}` — {len(rows)} issue{'s' if len(rows) != 1 else ''}{suffix}\n")
        rows.sort(key=lambda kv: kv[0])  # by ISO3_var
        for key, entry in rows:
            comment = strip_issue_tags(entry.get("comment", ""))
            ts = entry.get("ts", "")
            approved = entry.get("approved")
            marker = "✓" if approved else "⚠"
            p = pair_index.get(key, {})
            meta = pair_meta_line(p)
            add(f"### {marker} `{key}`{(' · ' + meta) if meta else ''}\n")
            if comment:
                for line in comment.splitlines():
                    add(f"> {line}")
                add("")
            else:
                add("_(tagged but no prose comment)_\n")
            add(f"<sub>saved {ts}</sub>\n")
        add("")
    OUT_PEER.write_text("\n".join(lines))
    return total


def write_consolidated(comments: dict, pair_index: dict) -> int:
    """Write `docs/AUDIT_CONSOLIDATED.md` — the same comments rolled up
    along orthogonal dimensions to surface SHARED root causes that aren't
    visible one pair at a time.

    Sections (each only includes groups with >=2 entries to avoid noise):
      1. By country (ISO3)
      2. By variable
      3. By ISO3 × peer source (non-Mitchell only — peer issues that look
         country-specific)
      4. By recurring phrase (n-gram counts across comment text)

    Returns total number of comment-references written across all sections.
    """
    # Pre-filter: only comments with prose (skip pure approvals)
    prose_comments = {
        k: v for k, v in comments.items()
        if (v.get("comment") or "").strip()
    }
    if not prose_comments:
        OUT_CONS.write_text(
            "# Audit consolidation — looking across pairs to find shared root causes\n\n"
            "_No prose comments yet — there's nothing to consolidate._\n"
        )
        return 0

    # ---- 1. By ISO3 ----------------------------------------------------------
    by_iso3: dict[str, list] = defaultdict(list)
    for key, entry in prose_comments.items():
        iso3 = key.split("_", 1)[0]
        by_iso3[iso3].append((key, entry))

    # ---- 2. By variable ------------------------------------------------------
    by_var: dict[str, list] = defaultdict(list)
    for key, entry in prose_comments.items():
        parts = key.split("_", 1)
        if len(parts) == 2:
            by_var[parts[1]].append((key, entry))

    # ---- 3. By ISO3 × peer source -------------------------------------------
    by_iso3_src: dict[tuple, list] = defaultdict(list)
    for key, entry in prose_comments.items():
        iso3 = key.split("_", 1)[0]
        srcs = ISSUE_TAG_RE.findall(entry.get("comment", ""))
        # We're looking for *peer* issues here. Mitchell is the default
        # attribution for tagless comments; not interesting at this layer.
        for s in set(srcs):
            if s == "Mitchell":
                continue
            by_iso3_src[(iso3, s)].append((key, entry))

    # ---- 4. Phrase n-grams ---------------------------------------------------
    phrase_keys: dict[str, set] = defaultdict(set)
    for key, entry in prose_comments.items():
        text = ISSUE_TAG_RE.sub(" ", entry.get("comment", "")).lower()
        # strip punctuation except letters, digits, hyphens, apostrophes,
        # whitespace; collapse whitespace
        text = re.sub(r"[^\w\s\-']", " ", text, flags=re.UNICODE)
        words = [w for w in text.split() if len(w) > 1 and w not in _STOPWORDS]
        for n in (2, 3):
            for i in range(len(words) - n + 1):
                ng = " ".join(words[i : i + n])
                phrase_keys[ng].add(key)
    # Keep phrases mentioned in >=2 distinct pairs; sort by frequency desc
    phrase_hits = sorted(
        ((ng, sorted(keys)) for ng, keys in phrase_keys.items() if len(keys) >= 2),
        key=lambda x: (-len(x[1]), x[0]),
    )

    # ---- Render --------------------------------------------------------------
    lines: list[str] = []
    add = lines.append
    now = _dt.datetime.now().isoformat(timespec="seconds")
    add(f"# Audit consolidation — looking across pairs to find shared root causes\n")
    add(f"_Auto-generated by `audit_dashboard/build_audit_log.py` on **{now}**._  ")
    add(f"_Companion to [`GMD_AUDIT_LOG.md`](GMD_AUDIT_LOG.md) "
        f"(per-pair record) and [`SOURCE_ISSUES.md`](SOURCE_ISSUES.md) "
        f"(rollup by attributed source). This file rolls the same comments "
        f"along orthogonal dimensions to spot patterns that aren't visible "
        f"one pair at a time — country-wide systematic issues, variable-wide "
        f"methodology gaps, recurring phrases that hint at a single root cause "
        f"behind many symptoms._\n")
    add(f"_Filter: pure approvals (no prose comment) are excluded; only the "
        f"**{len(prose_comments)}** comments with text are consolidated._\n")
    add("## Contents")
    add("1. [By country (ISO3)](#by-country)")
    add("2. [By variable](#by-variable)")
    add("3. [By ISO3 × peer source](#by-iso3-source)")
    add("4. [By recurring phrase](#by-phrase)")
    add("")

    total_refs = 0

    # Section 1
    add("## <a id=\"by-country\"></a>1. By country (ISO3)\n")
    add("_Countries with ≥2 commented pairs. Multiple comments on one country "
        "often share a root cause — a missed currency reform, a methodology "
        "switch, or a mis-classified subcategory that affects every monetary "
        "variable._\n")
    multi_iso3 = [(k, v) for k, v in by_iso3.items() if len(v) >= 2]
    if not multi_iso3:
        add("_No country yet has ≥2 prose comments._\n")
    else:
        # Sort by comment count desc, then ISO3
        multi_iso3.sort(key=lambda kv: (-len(kv[1]), kv[0]))
        for iso3, items in multi_iso3:
            add(f"### {iso3} — {len(items)} comments\n")
            items.sort(key=lambda kv: kv[0])
            for key, entry in items:
                _emit_comment(add, key, entry)
                total_refs += 1
            add("")

    # Section 2
    add("## <a id=\"by-variable\"></a>2. By variable\n")
    add("_Variables with ≥2 commented countries. Patterns here usually mean "
        "either a derivation bug (e.g., one source consistently misreports M2) "
        "or an indexing methodology issue (CPI / HPI / REER / rGDP base-year "
        "chaining)._\n")
    multi_var = [(k, v) for k, v in by_var.items() if len(v) >= 2]
    if not multi_var:
        add("_No variable yet has ≥2 prose comments._\n")
    else:
        multi_var.sort(key=lambda kv: (-len(kv[1]), kv[0]))
        for var, items in multi_var:
            isos = sorted({k.split("_", 1)[0] for k, _ in items})
            add(f"### {var} — {len(items)} comments  ·  countries: {', '.join(isos)}\n")
            items.sort(key=lambda kv: kv[0])
            for key, entry in items:
                _emit_comment(add, key, entry)
                total_refs += 1
            add("")

    # Section 3
    add("## <a id=\"by-iso3-source\"></a>3. By ISO3 × peer source\n")
    add("_Pairs of (country, peer source) explicitly tagged via `[ISSUE-<src>]`. "
        "Useful when a peer source has a country-specific bug — e.g. AFDB "
        "applied a 2000 currency reform but missed prior chains, only for "
        "country X. Mitchell as default attribution is excluded here._\n")
    if not by_iso3_src:
        add("_No comments yet have peer-source tags. Use the dashboard's "
            "source-issue buttons to attribute._\n")
    else:
        # Sort by (country, source), but lift entries with ≥2 to the top
        sorted_keys = sorted(by_iso3_src.items(), key=lambda kv: (-len(kv[1]), kv[0][0], kv[0][1]))
        for (iso3, src), items in sorted_keys:
            add(f"### {iso3} × `{src}` — {len(items)} comment{'s' if len(items) != 1 else ''}\n")
            items.sort(key=lambda kv: kv[0])
            for key, entry in items:
                _emit_comment(add, key, entry)
                total_refs += 1
            add("")

    # Section 4
    add("## <a id=\"by-phrase\"></a>4. By recurring phrase\n")
    add("_Two- and three-word phrases appearing in ≥2 distinct comments "
        "(stopwords stripped). Recurring phrases hint at a shared root cause: "
        "if `\"wrong scale\"` shows up across SDN_M0, SDN_M1, SDN_M2 it's "
        "almost certainly one fix._\n")
    if not phrase_hits:
        add("_No phrase appears in ≥2 comments yet._\n")
    else:
        # Show top 50 to keep the file readable
        for ng, keys in phrase_hits[:50]:
            add(f"### \"{ng}\" — {len(keys)} mention{'s' if len(keys) != 1 else ''}\n")
            for k in keys:
                entry = comments[k]
                _emit_comment(add, k, entry)
            add("")

    OUT_CONS.write_text("\n".join(lines))
    return total_refs


def _emit_comment(add, key: str, entry: dict) -> None:
    """Render one comment as a quoted block under whichever rollup section."""
    approved = entry.get("approved")
    marker = "✓" if approved else "⚠"
    ts = entry.get("ts", "")
    body = (entry.get("comment") or "").strip()
    add(f"- {marker} `{key}`")
    for line in body.splitlines():
        add(f"  > {line}")
    add(f"  <sub>saved {ts}</sub>")


def fmt_flag(f: dict) -> str:
    if f["t"] == "spike":
        return f"spike {f['y']} ({'+' if f['lr'] > 0 else ''}{f['lr']} log10)"
    if f["t"] == "lvl10":
        sign = "×10" if f["p"] > 0 else "÷10"
        return f"{sign}^{abs(f['p'])} vs {f['n']} peers"
    if f["t"] == "yoy":
        return f"{f['n']} large YoY jump{'s' if f['n'] > 1 else ''}"
    return json.dumps(f)


def pair_total_sev(p: dict) -> int:
    """Total suspicion across sources. sev is a per-source dict in the
    current shape; sum it (tolerate the legacy scalar form)."""
    sev = p.get("sev")
    if isinstance(sev, dict):
        return int(sum(v or 0 for v in sev.values()))
    return int(sev or 0)


def pair_reasons(p: dict) -> set:
    """Set of flagged reason short-names (engine + heuristic) for a pair."""
    reasons = set()
    for ef in (p.get("engine_flags") or []):
        for r in (ef.get("r") or []):
            reasons.add(r)
    hf = p.get("heuristic_flags") or {}
    if isinstance(hf, dict):
        for flist in hf.values():
            for f in (flist or []):
                if f.get("t"):
                    reasons.add(f["t"])
    return reasons


def pair_meta_line(p: dict) -> str:
    """Source-neutral one-line coverage summary for a pair, computed from the
    current (post-Mitchell-anchor) data.json shape: year span, total obs
    across all sources, source count, and the set of flagged reasons."""
    if not p:
        return ""
    n_obs = p.get("n_obs") or {}
    total_obs = sum(n_obs.values()) if isinstance(n_obs, dict) else 0
    n_sources = len(p.get("sources") or n_obs or [])
    # Reasons flagged on this pair (engine + heuristic short-names).
    reasons = pair_reasons(p)
    flag_str = f" · flags: {', '.join(sorted(reasons))}" if reasons else ""
    return (f"{p.get('year_min', '?')}–{p.get('year_max', '?')} "
            f"({total_obs:,} obs across {n_sources} source{'s' if n_sources != 1 else ''})"
            f"{flag_str}")


def main() -> int:
    DOCS.mkdir(exist_ok=True)
    now = _dt.datetime.now().isoformat(timespec="seconds")
    branch = branch_name()
    commits = git_log_since(AUDIT_BASE_SHA)
    sha = last_fix_sha(commits)
    comments = load_comments()
    pairs = load_data_pairs()
    pair_index = {f"{p['iso3']}_{p['var']}": p for p in pairs}

    approved = [k for k, v in comments.items() if v.get("approved")]
    commented_only = [k for k, v in comments.items() if not v.get("approved") and (v.get("comment") or "").strip()]

    # Sort comments by ISO3, then var
    sorted_keys = sorted(comments.keys())

    # Prepare flags inventory (top-50 by total suspicion across sources)
    flagged = [p for p in pairs if pair_reasons(p)]
    flagged.sort(key=lambda p: -pair_total_sev(p))

    lines: list[str] = []
    add = lines.append

    # --- Header ---
    add(f"# GMD Data Quality Audit Log\n")
    add(f"_Auto-generated by `audit_dashboard/build_audit_log.py` on **{now}**._  ")
    add(f"_Source-of-truth: `audit_dashboard/comments.json` (live) + git log on this branch._\n")
    add(f"- **Branch:** `{branch}` @ `{sha[:10]}`")
    add(f"- **Audit base:** `{AUDIT_BASE_SHA}` ({len(commits)} fix commits since)")
    add(f"- **Dashboard reviews:** **{len(approved)} approved**, "
        f"{len(commented_only)} commented-only, {len(pairs) - len(comments)} unreviewed "
        f"(of {len(pairs)} total pairs)")
    add(f"- **Heuristic flags:** {len(flagged)} pairs flagged out of {len(pairs)}")
    add(f"- **Companion files:**")
    add(f"  - [`SOURCE_ISSUES.md`](SOURCE_ISSUES.md) — same comments "
        f"rolled up by which source the reviewer flagged (parsed from "
        f"`[ISSUE-<src>]` tags; comments without explicit tags default to Mitchell).")
    add(f"  - [`AUDIT_CONSOLIDATED.md`](AUDIT_CONSOLIDATED.md) — same comments "
        f"clustered by ISO3, by variable, by ISO3×source, and by recurring phrase, "
        f"to surface shared root causes that aren't visible one pair at a time.")
    add("")
    add("> If `comments.json` is ever lost, **this file is the recoverable record**. "
        "Each `### KEY ✓ approved` block below is enough to reconstruct one entry "
        "(see *Recovery* at the bottom).")
    add("")

    # --- TOC ---
    add("## Contents")
    add("1. [Committed fixes](#committed-fixes)")
    add("2. [Manual review notes (dashboard comments)](#manual-review-notes)")
    add("3. [Open questions / KNOWN-LIMITATION](#known-limitation)")
    add("4. [Real economic events (no fix needed)](#real-events)")
    add("5. [Top suspects by heuristic flag (worst first)](#top-suspects)")
    add("6. [Recovery instructions](#recovery)")
    add("")

    # --- 1. Commits ---
    add("## <a id=\"committed-fixes\"></a>1. Committed fixes\n")
    if not commits:
        add(f"_No commits found since `{AUDIT_BASE_SHA}`. Either the branch hasn't moved, "
            "or the AUDIT_BASE_SHA constant in `build_audit_log.py` needs updating._\n")
    else:
        add(f"All {len(commits)} commits on this branch since `{AUDIT_BASE_SHA[:10]}`, "
            "oldest first. Each fix is independent and self-validated.\n")
        for c in commits:
            add(f"### `{c['sha'][:10]}` — {c['subject']}\n")
            if c["body"]:
                # Trim trailing Co-Authored-By line for compactness
                body = "\n".join(
                    ln for ln in c["body"].splitlines()
                    if not ln.startswith("Co-Authored-By:")
                ).strip()
                if body:
                    add(body + "\n")
        add("")

    # --- 2. Comments ---
    add("## <a id=\"manual-review-notes\"></a>2. Manual review notes\n")
    add(f"_{len(comments)} entries from the audit dashboard. "
        f"✓ = approved (Mitchell looks correct or correctly-imperfect for this pair); "
        f"⚠ = comment without explicit approval._\n")
    if not sorted_keys:
        add("_No comments yet._\n")
    for key in sorted_keys:
        v = comments[key]
        approved = v.get("approved")
        comment = (v.get("comment") or "").strip()
        ts = v.get("ts", "")
        marker = "✓" if approved else "⚠"
        # Pull pair metadata + flags if available
        p = pair_index.get(key, {})
        ml = pair_meta_line(p)
        meta = f"_{ml}._" if ml else ""
        add(f"### {marker} `{key}`\n")
        if meta:
            add(meta + "\n")
        if comment:
            # quote the user's comment to preserve tags/newlines
            for line in comment.splitlines():
                add(f"> {line}")
            add("")
        else:
            add("_(no comment — Mitchell looked acceptable)_\n")
        add(f"<sub>saved {ts}</sub>\n")
    add("")

    # --- 3. KNOWN-LIMITATION ---
    add("## <a id=\"known-limitation\"></a>3. Open questions / KNOWN-LIMITATION\n")
    add("Issues we **deliberately did not patch**, with the reason. These are "
        "either methodology (peer disagreement is real / definitional), genuinely "
        "irrecoverable from Mitchell IHS source, or out-of-scope (general "
        "infrastructure rather than Mitchell-only).\n")
    for label, reason in KNOWN_LIMITATIONS:
        add(f"- **{label}** — {reason}")
    add("")

    # --- 4. Real economic events ---
    add("## <a id=\"real-events\"></a>4. Real economic events (no fix needed)\n")
    add("_Cases where a Mitchell anomaly is the genuine economic record (war, "
        "currency crisis, regime change), confirmed by independent peer sources._\n")
    for label, reason in REAL_EVENTS:
        add(f"- **{label}** — {reason}")
    add("")

    # --- 5. Top suspects ---
    add("## <a id=\"top-suspects\"></a>5. Top suspects by heuristic flag (worst first)\n")
    add(f"Top 50 of {len(flagged)} flagged pairs ranked by suspicion score "
        "(see `compute_flags()` in `build_data.py` for the heuristic).\n")
    add("| sev | ISO3 | var | flags | reviewed |")
    add("|----:|------|-----|-------|:--------:|")
    for p in flagged[:50]:
        key = f"{p['iso3']}_{p['var']}"
        c = comments.get(key, {})
        reviewed = "✓" if c.get("approved") else ("⚠" if (c.get("comment") or "").strip() else "—")
        flag_str = ", ".join(sorted(pair_reasons(p)))
        add(f"| {pair_total_sev(p)} | {p['iso3']} | {p['var']} | {flag_str} | {reviewed} |")
    add("")

    # --- 6. Recovery instructions ---
    add("## <a id=\"recovery\"></a>6. Recovery instructions\n")
    add("If everything in `audit_dashboard/` is lost (laptop dies, worktree deleted, etc.) "
        "the comments above can be reconstructed because each `### marker \\`KEY\\`` block "
        "encodes one entry. To rebuild `comments.json`:\n")
    add("```python")
    add("# extract_comments_from_md.py")
    add("import json, re, sys")
    add("md = open('docs/GMD_AUDIT_LOG.md').read()")
    add("entries = {}")
    add("# block per ### marker `KEY`")
    add("for m in re.finditer(r'### ([✓⚠]) `([^`]+)`\\s*\\n(?:_[^\\n]*\\n)?(.*?)(?=\\n### |\\n## |\\Z)', md, re.S):")
    add("    marker, key, body = m.group(1), m.group(2), m.group(3)")
    add("    quoted = '\\n'.join(line[2:] for line in body.split('\\n') if line.startswith('> '))")
    add("    ts_match = re.search(r'<sub>saved ([^<]+)</sub>', body)")
    add("    entries[key] = {")
    add("        'comment': quoted.strip(),")
    add("        'approved': marker == '✓',")
    add("        'ts': ts_match.group(1) if ts_match else '',")
    add("    }")
    add("json.dump(entries, open('audit_dashboard/comments.json', 'w'), indent=2, sort_keys=True)")
    add("```\n")
    add("Append-only history is also in `audit_dashboard/comments.log` (one JSON line per save), "
        "which is independently sufficient to reconstruct the same data with `last-write-wins per key`.")
    add("")

    OUT.write_text("\n".join(lines))
    sz = OUT.stat().st_size
    print(f"Wrote {OUT.relative_to(ROOT)}  ({sz / 1024:.1f} KB, "
          f"{len(commits)} commits, {len(comments)} comments, {len(flagged)} flagged)")

    n_issues = write_peer_source_issues(comments, pair_index)
    sz2 = OUT_PEER.stat().st_size
    print(f"Wrote {OUT_PEER.relative_to(ROOT)}  ({sz2 / 1024:.1f} KB, "
          f"{n_issues} source-attributed issues)")

    n_cons = write_consolidated(comments, pair_index)
    sz3 = OUT_CONS.stat().st_size
    print(f"Wrote {OUT_CONS.relative_to(ROOT)}  ({sz3 / 1024:.1f} KB, "
          f"{n_cons} cross-references across rollups)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
