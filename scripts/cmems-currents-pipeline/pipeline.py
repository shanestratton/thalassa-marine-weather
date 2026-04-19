#!/usr/bin/env python3
"""
CMEMS ocean-currents → GitHub Release binary pipeline.

Runs daily via GitHub Action. Pulls the Copernicus Marine global physics
forecast (GLOBAL_ANALYSISFORECAST_PHY_001_024), surface currents only,
subsamples to a grid suitable for client-side WebGL particle rendering,
encodes each hour as a compact binary blob, and attaches the blobs to
a rolling GitHub release so the Thalassa web client can fetch them
directly (no third-party tile server dependency).

Binary file format (little-endian):
    bytes  0..3   magic 'THCU' (Thalassa Currents)
    byte   4      version (1)
    byte   5      reserved (0)
    u16    6..7   width
    u16    8..9   height
    f32   10..13  north (decimal degrees)
    f32   14..17  south
    f32   18..21  west
    f32   22..25  east
    u16   26..27  hours  (always 1 per file — one file per forecast hour)
    u16   28..29  reserved (0)
    // pixel data, row-major, north-to-south, west-to-east:
    f32[width*height] u  (east velocity, m/s)
    f32[width*height] v  (north velocity, m/s)

One file per forecast hour, named `h00.bin` through `h<H-1>.bin`.
"""
from __future__ import annotations

import logging
import os
import struct
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
# 12h forecast horizon — near-term passage-planning window.
FORECAST_HOURS = 12
# Subsample to this resolution (degrees). 0.5° = 720×320 ≈ 230k points per
# hour × 8 bytes (u+v float32) = ~1.8 MB/hour uncompressed, well under
# GitHub Release's 2 GB asset cap and fast to transfer.
SUBSAMPLE_DEG = 0.5

# GitHub Release tag to update daily. Must exist before first run — the
# workflow step creates it if missing.
RELEASE_TAG = "cmems-currents-latest"

