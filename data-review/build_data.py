#!/usr/bin/env python3
"""Build data.json for the GMD audit dashboard.

No source is privileged. For every chainlinked_<var>.dta in data/final/,
iterates every ISO3 with data from any source and emits one (ISO3, var)
pair. Each pair lists every contributing source plus heuristic suspicion
flags computed once per source and engine flag annotations from
audit_dashboard/flags.parquet.

Usage:
    python build_data.py
"""
from __future__ import annotations
import json
import math
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

# Input data root (a GMD/WED checkout). Resolution order: DATA_REVIEW_DATA_ROOT env
# → a gitignored `.data_root` file next to this script (one line = the path; local-dev
# convenience) → parents[1] (an in-repo checkout). In production the env var points at
# the S3-synced scratch dir. Outputs (data.json, snapshots) always stay next to this script.
def _resolve_data_root() -> Path:
    env = os.environ.get("DATA_REVIEW_DATA_ROOT")
    if env:
        return Path(env).resolve()
    local = Path(__file__).resolve().parent / ".data_root"
    if local.exists():
        return Path(local.read_text().strip()).resolve()
    return Path(__file__).resolve().parents[1]

DATA_ROOT = _resolve_data_root()
FINAL_DIR = DATA_ROOT / "data" / "final"
FLAGS_PATH = Path(__file__).parent / "flags.parquet"
SNAPSHOT_DIR = Path(__file__).parent / "snapshots"
OUT = Path(__file__).parent / "data.json"

# Crisis dummies and rGDP_USD are intentionally out of dashboard scope.
SKIP_VARS = {"BankingCrisis", "CurrencyCrisis", "SovDebtCrisis", "rGDP_USD"}

# Pull the var classification from flags.py so we don't restate it here.
# OTHRATIOS = ratios that can be negative (CA_GDP, govdef_GDP, cgovdef_GDP,
# gen_govdef_GDP). RATES = pct rates (cbrate, strate, ltrate, infl, unemp).
# Within-source year-on-year RATIO is a meaningless suspicion signal for
# either set: deficits cross zero and rates routinely move 1.0% -> 0.1%
# without any error.
import importlib.util as _imp
_spec = _imp.spec_from_file_location("_flags_module", Path(__file__).parent / "flags.py")
_flags_mod = _imp.module_from_spec(_spec)
_spec.loader.exec_module(_flags_mod)
NO_YOY_RATIO_VARS = set(_flags_mod.OTHRATIOS) | set(_flags_mod.RATES)
# Index variables: peer-level ratios are mechanically off because of
# different base years. Skip the per-source lvl10 heuristic on these.
INDEX_VARS = set(_flags_mod.INDICES)


def discover_chainlinked() -> list[tuple[str, Path]]:
    out = []
    for p in sorted(FINAL_DIR.glob("chainlinked_*.dta")):
        var = p.stem.removeprefix("chainlinked_")
        if var in SKIP_VARS:
            continue
        out.append((var, p))
    return out


def compute_first_seen() -> dict:
    """For each (ISO3, variable) pair, the earliest snapshot date in which
    it carried any flag. Pairs absent from every snapshot (brand-new this
    run) get today's date. Powers the dashboard's 'new in last N weeks'
    filter. Returns {f'{iso3}_{var}': 'YYYY-MM-DD'}."""
    import datetime as _dt
    today = _dt.date.today().isoformat()
    snaps = sorted(SNAPSHOT_DIR.glob("flags_*.parquet")) if SNAPSHOT_DIR.exists() else []
    first_seen: dict[str, str] = {}
    for snap in snaps:  # oldest first
        date = snap.stem.replace("flags_", "")
        try:
            sdf = pd.read_parquet(snap, columns=["ISO3", "variables"])
        except Exception:
            continue
        for iso, var in set(zip(sdf["ISO3"].astype(str), sdf["variables"].astype(str))):
            key = f"{iso}_{var}"
            if key not in first_seen:
                first_seen[key] = date
    if snaps:
        print(f"  loaded {len(snaps)} weekly snapshots for first-seen dates")
    return first_seen, today


