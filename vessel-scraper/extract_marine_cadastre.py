#!/usr/bin/env python3
"""
Marine Cadastre AIS Vessel Extractor

Extracts unique vessel identification data from NOAA/BOEM Marine Cadastre
AIS broadcast data (ZIP/CSV format hosted on NOAA servers).

Data source: https://coast.noaa.gov/htdata/CMSP/AISDataHandler/
Format: ZIP files containing daily CSVs (~300-500MB uncompressed each)

Strategy:
  - Download a small number of daily ZIP files (1-3 days is enough)
  - Read only the vessel metadata columns (skip lat/lon/timestamps)
  - Deduplicate by MMSI, keeping the most populated record
  - Export a clean CSV for import into vessel_metadata via import-csv.ts

Usage:
  pip3 install pandas requests
  python3 extract_marine_cadastre.py [--year 2024] [--month 1] [--days 1] [--output us_vessels.csv]

Output columns: MMSI, Vessel Name, Vessel Type, Call Sign, IMO Number, Length, Breadth, Depth
"""

import argparse
import csv
import io
import os
import sys
import zipfile
from typing import Optional

try:
    import pandas as pd
    import requests
except ImportError:
    print("Missing deps. Install with: pip3 install pandas requests")
    sys.exit(1)

# ── NOAA AIS data URL ──
NOAA_BASE = "https://coast.noaa.gov/htdata/CMSP/AISDataHandler/{year}/AIS_{year}_{month:02d}_{day:02d}.zip"

# Columns we want (skip lat/lon/timestamps to save memory)
WANT_COLS = ["MMSI", "VesselName", "VesselType", "Length", "Width", "Draft", "CallSign", "IMO"]

# AIS Vessel Type labels
def decode_type(code) -> str:
    try:
        c = int(code)
    except (ValueError, TypeError):
        return "Unknown"
    if c == 30: return "Fishing"
    if c in (31, 32): return "Towing"
    if c == 33: return "Dredger"
    if c == 34: return "Diving Ops"
    if c == 35: return "Military"
    if c == 36: return "Sailing"
    if c == 37: return "Pleasure Craft"
    if c == 52: return "Tug"
    if c == 50: return "Pilot"
    if c == 51: return "SAR"
    if c == 55: return "Law Enforcement"
    if 20 <= c <= 29: return "WIG"
    if 40 <= c <= 49: return "High Speed Craft"
    if 60 <= c <= 69: return "Passenger"
    if 70 <= c <= 79: return "Cargo"
    if 80 <= c <= 89: return "Tanker"
    if 90 <= c <= 99: return "Other"
    return "Vessel"


def download_and_extract(year: int, month: int, day: int) -> Optional[pd.DataFrame]:
    """Download a daily AIS ZIP, extract CSV, return vessel columns only."""
    url = NOAA_BASE.format(year=year, month=month, day=day)
    fname = os.path.basename(url)

    print(f"   📥 Downloading {fname}...", end=" ", flush=True)
    try:
        resp = requests.get(url, stream=True, timeout=120)
        if resp.status_code != 200:
            print(f"⚠️ HTTP {resp.status_code}")
            return None

        size_mb = len(resp.content) / 1024 / 1024
        print(f"({size_mb:.1f} MB)", end=" ", flush=True)

        # Extract CSV from ZIP
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            csv_names = [n for n in zf.namelist() if n.endswith('.csv')]
            if not csv_names:
                print("⚠️ No CSV in ZIP")
                return None

            with zf.open(csv_names[0]) as csvfile:
                # Read only the columns we need
                # First peek at headers
                raw = io.TextIOWrapper(csvfile, encoding='utf-8')
                reader = csv.reader(raw)
                headers = next(reader)

                # Find indices of columns we want
                available = [c for c in WANT_COLS if c in headers]
                if "MMSI" not in available:
                    print("⚠️ No MMSI column")
                    return None

                print(f"reading...", end=" ", flush=True)

        # Re-read with pandas using only needed columns
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            with zf.open(csv_names[0]) as csvfile:
                df = pd.read_csv(
                    csvfile,
                    usecols=available,
                    dtype=str,   # Read all as string to avoid mixed-type issues
                    low_memory=True,
                )

        print(f"✅ {len(df):,} rows, {len(available)} cols")
        return df

    except Exception as e:
        print(f"❌ {e}")
        return None


