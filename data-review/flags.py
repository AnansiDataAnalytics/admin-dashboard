"""
GMD flag engine -- pure Python port of code/error_checking.do +
code/functions/gmd_check.ado.

Reads:
  data/helpers/variables.csv               (the canonical variable list)
  data/distribute/GMD.dta                  (cross-variable checks)
  data/final/chainlinked_<var>.dta         (one per per-variable check)

Emits:
  audit_dashboard/flags.parquet            canonical long-format flag store
  data/helpers/master_check.dta            (only when --emit-master-check-dta;
                                            mirrors error_checking.do's output
                                            shape for parity verification)

Long-format columns:
  ISO3, year, variables, source, reason, value_str, value,
  reason_outlier, reason_corr, reason_discrep, reason_implaus,
  reason_cgovlargergengov, reason_govdef, reason_inflCPIdiscrp,
  reason_GDPaccounting, reason_GDPcompcorr,
  metric_type, CPI_gr, infl

Crisis dummies (BankingCrisis, CurrencyCrisis, SovDebtCrisis) are
excluded -- matches error_checking.do:18.

Thresholds match the .do verbatim so the parity check actually verifies a
port, not a redesign.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent          # outputs live next to the app (data-review/)
# Inputs come from a configurable data root (a GMD/WED checkout's data/ tree).
# Resolution order: DATA_REVIEW_DATA_ROOT env → a gitignored `.data_root` file next
# to this script (local-dev convenience) → parents[1] (an in-repo checkout).
def _resolve_data_root() -> Path:
    env = os.environ.get("DATA_REVIEW_DATA_ROOT")
    if env:
        return Path(env).resolve()
    local = SCRIPT_DIR / ".data_root"
    if local.exists():
        return Path(local.read_text().strip()).resolve()
    return Path(__file__).resolve().parents[1]

DATA_ROOT = _resolve_data_root()
DATA_HELPER = DATA_ROOT / "data" / "helpers"
DATA_FINAL = DATA_ROOT / "data" / "final"
DATA_DISTR = DATA_ROOT / "data" / "distribute"
OUT_PARQUET = SCRIPT_DIR / "flags.parquet"
RAW_PARQUET = SCRIPT_DIR / "flags_raw.parquet"  # pre-suppression cache
OUT_DTA = DATA_HELPER / "master_check.dta"
OUT_MANIFEST = SCRIPT_DIR / "flags_manifest.json"

# ---------------------------------------------------------------------------
# Thresholds (verbatim from error_checking.do:25-28 + gmd_check.ado)
# ---------------------------------------------------------------------------
THRESH_RATIO_LOWER = 0.5
THRESH_RATIO_UPPER = 1.5
THRESH_INFL_CPI_CORR_MIN = 0.3
THRESH_GDPCOMP_CORR_MIN = 0.0
PCTILE_LOW = 0.005
PCTILE_HIGH = 0.995

# Per-variable taxonomy (mirrors error_checking.do:51-61)
POSRATIOS = [
    "inv_GDP", "cons_GDP", "hcons_GDP", "gcons_GDP", "finv_GDP",
    "exports_GDP", "imports_GDP", "govexp_GDP", "govrev_GDP", "govtax_GDP",
    "govdebt_GDP", "cgovexp_GDP", "cgovrev_GDP", "cgovtax_GDP", "cgovdebt_GDP",
    "gen_govexp_GDP", "gen_govrev_GDP", "gen_govtax_GDP", "gen_govdebt_GDP",
]
OTHRATIOS = ["CA_GDP", "govdef_GDP", "cgovdef_GDP", "gen_govdef_GDP"]
LEVELS = [
    "CA", "CA_USD", "cons", "cons_USD", "hcons", "hcons_USD", "gcons", "gcons_USD",
    "exports", "exports_USD", "finv", "finv_USD", "imports", "imports_USD",
    "inv", "inv_USD", "M0", "M1", "M2", "M3", "M4",
    "nGDP", "nGDP_USD", "pop", "rGDP_USD", "USDfx",
    "cgovdebt", "cgovdef", "cgovexp", "cgovrev", "cgovtax",
    "gen_govdebt", "gen_govdef", "gen_govexp", "gen_govrev", "gen_govtax",
    "govrev", "govexp", "govtax",
]
INDICES = ["REER", "HPI", "CPI", "deflator", "rGDP"]
RATES = ["cbrate", "strate", "ltrate", "infl", "unemp"]

CRISIS_VARS = {"BankingCrisis", "SovDebtCrisis", "CurrencyCrisis"}

LABEL = {
    "cgovlargergengov": "General government smaller than central government",
    "govdef": "Government deficit discrepancy (Rev-Exp vs Deficit)",
    "inflCPIdiscrp": "Low correlation between inflation and CPI growth",
    "GDPaccounting": "GDP components (C+I+G+NX) inconsistent with nominal GDP",
    "GDPcompcorr": "GDP component growth weakly or negatively comoves with GDP",
    "lvl10": "Source disagrees with peers by clean integer power of 10",
    "break": "Within-source YoY jump >10x (likely missing currency conversion)",
    "Mordering": "Monetary aggregate ordering violated (M_n > M_{n+1})",
    "realrate": "Implied real rate (strate-infl) outside [-50, 50] pp",
    "share": "Country share of world nGDP_USD off from Wikipedia by >4x",
}

REASON_COLS = [
    "reason_GDPcompcorr", "reason_GDPaccounting", "reason_inflCPIdiscrp",
    "reason_govdef", "reason_cgovlargergengov",
    "reason_outlier", "reason_corr", "reason_discrep", "reason_implaus",
    "reason_lvl10", "reason_break", "reason_Mordering", "reason_realrate",
    "reason_share",
]


# ---------------------------------------------------------------------------
# Stata-equivalent helpers
# ---------------------------------------------------------------------------
def lag_within_country(df: pd.DataFrame, var: str) -> pd.Series:
    """Year-aware lag within ISO3. Stata `L.var` after xtset id year returns
    missing when the prior calendar year row doesn't exist; pandas groupby
    shift(1) only respects row order. We use a calendar-year merge to
    reproduce the missing-on-gap behaviour."""
    cur = df[["ISO3", "year", var]].copy()
    prv = cur.copy()
    prv["year"] = prv["year"] + 1
    prv = prv.rename(columns={var: f"_{var}_lag"})
    merged = cur.merge(prv[["ISO3", "year", f"_{var}_lag"]], on=["ISO3", "year"], how="left")
    return merged[f"_{var}_lag"].values


def growth_rate(df: pd.DataFrame, var: str) -> np.ndarray:
    """(x - L.x) / L.x, year-aware lag."""
    x = df[var].to_numpy(dtype=float)
    xl = lag_within_country(df, var)
    with np.errstate(divide="ignore", invalid="ignore"):
        g = (x - xl) / xl
    g = np.where(np.isfinite(g), g, np.nan)
    return g


def stata_pctile(s: pd.Series, p_low: float = PCTILE_LOW, p_high: float = PCTILE_HIGH) -> tuple[float, float]:
    """Stata _pctile uses linear interpolation between order statistics,
    same as pandas default. Returns (lo, hi) over non-missing values."""
    v = s.dropna().to_numpy()
    if v.size < 2:
        return (np.nan, np.nan)
    return (float(np.quantile(v, p_low)), float(np.quantile(v, p_high)))


def country_corr(df: pd.DataFrame, a: str, b: str) -> pd.Series:
    """bysort id: egen corr = corr(a b). Mirrors SSC egenmore _gcorr.ado
    semantics: marksample touse keeps only rows where BOTH a and b are
    non-missing, so the broadcast result is also missing on rows where
    either input is missing. Result is constant within the non-missing
    subset of each country."""
    out = pd.Series(np.nan, index=df.index, dtype=float)
    a_vals = df[a]
    b_vals = df[b]
    touse_mask = a_vals.notna() & b_vals.notna()
    for iso, sub in df.groupby("ISO3"):
        m = touse_mask.loc[sub.index]
        if m.sum() < 2:
            continue
        c = sub.loc[m, a].corr(sub.loc[m, b])
        out.loc[sub.index[m]] = c
    return out


def empty_master() -> pd.DataFrame:
    """Empty frame matching the master_check.dta column shape so per-section
    results can be appended without alignment drama."""
    return pd.DataFrame(
        columns=[
            "ISO3", "year", "variables", "value", "source", "reason",
            "metric_type", "CPI_gr", "infl",
        ] + REASON_COLS
    )


# ---------------------------------------------------------------------------
# Per-variable checks (gmd_check.ado, called for each chainlinked_<var>.dta)
# ---------------------------------------------------------------------------
def per_variable(var: str, posratios: list[str], othratios: list[str], rates: list[str],
                 levels: list[str], indices: list[str]) -> pd.DataFrame:
    """Reproduces gmd_check on one chainlinked_<var>.dta. Output rows are
    only those with check==1 (matches error_checking.do:120)."""
    path = DATA_FINAL / f"chainlinked_{var}.dta"
    if not path.exists():
        print(f"WARNING: {var} file not found in data/final folder, not checked", file=sys.stderr)
        return empty_master()

    df = pd.read_stata(path, convert_categoricals=False)

    # error_checking.do:107: cap drop if ISO3 == "USA"
    df = df[df["ISO3"] != "USA"].copy()

    # error_checking.do:110: cap ren IMF_WEO_forecast* IMF_WEO_f*
    df = df.rename(columns={c: c.replace("IMF_WEO_forecast", "IMF_WEO_f")
                            for c in df.columns if c.startswith("IMF_WEO_forecast")})

    df = df.sort_values(["ISO3", "year"]).reset_index(drop=True)
    if var not in df.columns:
        print(f"WARNING: {var} missing from chainlinked_{var}.dta -- skipping", file=sys.stderr)
        return empty_master()

    n = len(df)
    reason_outlier = np.zeros(n, dtype=float)
    reason_corr = np.zeros(n, dtype=float)
    reason_discrep = np.zeros(n, dtype=float)
    reason_implaus = np.zeros(n, dtype=float)
    reason_txt = np.full(n, "", dtype=object)
    check_flag = np.zeros(n, dtype=bool)  # mirrors Stata's `check` -- set on any tagged condition

    # Raw source columns: everything except the housekeeping cols + the
    # spliced var itself.
    exclude = {"ISO3", "year", "id", "countryname", "source", "source_change",
               "source_change_count", "check", "chainlinking_ratio", "note", var}
    rawvars = [c for c in df.columns if c not in exclude]

    # ---- Outliers --------------------------------------------------------
    if var == "unemp":
        v = df[var].to_numpy(dtype=float)
        mask = ~np.isnan(v) & ((v < 0) | (v > 60))
        reason_outlier[mask] = 1
        check_flag |= mask
        reason_txt = np.where(mask, np.char.add(reason_txt.astype(str),
                                                 "; Unemployment outside plausible range [0, 60]"),
                              reason_txt)
    elif var in (posratios + othratios + rates):
        lo, hi = stata_pctile(df[var])
        v = df[var].to_numpy(dtype=float)
        mask = ~np.isnan(v) & ((v < lo) | (v > hi))
        reason_outlier[mask] = 1
        check_flag |= mask
        reason_txt = np.where(mask, np.char.add(reason_txt.astype(str),
                                                 "; Data is in top or bottom 0.5%, flagged out of caution"),
                              reason_txt)

    if var in (levels + indices):
        g = growth_rate(df, var)
        lo, hi = stata_pctile(pd.Series(g))
        # gmd_check.ado:80-82 has an oddity: r(r1)/r(r2) are growth-rate
        # percentiles, but line 82 compares the LEVEL value against those
        # same bounds (`name < r(r1) | name > r(r2)`). For index/level
        # series the level is typically >> r(r2), so reason_outlier=1
        # ends up set on essentially every non-missing row -- but only
        # the rows where the GROWTH is in-tail get check=1, so only
        # those survive `keep if check==1`. Reproduce verbatim.
        v = df[var].to_numpy(dtype=float)
        gmask = ~np.isnan(g) & ((g < lo) | (g > hi))
        vmask = ~np.isnan(v) & ((v < lo) | (v > hi))
        check_flag |= gmask
        reason_txt = np.where(gmask, np.char.add(reason_txt.astype(str),
                                                  "; Growth rate is in top or bottom 0.5%, flagged out of caution"),
                              reason_txt)
        reason_outlier[vmask] = 1

    # ---- Discrepancy (posratios/othratios/rates/levels, not indices) ----
    if var in (posratios + othratios + rates + levels):
        is_rate = var in rates
        v = df[var].to_numpy(dtype=float)
        near_zero = is_rate & (np.abs(v) < 2)
        for raw in rawvars:
            r = df[raw].to_numpy(dtype=float)
            with np.errstate(divide="ignore", invalid="ignore"):
                ratio = r / v
            ratio = np.where(np.isfinite(ratio), ratio, np.nan)
            mask = ~np.isnan(ratio) & ((np.abs(ratio) > 5) | (np.abs(ratio) < 0.1)) & ~near_zero
            comp = raw.replace(f"_{var}", "")
            reason_discrep[mask] = 1
            check_flag |= mask
            reason_txt = np.where(mask, np.char.add(reason_txt.astype(str),
                                                     f"; +500%/-90% discrepancy between GMD and {comp}"),
                                  reason_txt)

    # ---- Correlation check (all source columns) -------------------------
    corr_thresh = 0.0 if var in ("pop", "unemp") else 0.3
    for raw in rawvars:
        if raw not in df.columns:
            continue
        c = country_corr(df, var, raw).to_numpy(dtype=float)
        mask = ~np.isnan(c) & (c < corr_thresh)
        comp = raw.replace(f"_{var}", "")
        reason_corr[mask] = 1
        check_flag |= mask
        reason_txt = np.where(mask, np.char.add(reason_txt.astype(str),
                                                 f"; <{corr_thresh} correlation between GMD and {comp}"),
                              reason_txt)

    # ---- Implausible ratio values ---------------------------------------
    if var in posratios:
        v = df[var].to_numpy(dtype=float)
        mask = ~np.isnan(v) & ((v > 300) | (v < 0.1))
        reason_implaus[mask] = 1
        check_flag |= mask
        reason_txt = np.where(mask, np.char.add(reason_txt.astype(str),
                                                 "; Ratio is above 300% or below 0.1%"),
                              reason_txt)
    elif var in othratios:
        v = df[var].to_numpy(dtype=float)
        mask = ~np.isnan(v) & ((v > 50) | (v < -50))
        reason_implaus[mask] = 1
        check_flag |= mask
        reason_txt = np.where(mask, np.char.add(reason_txt.astype(str),
                                                 "; Ratio is above 50% or below -50%"),
                              reason_txt)

    check = check_flag
    out = pd.DataFrame({
        "ISO3": df["ISO3"].values,
        "year": df["year"].values,
        "variables": var,
        "value": df[var].values,
        "source": df["source"].values if "source" in df.columns else "",
        "reason": [r[2:] if r.startswith("; ") else r for r in reason_txt],
        "metric_type": "per_variable",
        "reason_outlier": reason_outlier,
        "reason_corr": reason_corr,
        "reason_discrep": reason_discrep,
        "reason_implaus": reason_implaus,
    })
    return out[check].copy()


# ---------------------------------------------------------------------------
# Cross-variable checks (run on data/distribute/GMD.dta)
# ---------------------------------------------------------------------------
def check_gen_vs_central_gov(gmd: pd.DataFrame) -> pd.DataFrame:
    """error_checking.do:137-171. ratio = gen_X / cX < 1 is impossible."""
    rows = []
    for var in ["govtax", "govdebt", "govrev", "govexp"]:
        gen_col, c_col = f"gen_{var}", f"c{var}"
        if gen_col not in gmd.columns or c_col not in gmd.columns:
            continue
        with np.errstate(divide="ignore", invalid="ignore"):
            value = gmd[gen_col].values / gmd[c_col].values
        value = np.where(np.isfinite(value), value, np.nan)
        mask = ~np.isnan(value) & (value < 1)
        sub = gmd[mask].copy()
        sub["value"] = value[mask]
        sub["variables"] = var
        sub["reason"] = "; " + LABEL["cgovlargergengov"]
        sub["reason"] = sub["reason"].str[2:]  # trim leading "; "
        sub["reason_cgovlargergengov"] = 1.0
        sub["metric_type"] = "ratio_gengov_cgov"
        rows.append(sub[["ISO3", "year", "variables", "value", "reason",
                         "metric_type", "reason_cgovlargergengov"]])
    if not rows:
        return empty_master()
    return pd.concat(rows, ignore_index=True)


def check_deficit_identity(gmd: pd.DataFrame) -> pd.DataFrame:
    """error_checking.do:184-229. Deficit / (Rev - Exp) in [-1.5, -0.5] U [0.5, 1.5]."""
    rows = []
    for prefix, level in [("", "Combined"), ("c", "Central"), ("gen_", "General")]:
        defvar = f"{prefix}govdef"
        revvar = f"{prefix}govrev"
        expvar = f"{prefix}govexp"
        if not all(c in gmd.columns for c in (defvar, revvar, expvar)):
            continue
        denom = gmd[revvar].values - gmd[expvar].values
        with np.errstate(divide="ignore", invalid="ignore"):
            value = gmd[defvar].values / denom
        value = np.where(np.isfinite(value), value, np.nan)
        mask = ~np.isnan(value) & (
            (value < 0) | (np.abs(value) > THRESH_RATIO_UPPER) | (np.abs(value) < THRESH_RATIO_LOWER)
        )
        sub = gmd[mask].copy()
        sub["value"] = value[mask]
        sub["variables"] = defvar
        sub["reason"] = f"{level} {LABEL['govdef']}"
        sub["reason_govdef"] = 1.0
        sub["metric_type"] = "ratio_deficit_identity"
        rows.append(sub[["ISO3", "year", "variables", "value", "reason",
                         "metric_type", "reason_govdef"]])
    if not rows:
        return empty_master()
    return pd.concat(rows, ignore_index=True)


def check_cpi_infl_correlation(gmd: pd.DataFrame) -> pd.DataFrame:
    """error_checking.do:237-275. Country-specific corr(CPI_gr, infl) < 0.3."""
    g = gmd.sort_values(["ISO3", "year"]).reset_index(drop=True).copy()
    g["CPI_lag"] = lag_within_country(g, "CPI")
    with np.errstate(divide="ignore", invalid="ignore"):
        g["CPI_gr"] = (g["CPI"].values - g["CPI_lag"].values) / g["CPI_lag"].values
    g["CPI_gr"] = g["CPI_gr"].replace([np.inf, -np.inf], np.nan)
    g["value"] = country_corr(g, "CPI_gr", "infl")

    mask = g["value"].notna() & (g["value"] < THRESH_INFL_CPI_CORR_MIN)
    sub = g[mask].copy()
    sub["variables"] = "CPI and inflation rate consistency"
    sub["reason"] = (
        f"< {THRESH_INFL_CPI_CORR_MIN:.2f} correlation between inflation and CPI growth"
    )
    sub["reason_inflCPIdiscrp"] = 1.0
    sub["metric_type"] = "corr_infl_cpi"
    return sub[["ISO3", "year", "variables", "value", "reason", "metric_type",
                "reason_inflCPIdiscrp", "CPI_gr", "infl"]]


def check_gdp_accounting_identity(gmd: pd.DataFrame) -> pd.DataFrame:
    """error_checking.do:286-329. (cons+inv+govexp+exports-imports)/nGDP outside band."""
    g = gmd.copy()
    inv = g["inv"].copy()
    inv = inv.where(inv.notna(), g["finv"])
    s = g["cons"].values + inv.values + g["govexp"].values + (g["exports"].values - g["imports"].values)
    with np.errstate(divide="ignore", invalid="ignore"):
        value = s / g["nGDP"].values
    value = np.where(np.isfinite(value), value, np.nan)
    mask = ~np.isnan(value) & (
        (value < 0) | (np.abs(value) > THRESH_RATIO_UPPER) | (np.abs(value) < THRESH_RATIO_LOWER)
    )
    sub = g[mask].copy()
    sub["value"] = value[mask]
    sub["variables"] = "GDP components (accounting identities)"
    sub["reason"] = LABEL["GDPaccounting"]
    sub["reason_GDPaccounting"] = 1.0
    sub["metric_type"] = "ratio_GDP_components_to_nGDP"
    return sub[["ISO3", "year", "variables", "value", "reason",
                "metric_type", "reason_GDPaccounting"]]


def check_gdp_component_comovement(gmd: pd.DataFrame) -> pd.DataFrame:
    """error_checking.do:336-400. Min country-corr(nGDP growth, component growth) < 0."""
    g = gmd.sort_values(["ISO3", "year"]).reset_index(drop=True).copy()
    g["inv"] = g["inv"].where(g["inv"].notna(), g["finv"])
    g["nGDP_gr"] = growth_rate(g, "nGDP")
    components = ["exports", "imports", "govexp", "inv", "cons"]
    corr_cols = []
    for v in components:
        g[f"{v}_gr"] = growth_rate(g, v)
        col = f"corr_{v}"
        g[col] = country_corr(g, "nGDP_gr", f"{v}_gr")
        corr_cols.append(col)

    g["min_corr"] = g[corr_cols].min(axis=1)
    has_min = g["min_corr"].notna()
    worst = pd.Series("", index=g.index, dtype=object)
    if has_min.any():
        worst.loc[has_min] = (
            g.loc[has_min, corr_cols].idxmin(axis=1).str.replace("corr_", "", regex=False)
        )
    g["worst_var"] = worst

    mask = g["min_corr"].notna() & (g["min_corr"] < THRESH_GDPCOMP_CORR_MIN)
    sub = g[mask].copy()
    sub["value"] = sub["min_corr"]
    sub["variables"] = "GDP components (comovement)"
    sub["reason"] = (
        LABEL["GDPcompcorr"] + " (corr = " + sub["min_corr"].map(lambda x: f"{x:9.2f}".strip())
        + ", var = " + sub["worst_var"] + ")"
    )
    # The Stata format string is "%9.2f" which right-justifies in width 9; the
    # human-facing reason text uses the stripped form.
    sub["reason_GDPcompcorr"] = 1.0
    sub["metric_type"] = "min_corr_GDP_component"
    return sub[["ISO3", "year", "variables", "value", "reason",
                "metric_type", "reason_GDPcompcorr"]]


# ---------------------------------------------------------------------------
# New checks (additive to the Stata-ported ones above)
# ---------------------------------------------------------------------------
LVL10_MIN_PEERS = 2          # how many peers must agree on the same power
LVL10_MIN_OVERLAP = 5        # minimum overlapping years per peer comparison
BREAK_RATIO_THRESHOLD = 10.0 # within-source YoY jump considered a break
BREAK_INFL_HYPER = 100.0     # suppress break flag if abs(infl) > this in same year
REALRATE_BAND_PP = 50.0
COUNTRY_SHARE_BAND = 4.0     # for years <= 30 years before snapshot
COUNTRY_SHARE_BAND_OLD = 10.0
COUNTRY_SHARE_WINDOW = 30    # years


def check_lvl10(var: str) -> pd.DataFrame:
    """Per (ISO3, source), flag when the median ratio against >=N peers
    rounds to a clean non-zero integer power of 10. Catches decimal-place
    bugs that the Stata pipeline misses (it has no peer-comparison check
    at all).

    Skipped entirely for index variables (REER, HPI, CPI, deflator, rGDP):
    different sources rebase to different base years, so peer ratios are
    mechanically a power of 10 (or any other factor) without indicating
    any real disagreement. Growth-rate checks (the per-source corr check
    + the dashboard's YoY heuristic) keep firing for those variables."""
    if var in INDICES:
        return empty_master()
    path = DATA_FINAL / f"chainlinked_{var}.dta"
    if not path.exists():
        return empty_master()
    df = pd.read_stata(path, convert_categoricals=False)
    df = df[df["ISO3"] != "USA"]
    src_cols = [c for c in df.columns if c.endswith(f"_{var}") and c != var]
    if len(src_cols) < LVL10_MIN_PEERS + 1:
        return empty_master()
    # Treat the spliced GMD series (bare `var` column) as another focal series
    # + peer, so a unit/decimal error in the harmonized OUTPUT surfaces too.
    series_cols = src_cols + ([var] if var in df.columns else [])
    label_of = {c: ("GMD" if c == var else c[: -len(f"_{var}")]) for c in series_cols}

    rows = []
    for iso, grp in df.groupby("ISO3"):
        present = [c for c in series_cols if grp[c].notna().any()]
        if len(present) < LVL10_MIN_PEERS + 1:
            continue
        for focal in present:
            powers = []
            for peer in present:
                if peer == focal:
                    continue
                pair = grp[[focal, peer]].dropna()
                if len(pair) < LVL10_MIN_OVERLAP:
                    continue
                # opposite-sign year-pairs would corrupt the ratio
                pair = pair[pair[focal] * pair[peer] > 0]
                if len(pair) < LVL10_MIN_OVERLAP:
                    continue
                ratio_med = (pair[focal] / pair[peer]).median()
                if ratio_med <= 0:
                    continue
                p = round(math.log10(abs(ratio_med)))
                if abs(p) >= 1:
                    powers.append(p)
            if not powers:
                continue
            from collections import Counter as _Counter
            mode_p, n = _Counter(powers).most_common(1)[0]
            if n < LVL10_MIN_PEERS:
                continue
            source = label_of[focal]
            rows.append({
                "ISO3": str(iso),
                "year": np.nan,
                "variables": var,
                "value": float(10 ** mode_p),
                "source": source,
                "reason": f"{LABEL['lvl10']} (10^{mode_p:+d} vs {n} peers)",
                "metric_type": "peer_lvl10",
                "reason_lvl10": 1.0,
            })
    if not rows:
        return empty_master()
    return pd.DataFrame(rows)


def check_structural_break(var: str, gmd_infl: pd.DataFrame | None) -> pd.DataFrame:
    """Per (ISO3, year, source), within each source's series flag a
    >10x YoY jump unless `infl` in that year exceeds BREAK_INFL_HYPER
    (real hyperinflation). The vetting ledger is meant to mark legitimate
    redenomination years; this check fires on every break it sees.

    Skipped entirely for othratios (CA_GDP, govdef_GDP, etc.) and rates
    (cbrate, infl, ...): a deficit going from -3% to +1% has an undefined
    ratio, and rates often move 1.0% -> 0.1% legitimately."""
    if var in OTHRATIOS or var in RATES:
        return empty_master()
    path = DATA_FINAL / f"chainlinked_{var}.dta"
    if not path.exists():
        return empty_master()
    df = pd.read_stata(path, columns=None, convert_categoricals=False)
    df = df[df["ISO3"] != "USA"].sort_values(["ISO3", "year"]).reset_index(drop=True)
    src_cols = [c for c in df.columns if c.endswith(f"_{var}") and c != var]
    if not src_cols:
        return empty_master()
    # Also break-check the spliced GMD series itself (a >10x jump in the
    # harmonized output is a splice discontinuity worth surfacing).
    if var in df.columns:
        src_cols = src_cols + [var]

    # build a (ISO3, year) -> infl lookup once
    infl_lookup: dict[tuple[str, int], float] = {}
    if gmd_infl is not None and "infl" in gmd_infl.columns:
        for r in gmd_infl[["ISO3", "year", "infl"]].itertuples(index=False):
            if pd.notna(r.infl):
                infl_lookup[(r.ISO3, int(r.year))] = float(r.infl)

    rows = []
    for sc in src_cols:
        source = "GMD" if sc == var else sc[: -len(f"_{var}")]
        # narrow to rows with data in this source
        sub = df[["ISO3", "year", sc]].dropna(subset=[sc])
        if sub.empty:
            continue
        sub = sub.copy()
        sub["lag"] = lag_within_country(sub.rename(columns={sc: "_v"}), "_v") if False else None
        # cheaper: shift within country for same source presence
        sub["_v"] = sub[sc]
        sub = sub.sort_values(["ISO3", "year"]).reset_index(drop=True)
        prev = sub.copy()
        prev["year"] = prev["year"] + 1
        prev = prev.rename(columns={"_v": "_v_prev"})
        merged = sub.merge(prev[["ISO3", "year", "_v_prev"]], on=["ISO3", "year"], how="left")
        with np.errstate(divide="ignore", invalid="ignore"):
            ratio = merged["_v"].values / merged["_v_prev"].values
        ratio = np.where(np.isfinite(ratio), ratio, np.nan)
        mask = (
            ~np.isnan(ratio)
            & (merged["_v"].values * merged["_v_prev"].values > 0)
            & ((np.abs(ratio) > BREAK_RATIO_THRESHOLD)
               | (np.abs(ratio) < 1.0 / BREAK_RATIO_THRESHOLD))
        )
        for ix in np.flatnonzero(mask):
            iso = str(merged.at[ix, "ISO3"])
            yr = int(merged.at[ix, "year"])
            il = infl_lookup.get((iso, yr))
            if il is not None and abs(il) > BREAK_INFL_HYPER:
                continue  # real hyperinflation; suppress
            rows.append({
                "ISO3": iso,
                "year": yr,
                "variables": var,
                "value": float(ratio[ix]),
                "source": source,
                "reason": f"{LABEL['break']} ({source} year-on-year ratio = {ratio[ix]:.2g})",
                "metric_type": "within_source_break",
                "reason_break": 1.0,
            })
    if not rows:
        return empty_master()
    return pd.DataFrame(rows)


def check_m_ordering(gmd: pd.DataFrame) -> pd.DataFrame:
    """M0 <= M1 <= M2 <= M3 <= M4 at every (ISO3, year) where adjacent
    pairs are both non-missing. Violations are usually unit drift between
    sources contributing to neighboring aggregates."""
    rows = []
    for lo, hi in [("M0", "M1"), ("M1", "M2"), ("M2", "M3"), ("M3", "M4")]:
        if lo not in gmd.columns or hi not in gmd.columns:
            continue
        pair = gmd[["ISO3", "year", lo, hi]].dropna()
        bad = pair[pair[lo] > pair[hi]]
        if bad.empty:
            continue
        sub = bad.copy()
        sub["variables"] = f"{lo} vs {hi}"
        sub["value"] = (sub[lo] / sub[hi]).values
        sub["reason"] = LABEL["Mordering"] + f" ({lo} > {hi})"
        sub["reason_Mordering"] = 1.0
        sub["metric_type"] = "monetary_ordering"
        rows.append(sub[["ISO3", "year", "variables", "value", "reason",
                         "metric_type", "reason_Mordering"]])
    if not rows:
        return empty_master()
    return pd.concat(rows, ignore_index=True)


def check_real_rate(gmd: pd.DataFrame) -> pd.DataFrame:
    """strate - infl outside [-50, 50] pp. Either the rate or inflation
    is off by a power of 10. Also surface ltrate if available."""
    rows = []
    for rate_var in ["strate", "ltrate"]:
        if rate_var not in gmd.columns or "infl" not in gmd.columns:
            continue
        pair = gmd[["ISO3", "year", rate_var, "infl"]].dropna()
        rr = (pair[rate_var] - pair["infl"]).values
        mask = np.abs(rr) > REALRATE_BAND_PP
        if not mask.any():
            continue
        sub = pair[mask].copy()
        sub["value"] = rr[mask]
        sub["variables"] = f"{rate_var} - infl"
        sub["reason"] = LABEL["realrate"] + f" ({rate_var} - infl = {{:.1f}} pp)"
        sub["reason"] = [LABEL["realrate"] + f" ({rate_var} - infl = {v:.1f} pp)" for v in rr[mask]]
        sub["reason_realrate"] = 1.0
        sub["metric_type"] = "real_rate_band"
        rows.append(sub[["ISO3", "year", "variables", "value", "reason",
                         "metric_type", "reason_realrate"]])
    if not rows:
        return empty_master()
    return pd.concat(rows, ignore_index=True)


def check_country_share(gmd: pd.DataFrame) -> pd.DataFrame:
    """Country's share of world nGDP_USD vs the Wikipedia snapshot.

    Wide band (4x) for years within COUNTRY_SHARE_WINDOW of the snapshot;
    relaxed (10x) for older years. The wide band is intentional -- China,
    India, and various petro-exporters have changed share meaningfully in
    30 years; we only want to catch order-of-magnitude bugs."""
    if "nGDP_USD" not in gmd.columns:
        return empty_master()
    shares_path = DATA_HELPER / "country_gdp_shares.csv"
    if not shares_path.exists():
        return empty_master()
    wiki = pd.read_csv(shares_path)
    if wiki.empty:
        return empty_master()
    snapshot_year = int(wiki["snapshot_year"].max())
    wiki_share = dict(zip(wiki["ISO3"], wiki["share_pct"]))

    g = gmd[["ISO3", "year", "nGDP_USD"]].dropna()
    g = g[(g["year"] >= 1900) & (g["year"] <= snapshot_year)]
    if g.empty:
        return empty_master()
    world = g.groupby("year")["nGDP_USD"].sum()
    g = g.merge(world.rename("world").reset_index(), on="year", how="left")
    g["share_pct"] = g["nGDP_USD"] / g["world"] * 100.0
    g["wiki_share"] = g["ISO3"].map(wiki_share)
    g = g[g["wiki_share"].notna()]
    g["band"] = np.where(g["year"] >= snapshot_year - COUNTRY_SHARE_WINDOW,
                         COUNTRY_SHARE_BAND, COUNTRY_SHARE_BAND_OLD)
    g["rel"] = g["share_pct"] / g["wiki_share"]
    mask = (g["rel"] > g["band"]) | (g["rel"] < 1.0 / g["band"])
    sub = g[mask].copy()
    sub["value"] = sub["rel"]
    sub["variables"] = "nGDP_USD share of world"
    sub["reason"] = [
        LABEL["share"] + f" (share={s:.4f}%, wiki={w:.4f}%, ratio={r:.2g}, band={b:.0f}x)"
        for s, w, r, b in zip(sub["share_pct"], sub["wiki_share"], sub["rel"], sub["band"])
    ]
    sub["reason_share"] = 1.0
    sub["metric_type"] = "country_share_world"
    return sub[["ISO3", "year", "variables", "value", "reason",
                "metric_type", "reason_share"]]


# ---------------------------------------------------------------------------
# Suppression -- consult the vetting ledger and drop flagged cells that
# carry an active vetted-correct / known-limitation / pending-fix record.
# ---------------------------------------------------------------------------
def _value_matches(row_value, recorded) -> bool:
    """True if a flagged cell's current value still matches the value that was
    recorded when the flag was vetted. recorded=None means a legacy/blanket
    vetting that carried no value -> always matches (suppress regardless).
    A revised value (NaN or beyond a tight relative tolerance) does NOT match,
    so the flag re-surfaces for re-review."""
    if recorded is None:
        return True
    if pd.isna(row_value):
        return False
    return abs(row_value - recorded) <= 1e-9 + 1e-6 * max(abs(row_value), abs(recorded))


def _suppress_vetted(master: pd.DataFrame, active: list[dict] | None = None) -> pd.DataFrame:
    """Drop matching flag rows. Granular: a vetting with reason_type='all'
    clears every reason_* on the row; a vetting with reason_type='outlier'
    clears only reason_outlier. Rows where every reason_* is now NaN are
    dropped entirely. Suppression is logged to stderr per (variable, status).

    Value-keyed: a vetting that recorded the flagged cell's value only
    suppresses while the current value still matches; if the value was
    revised, the flag re-surfaces (the prior approval no longer covers it).
    """
    if active is None:
        try:
            from . import ledger  # type: ignore
        except (ImportError, ValueError):
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "_ledger_local", Path(__file__).resolve().parent / "ledger.py")
            ledger = importlib.util.module_from_spec(spec)  # type: ignore
            spec.loader.exec_module(ledger)  # type: ignore
        active = ledger.active_vettings()
    if not active:
        print("Suppression: no active vetting records -- nothing dropped.")
        return master

    # Don't mutate the caller's frame: we clear reason cells in place below,
    # and callers pass the raw cache (or injected test data) they may reuse.
    master = master.copy()

    # Index vettings by (iso3, variable) for cheap lookup.
    from collections import defaultdict
    by_pair: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for v in active:
        by_pair[(v["iso3"], v["variable"])].append(v)

    suppressed_count = 0
    resurfaced_count = 0
    cleared_pairs = set()
    iso3s = master["ISO3"].astype(str).values
    variables = master["variables"].astype(str).values
    years = master["year"].values
    values = master["value"].values if "value" in master.columns else [float("nan")] * len(master)
    sources = master["source"].astype(str).values if "source" in master.columns else [""] * len(master)

    for i in range(len(master)):
        candidates = by_pair.get((iso3s[i], variables[i]))
        if not candidates:
            continue
        yr = None if pd.isna(years[i]) else int(years[i])
        src = sources[i] if sources[i] and sources[i] != "nan" else None
        for v in candidates:
            if v["year"] is not None and v["year"] != yr:
                continue
            if v["source"] is not None and v["source"] != src:
                continue
            if not _value_matches(values[i], v.get("value")):
                # Value moved since this flag was approved -> re-surface it.
                resurfaced_count += 1
                continue
            if v["reason_type"] == "all":
                # clear every reason
                for c in REASON_COLS:
                    if c in master.columns:
                        master.iat[i, master.columns.get_loc(c)] = np.nan
                suppressed_count += 1
                cleared_pairs.add((iso3s[i], variables[i], v["status"]))
            else:
                col = f"reason_{v['reason_type']}"
                if col in master.columns:
                    master.iat[i, master.columns.get_loc(col)] = np.nan
                    suppressed_count += 1
                    cleared_pairs.add((iso3s[i], variables[i], v["status"]))

    # Drop rows where every reason_* is now NaN
    reason_mask = master[REASON_COLS].notna().any(axis=1)
    n_dropped = (~reason_mask).sum()
    master = master[reason_mask].copy()
    print(f"Suppression: {len(active)} active records cleared "
          f"{suppressed_count} reason-flags across {len(cleared_pairs)} "
          f"distinct (iso3, var, status) groups; {n_dropped} rows fully "
          f"vetted-out; {resurfaced_count} re-surfaced (value changed since "
          f"approval).")
    return master


