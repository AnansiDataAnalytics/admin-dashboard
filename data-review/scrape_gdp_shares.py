"""
One-shot scraper: fetch the IMF nominal-GDP table from Wikipedia and emit
data/helpers/country_gdp_shares.csv. Re-run only when the snapshot needs
refreshing -- the CSV is the source of truth for the country-share check
in flags.py, NOT this script.

Snapshot semantics:
  - country_gdp_shares.csv carries a frozen IMF estimate for every country.
  - The `snapshot_year` column records the year the IMF estimate refers to
    (usually +0 or +1 from the run year).
  - flags.py uses each country's share_pct as the "expected" share for
    any year in [snapshot_year - 30, snapshot_year]; outside that window
    the band widens.

The raw JSON below is the verbatim WebFetch result captured 2026-05-21
against https://en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal).
If you re-scrape, paste the new JSON in -- keep the script reproducible.
"""
from __future__ import annotations

import csv
import json
import re
import sys
import unicodedata
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[1]
OUT_CSV = REPO / "data" / "helpers" / "country_gdp_shares.csv"
COUNTRYLIST = REPO / "data" / "helpers" / "countrylist.dta"

# Snapshot captured 2026-05-21 from
# https://en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal)
# (IMF forecast/estimate column).
SNAPSHOT_DATE = "2026-05-21"
WIKI_URL = "https://en.wikipedia.org/wiki/List_of_countries_by_GDP_(nominal)"

