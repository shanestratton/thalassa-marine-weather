#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  THALASSA — GEBCO Tile Generator                                           ║
║  Splits Zarr store into 10°×10° binary tiles for Supabase Storage          ║
╚══════════════════════════════════════════════════════════════════════════════╝

Reads the chunked Zarr store (from gebco_ingest.py) and exports regional
tiles as flat Int16 binary arrays, ready to upload to Supabase Storage.

Each tile:
  - Covers 10° lat × 10° lon
  - Resolution: 2 arc-minutes (300 × 300 cells = 180 KB raw)
  - Format: row-major Int16 little-endian
  - Filename: gebco_tile_{lat}_{lon}.bin
    (lat/lon = floor of bottom-left corner, e.g., gebco_tile_-30_150.bin)

Upload to Supabase:
  supabase storage create gebco-tiles --public
  for f in tiles/*.bin; do
    supabase storage cp "$f" ss:///gebco-tiles/$(basename "$f")
  done

Only tiles containing water are exported (pure-land tiles are skipped).
Typical ocean coverage: ~400 tiles ≈ 72 MB total.

Usage:
    python gebco_tile_generator.py --zarr ./gebco_zarr --output ./tiles
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import xarray as xr


def generate_tiles(zarr_path: str, output_dir: str, tile_deg: int = 10, res_arcmin: int = 2) -> None:
    """Generate binary tiles from the Zarr store."""
    print(f"╔{'═' * 60}╗")
    print(f"║  THALASSA GEBCO Tile Generator{' ' * 29}║")
    print(f"╚{'═' * 60}╝")
    print()

    zarr = Path(zarr_path)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    if not zarr.exists():
        print(f"  ✗ Zarr store not found: {zarr}")
        print(f"    Run gebco_ingest.py first to create it.")
        sys.exit(1)

    ds = xr.open_zarr(str(zarr), consolidated=True)
    print(f"  Source: {zarr}")
    print(f"  Tile size: {tile_deg}° × {tile_deg}°")
    print(f"  Resolution: {res_arcmin} arc-min ({tile_deg * 60 // res_arcmin} cells per axis)")
    print()

    cells_per_axis = tile_deg * 60 // res_arcmin  # e.g., 300 for 10° at 2'
    step = res_arcmin / 60  # degrees per cell

    total_tiles = 0
    skipped_land = 0
    total_bytes = 0
    t0 = time.time()

    for lat_start in range(-90, 90, tile_deg):
        for lon_start in range(-180, 180, tile_deg):
            lat_end = lat_start + tile_deg
            lon_end = lon_start + tile_deg

            # Slice the Zarr store
            try:
                region = ds["elevation"].sel(
                    lat=slice(lat_start, lat_end - step),
                    lon=slice(lon_start, lon_end - step),
                )
            except Exception as e:
                print(f"    ⚠ Skip ({lat_start},{lon_start}): {e}")
                continue

            # Coarsen to target resolution
            src_res = abs(float(ds.lat[1] - ds.lat[0]))
            coarsen_factor = max(1, round(step / src_res))

            if coarsen_factor > 1:
                region = region.coarsen(
                    lat=coarsen_factor,
                    lon=coarsen_factor,
                    boundary="trim",
                ).min()  # min() = conservative (shallowest depth)

            data = region.compute().values.astype(np.int16)

            # Skip pure-land tiles (no water at all)
            if np.all(data > 0):
                skipped_land += 1
                continue

            # Resize to exact target dimensions
            if data.shape != (cells_per_axis, cells_per_axis):
                # Pad or trim if necessary
                tile = np.full((cells_per_axis, cells_per_axis), 1, dtype=np.int16)  # land default
                h = min(data.shape[0], cells_per_axis)
                w = min(data.shape[1], cells_per_axis)
                tile[:h, :w] = data[:h, :w]
                data = tile

            # Write binary tile
            filename = f"gebco_tile_{lat_start}_{lon_start}.bin"
            filepath = out / filename
            data.tofile(str(filepath))

            tile_bytes = filepath.stat().st_size
            total_bytes += tile_bytes
            total_tiles += 1

            water_pct = 100.0 * np.mean(data <= 0)
            print(f"  ✓ {filename:>35s}  {data.shape[0]}×{data.shape[1]}  "
                  f"{tile_bytes / 1024:.0f} KB  {water_pct:.0f}% water")

    ds.close()
    elapsed = time.time() - t0

    print()
    print(f"{'═' * 64}")
    print(f"  ✓ Generated {total_tiles} tiles in {elapsed:.1f}s")
    print(f"    Skipped {skipped_land} pure-land tiles")
    print(f"    Total size: {total_bytes / (1024 * 1024):.1f} MB")
    print(f"    Output: {out}")
    print()
    print(f"  Upload to Supabase:")
    print(f"    supabase storage create gebco-tiles --public")
    print(f"    for f in {out}/*.bin; do")
    print(f"      supabase storage cp \"$f\" ss:///gebco-tiles/$(basename \"$f\")")
    print(f"    done")
    print(f"{'═' * 64}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Generate binary GEBCO tiles for Supabase Storage",
    )
    parser.add_argument("--zarr", "-z", required=True, help="Path to GEBCO Zarr store")
    parser.add_argument("--output", "-o", default="./tiles", help="Output directory for .bin tiles")
    parser.add_argument("--tile-size", "-t", type=int, default=10, help="Tile size in degrees (default: 10)")
    parser.add_argument("--resolution", "-r", type=int, default=2, help="Resolution in arc-minutes (default: 2)")

    args = parser.parse_args()
    generate_tiles(args.zarr, args.output, args.tile_size, args.resolution)
