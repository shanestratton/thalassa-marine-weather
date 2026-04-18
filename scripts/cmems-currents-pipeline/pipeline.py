#!/usr/bin/env python3
"""
CMEMS ocean-currents → Mapbox Tiling Service pipeline.

Runs daily via GitHub Action. Pulls the Copernicus Marine global physics
forecast (GLOBAL_ANALYSISFORECAST_PHY_001_024), surface currents only,
and uploads the result to Mapbox MTS as a `raster-array` tileset with
two bands (uo = east velocity m/s, vo = north velocity m/s).

The Mapbox GL JS `raster-particle` layer then reads this tileset on the
client and renders animated particle flow, GPU-side, zero custom WebGL.

Environment variables (from GitHub Actions secrets):
    COPERNICUS_MARINE_USERNAME
    COPERNICUS_MARINE_PASSWORD
    MAPBOX_UPLOAD_TOKEN     - secret token with tilesets:write scope
    MAPBOX_USERNAME         - Mapbox account slug (e.g. "shanestratton")
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger("cmems-pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# ── Config ────────────────────────────────────────────────────────────────

DATASET_ID = "cmems_mod_glo_phy_anfc_merged-uv_PT1H-i_202211"
VARIABLES = ["uo", "vo"]
# 48-hour forecast window, surface only (depth=0).
FORECAST_HOURS = 48
DEPTH_M = 0.494

# Mapbox tileset naming. One tileset-per-hour keeps each upload bounded
# and lets the client scrub through time by switching source URLs.
MAPBOX_TILESET_PREFIX = "thalassa-currents"
MAPBOX_RECIPE_PATH = Path(__file__).parent / "recipe.json"

OUT_DIR = Path(os.environ.get("CMEMS_OUT_DIR", "/tmp/cmems-currents"))
OUT_DIR.mkdir(parents=True, exist_ok=True)


# ── Steps ─────────────────────────────────────────────────────────────────

def fetch_cmems(start: datetime, end: datetime) -> Path:
    """Download surface currents for the forecast window as a single NetCDF."""
    import copernicusmarine  # lazy import — keeps the script importable without creds

    out_path = OUT_DIR / f"cmems-currents-{start:%Y%m%dT%H}.nc"
    log.info("Fetching %s → %s into %s", start.isoformat(), end.isoformat(), out_path)

    # copernicusmarine 2.x notes:
    # - `force_download` was removed entirely (no-prompt download is now default)
    # - `overwrite_output_data` → `overwrite`
    # - The toolbox does NOT auto-read `COPERNICUS_MARINE_USERNAME`/`_PASSWORD`
    #   env vars; it looks for a login config file or explicit kwargs. Passing
    #   explicitly keeps secrets out of a credentials file on disk.
    # `merged-uv_PT1H-i` is a surface-only dataset, so no depth kwargs.
    copernicusmarine.subset(
        dataset_id=DATASET_ID,
        variables=VARIABLES,
        minimum_longitude=-180,
        maximum_longitude=180,
        minimum_latitude=-80,
        maximum_latitude=90,
        start_datetime=start.strftime("%Y-%m-%dT%H:%M:%S"),
        end_datetime=end.strftime("%Y-%m-%dT%H:%M:%S"),
        output_filename=out_path.name,
        output_directory=str(out_path.parent),
        overwrite=True,
        username=require_env("COPERNICUS_MARINE_USERNAME"),
        password=require_env("COPERNICUS_MARINE_PASSWORD"),
    )
    return out_path


def netcdf_to_geotiffs(nc_path: Path) -> list[Path]:
    """Slice the multi-hour NetCDF into per-hour 2-band GeoTIFFs."""
    import numpy as np
    import rioxarray  # noqa: F401  (registers .rio accessor)
    import xarray as xr

    ds = xr.open_dataset(nc_path)
    # Surface-only dataset has no `depth` dim; older products did, so
    # squeeze defensively.
    if "depth" in ds.dims:
        ds = ds.squeeze("depth", drop=True)
    ds = ds.rio.write_crs("EPSG:4326")

    out_paths: list[Path] = []
    for i, t in enumerate(ds.time.values):
        hour_slice = ds.sel(time=t)
        tif_path = nc_path.parent / f"currents-hour-{i:02d}.tif"
        # 2-band stack: band 1 = uo, band 2 = vo
        stacked = xr.concat(
            [hour_slice["uo"], hour_slice["vo"]],
            dim="band",
        ).assign_coords(band=[1, 2])
        stacked.rio.to_raster(
            tif_path,
            driver="GTiff",
            compress="deflate",
            dtype="float32",
            nodata=np.nan,
        )
        out_paths.append(tif_path)
        log.info("Wrote %s (shape=%s)", tif_path, stacked.shape)

    return out_paths


def upload_to_mts(tif_paths: list[Path]) -> None:
    """Upload each hourly GeoTIFF to Mapbox as a raster-array tileset."""
    username = require_env("MAPBOX_USERNAME")
    token = require_env("MAPBOX_UPLOAD_TOKEN")

    for i, tif in enumerate(tif_paths):
        tileset_id = f"{username}.{MAPBOX_TILESET_PREFIX}-h{i:02d}"
        log.info("Uploading %s → %s", tif, tileset_id)

        # Use the official `tilesets` CLI. It handles multipart upload,
        # recipe validation, and the publish step.
        env = {**os.environ, "MAPBOX_ACCESS_TOKEN": token}
        for cmd in [
            ["tilesets", "upload-raster-source", username, f"{MAPBOX_TILESET_PREFIX}-h{i:02d}", str(tif)],
            ["tilesets", "create", tileset_id, "--recipe", str(MAPBOX_RECIPE_PATH),
             "--name", f"Thalassa Currents h+{i:02d}"],
            ["tilesets", "publish", tileset_id],
        ]:
            log.info("$ %s", " ".join(cmd))
            subprocess.run(cmd, env=env, check=True)


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        log.error("Missing required env var %s", name)
        sys.exit(2)
    return val


def main() -> int:
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    end = now + timedelta(hours=FORECAST_HOURS)

    try:
        nc_path = fetch_cmems(now, end)
        tifs = netcdf_to_geotiffs(nc_path)
        upload_to_mts(tifs)
    except Exception:  # noqa: BLE001 — we want the traceback in the Action log
        log.exception("Pipeline failed")
        return 1

    log.info("✓ Pipeline complete — %d hourly tilesets published", len(tifs))
    return 0


if __name__ == "__main__":
    sys.exit(main())