# ---------------------------------------------------------------------------
# Top-level driver
# ---------------------------------------------------------------------------
def load_var_list() -> list[str]:
    v = pd.read_csv(DATA_HELPER / "variables.csv")
    mask = (v["finalvarlist"] == "Yes") & (v["derived"] != "Yes")
    v = v[mask]
    v = v[v["codes"] != "rGDP_USD"]
    v = v[~v["codes"].isin(CRISIS_VARS)]
    return sorted(v["codes"].tolist())


def categorize_check(vars_: list[str]) -> None:
    """Mirror error_checking.do:67-88 -- every variable must be in exactly one
    of {posratios, othratios, levels, rates, indices}."""
    all_cat = set(POSRATIOS + OTHRATIOS + LEVELS + RATES + INDICES)
    missing = [v for v in vars_ if v not in all_cat]
    if missing:
        print(f"ERROR: variables present in variables.csv but uncategorised: {missing}",
              file=sys.stderr)
        sys.exit(9)


def build_all() -> pd.DataFrame:
    vars_ = load_var_list()
    categorize_check(vars_)
    print(f"Checking {len(vars_)} variables: {vars_}")

    pieces = []
    for var in vars_:
        print(f"  Checking {var}")
        pieces.append(per_variable(var, POSRATIOS, OTHRATIOS, RATES, LEVELS, INDICES))

    # ----- Cross-variable checks (read GMD.dta once) -----
    gmd_cols = list({
        "ISO3", "id", "year",
        "CPI", "infl", "deflator", "rGDP", "USDfx",
        "exports", "imports", "govexp", "inv", "finv", "cons", "nGDP", "nGDP_USD",
        "govtax", "govdebt", "govrev", "govexp",
        "cgovtax", "cgovdebt", "cgovrev", "cgovexp",
        "gen_govtax", "gen_govdebt", "gen_govrev", "gen_govexp",
        "govdef", "cgovdef", "gen_govdef",
        "M0", "M1", "M2", "M3", "M4",
        "strate", "ltrate",
    })
    gmd = pd.read_stata(DATA_DISTR / "GMD.dta", columns=gmd_cols, convert_categoricals=False)

    print("Checking gen-vs-central gov ratio")
    pieces.append(check_gen_vs_central_gov(gmd))
    print("Checking deficit identity")
    pieces.append(check_deficit_identity(gmd))
    print("Checking CPI / infl correlation")
    pieces.append(check_cpi_infl_correlation(gmd))
    print("Checking GDP accounting identity")
    pieces.append(check_gdp_accounting_identity(gmd))
    print("Checking GDP component comovement")
    pieces.append(check_gdp_component_comovement(gmd))

    # ----- New checks (additive; each has its own reason_* column) -----
    print("Checking peer lvl10 (decimal-place bug)")
    for var in vars_:
        pieces.append(check_lvl10(var))
    print("Checking within-source structural breaks")
    for var in vars_:
        pieces.append(check_structural_break(var, gmd))
    print("Checking M0<=M1<=M2<=M3<=M4 ordering")
    pieces.append(check_m_ordering(gmd))
    print("Checking real-rate plausibility")
    pieces.append(check_real_rate(gmd))
    print("Checking country share of world nGDP_USD")
    pieces.append(check_country_share(gmd))

    master = pd.concat(pieces, ignore_index=True, sort=False)

    # Fill missing reason_* columns with NaN to match Stata's `gen reason_X = 0`
    # then-keep semantics (post-keep, untriggered flags appear as NaN per
    # baseline master_check.dta).
    for c in REASON_COLS:
        if c not in master.columns:
            master[c] = np.nan
        master[c] = master[c].replace(0.0, np.nan)

    master["value_str"] = master["value"].map(lambda x: "" if pd.isna(x) else f"{x:9.2f}".strip())

    for c in ("source", "CPI_gr", "infl"):
        if c not in master.columns:
            master[c] = np.nan
    return master[
        ["ISO3", "year", "variables", "source", "reason", "value_str", "value"]
        + REASON_COLS + ["metric_type", "CPI_gr", "infl"]
    ]