RAW_JSON = r"""
[
  {"country": "United States", "gdp_usd_mn": 32383920, "year": 2026},
  {"country": "China", "gdp_usd_mn": 20851593, "year": 2026},
  {"country": "Germany", "gdp_usd_mn": 5452858, "year": 2026},
  {"country": "Japan", "gdp_usd_mn": 4379253, "year": 2026},
  {"country": "United Kingdom", "gdp_usd_mn": 4264794, "year": 2026},
  {"country": "India", "gdp_usd_mn": 4153191, "year": 2026},
  {"country": "France", "gdp_usd_mn": 3596094, "year": 2026},
  {"country": "Italy", "gdp_usd_mn": 2738164, "year": 2026},
  {"country": "Russia", "gdp_usd_mn": 2656452, "year": 2026},
  {"country": "Brazil", "gdp_usd_mn": 2635912, "year": 2026},
  {"country": "Canada", "gdp_usd_mn": 2507340, "year": 2026},
  {"country": "Australia", "gdp_usd_mn": 2123963, "year": 2026},
  {"country": "Mexico", "gdp_usd_mn": 2120855, "year": 2026},
  {"country": "Spain", "gdp_usd_mn": 2091222, "year": 2026},
  {"country": "South Korea", "gdp_usd_mn": 1931008, "year": 2026},
  {"country": "Turkey", "gdp_usd_mn": 1640223, "year": 2026},
  {"country": "Indonesia", "gdp_usd_mn": 1539872, "year": 2026},
  {"country": "Netherlands", "gdp_usd_mn": 1449704, "year": 2026},
  {"country": "Saudi Arabia", "gdp_usd_mn": 1388676, "year": 2026},
  {"country": "Switzerland", "gdp_usd_mn": 1146911, "year": 2026},
  {"country": "Poland", "gdp_usd_mn": 1134248, "year": 2026},
  {"country": "Taiwan", "gdp_usd_mn": 976719, "year": 2026},
  {"country": "Ireland", "gdp_usd_mn": 779381, "year": 2026},
  {"country": "Belgium", "gdp_usd_mn": 776730, "year": 2026},
  {"country": "Sweden", "gdp_usd_mn": 760481, "year": 2026},
  {"country": "Israel", "gdp_usd_mn": 719848, "year": 2026},
  {"country": "Argentina", "gdp_usd_mn": 688378, "year": 2026},
  {"country": "Singapore", "gdp_usd_mn": 659572, "year": 2026},
  {"country": "Austria", "gdp_usd_mn": 623719, "year": 2026},
  {"country": "United Arab Emirates", "gdp_usd_mn": 621546, "year": 2026},
  {"country": "Norway", "gdp_usd_mn": 599406, "year": 2026},
  {"country": "Thailand", "gdp_usd_mn": 579996, "year": 2026},
  {"country": "Colombia", "gdp_usd_mn": 539530, "year": 2026},
  {"country": "Vietnam", "gdp_usd_mn": 527266, "year": 2026},
  {"country": "Malaysia", "gdp_usd_mn": 516428, "year": 2026},
  {"country": "Philippines", "gdp_usd_mn": 512222, "year": 2026},
  {"country": "Bangladesh", "gdp_usd_mn": 510705, "year": 2026},
  {"country": "Denmark", "gdp_usd_mn": 503772, "year": 2026},
  {"country": "Romania", "gdp_usd_mn": 480834, "year": 2026},
  {"country": "South Africa", "gdp_usd_mn": 479964, "year": 2026},
  {"country": "Pakistan", "gdp_usd_mn": 452192, "year": 2026},
  {"country": "Hong Kong", "gdp_usd_mn": 450138, "year": 2026},
  {"country": "Czech Republic", "gdp_usd_mn": 432597, "year": 2026},
  {"country": "Egypt", "gdp_usd_mn": 429645, "year": 2026},
  {"country": "Chile", "gdp_usd_mn": 407850, "year": 2026},
  {"country": "Peru", "gdp_usd_mn": 380900, "year": 2026},
  {"country": "Portugal", "gdp_usd_mn": 380637, "year": 2026},
  {"country": "Nigeria", "gdp_usd_mn": 377365, "year": 2026},
  {"country": "Kazakhstan", "gdp_usd_mn": 360456, "year": 2026},
  {"country": "Finland", "gdp_usd_mn": 337669, "year": 2026},
  {"country": "Algeria", "gdp_usd_mn": 317173, "year": 2026},
  {"country": "Greece", "gdp_usd_mn": 307554, "year": 2026},
  {"country": "Iran", "gdp_usd_mn": 300293, "year": 2026},
  {"country": "New Zealand", "gdp_usd_mn": 278636, "year": 2026},
  {"country": "Hungary", "gdp_usd_mn": 271122, "year": 2026},
  {"country": "Iraq", "gdp_usd_mn": 264784, "year": 2026},
  {"country": "Ukraine", "gdp_usd_mn": 225337, "year": 2026},
  {"country": "Qatar", "gdp_usd_mn": 217416, "year": 2026},
  {"country": "Morocco", "gdp_usd_mn": 194333, "year": 2026},
  {"country": "Uzbekistan", "gdp_usd_mn": 181502, "year": 2026},
  {"country": "Kuwait", "gdp_usd_mn": 172920, "year": 2026},
  {"country": "Slovakia", "gdp_usd_mn": 168897, "year": 2026},
  {"country": "Angola", "gdp_usd_mn": 152354, "year": 2026},
  {"country": "Bulgaria", "gdp_usd_mn": 148121, "year": 2026},
  {"country": "Kenya", "gdp_usd_mn": 147265, "year": 2026},
  {"country": "Ecuador", "gdp_usd_mn": 138194, "year": 2026},
  {"country": "Dominican Republic", "gdp_usd_mn": 136148, "year": 2026},
  {"country": "Puerto Rico", "gdp_usd_mn": 129012, "year": 2026},
  {"country": "Guatemala", "gdp_usd_mn": 128886, "year": 2026},
  {"country": "DR Congo", "gdp_usd_mn": 123406, "year": 2026},
  {"country": "Ethiopia", "gdp_usd_mn": 121527, "year": 2026},
  {"country": "Ghana", "gdp_usd_mn": 118293, "year": 2026},
  {"country": "Oman", "gdp_usd_mn": 117176, "year": 2026},
  {"country": "Croatia", "gdp_usd_mn": 116574, "year": 2026},
  {"country": "Ivory Coast", "gdp_usd_mn": 112115, "year": 2026},
  {"country": "Serbia", "gdp_usd_mn": 112025, "year": 2026},
  {"country": "Venezuela", "gdp_usd_mn": 111303, "year": 2026},
  {"country": "Luxembourg", "gdp_usd_mn": 110417, "year": 2026},
  {"country": "Costa Rica", "gdp_usd_mn": 109931, "year": 2026},
  {"country": "Lithuania", "gdp_usd_mn": 105907, "year": 2026},
  {"country": "Belarus", "gdp_usd_mn": 102042, "year": 2026},
  {"country": "Sri Lanka", "gdp_usd_mn": 98964, "year": 2024},
  {"country": "Uruguay", "gdp_usd_mn": 96092, "year": 2026},
  {"country": "Panama", "gdp_usd_mn": 95024, "year": 2026},
  {"country": "Tanzania", "gdp_usd_mn": 94889, "year": 2026},
  {"country": "Slovenia", "gdp_usd_mn": 86732, "year": 2026},
  {"country": "Myanmar", "gdp_usd_mn": 83832, "year": 2026},
  {"country": "Turkmenistan", "gdp_usd_mn": 83065, "year": 2026},
  {"country": "Bolivia", "gdp_usd_mn": 80743, "year": 2026},
  {"country": "Azerbaijan", "gdp_usd_mn": 78372, "year": 2026},
  {"country": "Uganda", "gdp_usd_mn": 73370, "year": 2026},
  {"country": "Cameroon", "gdp_usd_mn": 65135, "year": 2026},
  {"country": "Jordan", "gdp_usd_mn": 64909, "year": 2026},
  {"country": "Tunisia", "gdp_usd_mn": 60745, "year": 2026},
  {"country": "Paraguay", "gdp_usd_mn": 60542, "year": 2026},
  {"country": "Zimbabwe", "gdp_usd_mn": 56713, "year": 2026},
  {"country": "Macau", "gdp_usd_mn": 54228, "year": 2026},
  {"country": "Latvia", "gdp_usd_mn": 53686, "year": 2026},
  {"country": "Libya", "gdp_usd_mn": 52453, "year": 2026},
  {"country": "Cambodia", "gdp_usd_mn": 52379, "year": 2026},
  {"country": "Estonia", "gdp_usd_mn": 51634, "year": 2026},
  {"country": "Bahrain", "gdp_usd_mn": 48849, "year": 2026},
  {"country": "Nepal", "gdp_usd_mn": 45844, "year": 2026},
  {"country": "Cyprus", "gdp_usd_mn": 45171, "year": 2026},
  {"country": "Sudan", "gdp_usd_mn": 44688, "year": 2026},
  {"country": "Iceland", "gdp_usd_mn": 43800, "year": 2026},
  {"country": "Georgia", "gdp_usd_mn": 42716, "year": 2026},
  {"country": "Honduras", "gdp_usd_mn": 41505, "year": 2026},
  {"country": "Zambia", "gdp_usd_mn": 41243, "year": 2026},
  {"country": "Senegal", "gdp_usd_mn": 40469, "year": 2026},
  {"country": "El Salvador", "gdp_usd_mn": 39838, "year": 2026},
  {"country": "Haiti", "gdp_usd_mn": 39180, "year": 2026},
  {"country": "Bosnia and Herzegovina", "gdp_usd_mn": 36771, "year": 2026},
  {"country": "Lebanon", "gdp_usd_mn": 34497, "year": 2025},
  {"country": "Papua New Guinea", "gdp_usd_mn": 34403, "year": 2026},
  {"country": "Guyana", "gdp_usd_mn": 33961, "year": 2026},
  {"country": "Mali", "gdp_usd_mn": 33847, "year": 2026},
  {"country": "Albania", "gdp_usd_mn": 33333, "year": 2026},
  {"country": "Burkina Faso", "gdp_usd_mn": 32513, "year": 2026},
  {"country": "Armenia", "gdp_usd_mn": 31873, "year": 2026},
  {"country": "Malta", "gdp_usd_mn": 30712, "year": 2026},
  {"country": "Guinea", "gdp_usd_mn": 29930, "year": 2026},
  {"country": "Mongolia", "gdp_usd_mn": 28450, "year": 2026},
  {"country": "Benin", "gdp_usd_mn": 27786, "year": 2026},
  {"country": "Trinidad and Tobago", "gdp_usd_mn": 26836, "year": 2026},
  {"country": "Chad", "gdp_usd_mn": 25628, "year": 2026},
  {"country": "Niger", "gdp_usd_mn": 24813, "year": 2026},
  {"country": "Nicaragua", "gdp_usd_mn": 24227, "year": 2026},
  {"country": "Kyrgyzstan", "gdp_usd_mn": 23606, "year": 2026},
  {"country": "Gabon", "gdp_usd_mn": 23363, "year": 2026},
  {"country": "Mozambique", "gdp_usd_mn": 23275, "year": 2026},
  {"country": "Jamaica", "gdp_usd_mn": 23028, "year": 2026},
  {"country": "Botswana", "gdp_usd_mn": 21937, "year": 2026},
  {"country": "Moldova", "gdp_usd_mn": 21889, "year": 2026},
  {"country": "North Macedonia", "gdp_usd_mn": 21605, "year": 2026},
  {"country": "Madagascar", "gdp_usd_mn": 21185, "year": 2026},
  {"country": "Tajikistan", "gdp_usd_mn": 20418, "year": 2026},
  {"country": "Afghanistan", "gdp_usd_mn": 19662, "year": 2025},
  {"country": "Laos", "gdp_usd_mn": 18959, "year": 2026},
  {"country": "Malawi", "gdp_usd_mn": 18152, "year": 2026},
  {"country": "Rwanda", "gdp_usd_mn": 17336, "year": 2026},
  {"country": "Namibia", "gdp_usd_mn": 17314, "year": 2026},
  {"country": "Mauritius", "gdp_usd_mn": 17119, "year": 2026},
  {"country": "Bahamas", "gdp_usd_mn": 17042, "year": 2026},
  {"country": "Congo", "gdp_usd_mn": 17028, "year": 2026},
  {"country": "Brunei", "gdp_usd_mn": 16863, "year": 2026},
  {"country": "Palestine", "gdp_usd_mn": 16017, "year": 2024},
  {"country": "Mauritania", "gdp_usd_mn": 14352, "year": 2026},
  {"country": "Somalia", "gdp_usd_mn": 14174, "year": 2026},
  {"country": "Kosovo", "gdp_usd_mn": 14053, "year": 2026},
  {"country": "Equatorial Guinea", "gdp_usd_mn": 13722, "year": 2026},
  {"country": "Togo", "gdp_usd_mn": 13437, "year": 2026},
  {"country": "Montenegro", "gdp_usd_mn": 10227, "year": 2026},
  {"country": "Liechtenstein", "gdp_usd_mn": 9442, "year": 2026},
  {"country": "Barbados", "gdp_usd_mn": 8483, "year": 2026},
  {"country": "Sierra Leone", "gdp_usd_mn": 8270, "year": 2026},
  {"country": "Burundi", "gdp_usd_mn": 8137, "year": 2026},
  {"country": "Maldives", "gdp_usd_mn": 8130, "year": 2026},
  {"country": "Yemen", "gdp_usd_mn": 7435, "year": 2026},
  {"country": "Fiji", "gdp_usd_mn": 6352, "year": 2026},
  {"country": "South Sudan", "gdp_usd_mn": 6069, "year": 2026},
  {"country": "Suriname", "gdp_usd_mn": 5908, "year": 2026},
  {"country": "Eswatini", "gdp_usd_mn": 5792, "year": 2026},
  {"country": "Liberia", "gdp_usd_mn": 5642, "year": 2026},
  {"country": "Andorra", "gdp_usd_mn": 4879, "year": 2026},
  {"country": "Djibouti", "gdp_usd_mn": 4725, "year": 2026},
  {"country": "Aruba", "gdp_usd_mn": 4671, "year": 2026},
  {"country": "Bhutan", "gdp_usd_mn": 3856, "year": 2026},
  {"country": "Central African Republic", "gdp_usd_mn": 3492, "year": 2026},
  {"country": "Belize", "gdp_usd_mn": 3450, "year": 2026},
  {"country": "Cape Verde", "gdp_usd_mn": 3448, "year": 2026},
  {"country": "Guinea-Bissau", "gdp_usd_mn": 2985, "year": 2026},
  {"country": "Lesotho", "gdp_usd_mn": 2972, "year": 2026},
  {"country": "Gambia", "gdp_usd_mn": 2792, "year": 2026},
  {"country": "Saint Lucia", "gdp_usd_mn": 2765, "year": 2026},
  {"country": "San Marino", "gdp_usd_mn": 2417, "year": 2026},
  {"country": "Antigua and Barbuda", "gdp_usd_mn": 2385, "year": 2026},
  {"country": "Seychelles", "gdp_usd_mn": 2251, "year": 2026},
  {"country": "Timor-Leste", "gdp_usd_mn": 2170, "year": 2026},
  {"country": "Solomon Islands", "gdp_usd_mn": 1836, "year": 2026},
  {"country": "Comoros", "gdp_usd_mn": 1814, "year": 2026},
  {"country": "Grenada", "gdp_usd_mn": 1483, "year": 2026},
  {"country": "Vanuatu", "gdp_usd_mn": 1396, "year": 2026},
  {"country": "Samoa", "gdp_usd_mn": 1376, "year": 2026},
  {"country": "Saint Vincent and the Grenadines", "gdp_usd_mn": 1236, "year": 2026},
  {"country": "Sao Tome and Principe", "gdp_usd_mn": 1161, "year": 2026},
  {"country": "Saint Kitts and Nevis", "gdp_usd_mn": 1143, "year": 2026},
  {"country": "Dominica", "gdp_usd_mn": 791, "year": 2026},
  {"country": "Tonga", "gdp_usd_mn": 716, "year": 2026},
  {"country": "Federated States of Micronesia", "gdp_usd_mn": 521, "year": 2026},
  {"country": "Kiribati", "gdp_usd_mn": 401, "year": 2026},
  {"country": "Palau", "gdp_usd_mn": 377, "year": 2026},
  {"country": "Marshall Islands", "gdp_usd_mn": 342, "year": 2026},
  {"country": "Nauru", "gdp_usd_mn": 196, "year": 2026},
  {"country": "Tuvalu", "gdp_usd_mn": 65, "year": 2026}
]
"""