def main() -> int:
    files = discover_chainlinked()
    print(f"Found {len(files)} chainlinked variables.")
    first_seen, today = compute_first_seen()

    # Pre-load engine flag annotations (optional; degrade gracefully).
    eng_flags: dict[tuple[str, str], list[dict]] = defaultdict(list)
    eng_sev: dict[tuple[str, str, str], int] = defaultdict(int)
    REASON_SHORT = [
        ("reason_outlier", "outlier"), ("reason_corr", "corr"),
        ("reason_discrep", "discrep"), ("reason_implaus", "implaus"),
        ("reason_lvl10", "lvl10"), ("reason_break", "break"),
        ("reason_share", "share"),
        ("reason_realrate", "realrate"), ("reason_Mordering", "Mordering"),
        ("reason_govdef", "govdef"), ("reason_cgovlargergengov", "cgovlrgr"),
        ("reason_inflCPIdiscrp", "inflCPI"),
        ("reason_GDPaccounting", "GDPacct"),
        ("reason_GDPcompcorr", "GDPcomp"),
    ]
    if FLAGS_PATH.exists():
        fl = pd.read_parquet(FLAGS_PATH)
        # Vectorised: build a per-row "reasons" list once, then groupby (ISO3, variables).
        reason_cols = [c for c, _ in REASON_SHORT if c in fl.columns]
        short_for = {c: s for c, s in REASON_SHORT}
        # mask[i] = list of short reason names triggered on row i
        mask = fl[reason_cols].eq(1.0).values
        reasons_per_row: list[list[str]] = [
            [short_for[reason_cols[j]] for j in np.flatnonzero(row)]
            for row in mask
        ]
        n_per_row = [len(r) for r in reasons_per_row]
        keep = [i for i, n in enumerate(n_per_row) if n > 0]
        iso_arr = fl["ISO3"].astype(str).values
        var_arr = fl["variables"].astype(str).values
        yr_arr = fl["year"].values
        src_arr = fl["source"].astype(str).values
        for i in keep:
            iso = iso_arr[i]
            var = var_arr[i]
            src = src_arr[i] if src_arr[i] and src_arr[i] != "nan" else ""
            yr = int(yr_arr[i]) if pd.notna(yr_arr[i]) else None
            eng_flags[(iso, var)].append({"y": yr, "src": src, "r": reasons_per_row[i]})
            if src:
                eng_sev[(iso, var, src)] += n_per_row[i]
        print(f"  attached engine flags: {sum(len(v) for v in eng_flags.values())} rows")
    else:
        print(f"  no flags.parquet at {FLAGS_PATH} -- engine annotations skipped")

    pairs: list[dict] = []
    data: dict[str, dict[str, list[list[float]]]] = {}

    for var, path in files:
        print(f"  scanning {var}")
        df = pd.read_stata(path, convert_categoricals=False)
        # Every source column is <SOURCE>_<var>; the spliced final is just <var>.
        src_cols = [c for c in df.columns
                    if c.endswith(f"_{var}") and c != var
                    and c != "chainlinking_ratio"]
        if not src_cols:
            continue

        # The bare-variable column (e.g. "nGDP" alongside "WDI_nGDP" etc.) is
        # the FINAL spliced GMD value. Emit it as a virtual source named
        # "GMD" so the dashboard can plot it alongside the raw sources.
        spliced_col = var if var in df.columns else None
        for iso, group in df.groupby("ISO3"):
            iso = str(iso)
            if not iso or iso == "nan":
                continue
            sources: dict[str, list[list[float]]] = {}
            for sc in src_cols:
                vals = group.loc[group[sc].notna(), ["year", sc]].sort_values("year")
                if vals.empty:
                    continue
                src_name = sc[: -len(f"_{var}")]
                sources[src_name] = [
                    [int(r.year), _round(getattr(r, sc))]
                    for r in vals.itertuples(index=False)
                ]
            if spliced_col is not None:
                vals = group.loc[group[spliced_col].notna(),
                                 ["year", spliced_col]].sort_values("year")
                if not vals.empty:
                    sources["GMD"] = [
                        [int(r.year), _round(getattr(r, spliced_col))]
                        for r in vals.itertuples(index=False)
                    ]
            if not sources:
                continue
            year_min = min(d[0] for series in sources.values() for d in series)
            year_max = max(d[0] for series in sources.values() for d in series)

            heur_by_src: dict[str, list[dict]] = {}
            sev_by_src: dict[str, int] = {}
            for src_name in sources:
                hflags, hsev = compute_flags(src_name, sources, variable=var)
                heur_by_src[src_name] = hflags
                sev_by_src[src_name] = hsev + eng_sev.get((iso, var, src_name), 0)

            pair_engine_flags = eng_flags.get((iso, var), [])
            key = f"{iso}_{var}"

            pairs.append({
                "iso3": iso,
                "var": var,
                "sources": list(sources.keys()),
                "n_obs": {s: len(v) for s, v in sources.items()},
                "year_min": year_min,
                "year_max": year_max,
                "engine_flags": pair_engine_flags,
                "heuristic_flags": heur_by_src,
                "sev": sev_by_src,
                # Earliest weekly-snapshot date this pair was flagged; today
                # if it's new this run. Drives the "new in last N weeks" filter.
                "first_seen": first_seen.get(key, today),
            })
            data[f"{iso}_{var}"] = sources

    pairs.sort(key=lambda p: (p["iso3"], p["var"]))
    n_obs = sum(sum(p["n_obs"].values()) for p in pairs)
    print(f"Built {len(pairs)} pairs covering {n_obs:,} observations.")

    out = {"pairs": pairs, "data": data}
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"  {OUT.stat().st_size / 1024 / 1024:.1f} MB written to {OUT}")
    return 0