OUT_DIR = Path(os.environ.get("CMEMS_OUT_DIR", "/tmp/cmems-currents"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

BINARY_MAGIC = b"THCU"
BINARY_VERSION = 1


# ── Steps ─────────────────────────────────────────────────────────────────


def fetch_cmems(start: datetime, end: datetime) -> Path:
    """Download surface currents for the forecast window as a single NetCDF."""
    import copernicusmarine  # lazy import

    out_path = OUT_DIR / f"cmems-currents-{start:%Y%m%dT%H}.nc"
    username = require_env("COPERNICUS_MARINE_USERNAME")
    password = require_env("COPERNICUS_MARINE_PASSWORD")

    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        log.info(
            "Fetching %s → %s into %s (attempt %d/%d)",
            start.isoformat(), end.isoformat(), out_path, attempt, max_attempts,
        )
        try:
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
        except Exception as exc:  # noqa: BLE001
            msg = f"{type(exc).__name__}: {exc}"
            is_transient = any(
                sig in msg
                for sig in (
                    "CouldNotConnectToAuthenticationSystem",
                    "ConnectTimeout", "ReadTimeout", "ConnectionError",
                )
            )
            if is_transient and attempt < max_attempts:
                wait_s = 90 * attempt
                log.warning("Transient CMEMS auth failure: %s — retrying in %ds", msg, wait_s)
                time.sleep(wait_s)
                continue
            raise


def encode_hourly_binaries(nc_path: Path) -> list[Path]:
    """Subsample the multi-hour NetCDF and write one .bin per forecast hour."""
    import numpy as np
    import xarray as xr

    ds = xr.open_dataset(nc_path)
    if "depth" in ds.dims:
        ds = ds.squeeze("depth", drop=True)

    # Subsample to SUBSAMPLE_DEG resolution to cap file size.
    lat_step = max(1, int(round(SUBSAMPLE_DEG / abs(float(ds.latitude[1] - ds.latitude[0])))))
    lon_step = max(1, int(round(SUBSAMPLE_DEG / abs(float(ds.longitude[1] - ds.longitude[0])))))
    ds = ds.isel(latitude=slice(None, None, lat_step),
                 longitude=slice(None, None, lon_step))
    # Ensure lat goes north→south in the output (matches client expectation
    # of row-major north-to-south). CMEMS native is south→north.
    ds = ds.reindex(latitude=ds.latitude[::-1])

    height = ds.sizes["latitude"]
    width = ds.sizes["longitude"]
    north = float(ds.latitude[0])
    south = float(ds.latitude[-1])
    west = float(ds.longitude[0])
    east = float(ds.longitude[-1])

    out_paths: list[Path] = []
    for i, t in enumerate(ds.time.values):
        u = ds["uo"].isel(time=i).fillna(0.0).astype(np.float32).values  # ravel() applied below
        v = ds["vo"].isel(time=i).fillna(0.0).astype(np.float32).values

        bin_path = OUT_DIR / f"h{i:02d}.bin"
        header = struct.pack(
            "<4sBBHHffffHH",
            BINARY_MAGIC,
            BINARY_VERSION,
            0,
            width, height,
            north, south, west, east,
            1,  # hours in this file
            0,  # reserved
        )
        with bin_path.open("wb") as f:
            f.write(header)
            f.write(u.astype(np.float32).tobytes())
            f.write(v.astype(np.float32).tobytes())
        out_paths.append(bin_path)
        log.info(
            "Wrote %s (%dx%d, time=%s, size=%d bytes)",
            bin_path.name, width, height, t, bin_path.stat().st_size,
        )
    return out_paths


def upload_to_github_release(paths: list[Path]) -> None:
    """Attach binary files to the rolling `cmems-currents-latest` release.

    Requires `GH_TOKEN` or `GITHUB_TOKEN` in env (automatic in Actions).
    Uses `gh release upload --clobber` to replace files in place so the
    URL stays stable day-over-day.
    """
    repo = require_env("GITHUB_REPOSITORY")  # e.g. shanestratton/thalassa-marine-weather
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        log.error("Neither GH_TOKEN nor GITHUB_TOKEN set — cannot upload release assets")
        sys.exit(2)
    env = {**os.environ, "GH_TOKEN": token}

    # Ensure the release exists — create with a placeholder note if missing.
    create = subprocess.run(
        ["gh", "release", "view", RELEASE_TAG, "--repo", repo],
        env=env, capture_output=True, text=True,
    )
    if create.returncode != 0:
        log.info("Release %s missing — creating", RELEASE_TAG)
        subprocess.run(
            ["gh", "release", "create", RELEASE_TAG,
             "--repo", repo,
             "--title", "CMEMS currents (rolling latest)",
             "--notes", "Updated daily. Binary u/v current fields for the WebGL client."],
            env=env, check=True,
        )

    # Write a manifest that lists the files + their forecast hours
    # so the client can discover them without a directory listing.
    manifest_path = OUT_DIR / "manifest.json"
    manifest = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "hours": [
            {"hour": i, "file": p.name, "bytes": p.stat().st_size}
            for i, p in enumerate(paths)
        ],
    }
    import json as _json
    manifest_path.write_text(_json.dumps(manifest, indent=2))

    # Upload all .bin files + manifest in one CLI call (faster, fewer 429 risks)
    cmd = ["gh", "release", "upload", RELEASE_TAG,
           "--repo", repo,
           "--clobber"] + [str(p) for p in paths] + [str(manifest_path)]
    log.info("$ %s", " ".join(cmd[:5] + ["<%d files>" % (len(paths) + 1)]))
    subprocess.run(cmd, env=env, check=True)
    log.info("✓ Uploaded %d binaries + manifest to %s release", len(paths), RELEASE_TAG)


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
        bins = encode_hourly_binaries(nc_path)
        upload_to_github_release(bins)
    except Exception:  # noqa: BLE001
        log.exception("Pipeline failed")
        return 1

    log.info("✓ Pipeline complete — %d hourly binaries on %s", len(bins), RELEASE_TAG)
    return 0


if __name__ == "__main__":
    sys.exit(main())