SNAPSHOT_DIR = SCRIPT_DIR / "snapshots"
SNAPSHOT_MIN_DAYS = 6     # don't snapshot more often than ~weekly
SNAPSHOT_KEEP = 16        # prune older than the last N snapshots


def _write_weekly_snapshot(master: pd.DataFrame) -> None:
    """Save a dated snapshot of the flag set (ISO3, variables, reason
    columns only -- the minimum needed to compute first-seen dates) so
    build_data.py can show 'new this week'. Throttled to ~weekly and
    pruned to the last SNAPSHOT_KEEP files. Snapshots are gitignored."""
    import datetime as _dt
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    existing = sorted(SNAPSHOT_DIR.glob("flags_*.parquet"))
    today = _dt.date.today()
    if existing:
        try:
            last = existing[-1].stem.replace("flags_", "")
            last_date = _dt.date.fromisoformat(last)
            if (today - last_date).days < SNAPSHOT_MIN_DAYS:
                print(f"Snapshot skipped (last one {last_date}, < {SNAPSHOT_MIN_DAYS} days ago)")
                return
        except Exception:
            pass
    cols = ["ISO3", "variables"] + [c for c in REASON_COLS if c in master.columns]
    snap = master[cols].copy()
    dest = SNAPSHOT_DIR / f"flags_{today.isoformat()}.parquet"
    snap.to_parquet(dest, index=False)
    print(f"Wrote weekly snapshot {dest}")
    # Prune
    for old in sorted(SNAPSHOT_DIR.glob("flags_*.parquet"))[:-SNAPSHOT_KEEP]:
        try:
            old.unlink()
        except Exception:
            pass


