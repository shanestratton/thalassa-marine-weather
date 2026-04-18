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
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger("cmems-pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# ── Config ────────────────────────────────────────────────────────────────

DATASET_ID = "cmems_mod_glo_phy_anfc_merged-uv_PT1H-i"
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
    """Download surface currents for the forecast window as a single NetCDF.

    Copernicus's auth.marine.copernicus.eu endpoint is intermittently
    unreachable from GitHub's us-east-1 runners, so we retry the whole
    download on transient connection failures.
    """
    import copernicusmarine  # lazy import — keeps the script importable without creds

    out_path = OUT_DIR / f"cmems-currents-{start:%Y%m%dT%H}.nc"
    username = require_env("COPERNICUS_MARINE_USERNAME")
    password = require_env("COPERNICUS_MARINE_PASSWORD")

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        log.info("Fetching %s → %s into %s (attempt %d/%d)",
                 start.isoformat(), end.isoformat(), out_path, attempt, max_attempts)
        try:
            # copernicusmarine 2.x notes:
            # - `force_download` was removed entirely (no-prompt download is now default)
            # - `overwrite_output_data` → `overwrite`
            # - The toolbox does NOT auto-read `COPERNICUS_MARINE_USERNAME`/`_PASSWORD`
            #   env vars; it looks for a login config file or explicit kwargs.
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
                username=username,
                password=password,
            )
            return out_path
        except Exception as exc:  # noqa: BLE001 — we look at the class name
            msg = f"{type(exc).__name__}: {exc}"
            is_transient = any(
                sig in msg
                for sig in [
                    "CouldNotConnectToAuthenticationSystem",
                    "ConnectTimeout",
                    "ReadTimeout",
                    "ConnectionError",
                ]
            )
            if is_transient and attempt < max_attempts:
                wait_s = 90 * attempt  # 90s, 180s — give the auth system time to recover
                log.warning("Transient CMEMS auth failure: %s — retrying in %ds", msg, wait_s)
                time.sleep(wait_s)
                continue
            raise


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

        # Mapbox MTS raster-array doesn't accept NaN nodata — the job
        # fails with a generic "error during processing". Replace NaN
        # with a finite sentinel (-9999) and declare it explicitly.
        NODATA = -9999.0
        filled = stacked.fillna(NODATA)

        # LZW compression (MTS-friendly) — deflate is hit-or-miss.
        filled.rio.to_raster(
            tif_path,
            driver="GTiff",
            compress="lzw",
            dtype="float32",
            nodata=NODATA,
            tiled=True,  # cloud-optimized block layout, faster MTS reads
        )

        # MTS raster-array needs a stable way to tell the two bands apart
        # in the source_rules.name expression. The bandindex operator
        # doesn't cleanly differentiate per-filter-output, so we also
        # stamp explicit band descriptions into the GeoTIFF — MTS can
        # then filter/name via ["get", "description"].
        import rasterio
        with rasterio.open(tif_path, "r+") as dst:
            dst.set_band_description(1, "u")
            dst.set_band_description(2, "v")
            dst.update_tags(1, STANDARD_NAME="eastward_sea_water_velocity", UNITS="m/s")
            dst.update_tags(2, STANDARD_NAME="northward_sea_water_velocity", UNITS="m/s")

        out_paths.append(tif_path)
        log.info("Wrote %s (shape=%s, nodata=%s, bands=[u,v])", tif_path, filled.shape, NODATA)

    return out_paths


def run_with_retry(cmd: list[str], env: dict, step_label: str, max_attempts: int = 6) -> subprocess.CompletedProcess:
    """Run a tilesets CLI command, retrying on 429 Too Many Requests.

    MTS enforces ~40 API calls/min per endpoint. With 49 tilesets ×
    ~4 calls each (upload --replace = delete+upload, create, publish,
    optional update-recipe) that's ~200 calls, so we need generous
    backoff to stay ahead of the bucket.
    """
    for attempt in range(1, max_attempts + 1):
        result = subprocess.run(cmd, env=env, capture_output=True, text=True)
        combined = (result.stdout or "") + (result.stderr or "")
        if "Too Many Requests" in combined or "429" in combined:
            wait_s = 30 * attempt  # 30, 60, 90, 120, 150, 180s — ~10 min worst-case budget
            log.warning("%s hit 429 (attempt %d/%d) — sleeping %ds",
                        step_label, attempt, max_attempts, wait_s)
            time.sleep(wait_s)
            continue
        if result.returncode != 0:
            # Non-rate-limit failure — let the caller decide.
            log.error("%s failed rc=%d stdout=%s stderr=%s",
                      step_label, result.returncode,
                      result.stdout.strip() or "(empty)",
                      result.stderr.strip() or "(empty)")
            return result
        return result
    raise RuntimeError(f"{step_label} still rate-limited after {max_attempts} attempts")


