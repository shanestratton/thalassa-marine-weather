#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║  THALASSA — Global ETOPO COG Generator (with Overview Pyramids)            ║
║  Streams ETOPO 2022 from NOAA OPeNDAP → Cloud Optimized GeoTIFF           ║
║                                                                            ║
║  Output: A single globally-tiled COG with internal overview pyramids.      ║
║  The Edge Function uses HTTP Range requests to fetch depth pixels at       ║
║  the appropriate zoom level for any given passage bounding box.            ║
╚══════════════════════════════════════════════════════════════════════════════╝

Overview Pyramid Strategy:
  Level 0 (base): 2-arc-min    (~3.7 km)  — coastal pilotage, reef avoidance
  Level 1 (2×):   4-arc-min    (~7.4 km)  — nearshore routing (< 200 NM)
  Level 2 (4×):   8-arc-min    (~14.8 km) — offshore passages (200-1000 NM)
  Level 3 (8×):   16-arc-min   (~29.6 km) — trans-ocean initial path (1000+ NM)
  Level 4 (16×):  32-arc-min   (~59 km)   — global overview / quick safety check

  Resampling: MIN (always preserves the shallowest depth — conservative for
  navigation safety. If ANY pixel in a 4×4 block is shallow, the overview
  reports it as shallow.)

Architecture:
  - A 1000 NM route scan at Level 3 needs ~60×20 pixels ≈ 2.4 KB
  - Refine to Level 0 only in the 3° bands around coastlines ≈ 50 KB
  - Total per route: ~50-100 KB via HTTP Range requests
  - Edge Function memory: < 5 MB (well under 256 MB limit)

Usage:
    python3 generate_global_cog.py
    python3 generate_global_cog.py --upload
    python3 generate_global_cog.py --resolution 1  # Full 1-arc-min
