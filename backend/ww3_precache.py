#!/usr/bin/env python3
"""
WW3 Pre-Cache Pipeline — NOAA WaveWatch III GRIB2 Ingest

Downloads the latest GFS/WW3 wave model data from NOAA NOMADS,
decodes it with cfgrib, and uploads structured JSON to Supabase
Storage for the 4D passage planner to consume.

This runs as a cron job (every 6 hours) to keep wave forecasts current.

Pipeline:
  1. Download WW3 GRIB2 from NOMADS GRIB Filter (significant wave height,
     peak period, primary wave direction, wind wave height, swell height)
  2. Decode with cfgrib + xarray
  3. Extract global 0.5° grid for each forecast hour (0-120h, 3h steps)
  4. Upload JSON shards to Supabase Storage (one per forecast hour)
  5. Update metadata record in Supabase DB

Data Source:
  NOAA NOMADS GFS Wave (multi_1 global grid)
  URL: https://nomads.ncep.noaa.gov/cgi-bin/filter_wave_multi.pl

Variables:
  - HTSGW: Significant height of combined wind waves and swell (m)
  - PERPW: Primary wave mean period (s)
  - DIRPW: Primary wave direction (degrees FROM)
  - WVHGT: Significant height of wind waves (m)
  - SWELL: Significant height of swell waves (m)

Grid Resolution: 0.5° global (720x361 = ~260K points)
Temporal: 3-hourly out to 120h (41 timesteps)

Usage:
  python ww3_precache.py                   # Download latest cycle
  python ww3_precache.py --cycle 2026022400  # Specific cycle
  python ww3_precache.py --dry-run          # Preview only

Requirements:
  pip install cfgrib eccodes xarray requests supabase-py numpy
"""

import os
import sys
import json
import time
import argparse
import tempfile
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path

import numpy as np
import xarray as xr
import requests

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [WW3] %(levelname)s: %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('ww3')

# ══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ══════════════════════════════════════════════════════════════════

NOMADS_BASE = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_wave_multi.pl'

# WW3 variables to fetch
WW3_VARS = {
    'HTSGW': 'wave_ht_m',       # Combined significant wave height
    'PERPW': 'peak_period_s',   # Peak wave period
    'DIRPW': 'wave_dir_deg',    # Primary wave direction (FROM)
    'WVHGT': 'wind_wave_ht_m',  # Wind wave component
    'SWELL': 'swell_ht_m',      # Swell component
}

# Forecast hours to download (0 to 120h, every 3h)
FORECAST_HOURS = list(range(0, 121, 3))  # 41 timesteps

# Subsampling for manageable payload: every 2nd point → 0.5° effective → 1° grid
SUBSAMPLE = 2  # 1 = full 0.5°, 2 = 1° grid

# Supabase config
SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY', '')
STORAGE_BUCKET = 'ww3-cache'

# ══════════════════════════════════════════════════════════════════
# NOMADS GRIB FILTER DOWNLOAD
# ══════════════════════════════════════════════════════════════════

def get_latest_cycle() -> str:
    """Determine the latest available GFS wave cycle (00/06/12/18Z)."""
    now = datetime.now(timezone.utc) - timedelta(hours=5)  # 5h lag
    cycle_hour = (now.hour // 6) * 6
    cycle_time = now.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)
    return cycle_time.strftime('%Y%m%d%H')


def download_ww3_grib(cycle: str, forecast_hour: int, tmpdir: str) -> Path | None:
    """
    Download a single WW3 GRIB2 file from NOMADS for one forecast hour.
    Uses the GRIB Filter to request only the variables we need.
    """
    date_str = cycle[:8]  # YYYYMMDD
    cycle_hour = cycle[8:10]  # HH

    # Build GRIB filter URL
    # Pattern: multi_1.glo_30m.tHHz.fHHH.grib2
    fhr = f'{forecast_hour:03d}'
    filename = f'multi_1.glo_30m.t{cycle_hour}z.f{fhr}.grib2'

    params = {
        'file': filename,
        'dir': f'/multi_1.{date_str}',
        'subregion': '',  # Full global
    }

    # Add variable selections
    for var in WW3_VARS.keys():
        params[f'var_{var}'] = 'on'

    url = NOMADS_BASE
    outpath = Path(tmpdir) / filename

    try:
        log.info(f'Downloading f{fhr}: {filename}')
        resp = requests.get(url, params=params, timeout=60, stream=True)

        if resp.status_code == 404:
            log.warning(f'  ↳ f{fhr} not yet available (404)')
            return None

        resp.raise_for_status()

        with open(outpath, 'wb') as f:
            for chunk in resp.iter_content(chunk_size=65536):
                f.write(chunk)

        size_kb = outpath.stat().st_size / 1024
        log.info(f'  ↳ {size_kb:.0f} KB downloaded')
        return outpath

    except Exception as e:
        log.error(f'  ↳ Download failed: {e}')
        return None