def upload_to_mts(tif_paths: list[Path]) -> None:
    """Upload each hourly GeoTIFF to Mapbox as a raster-array tileset.

    For MTS raster-array, the recipe must reference the uploaded raster-
    source by its mapbox:// URI. We generate a per-hour recipe on the fly
    from the base recipe.json in this dir.
    """
    import json

    username = require_env("MAPBOX_USERNAME")
    token = require_env("MAPBOX_UPLOAD_TOKEN")
    base_recipe = json.loads(MAPBOX_RECIPE_PATH.read_text())

    env = {**os.environ, "MAPBOX_ACCESS_TOKEN": token}

    for i, tif in enumerate(tif_paths):
        source_id = f"{MAPBOX_TILESET_PREFIX}-h{i:02d}"
        tileset_id = f"{username}.{source_id}"
        source_uri = f"mapbox://tileset-source/{username}/{source_id}"
        log.info("Uploading %s → %s", tif, tileset_id)

        # 1. Upload the raster-source file.
        #    --replace deletes any previously uploaded files for this source.
        #    Without it, every daily run APPENDS another copy, and MTS then
        #    fails processing with "error during processing" when it tries
        #    to merge the conflicting files.
        up = run_with_retry(
            ["tilesets", "upload-raster-source", "--replace", username, source_id, str(tif)],
            env, f"upload h{i:02d}",
        )
        up.check_returncode()

        # 2. Write a per-hour recipe that points at this source.
        recipe_with_source = {**base_recipe, "sources": [{"uri": source_uri}]}
        recipe_path = tif.parent / f"recipe-h{i:02d}.json"
        recipe_path.write_text(json.dumps(recipe_with_source, indent=2))

        # 3. Create the tileset. `create` fails with "already exists" on the
        #    second-day run — then we `update-recipe` to keep it idempotent.
        create = run_with_retry(
            ["tilesets", "create", tileset_id, "--recipe", str(recipe_path),
             "--name", f"Thalassa Currents h{i:02d}"],
            env, f"create h{i:02d}",
        )
        log.info("create rc=%d stdout=%s stderr=%s",
                 create.returncode,
                 create.stdout.strip() or "(empty)",
                 create.stderr.strip() or "(empty)")
        combined = (create.stderr or "") + (create.stdout or "")

        # The tilesets CLI returns rc=0 for BOTH successful creation AND
        # "already exists" — we have to string-match to distinguish. If the
        # tileset already existed we MUST push update-recipe, otherwise the
        # stale recipe stays in place and publish runs against it.
        already_exists = "already exists" in combined.lower()
        if already_exists:
            log.info("Tileset exists — updating recipe")
            up2 = run_with_retry(
                ["tilesets", "update-recipe", tileset_id, str(recipe_path)],
                env, f"update-recipe h{i:02d}",
            )
            up2.check_returncode()
        elif create.returncode != 0:
            create.check_returncode()
        elif '"errors"' in combined:
            log.error("create returned 0 but response contains an errors array — aborting")
            raise RuntimeError(f"tilesets create reported an error: {combined}")

        # 4. Publish — kicks off the MTS processing job. This is the most
        #    rate-limited endpoint so the retry wrapper earns its keep here.
        pub = run_with_retry(
            ["tilesets", "publish", tileset_id],
            env, f"publish h{i:02d}",
        )
        pub.check_returncode()

        # Courtesy delay so we don't hammer MTS's rate limiter on the next
        # iteration. Mapbox's documented limit is 40 calls/min; 3 calls per
        # hour × 48 hours = 144 calls total, so we need >36s total pause.
        time.sleep(1.5)


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