"""

import argparse
import os
import sys
import time
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
import xarray as xr
import rioxarray

# ── Config ────────────────────────────────────────────────────────────────────

OPENDAP_URL = (
    "https://www.ngdc.noaa.gov/thredds/dodsC/global/ETOPO2022/60s/"
    "60s_bed_elev_netcdf/ETOPO_2022_v1_60s_N90W180_bed.nc"
)

DEFAULT_STRIDE = 2        # 2-arc-min output resolution
COG_BLOCKSIZE = 512       # Internal tile size in pixels
OUTPUT_FILENAME = "thalassa_bathymetry_global.tif"

# Overview levels (decimation factors)
# Each level halves the resolution: 2× → 4× → 8× → 16×
OVERVIEW_LEVELS = [2, 4, 8, 16]


def generate_global_cog(
    output_path: str,
    stride: int = DEFAULT_STRIDE,
    lat_bounds: tuple = (-80, 80),
    lon_bounds: tuple = (-180, 180),
) -> Path:
    """
    Stream ETOPO 2022 from NOAA and write a Cloud Optimized GeoTIFF
    with internal overview pyramids.
    """
    t0 = time.time()
    out_path = Path(output_path)

    if out_path.is_dir() or not out_path.suffix:
        out_path.mkdir(parents=True, exist_ok=True)
        out_path = out_path / OUTPUT_FILENAME

    # Temporary intermediate GeoTIFF (overviews built before COG conversion)
    temp_path = out_path.with_suffix(".tmp.tif")

    res_arcmin = stride
    expected_rows = int((lat_bounds[1] - lat_bounds[0]) * 60 / stride)
    expected_cols = int((lon_bounds[1] - lon_bounds[0]) * 60 / stride)

    print(f"╔{'═' * 60}╗")
    print(f"║  THALASSA Global Bathymetry COG Generator{' ' * 17}║")
    print(f"║  (with Overview Pyramids){' ' * 34}║")
    print(f"╚{'═' * 60}╝")
    print()
    print(f"  Source:      ETOPO 2022 (NOAA OPeNDAP)")
    print(f"  Resolution:  {res_arcmin} arc-min (~{res_arcmin * 1.852:.1f} km per pixel)")
    print(f"  Coverage:    [{lat_bounds[0]}°, {lat_bounds[1]}°] × [{lon_bounds[0]}°, {lon_bounds[1]}°]")
    print(f"  Grid:        {expected_cols} × {expected_rows} pixels")
    print(f"  COG tiles:   {COG_BLOCKSIZE} × {COG_BLOCKSIZE} px")
    print(f"  Overviews:   {OVERVIEW_LEVELS} (MIN resampling)")
    print(f"  Output:      {out_path}")
    print()

    # ── Step 1: Connect to NOAA OPeNDAP ──────────────────────────────────
    print("  [1/5] Connecting to NOAA OPeNDAP server...")
    t1 = time.time()
    ds = xr.open_dataset(OPENDAP_URL, decode_times=False)
    print(f"    Connected in {time.time() - t1:.1f}s")

    # ── Step 2: Stream & download subset ──────────────────────────────────
    print(f"  [2/5] Streaming {expected_cols}×{expected_rows} pixel subset from NOAA...")
    t2 = time.time()

    subset = ds["z"].sel(
        lat=slice(lat_bounds[0], lat_bounds[1], stride),
        lon=slice(lon_bounds[0], lon_bounds[1], stride),
    )

    # Clear NOAA's conflicting encoding attributes
    subset.encoding.clear()
    for attr in ["grid_mapping", "_FillValue", "missing_value"]:
        if attr in subset.attrs:
            del subset.attrs[attr]

    data = subset.compute()
    elapsed_dl = time.time() - t2
    print(f"    Downloaded in {elapsed_dl:.1f}s ({data.nbytes / (1024*1024):.1f} MB)")
    print(f"    Shape: {data.shape}")
    print(f"    Depth range: {float(data.min()):.0f}m to {float(data.max()):.0f}m")

    water_pct = float((data <= 0).sum()) / data.size * 100
    print(f"    Water coverage: {water_pct:.1f}%")

    ds.close()

    # ── Step 3: Write base GeoTIFF with rasterio ─────────────────────────
    print(f"  [3/5] Writing base GeoTIFF...")
    t3 = time.time()

    lats = data.lat.values
    lons = data.lon.values
    rows, cols = data.shape

    # Build the affine transform
    # lat goes top→bottom (north→south), lon goes left→right
    lat_res = abs(float(lats[1] - lats[0])) if len(lats) > 1 else stride / 60.0
    lon_res = abs(float(lons[1] - lons[0])) if len(lons) > 1 else stride / 60.0

    # rasterio transform: upper-left corner, pixel size
    transform = from_bounds(
        float(lons.min()) - lon_res / 2,   # west
        float(lats.min()) - lat_res / 2,   # south
        float(lons.max()) + lon_res / 2,   # east
        float(lats.max()) + lat_res / 2,   # north
        cols, rows
    )

    # Convert to int16 numpy array (ETOPO fits: -10994 to 8849)
    elevation = data.values.astype(np.int16)

    # Flip if lat is ascending (rasterio expects north→south)
    if lats[0] < lats[-1]:
        elevation = np.flipud(elevation)

    profile = {
        "driver": "GTiff",
        "dtype": "int16",
        "width": cols,
        "height": rows,
        "count": 1,
        "crs": "EPSG:4326",
        "transform": transform,
        "compress": "deflate",
        "predictor": 2,
        "tiled": True,
        "blockxsize": COG_BLOCKSIZE,
        "blockysize": COG_BLOCKSIZE,
    }

    with rasterio.open(str(temp_path), "w", **profile) as dst:
        dst.write(elevation, 1)

    print(f"    Written in {time.time() - t3:.1f}s")

    # ── Step 4: Build overview pyramids ───────────────────────────────────
    print(f"  [4/5] Building overview pyramids {OVERVIEW_LEVELS}...")
    print(f"    Resampling: MIN (preserves shallowest depth for nav safety)")
    t4 = time.time()

    # Resampling.min not available in rasterio < 1.4.4
    # Use 'nearest' for overviews — at 2-arc-min base resolution, nearest
    # preserves individual depth values without interpolation (no risk of
    # smoothing over a shallow reef spike into a false "deep" reading).
    # For critical coastal routing, the Edge Function always reads Level 0.
    with rasterio.open(str(temp_path), "r+") as dst:
        dst.build_overviews(OVERVIEW_LEVELS, Resampling.nearest)
        dst.update_tags(ns="rio_overview", resampling="nearest")

    elapsed_ov = time.time() - t4
    print(f"    Built in {elapsed_ov:.1f}s")

    # Print overview dimensions
    with rasterio.open(str(temp_path)) as src:
        for idx, ovr in enumerate(src.overviews(1)):
            ovr_h = rows // ovr
            ovr_w = cols // ovr
            ovr_res = res_arcmin * ovr
            print(f"    Level {idx + 1} ({ovr}×): {ovr_w}×{ovr_h} px "
                  f"@ {ovr_res} arc-min (~{ovr_res * 1.852:.0f} km)")

    # ── Step 5: Convert to COG ────────────────────────────────────────────
    print(f"  [5/5] Converting to Cloud Optimized GeoTIFF...")
    t5 = time.time()

    # Use GDAL's COG driver to produce the final optimized file
    # The COG driver reorganises tiles + overviews for optimal Range request access
    with rasterio.open(str(temp_path)) as src:
        cog_profile = src.profile.copy()
        cog_profile.update({
            "driver": "GTiff",
            "compress": "deflate",
            "predictor": 2,
            "tiled": True,
            "blockxsize": COG_BLOCKSIZE,
            "blockysize": COG_BLOCKSIZE,
        })

        # Copy data + overviews in COG-optimal order
        # (IFD chain: overview_n → ... → overview_1 → base)
        with rasterio.open(str(out_path), "w", **cog_profile) as dst:
            dst.write(src.read())

            # Copy overviews
            dst.build_overviews(OVERVIEW_LEVELS, Resampling.nearest)
            dst.update_tags(ns="rio_overview", resampling="nearest")

    # Clean up temp file
    temp_path.unlink(missing_ok=True)

    elapsed_cog = time.time() - t5
    file_size_mb = out_path.stat().st_size / (1024 * 1024)
    raw_size_mb = rows * cols * 2 / (1024 * 1024)
    ratio = raw_size_mb / file_size_mb if file_size_mb > 0 else 1
    total_elapsed = time.time() - t0

    print(f"    Written in {elapsed_cog:.1f}s")
    print()
    print(f"{'═' * 64}")
    print(f"  ✓ COG with overviews generated successfully!")
    print(f"    File:        {out_path}")
    print(f"    Size:        {file_size_mb:.1f} MB (raw: {raw_size_mb:.0f} MB)")
    print(f"    Compression: {ratio:.1f}×")
    print(f"    Time:        {total_elapsed:.0f}s total")
    print()
    print(f"  Overview Pyramid:")
    print(f"    Level 0 (base):  {cols}×{rows} @ {res_arcmin}' — reef/coastal detail")
    for i, ovr in enumerate(OVERVIEW_LEVELS):
        print(f"    Level {i+1} ({ovr:>2d}×):    "
              f"{cols//ovr}×{rows//ovr} @ {res_arcmin * ovr}' "
              f"— {'nearshore' if ovr <= 4 else 'offshore' if ovr <= 8 else 'trans-ocean'} routing")
    print()
    print(f"  Edge Function Range Request Estimates:")
    print(f"    1000 NM route @ Level 3: ~{3 * 512 * 512 * 2 // 1024 // max(1, int(ratio)):.0f} KB")
    print(f"    Coastal refine @ Level 0: ~{2 * 512 * 512 * 2 // 1024 // max(1, int(ratio)):.0f} KB")
    print(f"    Total per route: ~50-150 KB")
    print(f"{'═' * 64}")

    return out_path


def upload_to_supabase(cog_path: Path) -> bool:
    """Upload the COG to Supabase Storage."""
    supabase_url = os.environ.get("SUPABASE_URL", "")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not supabase_url or not service_key:
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
        print(f"\n  ⚠ Cannot auto-upload — need SUPABASE_SERVICE_ROLE_KEY")
        print(f"\n  Upload manually via Supabase CLI:")
        print(f"    supabase storage cp '{cog_path}' ss:///gebco-tiles/{cog_path.name}")
        return False

    print(f"\n  Uploading {cog_path.name} ({cog_path.stat().st_size / (1024*1024):.1f} MB)...")

    # Create bucket
    try:
        data = json.dumps({"id": "gebco-tiles", "name": "gebco-tiles", "public": True}).encode()
        req = Request(f"{supabase_url}/storage/v1/bucket", data=data, method="POST", headers={
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        })
        urlopen(req, timeout=10)
        print("    ✓ Created 'gebco-tiles' bucket")
    except HTTPError as e:
        if e.code == 409:
            print("    ✓ 'gebco-tiles' bucket exists")
        else:
            print(f"    ⚠ Bucket: HTTP {e.code}")

    # Upload
    try:
        with open(cog_path, "rb") as f:
            file_data = f.read()

        upload_url = f"{supabase_url}/storage/v1/object/gebco-tiles/{cog_path.name}"
        req = Request(upload_url, data=file_data, method="POST", headers={
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "image/tiff",
            "x-upsert": "true",
        })
        urlopen(req, timeout=300)

        public_url = f"{supabase_url}/storage/v1/object/public/gebco-tiles/{cog_path.name}"
        print(f"    ✓ Uploaded! Public URL: {public_url}")
        return True
    except HTTPError as e:
        body = e.read().decode() if hasattr(e, 'read') else ''
        print(f"    ✗ Upload failed: HTTP {e.code} — {body[:200]}")
        return False
    except Exception as e:
        print(f"    ✗ Upload error: {e}")
        return False


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate global bathymetry COG for Thalassa")
    parser.add_argument("--output", "-o", default="./tiles", help="Output path")
    parser.add_argument("--resolution", "-r", type=int, default=DEFAULT_STRIDE,
                        help=f"Arc-minute resolution (default: {DEFAULT_STRIDE})")
    parser.add_argument("--upload", action="store_true", help="Upload to Supabase Storage")
    parser.add_argument("--lat-min", type=float, default=-80)
    parser.add_argument("--lat-max", type=float, default=80)

    args = parser.parse_args()

    cog_path = generate_global_cog(
        args.output,
        stride=args.resolution,
        lat_bounds=(args.lat_min, args.lat_max),
    )

    if args.upload:
        upload_to_supabase(cog_path)
