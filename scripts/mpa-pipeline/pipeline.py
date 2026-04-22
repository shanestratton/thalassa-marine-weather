#!/usr/bin/env python3
"""
CAPAD Marine Protected Areas → GeoJSON → GitHub Release pipeline.

Fetches the Australian Collaborative Australian Protected Areas
Database (CAPAD) marine slice from DCCEEW's public ArcGIS REST
FeatureServer, normalises the attributes the frontend cares about
(name, IUCN category, zoning type, jurisdiction), and ships the
result as a single gzip-friendly GeoJSON to a rolling GitHub Release.

Why CAPAD: it's the canonical, government-maintained registry of
all Australian marine reserves (Commonwealth + State), refreshed
at minimum twice a year, and published under CC-BY 4.0. The
FeatureServer is open and well-attributed.

Why a single GeoJSON (vs. PMTiles vector tiles): Mapbox-GL v3
removed `addProtocol`, breaking the easy MapLibre-style PMTiles
bridge. Until we write a Mapbox CustomSource adapter, GeoJSON is
the lowest-friction shipping format. CAPAD's full marine slice
weighs ~2 MB after geometry simplification + gzip, which is fine
as a one-shot fetch when the user toggles MPA on for the first time.

Outputs:
    /tmp/mpa-pipeline/mpa.geojson   — fetched + classified FeatureCollection
    /tmp/mpa-pipeline/manifest.json — small JSON describing the bundle
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

log = logging.getLogger("mpa-pipeline")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

# ── Config ────────────────────────────────────────────────────────────────

# DCCEEW's public CAPAD FeatureServer. ENVIRON='MPA' filters to the
# marine slice (excludes terrestrial reserves which would bloat the
# tile bundle 10× with no marine value). outSR=4326 = WGS84 lat/lon
# which Mapbox consumes natively without a reproject step.
FEATURE_SERVER = (
    "https://gis.environment.gov.au/gispubmap/rest/services/"
    "ogc_services/CAPAD/FeatureServer/0/query"
)

# Fields we keep — the rest are noise for our use case.
#   NAME        — popup label
#   TYPE        — "Marine National Park" / "Sanctuary Zone" / etc.
#   IUCN        — IUCN category code (Ia, Ib, II, III, IV, V, VI, NA)
#   ZONE_TYPE   — fine-grained zoning (only set on multi-zone parks)
#   AUTHORITY   — managing agency (used for the popup credit line)
#   STATE       — jurisdiction
#   GIS_AREA    — area in km² (handy for sorting / summary popups)
KEEP_FIELDS = ["NAME", "TYPE", "IUCN", "ZONE_TYPE", "AUTHORITY", "STATE", "GIS_AREA"]

# ESRI servers cap each query at ~1000-2000 features. We page through
# until exhausted. Page size of 500 is conservative — the server
# rejects huge geometry payloads at 1000.
PAGE_SIZE = 500
MAX_PAGES = 200  # safety net — CAPAD is ~2-3k features today

OUT_DIR = Path("/tmp/mpa-pipeline")
GEOJSON_PATH = OUT_DIR / "mpa.geojson"
MANIFEST_PATH = OUT_DIR / "manifest.json"

RELEASE_TAG = "mpa-aus-latest"

USER_AGENT = "thalassa-marine-weather/1.0 (mpa-pipeline)"

# Restriction band — what the frontend uses to colour the polygon.
# We collapse the noisy CAPAD TYPE / IUCN combos into 3 buckets so
# the legend stays readable for users who don't care about the IUCN
# nomenclature. Reasoning:
#   "no_take"  = absolutely no extraction (fishing, collecting)
#   "partial"  = some restrictions (no-anchor, no-trawl, seasonal)
#   "general"  = multi-use; recreational fishing usually OK
RESTRICTION_NO_TAKE_KEYWORDS = (
    "sanctuary",
    "marine national park",
    "no-take",
    "no take",
    "scientific reference",
)
RESTRICTION_PARTIAL_KEYWORDS = (
    "habitat protection",
    "habitat zone",
    "conservation",
    "buffer",
    "recreational use",  # often no-anchor, no-trawl
    "special purpose",
    "preservation",
)
# Anything else (general use, multiple use, IPA Sea Country
# without specific zoning) defaults to "general".


# ── Fetcher ───────────────────────────────────────────────────────────────


def fetch_capad_marine() -> dict[str, Any]:
    """Page through the CAPAD FeatureServer and stitch into one
    GeoJSON FeatureCollection. Returns the in-memory FeatureCollection.

    Defensive against transient 502/504s — retries each page up to
    3 times with a small backoff."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    base_params: dict[str, str | int] = {
        "where": "ENVIRON='MPA'",
        "outFields": ",".join(KEEP_FIELDS),
        "outSR": 4326,
        "f": "geojson",
        "returnGeometry": "true",
        "geometryPrecision": 4,  # ~11m precision — plenty for a 2km-zoom-out overlay
    }

    all_features: list[dict[str, Any]] = []
    offset = 0
    for page in range(MAX_PAGES):
        params = {
            **base_params,
            "resultRecordCount": PAGE_SIZE,
            "resultOffset": offset,
        }
        log.info("Fetching page %d (offset=%d)", page, offset)

        last_err: Exception | None = None
        for attempt in range(3):
            try:
                r = session.get(FEATURE_SERVER, params=params, timeout=60)
                r.raise_for_status()
                payload = r.json()
                last_err = None
                break
            except (requests.RequestException, ValueError) as e:
                last_err = e
                log.warning("page %d attempt %d failed: %s", page, attempt, e)
                time.sleep(2 ** attempt)
        if last_err is not None:
            raise last_err

        feats = payload.get("features", [])
        log.info("  got %d features", len(feats))
        all_features.extend(feats)

        if "exceededTransferLimit" in payload and payload["exceededTransferLimit"]:
            offset += PAGE_SIZE
            continue
        if len(feats) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    else:
        log.warning("Hit MAX_PAGES safety net at offset=%d — CAPAD may have grown", offset)

    return {
        "type": "FeatureCollection",
        "features": all_features,
    }