def main():
    parser = argparse.ArgumentParser(description="Extract US vessel data from Marine Cadastre AIS")
    parser.add_argument("--year", type=int, default=2024, help="Year (default: 2024)")
    parser.add_argument("--month", type=int, default=1, help="Month (default: 1)")
    parser.add_argument("--days", type=int, default=1, help="Number of days to download (default: 1)")
    parser.add_argument("--output", type=str, default="us_vessels.csv", help="Output CSV path")
    args = parser.parse_args()

    print(f"\n{'═' * 55}")
    print(f"🇺🇸 Marine Cadastre AIS Vessel Extractor")
    print(f"   Year: {args.year}  Month: {args.month:02d}  Days: {args.days}")
    print(f"{'═' * 55}\n")

    # Download daily files
    frames = []
    for day in range(1, args.days + 1):
        df = download_and_extract(args.year, args.month, day)
        if df is not None:
            frames.append(df)

    if not frames:
        print("\n❌ No data downloaded. Check your network connection.")
        sys.exit(1)

    # Merge
    print(f"\n   Merging {len(frames)} files...")
    combined = pd.concat(frames, ignore_index=True)
    print(f"   Total AIS records: {len(combined):,}")

    # Clean MMSI
    combined["MMSI"] = pd.to_numeric(combined["MMSI"], errors="coerce")
    combined = combined.dropna(subset=["MMSI"])
    combined["MMSI"] = combined["MMSI"].astype(int)
    combined = combined[(combined["MMSI"] >= 100000000) & (combined["MMSI"] <= 999999999)]

    # Clean vessel name
    if "VesselName" in combined.columns:
        combined["VesselName"] = combined["VesselName"].replace(
            ["", "UNKNOWN", "Unknown", "N/A", "NA", "NONE", "---", "0", " "], pd.NA
        )
        combined["VesselName"] = combined["VesselName"].str.strip()

    # Score by completeness and deduplicate
    print("   Deduplicating by MMSI...")
    score_cols = [c for c in WANT_COLS if c in combined.columns and c != "MMSI"]
    combined["_score"] = combined[score_cols].notna().sum(axis=1)
    combined = combined.sort_values("_score", ascending=False)
    unique = combined.drop_duplicates(subset="MMSI", keep="first").drop(columns=["_score"])

    named = unique["VesselName"].notna().sum() if "VesselName" in unique.columns else 0

    print(f"\n   📊 Results:")
    print(f"      Unique MMSIs:    {len(unique):,}")
    print(f"      With name:       {named:,}")
    print(f"      Without name:    {len(unique) - named:,}")

    # Decode vessel type
    if "VesselType" in unique.columns:
        unique = unique.copy()
        unique["VesselTypeLabel"] = unique["VesselType"].apply(decode_type)

    # Add US flag
    unique = unique.copy()
    unique["Flag"] = "United States"

    # Rename for import-csv.ts compatibility
    rename_map = {
        "MMSI": "MMSI",
        "VesselName": "Vessel Name",
        "VesselTypeLabel": "Vessel Type",
        "CallSign": "Call Sign",
        "IMO": "IMO Number",
        "Length": "Length",
        "Width": "Breadth",
        "Draft": "Depth",
        "Flag": "Flag",
    }
    export = unique.rename(columns={k: v for k, v in rename_map.items() if k in unique.columns})

    final_cols = ["MMSI", "Vessel Name", "Vessel Type", "Call Sign", "IMO Number",
                  "Length", "Breadth", "Depth", "Flag"]
    final_cols = [c for c in final_cols if c in export.columns]

    export[final_cols].to_csv(args.output, index=False)

    fsize = os.path.getsize(args.output) / 1024 / 1024
    print(f"\n   💾 Saved: {args.output} ({fsize:.1f} MB)")
    print(f"\n{'═' * 55}")
    print(f"✅ DONE — Import with:")
    print(f"   cd vessel-scraper")
    print(f"   npx ts-node src/import-csv.ts {args.output} auto")
    print(f"{'═' * 55}\n")


if __name__ == "__main__":
    main()