# ══════════════════════════════════════════════════════════════════
# GRIB2 DECODE WITH CFGRIB
# ══════════════════════════════════════════════════════════════════

def decode_grib(filepath: Path) -> dict | None:
    """
    Decode a WW3 GRIB2 file into a dict of numpy arrays.
    Returns { 'wave_ht_m': array, 'peak_period_s': array, ... }
    with shape (nlat, nlon) at 0.5° resolution.
    """
    try:
        ds = xr.open_dataset(
            filepath,
            engine='cfgrib',
            backend_kwargs={'errors': 'ignore'},
        )

        result = {}
        var_mapping = {
            'swh': 'wave_ht_m',       # cfgrib shortName for HTSGW
            'perpw': 'peak_period_s',  # Primary wave period
            'dirpw': 'wave_dir_deg',   # Primary wave direction
            'shww': 'wind_wave_ht_m',  # Wind wave height
            'swel': 'swell_ht_m',      # Swell height
        }

        for grib_name, our_name in var_mapping.items():
            if grib_name in ds.data_vars:
                data = ds[grib_name].values
                if SUBSAMPLE > 1:
                    data = data[::SUBSAMPLE, ::SUBSAMPLE]
                # Replace NaN with 0
                data = np.nan_to_num(data, nan=0.0)
                result[our_name] = data.astype(np.float32)

        # Extract lat/lon axes
        lats = ds.latitude.values
        lons = ds.longitude.values
        if SUBSAMPLE > 1:
            lats = lats[::SUBSAMPLE]
            lons = lons[::SUBSAMPLE]

        result['lats'] = lats.astype(np.float32)
        result['lons'] = lons.astype(np.float32)

        ds.close()
        return result

    except Exception as e:
        log.error(f'GRIB decode failed for {filepath.name}: {e}')
        return None


# ══════════════════════════════════════════════════════════════════
# JSON SHARD BUILDER
# ══════════════════════════════════════════════════════════════════

def build_json_shard(decoded: dict, forecast_hour: int, cycle: str) -> dict:
    """
    Build a JSON shard for one forecast hour. 
    Compact encoding: lat/lon arrays + flat data arrays.
    """
    lats = decoded['lats']
    lons = decoded['lons']

    shard = {
        'cycle': cycle,
        'forecast_hour': forecast_hour,
        'valid_time': (
            datetime.strptime(cycle, '%Y%m%d%H') +
            timedelta(hours=forecast_hour)
        ).isoformat() + 'Z',
        'grid': {
            'nlat': len(lats),
            'nlon': len(lons),
            'lat_min': float(lats.min()),
            'lat_max': float(lats.max()),
            'lon_min': float(lons.min()),
            'lon_max': float(lons.max()),
            'resolution_deg': float(np.diff(lats[:2])[0]) if len(lats) > 1 else 1.0,
        },
        'data': {},
    }

    for key in ['wave_ht_m', 'peak_period_s', 'wave_dir_deg', 'wind_wave_ht_m', 'swell_ht_m']:
        if key in decoded:
            # Round to 1 decimal to save bandwidth
            arr = np.round(decoded[key], 1)
            shard['data'][key] = arr.flatten().tolist()

    return shard


# ══════════════════════════════════════════════════════════════════
# SUPABASE UPLOAD
# ══════════════════════════════════════════════════════════════════

def upload_to_supabase(shard: dict, cycle: str, forecast_hour: int) -> bool:
    """Upload a JSON shard to Supabase Storage."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.warning('Supabase credentials not set — skipping upload')
        return False

    try:
        filename = f'ww3_{cycle}_f{forecast_hour:03d}.json'
        url = f'{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{filename}'

        json_bytes = json.dumps(shard, separators=(',', ':')).encode('utf-8')
        size_kb = len(json_bytes) / 1024

        headers = {
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'x-upsert': 'true',
        }

        resp = requests.post(url, data=json_bytes, headers=headers, timeout=30)
        resp.raise_for_status()

        log.info(f'  ↳ Uploaded {filename} ({size_kb:.0f} KB)')
        return True

    except Exception as e:
        log.error(f'  ↳ Upload failed: {e}')
        return False


def update_metadata(cycle: str, hours_available: list[int]) -> bool:
    """Update the WW3 metadata record in Supabase."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return False

    try:
        metadata = {
            'cycle': cycle,
            'valid_from': (
                datetime.strptime(cycle, '%Y%m%d%H')
            ).isoformat() + 'Z',
            'valid_to': (
                datetime.strptime(cycle, '%Y%m%d%H') +
                timedelta(hours=max(hours_available))
            ).isoformat() + 'Z',
            'hours_available': hours_available,
            'total_hours': len(hours_available),
            'bucket': STORAGE_BUCKET,
            'file_pattern': f'ww3_{cycle}_f{{HHH}}.json',
            'updated_at': datetime.now(timezone.utc).isoformat(),
        }

        filename = 'ww3_latest.json'
        url = f'{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{filename}'

        json_bytes = json.dumps(metadata, indent=2).encode('utf-8')

        headers = {
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'x-upsert': 'true',
        }

        resp = requests.post(url, data=json_bytes, headers=headers, timeout=15)
        resp.raise_for_status()

        log.info(f'Updated metadata: {len(hours_available)} hours from {cycle}')
        return True

    except Exception as e:
        log.error(f'Metadata update failed: {e}')
        return False


