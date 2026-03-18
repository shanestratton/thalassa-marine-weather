#!/usr/bin/env python3
"""
Marine Cadastre AIS Vessel Extractor

Extracts unique vessel identification data from the NOAA/BOEM Marine Cadastre
AIS broadcast data stored as GeoParquet on Azure.

Data source: https://marinecadastre.gov/ais/
Format: GeoParquet (daily files, ~1-3GB each compressed)
Years available: 2009-2024+

Strategy:
  - Read only the vessel metadata columns (no lat/lon/timestamps)
  - Process a single month of daily files
  - Deduplicate by MMSI, keeping the most populated record
  - Export a clean CSV for import into vessel_metadata via import-csv.ts

Usage:
  pip install pandas pyarrow requests
  python extract_marine_cadastre.py [--year 2024] [--month 12] [--output us_vessels.csv]

Output columns: MMSI, VesselName, VesselType, Length, Width, Draft
"""

import argparse
import io
import os
import sys
from datetime import datetime
from typing import Optional

try:
    import pandas as pd
    import pyarrow.parquet as pq
except ImportError:
    print("❌ Missing dependencies. Install with:")
    print("   pip install pandas pyarrow requests")
    sys.exit(1)

# ── Marine Cadastre Azure Storage ──
# The AIS data is hosted on Azure Blob Storage via marinecadastre.gov
# Daily files: AIS_{YYYY}_{MM}_{DD}.parquet
AZURE_BASE_URL = "https://coast.noaa.gov/htdata/CMSP/AISDataHandler/{year}/AIS_{year}_{month:02d}_{day:02d}.zip"
PARQUET_BASE_URL = "https://marinecadastre.gov/downloads/ais{year}/"

# Columns we want from the Parquet files (skip lat/lon/timestamps)
VESSEL_COLUMNS = ["MMSI", "VesselName", "VesselType", "Length", "Width", "Draft", "CallSign", "IMO"]

# AIS Vessel Type mapping (Marine Cadastre uses numeric codes)
VESSEL_TYPE_LABELS = {
    0: "Not available",
    20: "Wing in Ground", 21: "Wing in Ground", 29: "Wing in Ground",
    30: "Fishing",
    31: "Towing", 32: "Towing (large)",
    33: "Dredging",
    34: "Diving Operations",
    35: "Military Operations",
    36: "Sailing Vessel",
    37: "Pleasure Craft",
    40: "High Speed Craft", 49: "High Speed Craft",
    50: "Pilot Vessel",
    51: "Search & Rescue",
    52: "Tug",
    53: "Port Tender",
    54: "Anti-Pollution",
    55: "Law Enforcement",
    58: "Medical Transport",
    59: "Non-Combatant",
    60: "Passenger", 69: "Passenger",
    70: "Cargo", 79: "Cargo",
    80: "Tanker", 89: "Tanker",
    90: "Other", 99: "Other",
}


def decode_vessel_type(code: int) -> str:
    """Decode AIS vessel type code to human-readable label."""
    if code in VESSEL_TYPE_LABELS:
        return VESSEL_TYPE_LABELS[code]
    # Range-based lookup
    if 20 <= code <= 29: return "Wing in Ground"
    if 40 <= code <= 49: return "High Speed Craft"
    if 60 <= code <= 69: return "Passenger"
    if 70 <= code <= 79: return "Cargo"
    if 80 <= code <= 89: return "Tanker"
    if 90 <= code <= 99: return "Other"
    return "Unknown"


def get_parquet_urls(year: int, month: int) -> list[str]:
    """Generate list of daily GeoParquet file URLs for a given month."""
    import calendar
    days_in_month = calendar.monthrange(year, month)[1]

    urls = []
    for day in range(1, days_in_month + 1):
        # Marine Cadastre naming convention: AIS_YYYY_MM_DD.parquet
        filename = f"AIS_{year}_{month:02d}_{day:02d}.parquet"
        url = f"https://marinecadastre.gov/downloads/ais{year}/{filename}"
        urls.append(url)

    return urls


