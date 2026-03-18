#!/usr/bin/env python3
"""
Import AMSA Ship Register CSV directly into the amsa_register Supabase table.
No MMSI needed — stores all 7,490 vessels for real-time AIS name lookups.

Usage:
  python3 import_amsa_direct.py --csv ~/Desktop/AU.csv
"""

import argparse
import os
import sys

try:
    import pandas as pd
    import requests
except ImportError:
    print("❌ pip3 install pandas requests")
    sys.exit(1)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://pcisdplnodrphauixcau.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def upsert_batch(rows: list, headers: dict) -> int:
    """Upsert a batch of rows into amsa_register."""
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/amsa_register",
        json=rows,
        headers={
            **headers,
            "Prefer": "resolution=merge-duplicates",
        },
        timeout=30,
    )
    if resp.status_code in (200, 201):
        return len(rows)
    else:
        print(f"   ⚠️ HTTP {resp.status_code}: {resp.text[:200]}")
        return 0


def main():
    parser = argparse.ArgumentParser(description="Import AMSA Register into Supabase")
    parser.add_argument("--csv", default=os.path.expanduser("~/Desktop/AU.csv"))
    args = parser.parse_args()

    if not SUPABASE_KEY:
        print("❌ Set SUPABASE_SERVICE_KEY env var")
        sys.exit(1)

    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }

    print(f"\n{'═' * 55}")
    print(f"🇦🇺 AMSA Register → Supabase Direct Import")
    print(f"{'═' * 55}\n")

    df = pd.read_csv(args.csv, dtype=str)
    df.columns = [c.strip() for c in df.columns]
    print(f"   📋 Loaded {len(df):,} vessels from {args.csv}")

    # Build rows
    rows = []
    for _, r in df.iterrows():
        name = str(r.get("Ship name", "")).strip()
        official = str(r.get("Official number", "")).strip()
        if not name or not official:
            continue

        imo = str(r.get("IMO number", "")).strip()
        length_str = str(r.get("Length", "")).strip()
        year_str = str(r.get("Year of completion", "")).strip()

        # All keys must be present in every row (PostgREST requirement)
        imo_val = imo if imo and imo not in ("", "nan", "None") else None
        try:
            length_val = float(length_str) if length_str and length_str not in ("", "nan", "None") else None
        except ValueError:
            length_val = None
        try:
            year_val = int(float(year_str)) if year_str and year_str not in ("", "nan", "None", "0") else None
        except ValueError:
            year_val = None

        row = {
            "official_number": official,
            "ship_name": name,
            "imo_number": imo_val,
            "length_m": length_val,
            "year_built": year_val,
            "vessel_type": str(r.get("Type", "")).strip() or None,
            "home_port": str(r.get("Home port", "")).strip() or None,
            "status": str(r.get("Status", "")).strip() or "Registered",
        }

        rows.append(row)

    print(f"   Parsed {len(rows):,} valid vessels\n")

    # Upsert in batches of 500
    total = 0
    batch_size = 500
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        n = upsert_batch(batch, headers)
        total += n
        print(f"   ... {min(i + batch_size, len(rows)):,}/{len(rows):,} — {total:,} loaded", flush=True)

    print(f"\n{'═' * 55}")
    print(f"✅ IMPORT COMPLETE: {total:,} vessels in amsa_register")
    print(f"{'═' * 55}\n")


if __name__ == "__main__":
    main()
