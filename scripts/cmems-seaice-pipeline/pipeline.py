#!/usr/bin/env python3
"""
CMEMS sea-ice concentration → GitHub Release binary pipeline.

Pulls daily-mean sea-ice fraction from the global physics
analysis-forecast suite (`siconc` variable, 0–1 fraction) and packs
the values into the u-channel of our v2 THCU binary (same shape as
SST and chl). Frontend reads a single scalar plane and renders with
an ice-white colour ramp that fades smoothly to transparent below the
15% concentration "ice edge" threshold meteorologists use.

Why sea-ice: unlocks high-latitude routing (Baltic winter, Alaska,
Svalbard, Antarctic) — the last globally-relevant data layer the
Thalassa map didn't cover. Roadmap item 3.5 final piece.

Notes on the data:
- siconc is dimensionless [0, 1] — already-normalised, no log scale or
  offset like chl/SST need. We pack it directly into the u-channel.
- 15% concentration = "ice edge" by convention. Below that we let the
  shader discard so polar routes through marginal ice show clean ocean.
- 100% = consolidated pack ice (think central Arctic Ocean in winter).

Dataset: cmems_mod_glo_phy-siconc_anfc_0.083deg_P1D-m. Same per-variable
physics convention as SST (cmems_mod_glo_phy-thetao_...). Coarsened to
0.25° globally to match sister pipelines and keep file sizes sane.
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

log = logging.getLogger("cmems-seaice-pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# ── Config ────────────────────────────────────────────────────────────────

# Per-variable physics dataset for sea-ice concentration. CMEMS split
# the combined glo_phy_anfc dataset into per-variable variants — siconc
# follows the same convention as thetao (SST).
DATASET_ID = "cmems_mod_glo_phy-siconc_anfc_0.083deg_P1D-m"
VARIABLES = ["siconc"]  # sea-ice concentration, dimensionless [0, 1]

FORECAST_DAYS = 5
# Coarsen 0.083° → 0.25° to match the rest of the CMEMS layer suite.
# Sea ice is naturally smooth — fronts evolve over days, not hours, and
# polar regions are vast — so 0.25° loses essentially nothing visible
# at marine routing zoom (4-12) while shrinking each daily binary by ~9×.
SUBSAMPLE_DEG = 0.25

RELEASE_TAG = "cmems-seaice-latest"

OUT_DIR = Path(os.environ.get("CMEMS_OUT_DIR", "/tmp/cmems-seaice"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

BINARY_MAGIC = b"THCU"
BINARY_VERSION = 2


# ── Steps ─────────────────────────────────────────────────────────────────


def fetch_cmems(start: datetime, end: datetime) -> Path:
    """Download sea-ice concentration for the forecast window."""
    import copernicusmarine

    out_path = OUT_DIR / f"cmems-seaice-{start:%Y%m%d}.nc"
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
                # Full latitude range — we want both Arctic and Antarctic
                # ice. CMEMS's tripolar→regular regridded grid typically
                # tops out around 89.95°N / -80°S.
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


def encode_daily_binaries(nc_path: Path) -> list[tuple[Path, int]]:
    """Encode the multi-day NetCDF and write one .bin per forecast day."""
    import numpy as np
    import xarray as xr

    ds = xr.open_dataset(nc_path)
    # siconc has no depth dimension — surface only by definition. Strip
    # if CMEMS happens to add a depth axis on some build of the dataset.
    if "depth" in ds.dims:
        ds = ds.isel(depth=0, drop=True)

    lat_res = abs(float(ds.latitude[1] - ds.latitude[0]))
    lon_res = abs(float(ds.longitude[1] - ds.longitude[0]))
    lat_block = max(1, int(round(SUBSAMPLE_DEG / lat_res)))
    lon_block = max(1, int(round(SUBSAMPLE_DEG / lon_res)))

    # siconc is NaN over land — perfect for deriving the land mask.
    land_native = ds["siconc"].isel(time=0).isnull().astype("float32")

    if lat_block > 1 or lon_block > 1:
        ds = ds.coarsen(latitude=lat_block, longitude=lon_block, boundary="trim").mean()
        land_frac = land_native.coarsen(latitude=lat_block, longitude=lon_block, boundary="trim").mean()
        land_da = (land_frac >= 0.5).astype("uint8")
    else:
        land_da = land_native.astype("uint8")

    # Frontend wants rows north→south, cols west→east (matches sister layers).
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
        # Open water = 0 (we replace NaN-over-ocean with 0 so the shader
        # discard threshold cleanly identifies "no ice"). NaN-over-land
        # stays in the land mask and gets discarded separately.
        siconc_raw = ds["siconc"].isel(time=i).fillna(0.0).astype(np.float32).values

        # siconc is dimensionless [0, 1] already — clip in case of tiny
        # numerical overshoots from the regridding step and pack directly.
        t_norm = np.clip(siconc_raw, 0.0, 1.0).astype(np.float32)

        u = t_norm                              # pre-normalised [0,1]
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

        ocean = siconc_raw[land_mask == 0]
        ice_pixels = int((ocean >= 0.15).sum()) if ocean.size else 0
        c_max = float(np.nanmax(ocean)) if ocean.size else float("nan")
        log.info(
            "Wrote %s (%dx%d, t=%s, T+%dh, ice cells=%d at >=15%%, max=%.2f, %d land / %d total)",
            bin_path.name, width, height, t, hour_offset,
            ice_pixels, c_max, land_count, width * height,
        )
    return out


def upload_to_github_release(entries: list[tuple[Path, int]]) -> None:
    """Attach binary files to the rolling `cmems-seaice-latest` release."""
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
             "--title", "CMEMS sea-ice concentration (rolling latest)",
             "--notes", "Updated daily. Sea-ice concentration (0–1) packed into u-channel for the WebGL client."],
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