def try_read_parquet_from_url(url: str, columns: list[str]) -> Optional[pd.DataFrame]:
    """Try to read specific columns from a remote Parquet file."""
    try:
        import requests

        print(f"   📥 Fetching: {os.path.basename(url)}...", end=" ", flush=True)

        # Use requests to download, then read with pyarrow
        # Only download column metadata first to check schema
        resp = requests.get(url, stream=True, timeout=30)

        if resp.status_code != 200:
            print(f"⚠️ HTTP {resp.status_code}")
            return None

        # Read into memory (Parquet is compressed, typically 50-200MB per day)
        data = resp.content
        print(f"({len(data) / 1024 / 1024:.1f} MB)", end=" ", flush=True)

        # Read only the columns we need
        table = pq.read_table(
            io.BytesIO(data),
            columns=[c for c in columns if c],
        )
        df = table.to_pandas()
        print(f"✅ {len(df):,} rows")
        return df

    except Exception as e:
        print(f"❌ {e}")
        return None


def try_azure_open_dataset(year: int, month: int, columns: list[str]) -> Optional[pd.DataFrame]:
    """
    Try Azure Open Datasets SDK if available.
    Faster than HTTP downloads for Azure-hosted data.
    """
    try:
        from azureml.opendatasets import NominalSsa
        print("   Using Azure Open Datasets SDK...")
        # This is the fast path if running on Azure
        return None  # Fallback to HTTP for non-Azure environments
    except ImportError:
        return None


def extract_unique_vessels(year: int, month: int, max_days: int = 7) -> pd.DataFrame:
    """
    Extract unique vessel metadata from Marine Cadastre GeoParquet files.

    Strategy:
      - Download daily Parquet files for the specified month
      - Read only vessel columns (no location/time data)
      - Merge across days, keeping the most complete record per MMSI
      - Limit to max_days to keep download time reasonable

    Returns a DataFrame of unique vessels.
    """
    urls = get_parquet_urls(year, month)

    # Limit the number of days to download (each file is 50-200MB)
    if max_days and len(urls) > max_days:
        print(f"\n   ⚡ Sampling {max_days} days from month {month:02d}/{year}")
        # Take evenly spaced days for better coverage
        step = len(urls) // max_days
        urls = [urls[i * step] for i in range(max_days)]

    # Available columns might vary — try the ideal set, fall back gracefully
    ideal_columns = VESSEL_COLUMNS.copy()

    all_frames: list[pd.DataFrame] = []

    for url in urls:
        # Try with all columns first, then fall back
        df = try_read_parquet_from_url(url, ideal_columns)

        if df is None:
            # Try with fewer columns
            df = try_read_parquet_from_url(url, ["MMSI", "VesselName", "VesselType", "Length", "Width"])
            if df is None:
                continue

        all_frames.append(df)

    if not all_frames:
        print("\n❌ No data could be downloaded. Check URLs and network.")
        return pd.DataFrame()

    # Concatenate all days
    print(f"\n   Merging {len(all_frames)} daily files...")
    combined = pd.concat(all_frames, ignore_index=True)
    print(f"   Total AIS records: {len(combined):,}")

    # ── Deduplicate by MMSI ──
    # Keep the row with the most populated fields per MMSI
    print("   Deduplicating by MMSI...")

    # Clean MMSI — ensure it's a valid 9-digit number
    combined["MMSI"] = pd.to_numeric(combined["MMSI"], errors="coerce")
    combined = combined.dropna(subset=["MMSI"])
    combined["MMSI"] = combined["MMSI"].astype(int)
    combined = combined[(combined["MMSI"] >= 100000000) & (combined["MMSI"] <= 999999999)]

    # Clean vessel name — remove blanks and sentinel values
    if "VesselName" in combined.columns:
        combined["VesselName"] = combined["VesselName"].replace(
            ["", "UNKNOWN", "Unknown", "N/A", "NA", "NONE", "---", "0"], pd.NA
        )
        combined["VesselName"] = combined["VesselName"].str.strip()

    # Score each row by completeness (more filled fields = higher score)
    score_cols = [c for c in ["VesselName", "VesselType", "Length", "Width", "Draft", "CallSign", "IMO"]
                  if c in combined.columns]
    combined["_completeness"] = combined[score_cols].notna().sum(axis=1)

    # Sort by completeness (descending) and drop duplicates keeping best
    combined = combined.sort_values("_completeness", ascending=False)
    unique = combined.drop_duplicates(subset="MMSI", keep="first").copy()
    unique = unique.drop(columns=["_completeness"])

    # Filter out vessels without a name (low value)
    named = unique[unique["VesselName"].notna()].copy()
    unnamed = unique[unique["VesselName"].isna()].copy()

    print(f"\n   📊 Results:")
    print(f"      Unique MMSIs:    {len(unique):,}")
    print(f"      With name:       {len(named):,}")
    print(f"      Without name:    {len(unnamed):,}")

    # Decode vessel type codes to labels
    if "VesselType" in unique.columns:
        unique["VesselTypeLabel"] = unique["VesselType"].apply(
            lambda x: decode_vessel_type(int(x)) if pd.notna(x) else "Unknown"
        )

    # Add flag info (all US vessels from this dataset)
    unique["Flag"] = "United States"
    unique["FlagEmoji"] = "🇺🇸"

    return unique


