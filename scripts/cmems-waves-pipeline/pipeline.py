#!/usr/bin/env python3
"""
CMEMS ocean-waves → GitHub Release binary pipeline.

Runs daily via GitHub Action. Pulls the Copernicus Marine global wave
analysis+forecast (GLOBAL_ANALYSISFORECAST_WAV_001_027), significant
height + mean direction only, area-averages to a grid matching the
currents layer, converts direction + height into u/v components so the
existing CurrentParticleLayer-style renderer can ingest it directly
(same binary format, same parser), and attaches the blobs to a rolling
`cmems-waves-latest` GitHub Release.

Sister pipeline to cmems-currents-pipeline; same v2 binary format so
the frontend parser reuses all the same code paths. The only real
difference is the source dataset + the VHM0/VMDR → u/v conversion.

Binary file format (little-endian) — v2, identical to currents:
    bytes  0..3   magic 'THCU' (kept so existing parser works unchanged)
    byte   4      version (2)
    byte   5      reserved (0)
    u16    6..7   width
    u16    8..9   height
    f32   10..13  north (decimal degrees)
    f32   14..17  south
    f32   18..21  west
    f32   22..25  east
    u16   26..27  hours  (always 1 per file)
    u16   28..29  reserved (0)
    // pixel data, row-major, north-to-south, west-to-east:
    f32[width*height] u           (east "wave velocity" = VHM0 * sin(to_dir), m)
    f32[width*height] v           (north "wave velocity" = VHM0 * cos(to_dir), m)
    u8 [width*height] land_mask   (1=land, 0=ocean)

u/v are the VHM0 magnitude projected onto cardinal axes using the
to-direction (VMDR + 180°, since VMDR is in meteorological "from"
convention). Downstream this lets the particle layer advect and colour
particles by the same vector-field math as currents — the only UI-side
difference is the colour-ramp bounds (a 6m swell is "red" where a 1.5
m/s current is "red").

One file per forecast time step, named `h00.bin` through `h<N-1>.bin`.
The dataset is 3-hourly, so h00 = T+0h, h01 = T+3h, etc.
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

log = logging.getLogger("cmems-waves-pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# ── Config ────────────────────────────────────────────────────────────────

DATASET_ID = "cmems_mod_glo_wav_anfc_0.083deg_PT3H-i"
# VHM0 = significant wave height (m)
# VMDR = mean wave direction (degrees, meteorological "from" convention)
VARIABLES = ["VHM0", "VMDR"]
# 48h forecast window — waves matter more for passage planning than
# currents (storms develop over days), so a longer horizon is useful.
# At 3-hourly native cadence, 48h = 17 snapshots.
FORECAST_HOURS = 48
# 0.25° to match currents layer and share the same parser + mesh.
SUBSAMPLE_DEG = 0.25

RELEASE_TAG = "cmems-waves-latest"

OUT_DIR = Path(os.environ.get("CMEMS_OUT_DIR", "/tmp/cmems-waves"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Same magic as currents — the frontend parser checks this; reusing it
# means no new parsing code. "THCU" stood for Thalassa Currents but is
# effectively now "Thalassa Cartesian-UV binary" which covers both.
BINARY_MAGIC = b"THCU"
BINARY_VERSION = 2


# ── Steps ─────────────────────────────────────────────────────────────────


def fetch_cmems(start: datetime, end: datetime) -> Path:
    """Download surface waves for the forecast window as a single NetCDF."""
    import copernicusmarine  # lazy import

    out_path = OUT_DIR / f"cmems-waves-{start:%Y%m%dT%H}.nc"
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


def encode_hourly_binaries(nc_path: Path) -> list[tuple[Path, int]]:
    """Coarsen the multi-hour NetCDF and write one .bin per forecast step.

    Returns list of (path, hour_offset) tuples so the manifest builder
    can record actual forecast hours (0, 3, 6, 9, ...) rather than step
    indices.
    """
    import numpy as np
    import xarray as xr

    ds = xr.open_dataset(nc_path)
    if "depth" in ds.dims:
        ds = ds.squeeze("depth", drop=True)

    # Build a NATIVE-resolution land mask BEFORE filling NaNs. CMEMS marks
    # land cells as NaN — use VHM0's NaN pattern as the truth.
    lat_block = max(1, int(round(SUBSAMPLE_DEG / abs(float(ds.latitude[1] - ds.latitude[0])))))
    lon_block = max(1, int(round(SUBSAMPLE_DEG / abs(float(ds.longitude[1] - ds.longitude[0])))))

    land_native = ds["VHM0"].isel(time=0).isnull().astype("float32")  # 1=land, 0=ocean

    # Area-average (coarsen+mean), not nearest-neighbour. Preserves narrow
    # swell features — same reasoning as currents (EAC was invisible under
    # nearest-neighbour 0.5° downsampling).
    ds = ds.coarsen(latitude=lat_block, longitude=lon_block, boundary="trim").mean()
    land_frac = land_native.coarsen(latitude=lat_block, longitude=lon_block, boundary="trim").mean()
    land_da = (land_frac >= 0.5).astype("uint8")

    # Reverse latitude so output is row-major north→south (client convention).
    ds = ds.reindex(latitude=ds.latitude[::-1])
    land_da = land_da.reindex(latitude=land_da.latitude[::-1])

    height = ds.sizes["latitude"]
    width = ds.sizes["longitude"]
    north = float(ds.latitude[0])
    south = float(ds.latitude[-1])
    west = float(ds.longitude[0])
    east = float(ds.longitude[-1])

    land_mask = np.ascontiguousarray(land_da.values, dtype=np.uint8)
    land_count = int(land_mask.sum())

    # Pre-compute hour offsets from the first time step
    times = ds.time.values
    t0 = times[0]

    out: list[tuple[Path, int]] = []
    for i, t in enumerate(times):
        # VHM0 = significant wave height (m)
        # VMDR = mean wave direction, "from" convention in degrees
        H = ds["VHM0"].isel(time=i).fillna(0.0).astype(np.float32).values
        D = ds["VMDR"].isel(time=i).fillna(0.0).astype(np.float32).values

        # Convert to "to" direction and project onto east/north axes.
        # VMDR = meteorological "from" → wave goes the OPPOSITE way.
        # to_dir = VMDR + 180, but we can skip the +180 by negating the
        # sin/cos:
        #   u = H * sin((VMDR + 180) * π/180) = -H * sin(VMDR * π/180)
        #   v = H * cos((VMDR + 180) * π/180) = -H * cos(VMDR * π/180)
        rad = np.deg2rad(D)
        u = (-H * np.sin(rad)).astype(np.float32)
        v = (-H * np.cos(rad)).astype(np.float32)

        # Hour offset in whole hours from the first time step. NumPy
        # timedelta64 → float64 seconds via .astype('timedelta64[s]').
        hour_offset = int(round(float((t - t0).astype("timedelta64[s]").astype(float)) / 3600.0))

        bin_path = OUT_DIR / f"h{i:02d}.bin"
        header = struct.pack(
            "<4sBBHHffffHH",
            BINARY_MAGIC,
            BINARY_VERSION,
            0,
            width, height,
            north, south, west, east,
            1,   # hours in this file
            0,   # reserved
        )
        with bin_path.open("wb") as f:
            f.write(header)
            f.write(np.ascontiguousarray(u, dtype=np.float32).tobytes())
            f.write(np.ascontiguousarray(v, dtype=np.float32).tobytes())
            f.write(land_mask.tobytes())
        out.append((bin_path, hour_offset))
        log.info(
            "Wrote %s (%dx%d, t=%s, T+%dh, %d bytes, %d land / %d total)",
            bin_path.name, width, height, t, hour_offset, bin_path.stat().st_size,
            land_count, width * height,
        )
    return out


def upload_to_github_release(entries: list[tuple[Path, int]]) -> None:
    """Attach binary files to the rolling `cmems-waves-latest` release."""
    repo = require_env("GITHUB_REPOSITORY")
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not token:
        log.error("Neither GH_TOKEN nor GITHUB_TOKEN set — cannot upload release assets")
        sys.exit(2)
    env = {**os.environ, "GH_TOKEN": token}

    create = subprocess.run(
        ["gh", "release", "view", RELEASE_TAG, "--repo", repo],
        env=env, capture_output=True, text=True,
    )
    if create.returncode != 0:
        log.info("Release %s missing — creating", RELEASE_TAG)
        subprocess.run(
            ["gh", "release", "create", RELEASE_TAG,
             "--repo", repo,
             "--title", "CMEMS waves (rolling latest)",
             "--notes", "Updated daily. Binary VHM0+VMDR → u/v wave fields for the WebGL client."],
            env=env, check=True,
        )

    manifest_path = OUT_DIR / "manifest.json"
    manifest = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        # `hour` is the ACTUAL forecast hour offset from issuance (0, 3,
        # 6, 9, …) — not a sequential step index. The frontend uses this
        # to label the scrubber with real T+Xh times.
        "hours": [
            {"hour": hr, "file": p.name, "bytes": p.stat().st_size}
            for (p, hr) in entries
        ],
    }
    import json as _json
    manifest_path.write_text(_json.dumps(manifest, indent=2))

    paths = [p for (p, _) in entries]
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
    # Align to the nearest 3-hour slot before NOW so we catch the freshest
    # analysis snapshot. CMEMS WAV forecasts run at 00/06/12/18 UTC and
    # publish ~2h later.
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    now = now.replace(hour=now.hour - (now.hour % 3))
    end = now + timedelta(hours=FORECAST_HOURS)

    try:
        nc_path = fetch_cmems(now, end)
        entries = encode_hourly_binaries(nc_path)
        upload_to_github_release(entries)
    except Exception:  # noqa: BLE001
        log.exception("Pipeline failed")
        return 1

    log.info("✓ Pipeline complete — %d snapshots on %s", len(entries), RELEASE_TAG)
    return 0


if __name__ == "__main__":
    sys.exit(main())
