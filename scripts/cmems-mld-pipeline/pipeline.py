#!/usr/bin/env python3
"""
CMEMS mixed-layer depth → GitHub Release binary pipeline.

Pulls daily-mean mixed-layer depth from the global physics
analysis-forecast (`mlotst` variable, in metres) and packs the
log-normalised values into the u-channel of our v2 THCU binary.
Frontend reads a single scalar plane and renders with a plasma
colour ramp that maps shallow MLD (warm sunlit, ~5m) through
deep MLD (cold convective, ~1000m+).

Why MLD: it's the depth above which the ocean is well-mixed and
isothermal. For fishers it's where the thermocline / oxycline lives
— bait fish and predators stack along it. For sailors it's a useful
"how shocky is the water" proxy: shallow MLD = stable surface layer,
deep MLD = active mixing / cold-water upwelling. Final piece of
roadmap 3.5.

Notes on the data:
- mlotst is in metres. Range varies wildly: ~5m in tropical sunlit
  waters, 50-200m in temperate seas, 500-2000m in deep convective
  sites (Labrador Sea winter, Greenland Sea, Weddell Sea).
- Linear encoding wastes resolution — most ocean is 10-300m. We
  log10-normalise across [1m, 1000m] so 100m sits at t=0.5 and
  every order of magnitude gets equal colour budget. Same trick
  chl uses for its 4-decade concentration span.
- We discard t < 0.10 (~2m MLD) in the shader so coastal noise and
  numerical underflow stay invisible.

Dataset: cmems_mod_glo_phy_anfc_0.083deg_P1D-m. Combined daily
physics — same dataset that ships sea-ice (siconc), surface height
(zos), bottom temperature (tob). Coarsened to 0.25° to match the
rest of the layer suite.
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

log = logging.getLogger("cmems-mld-pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# ── Config ────────────────────────────────────────────────────────────────

# Combined physics dataset — same as seaice. mlotst rides alongside
# siconc / zos / tob etc. The per-variable split that thetao got
# doesn't apply here (we'd hit DatasetNotFound).
DATASET_ID = "cmems_mod_glo_phy_anfc_0.083deg_P1D-m"
VARIABLES = ["mlotst"]  # mixed-layer depth in metres

FORECAST_DAYS = 5
SUBSAMPLE_DEG = 0.25  # coarsen 0.083° → 0.25° to match sister layers

# Log10-normalisation range for MLD. 1m floor (below noise), 1000m
# ceiling (catches all but the most extreme deep convective sites,
# which saturate at the deepest colour and that's fine for our use).
# log10(1) = 0, log10(1000) = 3 → 3 orders of magnitude get equal
# colour budget instead of being squashed by linear encoding.
MLD_LOG_MIN = 0.0   # log10(1)
MLD_LOG_MAX = 3.0   # log10(1000)
MLD_LOG_RANGE = MLD_LOG_MAX - MLD_LOG_MIN  # 3.0

RELEASE_TAG = "cmems-mld-latest"

OUT_DIR = Path(os.environ.get("CMEMS_OUT_DIR", "/tmp/cmems-mld"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

BINARY_MAGIC = b"THCU"
BINARY_VERSION = 2


# ── Steps ─────────────────────────────────────────────────────────────────


def fetch_cmems(start: datetime, end: datetime) -> Path:
    """Download mixed-layer depth for the forecast window."""
    import copernicusmarine

    out_path = OUT_DIR / f"cmems-mld-{start:%Y%m%d}.nc"
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


def encode_daily_binaries(nc_path: Path) -> list[tuple[Path, int]]:
    """Encode the multi-day NetCDF and write one .bin per forecast day."""
    import numpy as np
    import xarray as xr

    ds = xr.open_dataset(nc_path)
    if "depth" in ds.dims:
        ds = ds.isel(depth=0, drop=True)

    lat_res = abs(float(ds.latitude[1] - ds.latitude[0]))
    lon_res = abs(float(ds.longitude[1] - ds.longitude[0]))
    lat_block = max(1, int(round(SUBSAMPLE_DEG / lat_res)))
    lon_block = max(1, int(round(SUBSAMPLE_DEG / lon_res)))

    # mlotst is NaN over land → land mask source.
    land_native = ds["mlotst"].isel(time=0).isnull().astype("float32")

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
        # NaN over ocean = no MLD diagnosed (very rare). Fill with 1m
        # so it falls below the shader's discard threshold.
        mld_raw = ds["mlotst"].isel(time=i).fillna(1.0).astype(np.float32).values

        # Log10 + normalise to [0, 1]. Floor at 1m so log doesn't go
        # negative on numerical underflow; clip top end at saturate.
        log_mld = np.log10(np.maximum(mld_raw, 1.0)).astype(np.float32)
        t_norm = np.clip((log_mld - MLD_LOG_MIN) / MLD_LOG_RANGE, 0.0, 1.0).astype(np.float32)

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

        ocean = mld_raw[land_mask == 0]
        m_min = float(np.nanmin(ocean)) if ocean.size else float("nan")
        m_med = float(np.nanmedian(ocean)) if ocean.size else float("nan")
        m_max = float(np.nanmax(ocean)) if ocean.size else float("nan")
        log.info(
            "Wrote %s (%dx%d, t=%s, T+%dh, mld min=%.1fm med=%.1fm max=%.1fm, %d land / %d total)",
            bin_path.name, width, height, t, hour_offset,
            m_min, m_med, m_max, land_count, width * height,
        )
    return out


def upload_to_github_release(entries: list[tuple[Path, int]]) -> None:
    """Attach binary files to the rolling `cmems-mld-latest` release."""
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
             "--title", "CMEMS mixed-layer depth (rolling latest)",
             "--notes", "Updated daily. MLD log10-normalised over [1m, 1000m] for the WebGL client."],
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
