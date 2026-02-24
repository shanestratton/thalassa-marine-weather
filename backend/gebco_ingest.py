#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  THALASSA — GEBCO Bathymetry Ingestion Pipeline                            ║
║  Converts raw GEBCO NetCDF → Chunked Zarr Store                            ║
║                                                                            ║
║  Input:  GEBCO_2024.nc  (≈7.5 GB, 15-arc-second global grid)              ║
║  Output: gebco_zarr/    (≈1.2 GB Zarr store with Blosc/Zstd compression)  ║
╚══════════════════════════════════════════════════════════════════════════════╝

Usage:
    python gebco_ingest.py --input GEBCO_2024.nc --output ./gebco_zarr

The Zarr store is spatially chunked so the A* routing engine can load
ONLY the regional tile it needs (e.g., Coral Sea, Arafura Sea) without
touching the rest of the globe.

Chunk Size Strategy:
────────────────────
GEBCO 2024 is a regular grid at 15-arc-second (0.004167°) resolution:
  - 86,400 columns (lon) × 43,200 rows (lat)
  - Each cell is ~450m at the equator

For offshore passages spanning 500–3000 NM:
  - A bounding box typically covers 10°–40° in each axis
  - At 15-arc-sec, that's 2,400–9,600 cells per axis
  - Chunk = 1000×1000 cells ≈ 4.17° × 4.17° (≈250 NM per tile)
  - A trans-Coral-Sea passage (Newport→Bali) loads ~8–12 tiles
  - Each tile is ~4 MB compressed → 32–48 MB in memory
  - This keeps the router fast and memory-lean even on a 1 GB VPS

For coastal passages (<200 NM):
  - Only 1–4 tiles loaded
  - <16 MB memory footprint