# ── Normaliser ────────────────────────────────────────────────────────────


def classify_restriction(props: dict[str, Any]) -> str:
    """Collapse CAPAD's verbose TYPE / IUCN / ZONE_TYPE attributes
    into one of three frontend buckets. Never returns None."""
    iucn = (props.get("IUCN") or "").strip()
    if iucn in {"Ia", "Ib", "II"}:
        return "no_take"
    if iucn in {"III", "IV"}:
        return "partial"

    haystack = " ".join(
        str(props.get(k) or "").lower()
        for k in ("TYPE", "ZONE_TYPE", "NAME")
    )
    if any(kw in haystack for kw in RESTRICTION_NO_TAKE_KEYWORDS):
        return "no_take"
    if any(kw in haystack for kw in RESTRICTION_PARTIAL_KEYWORDS):
        return "partial"
    return "general"


def normalise_features(fc: dict[str, Any]) -> dict[str, Any]:
    """Strip CAPAD-internal fields, add our `restriction` bucket,
    and keep only the props the frontend will actually render."""
    out: list[dict[str, Any]] = []
    counts = {"no_take": 0, "partial": 0, "general": 0}
    for feat in fc["features"]:
        props = feat.get("properties") or {}
        restriction = classify_restriction(props)
        counts[restriction] += 1
        slim_props = {
            "name": props.get("NAME") or "Unknown reserve",
            "type": props.get("TYPE") or "",
            "iucn": props.get("IUCN") or "",
            "zone": props.get("ZONE_TYPE") or "",
            "authority": props.get("AUTHORITY") or "",
            "state": props.get("STATE") or "",
            "area_km2": round(float(props.get("GIS_AREA") or 0), 1),
            "restriction": restriction,
        }
        out.append({
            "type": "Feature",
            "geometry": feat.get("geometry"),
            "properties": slim_props,
        })

    log.info(
        "Classified %d features → no_take=%d partial=%d general=%d",
        len(out), counts["no_take"], counts["partial"], counts["general"],
    )
    return {"type": "FeatureCollection", "features": out}


# ── Uploader ──────────────────────────────────────────────────────────────


def upload_to_github_release(feature_count: int) -> None:
    """Attach mpa.geojson + manifest.json to the rolling
    `mpa-aus-latest` GitHub release."""
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
             "--title", "Australian Marine Protected Areas (rolling latest)",
             "--notes",
             "CAPAD marine reserves as GeoJSON. Refreshed weekly.\n\n"
             "Source: DCCEEW Collaborative Australian Protected Areas\n"
             "Database, ENVIRON='MPA'. Licensed CC BY 4.0."],
            env=env, check=True,
        )

    manifest = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "feature_count": feature_count,
        "data_file": "mpa.geojson",
        "attribution": "© Commonwealth of Australia (DCCEEW)",
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))

    cmd = ["gh", "release", "upload", RELEASE_TAG,
           "--repo", repo, "--clobber",
           str(GEOJSON_PATH), str(MANIFEST_PATH)]
    log.info("$ %s", " ".join(cmd))
    subprocess.run(cmd, env=env, check=True)
    log.info("✓ Uploaded mpa.geojson + manifest.json to %s release", RELEASE_TAG)


# ── Helpers ───────────────────────────────────────────────────────────────


def require_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        log.error("Missing required env var %s", name)
        sys.exit(2)
    return val


def main() -> int:
    try:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        log.info("Fetching CAPAD marine features…")
        raw_fc = fetch_capad_marine()
        log.info("Fetched %d raw features", len(raw_fc["features"]))

        norm_fc = normalise_features(raw_fc)
        # `separators` strips spaces — GeoJSON polygons are dominated
        # by coordinate arrays so the difference is ~10–15% smaller.
        GEOJSON_PATH.write_text(json.dumps(norm_fc, separators=(",", ":")))
        log.info("Wrote %s (%d bytes)", GEOJSON_PATH, GEOJSON_PATH.stat().st_size)

        log.info("Uploading to GitHub release…")
        upload_to_github_release(len(norm_fc["features"]))
    except Exception:  # noqa: BLE001
        log.exception("Pipeline failed")
        return 1

    log.info("✓ Pipeline complete — %d features published", len(norm_fc["features"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