# Wikipedia name -> GMD countrylist `countryname`. Only the cases where a
# direct case-insensitive match against countrylist.dta fails. Verified
# manually against data/helpers/countrylist.dta on the snapshot date.
NAME_ALIAS = {
    "DR Congo": "Democratic Republic of the Congo",
    "Congo": "Republic of the Congo",
    "Russia": "Russian Federation",
    "Federated States of Micronesia": "Micronesia (Federated States of)",
    "North Macedonia": "Macedonia",
}


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-zA-Z0-9]+", " ", s).strip().lower()
    return s


def main() -> int:
    countrylist = pd.read_stata(COUNTRYLIST)
    name_to_iso3 = {_norm(r.countryname): r.ISO3 for r in countrylist.itertuples(index=False)}

    rows = json.loads(RAW_JSON)
    total = sum(r["gdp_usd_mn"] for r in rows)

    unresolved: list[str] = []
    out_rows: list[dict] = []
    for r in rows:
        wiki_name = r["country"]
        alias = NAME_ALIAS.get(wiki_name, wiki_name)
        iso3 = name_to_iso3.get(_norm(alias))
        if not iso3:
            unresolved.append(wiki_name)
            continue
        share_pct = r["gdp_usd_mn"] / total * 100
        out_rows.append({
            "ISO3": iso3,
            "wiki_name": wiki_name,
            "gdp_usd_mn": r["gdp_usd_mn"],
            "share_pct": round(share_pct, 6),
            "snapshot_year": r["year"],
            "snapshot_date": SNAPSHOT_DATE,
            "source_url": WIKI_URL,
        })

    if unresolved:
        print(f"unresolved country names ({len(unresolved)}):")
        for n in unresolved:
            print(f"  - {n!r}")
        # Don't fail -- emit what we can. The check tolerates missing rows.
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_CSV, "w") as f:
        w = csv.DictWriter(f, fieldnames=list(out_rows[0].keys()))
        w.writeheader()
        w.writerows(sorted(out_rows, key=lambda r: -r["share_pct"]))

    print(f"wrote {len(out_rows)} rows to {OUT_CSV.relative_to(REPO)}")
    print(f"top 5:")
    for r in sorted(out_rows, key=lambda r: -r["share_pct"])[:5]:
        print(f"  {r['ISO3']:>5}  {r['wiki_name']:<25} {r['share_pct']:6.2f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