def _fingerprint(p: Path) -> dict | None:
    """Cheap, parse-free signature of an input file: size + nanosecond mtime.
    None if the file is absent (so a later appearance reads as a change)."""
    try:
        st = p.stat()
    except FileNotFoundError:
        return None
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns}


def write_manifest(vars_: list[str]) -> None:
    """Record a fingerprint of every input flags.py consumed, so the dashboard
    can tell whether flags.parquet is stale by stat()-ing these paths -- no
    pandas, no .dta parsing. Keys are repo-relative for portability. flags.py's
    own source is hashed (not stat'd) so a git checkout that preserves content
    doesn't read as a spurious change."""
    inputs = [
        DATA_HELPER / "variables.csv",
        DATA_HELPER / "country_gdp_shares.csv",
        DATA_DISTR / "GMD.dta",
    ] + [DATA_FINAL / f"chainlinked_{v}.dta" for v in vars_]
    manifest = {
        "generated_at": _dt.datetime.now().isoformat(timespec="seconds"),
        "engine_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "inputs": {str(p.relative_to(DATA_ROOT)): _fingerprint(p) for p in inputs},
    }
    OUT_MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True))
    print(f"Wrote {OUT_MANIFEST}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit-master-check-dta", action="store_true",
                    help="also write data/helpers/master_check.dta for parity verification")
    ap.add_argument("--out-dta", default=None, help="override path for master_check.dta")
    ap.add_argument("--resuppress-only", action="store_true",
                    help="skip the slow recompute: reload the cached raw flag "
                         "set and just re-apply vetting suppression. Use after "
                         "ledger (approval/revoke) changes when the data is "
                         "unchanged.")
    args = ap.parse_args()

    if args.resuppress_only:
        if not RAW_PARQUET.exists():
            print(f"No raw cache at {RAW_PARQUET} -- run a full pass first.",
                  file=sys.stderr)
            return 1
        raw = pd.read_parquet(RAW_PARQUET)
        print(f"Loaded {len(raw):,} raw flag rows from {RAW_PARQUET}")
    else:
        raw = build_all()
        RAW_PARQUET.parent.mkdir(parents=True, exist_ok=True)
        raw.to_parquet(RAW_PARQUET, index=False)
        print(f"Wrote {RAW_PARQUET} ({len(raw):,} pre-suppression rows)")

    master = _suppress_vetted(raw)
    print(f"\nTotal flag rows: {len(master):,}")
    for c in REASON_COLS:
        n = int((master[c] == 1).sum())
        print(f"  {c:>30s}: {n:>7,}")

    OUT_PARQUET.parent.mkdir(parents=True, exist_ok=True)
    master.to_parquet(OUT_PARQUET, index=False)
    print(f"Wrote {OUT_PARQUET}")
    # The weekly snapshot + input manifest describe the full recompute; a
    # resuppress-only pass doesn't touch inputs, so skip them.
    if not args.resuppress_only:
        _write_weekly_snapshot(master)
        write_manifest(load_var_list())

    if args.emit_master_check_dta:
        dest = Path(args.out_dta) if args.out_dta else OUT_DTA
        # Stata file format requires sane types; coerce strL-style cols.
        m = master.copy()
        m["year"] = m["year"].astype(float)
        m["value"] = m["value"].astype(float)
        for c in REASON_COLS:
            m[c] = m[c].astype(float)
        for c in ["ISO3", "variables", "source", "reason", "value_str", "metric_type"]:
            m[c] = m[c].fillna("").astype(str)
        m.to_stata(dest, write_index=False, version=118)
        print(f"Wrote {dest}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