The Dask scheduler handles lazy loading — tiles not on the route path
are never read from disk.
"""

import argparse
import sys
import time
from pathlib import Path

import dask
import numpy as np
import xarray as xr
from numcodecs import Blosc


def ingest_gebco(input_path: str, output_path: str, chunk_size: int = 1000) -> None:
    """
    Convert a GEBCO NetCDF file to a spatially-chunked, compressed Zarr store.

    Parameters
    ----------
    input_path : str
        Path to the raw GEBCO NetCDF file (e.g., GEBCO_2024.nc)
    output_path : str
        Path for the output Zarr directory store
    chunk_size : int
        Number of cells per chunk in each spatial dimension (default: 1000)
    """
    print(f"╔{'═' * 60}╗")
    print(f"║  THALASSA GEBCO Ingestion Pipeline{' ' * 25}║")
    print(f"╚{'═' * 60}╝")
    print()

    # ─── Step 1: Validate input ───────────────────────────────────────────
    src = Path(input_path)
    if not src.exists():
        print(f"✗ Input file not found: {src}")
        print()
        print("  Download GEBCO 2024 from:")
        print("    https://www.gebco.net/data_and_products/gridded_bathymetry_data/")
        print()
        print("  Select: GEBCO_2024 → NetCDF → Global grid")
        print("  File size: ~7.5 GB")
        sys.exit(1)

    dst = Path(output_path)

    # ─── Step 2: Open with Dask lazy loading ──────────────────────────────
    print(f"  [1/4] Opening {src.name} with Dask lazy loading...")
    t0 = time.time()

    ds = xr.open_dataset(
        input_path,
        engine="netcdf4",
        chunks={"lat": chunk_size, "lon": chunk_size},
    )

    # GEBCO uses 'elevation' as the variable name
    # Negative values = water depth (below sea level)
    # Positive values = land elevation (above sea level)
    if "elevation" not in ds.data_vars:
        # Some GEBCO versions use different naming
        candidates = [v for v in ds.data_vars if "elev" in v.lower() or "depth" in v.lower()]
        if candidates:
            print(f"  ℹ Using variable '{candidates[0]}' (no 'elevation' found)")
            ds = ds.rename({candidates[0]: "elevation"})
        else:
            print(f"  ✗ No elevation/depth variable found. Variables: {list(ds.data_vars)}")
            sys.exit(1)

    lat_size = ds.dims.get("lat", ds.dims.get("y", 0))
    lon_size = ds.dims.get("lon", ds.dims.get("x", 0))
    print(f"    Grid: {lon_size} × {lat_size} ({lon_size * lat_size:,} cells)")
    print(f"    Resolution: {abs(float(ds.lat[1] - ds.lat[0])):.6f}° "
          f"(~{abs(float(ds.lat[1] - ds.lat[0])) * 111_000:.0f}m)")
    print(f"    Chunks: {chunk_size} × {chunk_size} "
          f"({chunk_size * abs(float(ds.lat[1] - ds.lat[0])):.2f}° per tile)")
    print(f"    Loaded in {time.time() - t0:.1f}s (lazy — no data read yet)")
    print()

    # ─── Step 3: Configure compression ────────────────────────────────────
    print("  [2/4] Configuring Blosc/Zstandard compression...")

    compressor = Blosc(
        cname="zstd",       # Zstandard — best compression/speed ratio
        clevel=5,           # Level 5 = good compression, fast decompression
        shuffle=Blosc.BITSHUFFLE,  # Bitshuffle for int16 elevation data
    )

    # Encoding dict for the Zarr store
    encoding = {
        "elevation": {
            "compressor": compressor,
            "chunks": (chunk_size, chunk_size),
            "dtype": "int16",  # GEBCO elevation fits in int16 (-10994m to 8849m)
        }
    }

    print(f"    Compressor: Blosc (Zstandard, level 5, bitshuffle)")
    print(f"    dtype: int16 (range: -10,994m to +8,849m)")
    print()

    # ─── Step 4: Write Zarr store ─────────────────────────────────────────
    print(f"  [3/4] Writing Zarr store to {dst}...")
    print(f"    This may take 5–15 minutes for the full global grid...")
    t1 = time.time()

    # Remove existing store if present
    if dst.exists():
        import shutil
        shutil.rmtree(dst)
        print(f"    ℹ Removed existing store at {dst}")

    # Write with Dask parallelism
    with dask.config.set(scheduler="threads", num_workers=4):
        ds.to_zarr(
            str(dst),
            mode="w",
            encoding=encoding,
            consolidated=True,  # Single metadata file for fast opens
        )

    elapsed = time.time() - t1
    print(f"    Written in {elapsed:.1f}s")
    print()

    # ─── Step 5: Verify ──────────────────────────────────────────────────
    print("  [4/4] Verifying Zarr store...")

    store = xr.open_zarr(str(dst), consolidated=True)
    chunk_info = store["elevation"].encoding.get("chunks", "unknown")

    # Calculate compressed size
    total_bytes = sum(
        f.stat().st_size for f in dst.rglob("*") if f.is_file()
    )
    total_mb = total_bytes / (1024 * 1024)
    raw_mb = (lon_size * lat_size * 2) / (1024 * 1024)  # int16 = 2 bytes
    ratio = raw_mb / total_mb if total_mb > 0 else 1

    print(f"    ✓ Store opened successfully")
    print(f"    ✓ Chunks: {chunk_info}")
    print(f"    ✓ Raw size:        {raw_mb:,.0f} MB")
    print(f"    ✓ Compressed size: {total_mb:,.0f} MB")
    print(f"    ✓ Compression ratio: {ratio:.1f}x")
    print()

    store.close()
    ds.close()

    print(f"{'═' * 64}")
    print(f"  ✓ GEBCO Zarr store ready at: {dst}")
    print(f"{'═' * 64}")


def get_regional_bathymetry(
    zarr_path: str,
    min_lat: float,
    max_lat: float,
    min_lon: float,
    max_lon: float,
    buffer_deg: float = 0.5,
) -> xr.DataArray:
    """
    Efficiently load a regional bounding box from the Zarr store.

    This function demonstrates the key advantage of the chunked Zarr format:
    only the tiles covering the requested region are read from disk.
    A 20° × 20° box loads ~25 tiles (≈100 MB), while the full globe would
    be 43,200 × 86,400 cells (≈7.5 GB).

    Parameters
    ----------
    zarr_path : str
        Path to the chunked Zarr store
    min_lat, max_lat : float
        Latitude bounds (degrees, -90 to 90)
    min_lon, max_lon : float
        Longitude bounds (degrees, -180 to 180)
    buffer_deg : float
        Extra padding around the bounding box (default: 0.5°, ~30 NM)
        This ensures the A* router has room to route around obstacles
        near the edges of the search area.

    Returns
    -------
    xr.DataArray
        2D array of elevation values (negative = depth, positive = land)
        with lat/lon coordinates attached.

    Example
    -------
    >>> # Newport QLD to Bali — Coral Sea + Arafura Sea
    >>> bathy = get_regional_bathymetry(
    ...     "./gebco_zarr",
    ...     min_lat=-30, max_lat=0,
    ...     min_lon=110, max_lon=155
    ... )
    >>> print(f"Loaded {bathy.shape} grid ({bathy.nbytes / 1e6:.1f} MB)")
    # Loaded (7200, 10800) grid (155.5 MB)
    """
    ds = xr.open_zarr(zarr_path, consolidated=True)

    # Apply buffer
    lat_lo = max(-90.0, min_lat - buffer_deg)
    lat_hi = min(90.0, max_lat + buffer_deg)
    lon_lo = max(-180.0, min_lon - buffer_deg)
    lon_hi = min(180.0, max_lon + buffer_deg)

    # Slice — Dask only reads the chunks that intersect this box
    region = ds["elevation"].sel(
        lat=slice(lat_lo, lat_hi),
        lon=slice(lon_lo, lon_hi),
    )

    # .compute() triggers the actual read — only for the needed chunks
    data = region.compute()

    ds.close()
    return data


# ─── CLI Entry Point ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Ingest GEBCO NetCDF into a chunked Zarr store for Thalassa routing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Standard ingestion (recommended chunk size)
  python gebco_ingest.py --input GEBCO_2024.nc --output ./gebco_zarr

  # Smaller chunks for memory-constrained servers
  python gebco_ingest.py --input GEBCO_2024.nc --output ./gebco_zarr --chunks 500

  # Query a region (Python)
  from gebco_ingest import get_regional_bathymetry
  bathy = get_regional_bathymetry("./gebco_zarr", -30, 0, 110, 155)
        """,
    )
    parser.add_argument("--input", "-i", required=True, help="Path to GEBCO NetCDF file")
    parser.add_argument("--output", "-o", default="./gebco_zarr", help="Output Zarr store path")
    parser.add_argument("--chunks", "-c", type=int, default=1000, help="Chunk size (default: 1000)")

    args = parser.parse_args()
    ingest_gebco(args.input, args.output, args.chunks)
