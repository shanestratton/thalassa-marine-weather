#!/usr/bin/env python3
"""
CMEMS chlorophyll-a → GitHub Release binary pipeline.

Pulls daily-mean surface chlorophyll concentration from the global
biogeochemistry forecast (GLOBAL_ANALYSISFORECAST_BGC_001_028) and
packs the values into the u-channel of our v2 THCU binary (same shape
as SST). Frontend reads a single scalar plane and renders with an
algal colour ramp.

Key difference from SST: chlorophyll concentration spans ~4 orders
of magnitude (0.01 mg/m³ in oligotrophic gyres up to ~50 mg/m³ in
productive coastal blooms). Linear encoding would saturate 90% of the
ocean to one colour bucket. We encode LOG10(chl + 0.01) normalized to
[0, 1] in the pipeline so the frontend can treat it as a linear-u8
texture without doing log math in the shader.

Binary format: v2 THCU. u = normalized log-chl [0,1], v = 0.
Frontend shader maps u directly into the algal colour ramp (u=0 →
deep purple gyres, u=1 → bright green blooms).

Dataset: cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m is already at 0.25°
native (the resolution we coarsen currents/waves/sst down TO), so no
coarsening is needed — grab it as-is.
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

log = logging.getLogger("cmems-chl-pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# ── Config ────────────────────────────────────────────────────────────────

# BGC-PFT dataset: plankton functional types + chlorophyll. CMEMS
# publishes per-variable variants — if this combined id fails the
# way the SST physics one did, try cmems_mod_glo_bgc-chl_anfc_...
DATASET_ID = "cmems_mod_glo_bgc-pft_anfc_0.25deg_P1D-m"
VARIABLES = ["chl"]  # chlorophyll concentration in mg/m³

FORECAST_DAYS = 5
# BGC native is already 0.25° = no coarsening step. We leave the
# coarsen machinery in the pipeline anyway (block size = 1 is a no-op)
# so the code path is identical to sister pipelines.
SUBSAMPLE_DEG = 0.25

# Log-normalisation range for chlorophyll. 0.01 mg/m³ = open-ocean
# oligotrophic floor, 50 mg/m³ = rare but-observed bloom peak. Cover
# the full 4-orders-of-magnitude span so every real ocean value maps
# into the colour ramp.
CHL_LOG_MIN = -2.0   # log10(0.01)
CHL_LOG_MAX = 1.7    # log10(50)
CHL_LOG_RANGE = CHL_LOG_MAX - CHL_LOG_MIN  # 3.7

RELEASE_TAG = "cmems-chl-latest"

OUT_DIR = Path(os.environ.get("CMEMS_OUT_DIR", "/tmp/cmems-chl"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

BINARY_MAGIC = b"THCU"
BINARY_VERSION = 2


# ── Steps ─────────────────────────────────────────────────────────────────


def fetch_cmems(start: datetime, end: datetime) -> Path:
    """Download surface chlorophyll for the forecast window."""
    import copernicusmarine

    out_path = OUT_DIR / f"cmems-chl-{start:%Y%m%d}.nc"
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
                minimum_depth=0,
                maximum_depth=1,
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


def encode_daily_binaries(nc_path: Path) -> list[tuple[Path, int]]:
    """Encode the multi-day NetCDF and write one .bin per forecast day."""
    import numpy as np
    import xarray as xr

    ds = xr.open_dataset(nc_path)
    if "depth" in ds.dims:
        ds = ds.isel(depth=0, drop=True)

    # Coarsening — at native 0.25° this is a 1×1 block (no-op) so we
    # preserve every native cell. Kept in the code path for parity with
    # the other pipelines in case CMEMS publishes a finer BGC grid.
    lat_res = abs(float(ds.latitude[1] - ds.latitude[0]))
    lon_res = abs(float(ds.longitude[1] - ds.longitude[0]))
    lat_block = max(1, int(round(SUBSAMPLE_DEG / lat_res)))
    lon_block = max(1, int(round(SUBSAMPLE_DEG / lon_res)))

    land_native = ds["chl"].isel(time=0).isnull().astype("float32")

    if lat_block > 1 or lon_block > 1:
        ds = ds.coarsen(latitude=lat_block, longitude=lon_block, boundary="trim").mean()
        land_frac = land_native.coarsen(latitude=lat_block, longitude=lon_block, boundary="trim").mean()
        land_da = (land_frac >= 0.5).astype("uint8")
    else:
        land_da = land_native.astype("uint8")

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

    times = ds.time.values
    t0 = times[0]

    out: list[tuple[Path, int]] = []
    for i, t in enumerate(times):
        chl_raw = ds["chl"].isel(time=i).fillna(0.01).astype(np.float32).values

        # Log10 + normalise to [0, 1]. Clamp to the range so coastal
        # bloom spikes above 50 mg/m³ saturate at max colour instead of
        # wrapping / going negative.
        log_chl = np.log10(np.maximum(chl_raw, 0.001) + 0.01).astype(np.float32)
        t_norm = np.clip((log_chl - CHL_LOG_MIN) / CHL_LOG_RANGE, 0.0, 1.0).astype(np.float32)

        u = t_norm                              # pre-normalised [0,1] for direct shader use
        v = np.zeros_like(t_norm, dtype=np.float32)

        hour_offset = int(round(float((t - t0).astype("timedelta64[s]").astype(float)) / 3600.0))

        bin_path = OUT_DIR / f"h{i:02d}.bin"
        header = struct.pack(
            "<4sBBHHffffHH",
            BINARY_MAGIC,
            BINARY_VERSION,
            0,
            width, height,
            north, south, west, east,
            1, 0,
        )
        with bin_path.open("wb") as f:
            f.write(header)
            f.write(np.ascontiguousarray(u, dtype=np.float32).tobytes())
            f.write(np.ascontiguousarray(v, dtype=np.float32).tobytes())
            f.write(land_mask.tobytes())
        out.append((bin_path, hour_offset))

        ocean = chl_raw[land_mask == 0]
        c_min = float(np.nanmin(ocean)) if ocean.size else float("nan")
        c_max = float(np.nanmax(ocean)) if ocean.size else float("nan")
        c_med = float(np.nanmedian(ocean)) if ocean.size else float("nan")
        log.info(
            "Wrote %s (%dx%d, t=%s, T+%dh, chl min=%.3f med=%.3f max=%.2f mg/m³, %d land / %d total)",
            bin_path.name, width, height, t, hour_offset, c_min, c_med, c_max,
            land_count, width * height,
        )
    return out


def upload_to_github_release(entries: list[tuple[Path, int]]) -> None:
    """Attach binary files to the rolling `cmems-chl-latest` release."""
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
             "--title", "CMEMS chlorophyll (rolling latest)",
             "--notes", "Updated daily. Surface chlorophyll (log-normalised) for the WebGL client."],
            env=env, check=True,
        )

    manifest_path = OUT_DIR / "manifest.json"
    manifest = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
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
    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    end = now + timedelta(days=FORECAST_DAYS)

    try:
        nc_path = fetch_cmems(now, end)
        entries = encode_daily_binaries(nc_path)
        upload_to_github_release(entries)
    except Exception:  # noqa: BLE001
        log.exception("Pipeline failed")
        return 1

    log.info("✓ Pipeline complete — %d daily snapshots on %s", len(entries), RELEASE_TAG)
    return 0


if __name__ == "__main__":
    sys.exit(main())
