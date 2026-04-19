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
# 12-hour forecast window, surface only. Mapbox MTS rate limits mean
# we can only publish ~12-15 tilesets per run without hitting sustained
# 429s — so ship a useful near-term horizon now and chunk longer-range
# forecasts across multiple workflow runs later.
FORECAST_HOURS = 12
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


def netcdf_to_geotiffs(nc_path: Path) -> list[tuple[Path, Path]]:
    """Slice the multi-hour NetCDF into per-hour pairs (u.nc, v.nc).

    Each component goes in its own single-variable NetCDF so MTS sees
    unambiguous 1-source-1-band semantics. The recipe then references
    BOTH files as `sources[]` and filters on sourceindex — no band-
    metadata guessing needed.
    """
    import numpy as np  # noqa: F401
    import xarray as xr

    ds = xr.open_dataset(nc_path)
    if "depth" in ds.dims:
        ds = ds.squeeze("depth", drop=True)

    NODATA = -9999.0

    out_pairs: list[tuple[Path, Path]] = []
    for i, t in enumerate(ds.time.values):
        single = ds.sel(time=slice(t, t))
        u_path = nc_path.parent / f"currents-hour-{i:02d}-u.nc"
        v_path = nc_path.parent / f"currents-hour-{i:02d}-v.nc"

        u = single["uo"].fillna(NODATA)
        v = single["vo"].fillna(NODATA)
        u.attrs.pop("_FillValue", None)
        v.attrs.pop("_FillValue", None)

        xr.Dataset({"u": u}).to_netcdf(
            u_path,
            encoding={"u": {"dtype": "float32", "_FillValue": NODATA, "zlib": True}},
        )
        xr.Dataset({"v": v}).to_netcdf(
            v_path,
            encoding={"v": {"dtype": "float32", "_FillValue": NODATA, "zlib": True}},
        )
        out_pairs.append((u_path, v_path))
        log.info(
            "Wrote pair h%02d: %s + %s (time=%s, nodata=%s)",
            i, u_path.name, v_path.name, t, NODATA,
        )

    return out_pairs


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

    for i, pair in enumerate(tif_paths):
        u_path, v_path = pair
        u_source_id = f"{MAPBOX_TILESET_PREFIX}-h{i:02d}-u"
        v_source_id = f"{MAPBOX_TILESET_PREFIX}-h{i:02d}-v"
        source_id = f"{MAPBOX_TILESET_PREFIX}-h{i:02d}"
        tileset_id = f"{username}.{source_id}"
        u_source_uri = f"mapbox://tileset-source/{username}/{u_source_id}"
        v_source_uri = f"mapbox://tileset-source/{username}/{v_source_id}"
        log.info("Uploading pair h%02d → %s", i, tileset_id)

        # 1. Upload both source files. --replace cleans up previous uploads.
        up_u = run_with_retry(
            ["tilesets", "upload-raster-source", "--replace", username, u_source_id, str(u_path)],
            env, f"upload h{i:02d}-u",
        )
        up_u.check_returncode()
        up_v = run_with_retry(
            ["tilesets", "upload-raster-source", "--replace", username, v_source_id, str(v_path)],
            env, f"upload h{i:02d}-v",
        )
        up_v.check_returncode()

        # 2. Write a per-hour recipe referencing BOTH sources — tagged so
        #    the `sourcetag` filter operator can tell them apart.
        recipe_with_sources = {
            **base_recipe,
            "sources": [
                {"uri": u_source_uri, "tag": "u"},
                {"uri": v_source_uri, "tag": "v"},
            ],
        }
        recipe_path = u_path.parent / f"recipe-h{i:02d}.json"
        recipe_path.write_text(json.dumps(recipe_with_sources, indent=2))

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

        # Courtesy delay — stay well under MTS's ~40 calls/min limit.
        # With --replace, upload alone costs 2 calls (delete+upload), plus
        # create/update-recipe and publish = 4–5 calls per hour. 4s between
        # iterations = 15 requests/min ceiling, comfortably under limit,
        # without which we saw sustained 429s even after 10min of retries.
        time.sleep(4)


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