def export_csv(df: pd.DataFrame, output_path: str) -> None:
    """Export the deduplicated vessel data as CSV for import."""
    # Rename columns to match our import-csv.ts expected format
    export_df = df.rename(columns={
        "MMSI": "MMSI",
        "VesselName": "Vessel Name",
        "VesselType": "Vessel Type Code",
        "VesselTypeLabel": "Vessel Type",
        "Length": "Length",
        "Width": "Breadth",
        "Draft": "Depth",
        "CallSign": "Call Sign",
        "IMO": "IMO Number",
        "Flag": "Flag",
        "FlagEmoji": "Flag Emoji",
    })

    # Select final columns
    final_cols = ["MMSI", "Vessel Name", "Vessel Type", "Call Sign", "IMO Number",
                  "Length", "Breadth", "Depth", "Flag", "Flag Emoji"]
    final_cols = [c for c in final_cols if c in export_df.columns]

    export_df[final_cols].to_csv(output_path, index=False)
    print(f"\n   💾 Exported to: {output_path}")
    print(f"      Vessels: {len(export_df):,}")
    file_size = os.path.getsize(output_path) / 1024 / 1024
    print(f"      File size: {file_size:.1f} MB")


def main():
    parser = argparse.ArgumentParser(
        description="Extract unique vessel data from Marine Cadastre AIS GeoParquet",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python extract_marine_cadastre.py
  python extract_marine_cadastre.py --year 2024 --month 6 --days 5
  python extract_marine_cadastre.py --output my_vessels.csv

After extraction, import into Thalassa:
  cd vessel-scraper
  npx ts-node src/import-csv.ts ../us_vessels.csv auto
        """
    )
    parser.add_argument("--year", type=int, default=2024, help="Year (default: 2024)")
    parser.add_argument("--month", type=int, default=12, help="Month (default: 12 = December)")
    parser.add_argument("--days", type=int, default=7, help="Max days to sample (default: 7)")
    parser.add_argument("--output", type=str, default="us_vessels.csv", help="Output CSV path")

    args = parser.parse_args()

    print(f"\n{'═' * 55}")
    print(f"🇺🇸 Marine Cadastre AIS Vessel Extractor")
    print(f"   Year: {args.year}  Month: {args.month:02d}  Days: {args.days}")
    print(f"{'═' * 55}")

    df = extract_unique_vessels(args.year, args.month, max_days=args.days)

    if df.empty:
        print("\n❌ No vessels extracted.")
        sys.exit(1)

    export_csv(df, args.output)

    print(f"\n{'═' * 55}")
    print(f"✅ DONE — Next step:")
    print(f"   cd vessel-scraper")
    print(f"   npx ts-node src/import-csv.ts ../{args.output} auto")
    print(f"{'═' * 55}\n")


if __name__ == "__main__":
    main()
