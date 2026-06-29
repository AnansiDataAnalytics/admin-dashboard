#!/usr/bin/env python3
"""Sync the review inputs from S3 into a local scratch data root, laid out as
data/final/, data/distribute/, data/helpers/ so build_data.py / flags.py can run
against it via DATA_REVIEW_DATA_ROOT=<scratch>.

The three inputs are configured independently (so they can live in different
buckets/prefixes); for the "same location" case just point --gmd-uri inside the
chainlinked dir. Only what the build needs is pulled -- chainlinked_*.dta,
GMD.dta, and the two helper CSVs -- NOT the large unused helpers (data_log.dta,
shapefiles, ...).

Usage:
  python fetch_inputs.py \
      --chainlinked-uri s3://bucket/final/ \
      --gmd-uri         s3://bucket/final/GMD.dta \
      --helpers-uri     s3://bucket/helpers/ \
      [--dest DIR] [--region ap-southeast-1]

Prints the scratch data-root path on success (use it as DATA_REVIEW_DATA_ROOT).
Uses the AWS CLI (honours the instance/task IAM role in deployment, or local creds).
"""
from __future__ import annotations
import argparse
import subprocess
import sys
from pathlib import Path

HELPER_FILES = ("variables.csv", "country_gdp_shares.csv")


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def _as_dir(uri: str) -> str:
    return uri if uri.endswith("/") else uri + "/"


def fetch(chainlinked_uri: str, gmd_uri: str, helpers_uri: str,
          dest: Path, region: str | None) -> Path:
    reg = ["--region", region] if region else []
    final = dest / "data" / "final"
    distribute = dest / "data" / "distribute"
    helpers = dest / "data" / "helpers"
    for d in (final, distribute, helpers):
        d.mkdir(parents=True, exist_ok=True)

    # chainlinked_*.dta -> data/final/  (exclude everything else in the prefix)
    _run(["aws", "s3", "sync", _as_dir(chainlinked_uri), str(final),
          "--exclude", "*", "--include", "chainlinked_*.dta", *reg])
    # GMD.dta -> data/distribute/GMD.dta  (gmd_uri may be a full key or a dir)
    gmd_key = gmd_uri if gmd_uri.endswith(".dta") else _as_dir(gmd_uri) + "GMD.dta"
    _run(["aws", "s3", "cp", gmd_key, str(distribute / "GMD.dta"), *reg])
    # only the two helper CSVs flags.py needs -> data/helpers/
    for name in HELPER_FILES:
        _run(["aws", "s3", "cp", _as_dir(helpers_uri) + name, str(helpers / name), *reg])
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description="Sync review inputs from S3 to a scratch data root.")
    ap.add_argument("--chainlinked-uri", required=True, help="s3:// dir holding chainlinked_*.dta")
    ap.add_argument("--gmd-uri", required=True, help="s3:// key or dir for GMD.dta")
    ap.add_argument("--helpers-uri", required=True,
                    help="s3:// dir holding variables.csv + country_gdp_shares.csv")
    ap.add_argument("--dest", default=str(Path(__file__).resolve().parent / "_scratch"),
                    help="local scratch data root (default: ./_scratch next to this script)")
    ap.add_argument("--region", default=None)
    a = ap.parse_args()
    dest = fetch(a.chainlinked_uri, a.gmd_uri, a.helpers_uri, Path(a.dest).resolve(), a.region)
    print(str(dest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