def compute_flags(focus: str, sources: dict, variable: str = "") -> tuple[list[dict], int]:
    """Heuristic flags for one source within a pair. The focal source is
    compared against every other source. Flag schema (compact JSON keys:
    t=type, y=year, lr=log10 ratio, p=power, n=count):

      {t:"spike", y:1985, lr:-2.0}  -- single-year off >4x vs surroundings
      {t:"lvl10", p:1, n:3}         -- agrees with N>=2 peers that
                                       focal is off by 10^p
      {t:"yoy", n:4}                -- count of large within-source jumps
                                       (skipped for othratios/rates -- the
                                       ratio metric is meaningless when
                                       values cross zero or are << 1)
    """
    flags: list[dict] = []
    series = sources.get(focus) or []
    if len(series) < 3:
        return flags, 0
    m_map = {y: v for y, v in series if v is not None}
    m_years = sorted(m_map.keys())

    for i in range(2, len(m_years) - 2):
        yh = m_years[i]
        if not all(m_years[i + k] == yh + k for k in (-2, -1, 1, 2)):
            continue
        vs = [m_map[m_years[i + k]] for k in (-2, -1, 0, 1, 2)]
        if any(v is None for v in vs) or any(v <= 0 for v in vs):
            continue
        v_2, v_1, vh, v1, v2 = vs
        surr = [v_2, v_1, v1, v2]
        if max(surr) / min(surr) > 2.5:
            continue
        local = math.exp(sum(math.log(x) for x in surr) / 4)
        if local == 0:
            continue
        ratio = vh / local
        try:
            lr = math.log10(abs(ratio))
        except ValueError:
            continue
        if abs(lr) >= 0.6:
            flags.append({"t": "spike", "y": int(yh), "lr": round(lr, 2)})

    # Peer power-of-10 detection: skipped for index variables because
    # different sources rebase to different base years, so peer level
    # ratios are mechanically 10ⁿ without indicating any unit bug.
    # (CPI 2010=100 vs CPI 1960=100 looks like a flat ×10 disagreement
    # even though their growth rates are identical.)
    if variable not in INDEX_VARS:
        peer_meds: dict[str, tuple[float, int]] = {}
        for src, ps in sources.items():
            if src == focus:
                continue
            ratios = []
            for y, v in ps:
                if v is None or v == 0:
                    continue
                mv = m_map.get(y)
                if mv is None or mv == 0 or mv * v <= 0:
                    continue
                ratios.append(mv / v)
            if len(ratios) >= 5:
                ratios.sort()
                peer_meds[src] = (ratios[len(ratios) // 2], len(ratios))
        rounded = []
        for med, _ in peer_meds.values():
            if med <= 0:
                continue
            r = round(math.log10(med))
            if abs(r) >= 1:
                rounded.append(r)
        for power, count in Counter(rounded).items():
            if count >= 2:
                flags.append({"t": "lvl10", "p": power, "n": count})

    # Skip the YoY ratio check for ratios that can be negative (othratios)
    # and rate variables. A current-account deficit going -3 -> +1 would
    # otherwise trigger a "jump" without indicating any data problem;
    # interest/inflation/unemp rates of 1.0 -> 0.1 % do the same.
    if variable not in NO_YOY_RATIO_VARS:
        big_yoy = 0
        for i in range(1, len(m_years)):
            if m_years[i] != m_years[i - 1] + 1:
                continue
            v0, v1 = m_map[m_years[i - 1]], m_map[m_years[i]]
            if v0 is None or v1 is None or v0 == 0 or v0 * v1 < 0:
                continue
            try:
                r = abs(v1 / v0)
            except (ZeroDivisionError, ValueError):
                continue
            if r > 5 or r < 0.2:
                big_yoy += 1
        if big_yoy >= 1:
            flags.append({"t": "yoy", "n": big_yoy})

    severity = 0
    for f in flags:
        if f["t"] == "spike":
            severity += int(round(abs(f["lr"]) * 3))
        elif f["t"] == "lvl10":
            severity += abs(f["p"]) * 4 + f["n"]
        elif f["t"] == "yoy":
            severity += min(f["n"], 5)
    return flags, severity


def _round(x: float) -> float:
    if x == 0 or x != x:
        return float(x)
    try:
        from math import floor, log10
        d = 6 - int(floor(log10(abs(x)))) - 1
        return round(float(x), d)
    except Exception:
        return float(x)


if __name__ == "__main__":
    sys.exit(main())
