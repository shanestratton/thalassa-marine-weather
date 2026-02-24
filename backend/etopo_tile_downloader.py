#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  THALASSA — ETOPO Tile Generator (Direct HTTP Download)                    ║
║  Downloads bathymetry directly from NOAA ERDDAP → Supabase Storage tiles   ║
║                                                                            ║
║  No GEBCO download required — pulls ETOPO 2022 data via HTTP API.          ║
║  Only downloads tiles that contain water (skips pure-land regions).        ║
╚══════════════════════════════════════════════════════════════════════════════╝

This script:
1. Downloads ETOPO 2022 (1-arc-minute) bathymetry tile-by-tile from NOAA ERDDAP
2. Saves each 10°×10° region as a flat Int16 binary tile
3. Uploads tiles to Supabase Storage (gebco-tiles bucket)

Usage:
    python3 etopo_tile_downloader.py --output ./tiles --upload
"""

import argparse
import struct
import sys
import time
import os
import json
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

# ── Configuration ─────────────────────────────────────────────────

TILE_DEG = 10           # Degrees per tile
TARGET_RES_ARCMIN = 2   # Output resolution in arc-minutes
CELLS_PER_TILE = TILE_DEG * 60 // TARGET_RES_ARCMIN  # 300 for 2-arcmin
ETOPO_RES_ARCMIN = 1    # ETOPO native resolution
STRIDE = TARGET_RES_ARCMIN // ETOPO_RES_ARCMIN  # Downsample stride

# NOAA ERDDAP ETOPO 2022 endpoint
ERDDAP_BASE = "https://www.ngdc.noaa.gov/thredds/dodsC/global/ETOPO2022/60s/60s_bed_elev_netcdf/ETOPO_2022_v1_60s_N90W180_bed.nc"

# Regions to focus on (lat_min, lat_max, lon_min, lon_max)
# These cover the major sailing areas. Skip polar/deep-land regions.
SAILING_REGIONS = [
    # Australia / SE Asia / Pacific
    (-50, 10, 100, 180),
    (-50, 10, -180, -120),
    # Indian Ocean
    (-40, 30, 30, 100),
    # Atlantic
    (-60, 60, -80, 10),
    # Mediterranean / Europe
    (30, 60, -10, 40),
    # Caribbean / Central America
    (0, 30, -100, -50),
    # North Pacific
    (10, 60, 100, 180),
    (10, 60, -180, -100),
]


def lat_to_idx(lat: float) -> int:
    """Convert latitude to ETOPO grid index (1-arc-min, N→S)."""
    return round((90 - lat) * 60)


def lon_to_idx(lon: float) -> int:
    """Convert longitude to ETOPO grid index (1-arc-min, W→E, -180 to 180)."""
    return round((lon + 180) * 60)


def download_tile(lat_start: int, lon_start: int, output_dir: Path) -> tuple[str, bool]:
    """
    Download a single 10°×10° tile from NOAA ERDDAP.
    Returns (filename, success).
    """
    lat_end = lat_start + TILE_DEG
    lon_end = lon_start + TILE_DEG

    filename = f"gebco_tile_{lat_start}_{lon_start}.bin"
    filepath = output_dir / filename

    # Skip if already exists
    if filepath.exists() and filepath.stat().st_size > 0:
        return filename, True

    # Calculate ETOPO grid indices (note: latitude is N→S in ETOPO)
    # We want lat_start (south) to lat_end (north), stride by TARGET_RES
    y_start = lat_to_idx(lat_end)    # North (smaller index)
    y_end = lat_to_idx(lat_start)    # South (larger index)
    x_start = lon_to_idx(lon_start)  # West
    x_end = lon_to_idx(lon_end)      # East

    # Build OPeNDAP URL for ASCII subset
    # z[y_start:stride:y_end][x_start:stride:x_end]
    url = f"{ERDDAP_BASE}.ascii?z[{y_start}:{STRIDE}:{y_end}][{x_start}:{STRIDE}:{x_end}]"

    try:
        req = Request(url, headers={"User-Agent": "Thalassa-Marine-Router/1.0"})
        with urlopen(req, timeout=60) as resp:
            text = resp.read().decode("utf-8", errors="replace")

        # Parse the OPeNDAP ASCII response
        # Format: header lines, then data lines with comma-separated values
        # Find where the data starts (after the separator line)
        lines = text.split("\n")
        data_start = None
        for i, line in enumerate(lines):
            if line.strip().startswith("---"):
                data_start = i + 1
                break

        if data_start is None:
            # Try alternative parsing — look for lines starting with digits
            data_start = 0
            for i, line in enumerate(lines):
                stripped = line.strip()
                if stripped and (stripped[0].isdigit() or stripped[0] == '-' or stripped[0] == '['):
                    data_start = i
                    break

        # Extract elevation values
        values = []
        for line in lines[data_start:]:
            line = line.strip()
            if not line or line.startswith("z,") or line.startswith("z."):
                continue

            # Handle array notation: [row_idx] val1, val2, val3...
            if line.startswith("["):
                # Strip the row index prefix: [0][0] val1, val2...
                bracket_end = line.rfind("]")
                if bracket_end >= 0:
                    line = line[bracket_end + 1:].strip()
                    if line.startswith(","):
                        line = line[1:].strip()

            for part in line.split(","):
                part = part.strip()
                # Remove any remaining bracket notation
                if "[" in part:
                    part = part.split("]")[-1].strip()
                try:
                    val = int(float(part))
                    values.append(val)
                except (ValueError, IndexError):
                    continue

        if len(values) < 10:
            print(f"    ⚠ {filename}: Only {len(values)} values parsed — skipping")
            return filename, False

        # Check if entire tile is land (all values > 0)
        has_water = any(v <= 0 for v in values)
        if not has_water:
            return filename, False  # Pure land — skip

        # Reshape to CELLS_PER_TILE × CELLS_PER_TILE
        # May need padding if we got fewer values than expected
        expected = CELLS_PER_TILE * CELLS_PER_TILE
        tile = [1] * expected  # Default to land (elevation = 1)

        for i in range(min(len(values), expected)):
            tile[i] = max(-32768, min(32767, values[i]))

        # Write as raw Int16 little-endian
        with open(filepath, "wb") as f:
            for v in tile:
                f.write(struct.pack("<h", v))

        water_pct = sum(1 for v in tile if v <= 0) / len(tile) * 100
        size_kb = filepath.stat().st_size / 1024
        print(f"  ✓ {filename:>35s}  {CELLS_PER_TILE}×{CELLS_PER_TILE}  "
              f"{size_kb:.0f} KB  {water_pct:.0f}% water  ({len(values)} vals)")

        return filename, True

    except HTTPError as e:
        print(f"    ⚠ {filename}: HTTP {e.code} — {e.reason}")
        return filename, False
    except URLError as e:
        print(f"    ⚠ {filename}: Network error — {e.reason}")
        return filename, False
    except Exception as e:
        print(f"    ⚠ {filename}: Error — {e}")
        return filename, False


def upload_to_supabase(tiles_dir: Path) -> int:
    """Upload tiles to Supabase Storage using the Management API."""
    supabase_url = os.environ.get("SUPABASE_URL", "")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not supabase_url or not service_key:
        # Try to read from .env
        env_path = Path(__file__).parent.parent / ".env"
        if env_path.exists():
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("VITE_SUPABASE_URL="):
                        supabase_url = line.split("=", 1)[1].strip().strip("'\"")
                    elif line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                        service_key = line.split("=", 1)[1].strip().strip("'\"")

    if not supabase_url or not service_key:
        print("\n  ⚠ Cannot upload — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
        print("    or add them to .env in the project root.")
        return 0

    # Create bucket if it doesn't exist
    try:
        create_url = f"{supabase_url}/storage/v1/bucket"
        data = json.dumps({"id": "gebco-tiles", "name": "gebco-tiles", "public": True}).encode()
        req = Request(create_url, data=data, method="POST", headers={
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        })
        urlopen(req, timeout=10)
        print("  ✓ Created 'gebco-tiles' bucket")
    except HTTPError as e:
        if e.code == 409:
            print("  ✓ 'gebco-tiles' bucket already exists")
        else:
            print(f"  ⚠ Bucket creation: HTTP {e.code}")

    # Upload each tile
    uploaded = 0
    tiles = sorted(tiles_dir.glob("*.bin"))
    print(f"\n  Uploading {len(tiles)} tiles...")

    for tile_path in tiles:
        try:
            with open(tile_path, "rb") as f:
                tile_data = f.read()

            upload_url = f"{supabase_url}/storage/v1/object/gebco-tiles/{tile_path.name}"
            req = Request(upload_url, data=tile_data, method="POST", headers={
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/octet-stream",
                "x-upsert": "true",
            })
            urlopen(req, timeout=30)
            uploaded += 1
            print(f"  ↑ {tile_path.name} ({tile_path.stat().st_size / 1024:.0f} KB)")
        except HTTPError as e:
            print(f"  ⚠ {tile_path.name}: HTTP {e.code}")
        except Exception as e:
            print(f"  ⚠ {tile_path.name}: {e}")

    return uploaded


def main():
    parser = argparse.ArgumentParser(description="Download ETOPO tiles for Thalassa routing")
    parser.add_argument("--output", "-o", default="./tiles", help="Output directory")
    parser.add_argument("--upload", action="store_true", help="Upload to Supabase Storage")
    parser.add_argument("--global", dest="global_coverage", action="store_true",
                        help="Download all ocean tiles globally (slower)")
    args = parser.parse_args()

    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    print(f"╔{'═' * 60}╗")
    print(f"║  THALASSA ETOPO Tile Downloader{' ' * 28}║")
    print(f"╚{'═' * 60}╝")
    print()
    print(f"  Resolution: {TARGET_RES_ARCMIN} arc-min ({CELLS_PER_TILE}×{CELLS_PER_TILE} cells per tile)")
    print(f"  Tile size:  {TILE_DEG}° × {TILE_DEG}°")
    print(f"  Output:     {out}")
    print()

    # Determine which tiles to download
    tiles_to_download = set()

    if args.global_coverage:
        # All ocean regions
        for lat in range(-80, 80, TILE_DEG):
            for lon in range(-180, 180, TILE_DEG):
                tiles_to_download.add((lat, lon))
    else:
        # Only sailing regions
        for min_lat, max_lat, min_lon, max_lon in SAILING_REGIONS:
            for lat in range(int(min_lat) // TILE_DEG * TILE_DEG,
                             int(max_lat) // TILE_DEG * TILE_DEG + TILE_DEG,
                             TILE_DEG):
                for lon in range(int(min_lon) // TILE_DEG * TILE_DEG,
                                 int(max_lon) // TILE_DEG * TILE_DEG + TILE_DEG,
                                 TILE_DEG):
                    if -80 <= lat < 80:
                        tiles_to_download.add((lat, lon))

    print(f"  Tiles to download: {len(tiles_to_download)}")
    print()

    t0 = time.time()
    success = 0
    skipped = 0
    failed = 0

    sorted_tiles = sorted(tiles_to_download)
    for i, (lat, lon) in enumerate(sorted_tiles):
        # Rate limit (be nice to NOAA)
        if i > 0:
            time.sleep(0.5)

        filename, ok = download_tile(lat, lon, out)
        if ok:
            if (out / filename).exists():
                success += 1
            else:
                skipped += 1  # Pure land
        else:
            if not (out / filename).exists():
                skipped += 1
            else:
                failed += 1

        # Progress
        if (i + 1) % 10 == 0:
            elapsed = time.time() - t0
            rate = (i + 1) / elapsed if elapsed > 0 else 0
            remaining = (len(sorted_tiles) - i - 1) / rate if rate > 0 else 0
            print(f"  --- Progress: {i + 1}/{len(sorted_tiles)} "
                  f"({success} ok, {skipped} land, {failed} fail) "
                  f"~{remaining / 60:.0f}m remaining ---")

    elapsed = time.time() - t0

    # Count actual tiles on disk
    tile_files = list(out.glob("*.bin"))
    total_mb = sum(f.stat().st_size for f in tile_files) / (1024 * 1024)

    print()
    print(f"{'═' * 64}")
    print(f"  ✓ Download complete in {elapsed / 60:.1f} minutes")
    print(f"    Water tiles: {len(tile_files)}")
    print(f"    Land tiles skipped: {skipped}")
    print(f"    Failed: {failed}")
    print(f"    Total size: {total_mb:.1f} MB")
    print(f"{'═' * 64}")

    # Upload
    if args.upload:
        print()
        print("  Uploading to Supabase Storage...")
        uploaded = upload_to_supabase(out)
        print(f"\n  ✓ Uploaded {uploaded} tiles to Supabase Storage")


if __name__ == "__main__":
    main()
