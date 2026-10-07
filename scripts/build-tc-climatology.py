#!/usr/bin/env python3
"""Build public/climatology/tc-monthly-5deg.json from NOAA IBTrACS v04r01.

What it makes
-------------
For every 5-degree box and calendar month: WHICH tropical cyclones passed
through it, 1991-2024 inclusive, all basins. The app's cyclone-season card
(components/passage/SeasonRiskCard.tsx via services/climatology/
tcClimatology.ts) unions those storms over the boxes near a planned route, so
a storm that crosses several of the route's boxes is still one storm.

Counting rule (stated in the JSON as `rule`)
--------------------------------------------
* A storm is one IBTrACS SID. Spur tracks (TRACK_TYPE "spur-*") are skipped:
  they are alternative pieces of a storm already carried on its main track.
  Main and provisional tracks count.
* A storm counts in a box and month when at least one of its fixes there
  - falls in that calendar month (ISO_TIME, UTC) of a year 1991..2024,
  - is reported tropical (NATURE "TS") anywhere, OR has an unreported
    ("NR") or disputed ("MX": the agencies' reports disagree) nature within
    30 degrees of the equator. "ET" (extratropical), "SS" (subtropical) and
    "DS" (disturbance) never count. Why the split, measured on the
    2026-10-02 file: NR does not mean "not tropical" - every North Indian
    Ocean fix 1991-1995 is NR (the April 1991 Bangladesh cyclone among
    them), as are recent provisional tracks, so a TS-only rule silently
    dropped 44 storms and 463 storm-box-months. But poleward of 30 degrees
    NR and MX are mostly the post-tropical tail (NR fixes run to 70S in the
    South Pacific; most MX fixes there carry USA_STATUS EX or SS), which
    would count ex-tropical lows as tropical cyclones off New Zealand and
    Japan. Within 30 degrees the split restores every NR/MX storm found
    on the routes checked; and
  - is at tropical-storm strength: 34 kt or more on WMO_WIND (the
    responsible RSMC, mostly 10-min) or USA_WIND (JTWC/NHC, 1-min),
    whichever is higher. 34 kt is the international threshold for a named
    tropical storm / cyclonic storm / Australian-scale tropical cyclone.
* Each storm counts ONCE per box per month however many fixes it has there.
* Boxes are keyed by their south-west corner in whole degrees, longitudes in
  [-180, 180): "-20,165" is 20S-15S, 165E-170E.

Encoding
--------
Storms are numbered 0..N-1 in SID order and written as fixed-width tokens
over a 64-character URL-safe alphabet (2 characters while N <= 4096). Each
cell is one string of 12 month segments joined by "|" (January first); a
segment is the concatenated tokens of the storms in that box that month. The
count for a box-month is len(segment) / idWidth; the count near a route is the
number of distinct tokens across its boxes.

Source, terms and citation (verified on the NCEI product page 2026-10-08,
https://www.ncei.noaa.gov/products/international-best-track-archive)
-------------------------------------------------------------------------
* Data usage follows the World Data Center for Meteorology policy: full and
  open access. Commercial use is guided by WMO Resolution 40.
* Short credit, for works without a bibliography: "NOAA's International Best
  Track Archive for Climate Stewardship (IBTrACS) data, accessed on [date]".
* Dataset: Gahtan, J., K. R. Knapp, C. J. Schreck, H. J. Diamond, J. P.
  Kossin, M. C. Kruk, 2024: International Best Track Archive for Climate
  Stewardship (IBTrACS) Project, Version 4r01. NOAA National Centers for
  Environmental Information. doi:10.25921/82ty-9e16
* Paper: Knapp, K. R., M. C. Kruk, D. H. Levinson, H. J. Diamond, and C. J.
  Neumann, 2010: The International Best Track Archive for Climate Stewardship
  (IBTrACS): Unifying tropical cyclone best track data. Bulletin of the
  American Meteorological Society, 91, 363-376. doi:10.1175/2009BAMS2755.1

How to run (standard library only; ~145 MB download, a few seconds of CPU)
-------------------------------------------------------------------------
    python3 scripts/build-tc-climatology.py --download-dir /some/scratch/dir
        # fetches ibtracs.since1980.list.v04r01.csv, builds, deletes the CSV
    python3 scripts/build-tc-climatology.py --csv /path/to/ibtracs.since1980.list.v04r01.csv
    python3 scripts/build-tc-climatology.py --self-test

Re-run yearly once IBTrACS has a further complete year; move --last-year and
the app's copy ("N in 34 years") follows the JSON's own year span.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import math
import os
import sys
import urllib.request
from collections import defaultdict
from typing import Dict, Iterable, Iterator, List, Optional, Set, Tuple

SOURCE_URL = (
    "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/"
    "v04r01/access/csv/ibtracs.since1980.list.v04r01.csv"
)
SOURCE = "NOAA IBTrACS v04r01"
DATASET_CITATION = (
    "Gahtan, J., K. R. Knapp, C. J. Schreck, H. J. Diamond, J. P. Kossin, M. C. Kruk, 2024: "
    "International Best Track Archive for Climate Stewardship (IBTrACS) Project, Version 4r01. "
    "[{subset}]. NOAA National Centers for Environmental Information. doi:10.25921/82ty-9e16 "
    "[accessed {accessed}]"
)
PAPER_CITATION = (
    "Knapp, K. R., M. C. Kruk, D. H. Levinson, H. J. Diamond, and C. J. Neumann, 2010: The International "
    "Best Track Archive for Climate Stewardship (IBTrACS): Unifying tropical cyclone best track data. "
    "Bulletin of the American Meteorological Society, 91, 363-376. doi:10.1175/2009BAMS2755.1"
)
TERMS = (
    "Full and open access under the World Data Center for Meteorology data policy; "
    "commercial use guided by WMO Resolution 40 (NCEI IBTrACS product page)."
)
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_"
# NATURE values that count. TS (tropical) everywhere. NR (not reported) and MX
# (agencies disagree) say neither "tropical" nor "not tropical": they count
# within UNSURE_NATURE_MAX_ABS_LAT of the equator, where they are whole
# basin-years of real storms, and not poleward of it, where they are mostly
# post-tropical tails. ET, SS and DS (extratropical, subtropical, disturbance)
# never count.
TROPICAL_NATURE = "TS"
UNSURE_NATURES = ("NR", "MX")
UNSURE_NATURE_MAX_ABS_LAT = 30.0

Incidence = Tuple[str, int, int, int]  # (sid, lat_sw, lon_sw, month 1..12)


def _num(value: str) -> Optional[float]:
    value = value.strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def box_corner(lat: float, lon: float, box_deg: int) -> Tuple[int, int]:
    """South-west corner of the box holding (lat, lon); lon normalised to [-180, 180)."""
    lon = ((lon + 180.0) % 360.0) - 180.0
    lat = min(max(lat, -90.0), 89.999999)
    return (int(math.floor(lat / box_deg)) * box_deg, int(math.floor(lon / box_deg)) * box_deg)


def counts_as_tropical(nature: str, lat: float) -> bool:
    """TS anywhere; NR/MX only within UNSURE_NATURE_MAX_ABS_LAT of the equator; ET/SS/DS never."""
    nature = nature.strip()
    if nature == TROPICAL_NATURE:
        return True
    return nature in UNSURE_NATURES and abs(lat) <= UNSURE_NATURE_MAX_ABS_LAT


def iter_incidences(
    rows: Iterable[Dict[str, str]],
    first_year: int,
    last_year: int,
    box_deg: int,
    min_wind_kt: float,
) -> Iterator[Incidence]:
    """Yield (sid, lat_sw, lon_sw, month) for every qualifying fix (duplicates included)."""
    for row in rows:
        iso = row.get("ISO_TIME", "")
        if len(iso) < 7 or not iso[:4].isdigit():
            continue  # the units row and anything malformed
        year = int(iso[:4])
        if year < first_year or year > last_year:
            continue
        if row.get("TRACK_TYPE", "").startswith("spur"):
            continue
        winds = [w for w in (_num(row.get("WMO_WIND", "")), _num(row.get("USA_WIND", ""))) if w is not None]
        if not winds or max(winds) < min_wind_kt:
            continue
        lat = _num(row.get("LAT", ""))
        lon = _num(row.get("LON", ""))
        if lat is None or lon is None:
            continue
        if not counts_as_tropical(row.get("NATURE", ""), lat):
            continue
        lat_sw, lon_sw = box_corner(lat, lon, box_deg)
        yield (row["SID"], lat_sw, lon_sw, int(iso[5:7]))


def id_width_for(storm_count: int) -> int:
    width = 1
    while len(ALPHABET) ** width < max(storm_count, 1):
        width += 1
    return width


def encode_id(index: int, width: int) -> str:
    chars = []
    for _ in range(width):
        index, rem = divmod(index, len(ALPHABET))
        chars.append(ALPHABET[rem])
    if index:
        raise ValueError("storm index does not fit the id width")
    return "".join(reversed(chars))


def build_cells(incidences: Iterable[Incidence]) -> Tuple[Dict[str, str], int, int, int]:
    """Collapse incidences into {"lat,lon": "jan|feb|...|dec"}; returns (cells, storms, width, pairs)."""
    unique: Set[Incidence] = set(incidences)  # once per storm per box per month
    sids = sorted({sid for sid, _, _, _ in unique})
    index = {sid: i for i, sid in enumerate(sids)}
    width = id_width_for(len(sids))
    by_cell: Dict[Tuple[int, int], List[List[int]]] = defaultdict(lambda: [[] for _ in range(12)])
    for sid, lat_sw, lon_sw, month in unique:
        by_cell[(lat_sw, lon_sw)][month - 1].append(index[sid])
    cells: Dict[str, str] = {}
    for lat_sw, lon_sw in sorted(by_cell):
        months = by_cell[(lat_sw, lon_sw)]
        cells[f"{lat_sw},{lon_sw}"] = "|".join(
            "".join(encode_id(i, width) for i in sorted(month)) for month in months
        )
    return cells, len(sids), width, len(unique)


def render_json(meta: Dict[str, object], cells: Dict[str, str]) -> str:
    """One key per line at 4-space indent: exactly what the repo's Prettier
    (format:check, lint-staged) expects of a .json file, and a yearly refresh
    diffs one box per line."""
    return json.dumps({**meta, "cells": cells}, indent=4, ensure_ascii=False) + "\n"


def read_rows(path: str) -> Iterator[Dict[str, str]]:
    with open(path, newline="", encoding="utf-8", errors="replace") as fh:
        yield from csv.DictReader(fh)


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, directory: str) -> Tuple[str, Optional[str]]:
    """Stream the CSV to `directory`; a failed or interrupted download leaves no partial file."""
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory, url.rsplit("/", 1)[-1])
    try:
        with urllib.request.urlopen(url, timeout=120) as resp, open(target, "wb") as out:
            last_modified = resp.headers.get("Last-Modified")
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
    except BaseException:
        if os.path.exists(target):
            os.remove(target)
        raise
    return target, last_modified


def mediterranean_report(path: str, first_year: int, last_year: int) -> List[str]:
    """Every main-track fix, any nature or wind, inside 30-46N 5.5W-37E (the Med's boxes and the Strait)."""
    seen: Dict[str, List[str]] = defaultdict(list)
    for row in read_rows(path):
        iso = row.get("ISO_TIME", "")
        if len(iso) < 7 or not iso[:4].isdigit() or not first_year <= int(iso[:4]) <= last_year:
            continue
        if row.get("TRACK_TYPE", "").startswith("spur"):
            continue
        lat, lon = _num(row.get("LAT", "")), _num(row.get("LON", ""))
        if lat is None or lon is None:
            continue
        lon = ((lon + 180.0) % 360.0) - 180.0
        if 30.0 <= lat <= 46.0 and -5.5 <= lon <= 37.0:
            wind = max([w for w in (_num(row["WMO_WIND"]), _num(row["USA_WIND"])) if w is not None], default=None)
            seen[f'{row["SID"]} {row["NAME"]}'].append(f'{iso[:13]} {lat:.1f},{lon:.1f} {row["NATURE"]} {wind}kt')
    return [f"{k}: {len(v)} fix(es): {v[0]} .. {v[-1]}" for k, v in seen.items()]


def self_test() -> None:
    header = "SID,ISO_TIME,NATURE,LAT,LON,WMO_WIND,USA_WIND,TRACK_TYPE,NAME\n"
    units = " , , ,degrees_north,degrees_east,kts,kts, , \n"
    body = "".join(
        [
            # Storm A: three fixes in one box in September -> counts once there,
            # then crosses into the next box -> once there too.
            "2001250N15300,2001-09-07 00:00:00,TS,15.2,-60.4,40, ,main,ALPHA\n",
            "2001250N15300,2001-09-07 03:00:00,TS,15.6,-61.0, ,45,main,ALPHA\n",
            "2001250N15300,2001-09-07 06:00:00,TS,16.0,-61.9,50,55,main,ALPHA\n",
            "2001250N15300,2001-09-08 00:00:00,TS,16.4,-65.2,60,65,main,ALPHA\n",
            # Storm A's spur repeats the first box: ignored.
            "2001250N15301,2001-09-07 00:00:00,TS,15.2,-60.4,40,40,spur-other,ALPHA\n",
            # Storm B: same box, same month -> second distinct storm there.
            "2003251N15300,2003-09-10 00:00:00,TS,17.0,-62.0,35, ,main,BRAVO\n",
            # Storm C: too weak, extratropical, outside the years -> nothing.
            "2003300N15300,2003-10-27 00:00:00,TS,17.0,-62.0,30,33,main,CHARLIE\n",
            "2003300N15300,2003-10-28 00:00:00,ET,17.0,-62.0,50,50,main,CHARLIE\n",
            "1990250N15300,1990-09-07 00:00:00,TS,15.2,-60.4,90,90,main,OLD\n",
            "2025250N15300,2025-09-07 00:00:00,TS,15.2,-60.4,90,90,main,NEW\n",
            # Storm D: across the antimeridian (east longitude > 180 in some files).
            "2010020S17179,2010-01-20 00:00:00,TS,-17.5,181.0,50,55,main,DELTA\n",
            # Storm E: NATURE "NR" (not reported; every North Indian Ocean fix
            # 1991-1995) is NOT "not tropical" -> counts. Modelled on the April
            # 1991 Bangladesh cyclone.
            "1991113N10091,1991-04-29 00:00:00,NR,20.6,90.6,127,140,main,ECHO\n",
            # Storm F: NATURE "MX" (agencies disagree) -> counts.
            "2005270N25280,2005-09-28 00:00:00,MX,25.0,-80.5,45,45,main,FOXTROT\n",
            # Subtropical and disturbance stages -> nothing.
            "2006270N25280,2006-09-28 00:00:00,SS,25.0,-80.5,45,45,main,GOLF\n",
            "2007270N25280,2007-09-28 00:00:00,DS,25.0,-80.5,45,45,main,HOTEL\n",
            # NR / MX poleward of 30 degrees: the post-tropical tail -> nothing.
            "2010040S15190,2010-02-12 00:00:00,NR,-45.5,-170.0,45,45,main,INDIA\n",
            "2011250N20130,2011-09-20 00:00:00,MX,36.0,141.0,50,50,main,JULIETT\n",
        ]
    )
    rows = csv.DictReader(io.StringIO(header + units + body))
    cells, storms, width, pairs = build_cells(iter_incidences(rows, 1991, 2024, 5, 34))
    assert storms == 5, storms
    assert width == 1, width
    assert pairs == 6, pairs
    sep = cells["15,-65"].split("|")
    assert len(sep) == 12 and len(sep[8]) == 2, cells["15,-65"]  # A and B, once each
    # Ids follow SID order: E=0, A=1, B=2, F=3, D=4.
    assert counts_as_tropical("NR", 30.0) and not counts_as_tropical("MX", -30.5)
    assert not counts_as_tropical("ET", 10.0) and counts_as_tropical(" TS ", 60.0)
    assert cells["15,-70"].split("|")[8] == "1", cells["15,-70"]  # A only
    assert cells["-20,-180"].split("|")[0] == "4", cells["-20,-180"]  # D, Jan, lon wrapped
    assert cells["20,90"].split("|")[3] == "0", cells["20,90"]  # E (NR), April
    assert cells["25,-85"].split("|")[8] == "3", cells["25,-85"]  # F (MX) only: not G (SS), not H (DS)
    assert set(cells) == {"15,-65", "15,-70", "-20,-180", "20,90", "25,-85"}, cells
    assert encode_id(4095, 2) == "__" and encode_id(64, 2) == "10"
    print("self-test ok")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    src = parser.add_mutually_exclusive_group()
    src.add_argument("--csv", help="local ibtracs.since1980.list.v04r01.csv (or ibtracs.ALL)")
    src.add_argument("--download-dir", help="download the official CSV here, build, then delete it")
    src.add_argument("--self-test", action="store_true")
    parser.add_argument("--keep-download", action="store_true")
    parser.add_argument("--source-last-modified", help="HTTP Last-Modified of a --csv you fetched yourself")
    parser.add_argument("--out", default="public/climatology/tc-monthly-5deg.json")
    parser.add_argument("--first-year", type=int, default=1991)
    parser.add_argument("--last-year", type=int, default=2024)
    parser.add_argument("--box", type=int, default=5)
    parser.add_argument("--min-wind", type=float, default=34.0)
    parser.add_argument("--accessed", default=dt.datetime.now(dt.timezone.utc).date().isoformat())
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        return 0
    if not args.csv and not args.download_dir:
        parser.error("give --csv, --download-dir or --self-test")

    last_modified = args.source_last_modified
    path = args.csv
    if args.download_dir:
        path, last_modified = download(SOURCE_URL, args.download_dir)
    try:
        digest = sha256_of(path)
        cells, storms, width, pairs = build_cells(
            iter_incidences(read_rows(path), args.first_year, args.last_year, args.box, args.min_wind)
        )
        med = mediterranean_report(path, args.first_year, args.last_year)
    finally:
        if args.download_dir and not args.keep_download and path and os.path.exists(path):
            os.remove(path)

    years = args.last_year - args.first_year + 1
    subset = f"since1980 list, {args.first_year}-{args.last_year}, all basins"
    meta: Dict[str, object] = {
        "format": "thalassa.tc-climatology",
        "version": 1,
        "title": f"Tropical cyclones per {args.box}-degree box per month, {args.first_year}-{args.last_year}",
        "source": SOURCE,
        "credit": (
            "NOAA's International Best Track Archive for Climate Stewardship (IBTrACS) v04r01, "
            f"accessed {args.accessed}"
        ),
        "citation": DATASET_CITATION.format(subset=subset, accessed=args.accessed),
        "paper": PAPER_CITATION,
        "terms": TERMS,
        "inputFile": os.path.basename(path),
        "inputSha256": digest,
        "inputLastModified": last_modified,
        "accessed": args.accessed,
        "firstYear": args.first_year,
        "lastYear": args.last_year,
        "years": years,
        "boxDeg": args.box,
        "minWindKt": args.min_wind if args.min_wind % 1 else int(args.min_wind),
        "rule": (
            "One storm = one IBTrACS SID (spur tracks skipped). It counts once in a box and calendar month "
            f"(UTC) when any fix there is at {args.min_wind:g} kt or more on WMO_WIND or USA_WIND and has "
            f"NATURE TS, or NATURE NR or MX within {UNSURE_NATURE_MAX_ABS_LAT:g} degrees of the equator; "
            "ET, SS and DS never count."
        ),
        "storms": storms,
        "stormBoxMonths": pairs,
        "idWidth": width,
        "idAlphabet": ALPHABET,
    }
    text = render_json(meta, cells)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text)

    print(f"storms {storms}, storm-box-months {pairs}, boxes {len(cells)}, id width {width}")
    print(f"wrote {args.out}: {len(text.encode('utf-8'))} bytes")
    print("Mediterranean boxes, every main-track fix of any nature or wind:")
    for line in med or ["(none)"]:
        print("  " + line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