# ══════════════════════════════════════════════════════════════════
# MAIN PIPELINE
# ══════════════════════════════════════════════════════════════════

def run_pipeline(cycle: str | None = None, dry_run: bool = False, 
                 local_dir: str | None = None):
    """
    Full WW3 pre-cache pipeline:
      1. Determine cycle
      2. Download GRIB2 files for each forecast hour
      3. Decode with cfgrib
      4. Build JSON shards
      5. Upload to Supabase Storage
    """
    if cycle is None:
        cycle = get_latest_cycle()

    log.info(f'='*60)
    log.info(f'WW3 Pre-Cache Pipeline')
    log.info(f'Cycle:     {cycle}')
    log.info(f'Hours:     {FORECAST_HOURS[0]}-{FORECAST_HOURS[-1]} (3h steps)')
    log.info(f'Subsample: {SUBSAMPLE}x ({"0.5" if SUBSAMPLE == 1 else f"{0.5*SUBSAMPLE}"}° effective)')
    log.info(f'Dry run:   {dry_run}')
    log.info(f'='*60)

    t0 = time.time()
    successful_hours: list[int] = []
    failed_hours: list[int] = []

    with tempfile.TemporaryDirectory(prefix='ww3_') as tmpdir:
        if local_dir:
            tmpdir = local_dir
            Path(tmpdir).mkdir(parents=True, exist_ok=True)

        for fhr in FORECAST_HOURS:
            log.info(f'── Forecast Hour +{fhr:03d}h ──')

            # 1. Download
            grib_path = download_ww3_grib(cycle, fhr, tmpdir)
            if not grib_path:
                failed_hours.append(fhr)
                continue

            # 2. Decode
            decoded = decode_grib(grib_path)
            if not decoded:
                failed_hours.append(fhr)
                continue

            # 3. Build JSON shard
            shard = build_json_shard(decoded, fhr, cycle)

            if dry_run:
                # Just print stats
                data_vars = list(shard['data'].keys())
                grid = shard['grid']
                log.info(f'  ↳ Grid: {grid["nlat"]}×{grid["nlon"]}, vars: {data_vars}')
                if 'wave_ht_m' in shard['data']:
                    arr = np.array(shard['data']['wave_ht_m'])
                    log.info(f'  ↳ Wave height: min={arr.min():.1f}m, max={arr.max():.1f}m, mean={arr.mean():.1f}m')
                successful_hours.append(fhr)
                continue

            # 4. Save locally (for debugging)
            if local_dir:
                local_path = Path(local_dir) / f'ww3_{cycle}_f{fhr:03d}.json'
                with open(local_path, 'w') as f:
                    json.dump(shard, f, separators=(',', ':'))
                log.info(f'  ↳ Saved locally: {local_path}')

            # 5. Upload to Supabase
            if upload_to_supabase(shard, cycle, fhr):
                successful_hours.append(fhr)
            else:
                failed_hours.append(fhr)

            # Cleanup GRIB to save disk
            try:
                grib_path.unlink()
            except Exception:
                pass

        # 6. Update metadata
        if successful_hours and not dry_run:
            update_metadata(cycle, successful_hours)

    elapsed = time.time() - t0

    log.info(f'')
    log.info(f'═══ COMPLETE ═══')
    log.info(f'Cycle:       {cycle}')
    log.info(f'Successful:  {len(successful_hours)}/{len(FORECAST_HOURS)} hours')
    log.info(f'Failed:      {len(failed_hours)}')
    log.info(f'Elapsed:     {elapsed:.1f}s')

    if failed_hours:
        log.warning(f'Failed hours: {failed_hours}')

    return len(failed_hours) == 0


# ══════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='WW3 Pre-Cache Pipeline — Download and upload WaveWatch III wave forecasts',
    )
    parser.add_argument('--cycle', type=str, default=None,
                       help='Specific cycle (YYYYMMDDHH), e.g. 2026022400. Default: latest.')
    parser.add_argument('--dry-run', action='store_true',
                       help='Download and decode but do not upload.')
    parser.add_argument('--local-dir', type=str, default=None,
                       help='Save JSON shards locally to this directory.')
    parser.add_argument('--hours', type=str, default=None,
                       help='Comma-separated forecast hours to process, e.g. "0,3,6,12"')

    args = parser.parse_args()

    if args.hours:
        FORECAST_HOURS[:] = [int(h) for h in args.hours.split(',')]

    success = run_pipeline(
        cycle=args.cycle,
        dry_run=args.dry_run,
        local_dir=args.local_dir,
    )

    sys.exit(0 if success else 1)
