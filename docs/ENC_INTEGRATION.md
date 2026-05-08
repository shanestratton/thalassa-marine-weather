# ENC Integration Spec

Status: in flight. Owner: Claude + Shane. Started 2026-05-08.

## Goal

Use a user's installed **vector ENC charts** (S-57 `.000` cells from
hydrographic offices — AHO, NOAA, UKHO, etc.) as a routing-grade
hazard layer, replacing GEBCO bathymetry where ENC coverage exists.

**The promise to the user:** if you've imported ENCs for the area
you're routing in, our routing engine respects the vector hazards
in those charts (depth contours, coastlines, obstructions, wrecks,
underwater rocks). ENCs are surveyed, not interpolated — this is
the highest accuracy data we can get, short of running our own
sonar.

**Where ENCs come from:** user provides their own. We never touch,
host, or redistribute the raw cells (most hydrographic offices
license ENCs for personal use only — no redistribution rights).

## Why GEBCO alone isn't enough

GEBCO_2024 is a **15 arc-second** (≈460m) globally-interpolated
bathymetry. It's good for "is this open ocean or near land?"
checks. It's bad for:

- **Reefs and atolls** — coral structures often smaller than 460m
  pixels, frequently missing from GEBCO entirely. Pacific atolls
  have known position errors of 100–500m.
- **Channels and passes** — narrow gaps between islands often
  smoothed over in interpolation.
- **Charted obstructions** — wrecks, isolated rocks, navigation
  hazards aren't in bathymetry data at all.

ENCs have all of this as vector data, surveyed by hydrographic
offices, with **CATZOC** (Category Zone of Confidence) ratings
that tell us the survey quality.

## What an ENC contains (S-57 layers we care about)

| Layer    | Geometry      | What it tells us                                     |
| -------- | ------------- | ---------------------------------------------------- |
| `DEPARE` | Polygon       | Depth area — `DRVAL1`/`DRVAL2` give min/max depth    |
| `LNDARE` | Polygon       | Land area (always hazard)                            |
| `COALNE` | Line          | Coastline (proximity hazard)                         |
| `OBSTRN` | Point/Polygon | General obstructions, with `VALSOU` (depth)          |
| `WRECKS` | Point/Polygon | Wrecks, with `VALSOU` if known                       |
| `UWTROC` | Point         | Underwater rocks                                     |
| `M_QUAL` | Polygon       | CATZOC zone — survey confidence rating               |
| `DEPCNT` | Line          | Depth contours (display only, redundant with DEPARE) |

Phase 1 implementation: `LNDARE`, `DEPARE`, `OBSTRN`, `WRECKS`,
`UWTROC`, `M_QUAL`. Phase 2: `COALNE` proximity buffer.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  ON DEVICE (Capacitor iOS app)                              │
│                                                              │
│  ┌────────────────┐       ┌──────────────────┐              │
│  │ ChartLocker UI │  ──→  │ EncImportService │              │
│  │ (drop .000 or  │       │ • detect S-57    │              │
│  │  ENC_ROOT zip) │       │ • POST to Pi     │              │
│  └────────────────┘       │ • download GeoJSON│              │
│                            │ • cache & index  │              │
│                            └──────────────────┘              │
│                                    │                         │
│                                    ▼                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ EncCellStore (Capacitor Filesystem)                  │   │
│  │ • per-cell GeoJSON blobs (~5–50 MB each)             │   │
│  │ • lazy load by bbox intersection                     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                    │                         │
│                                    ▼                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ EncCellMetadata (IndexedDB)                          │   │
│  │ • cell ID → bbox, edition, source HO, CATZOC summary │   │
│  │ • used for "do I have coverage for this route?"      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                    │                         │
│                                    ▼                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ EncSpatialIndex (RBush, in-memory, per-cell)         │   │
│  │ • built on cell load                                 │   │
│  │ • point/segment hazard lookup → ms                   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                    │                         │
│                                    ▼                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ HazardQueryService (NEW — unified façade)            │   │
│  │ async queryHazards(points) →                         │   │
│  │   for each pt:                                       │   │
│  │     if ENC covers pt → ENC result                    │   │
│  │     else → GEBCO result                              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                    │                         │
│                                    ▼                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ landAvoidance.ts  (existing, refactored)             │   │
│  │ • validateRouteSegments uses HazardQueryService      │   │
│  │ • findDetourAroundIsland uses HazardQueryService     │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                                ▲
                                │ (POST .000 → GeoJSON response)
                                │
┌──────────────────────────────────────────────────────────────┐
│  PI-CACHE (user's Raspberry Pi)                              │
│                                                              │
│  POST /api/charts/enc/convert                                │
│  • receives raw S-57 cell (.000 or zip of cells)             │
│  • runs ogr2ogr -f GeoJSON for each layer of interest        │
│  • returns: { cellId, bbox, layers: { DEPARE, LNDARE, ... } }│
│  • cells stored locally on Pi for re-conversion              │
└──────────────────────────────────────────────────────────────┘
```

## Key design decisions

### 1. Conversion happens on the Pi, not the device

GDAL is a C++ library. There's no JS S-57 parser. Options
considered:

- ❌ **WASM GDAL** — exists (gdal-js), but 50+ MB binary, slow,
  no S-57 driver in the JS distribution.
- ❌ **Supabase edge fn** — GDAL deploy in serverless is painful,
  edge fn file size limits.
- ✅ **Pi-cache** — already runs Node/Python, has filesystem,
  `apt install gdal-bin` is one line. Falls in line with
  Bosun architecture (boat brain owns the heavy compute).

Tradeoff: only Pi users get ENC routing in v1. Without-Pi users
get current GEBCO behaviour. We can add a cleared-region cloud
service later (NOAA ENCs are public domain → safe to host).

### 2. GeoJSON, not a custom binary format

GeoJSON is verbose but:

- Trivial to consume in JS (no parser to write/maintain)
- Plays with every map library
- Compressed via gzip transport, then stored decompressed for
  fast spatial index build

If sizes balloon, we can switch to TopoJSON or Mapbox Vector
Tiles in Phase 3 without changing the validator interface.

### 3. RBush spatial index, not GeoPackage / SpatiaLite

RBush is ~150 KB, pure JS, well-maintained, builds an R-tree
in memory in milliseconds for typical cell sizes. SQLite
spatial extensions (GeoPackage, SpatiaLite) work but add
deployment friction in Capacitor.

### 4. Validator precedence: ENC > GEBCO > push fallback

```
queryHazard(lat, lon) {
  if (encCellCovers(lat, lon)) {
    const result = encSpatialIndex.query(lat, lon);
    return result;  // authoritative — skip GEBCO
  }
  return gebcoQuery(lat, lon);  // fallback
}
```

Critical: when ENC says "clear water," we **trust it and skip
GEBCO**. This is faster (no edge fn call) and more accurate
(GEBCO might falsely flag a charted-deep area).

### 5. CATZOC awareness (Phase 2)

ENCs ship with `M_QUAL` polygons rating each cell's survey
confidence (CATZOC A1 = best, U = unassessed). When routing
through CATZOC C/D/U cells we surface a warning to the user
("this area is unassessed/poorly surveyed — verify visually").

Not blocking for Phase 1 but UX-relevant.

### 6. License & redistribution

We never store, host, or redistribute raw ENCs. The user
imports cells they legally own → Pi converts → device caches
GeoJSON → device uses. The GeoJSON is derivative but stays
on-device (no upload to our servers).

Where this gets dicey: the converted GeoJSON is technically a
derivative work. We need to add a "ENC source attribution"
panel showing which hydrographic office's data is in use
(IHO standard practice — every chart display has this).

## Phase plan

### Phase 1 — Foundation (this weekend)

- [ ] Spec doc (this file) ✓
- [ ] Pi-cache `/api/charts/enc/convert` endpoint with GDAL
- [ ] `services/enc/types.ts` — shared types
- [ ] `services/enc/EncCellStore.ts` — Capacitor Filesystem GeoJSON storage
- [ ] `services/enc/EncCellMetadata.ts` — IndexedDB metadata
- [ ] `services/enc/EncSpatialIndex.ts` — RBush wrapper
- [ ] `services/enc/EncHazardService.ts` — public API
- [ ] `services/HazardQueryService.ts` — unified facade
- [ ] Refactor `landAvoidance.ts` to use HazardQueryService
- [ ] Smoke test: hardcode one cell, verify validator picks ENC > GEBCO

### Phase 2 — Real import (next few days)

- [ ] ChartLockerService detects S-57 (`.000` magic bytes / extension)
- [ ] Import UI: drop file → progress → success
- [ ] Convert progress polling
- [ ] Test against your Australian ENC
- [ ] Cell metadata UI: list of imported cells, coverage map
- [ ] Visual indicator on map: "ENC coverage here" vs "GEBCO only"

### Phase 3 — Polish

- [ ] CATZOC warning surfacing
- [ ] COALNE proximity buffer
- [ ] Source attribution panel (IHO requirement)
- [ ] ENC update workflow (HOs release new editions monthly)
- [ ] Multi-cell route handling (route spans multiple cells)

## Acceptance criteria for Phase 1

A test route between two points where:

1. Both points are inside an imported ENC cell.
2. The straight-line GC arc passes over a charted reef that GEBCO
   misses (reef smaller than 460m).
3. The validator must detect the reef via ENC and reroute around
   it — without making any GEBCO edge fn calls for those samples.

This proves:

- ENC data flows end-to-end (Pi → device → store → index → validator)
- Precedence works (ENC wins where covered)
- Hazard detection improves vs GEBCO-only

## Out of scope (for now)

- Real-time ENC updates / WMS streaming
- ENC display rendering on the map (we have raster `.mbtiles`
  for that — different problem)
- Tide-aware draft vs depth comparison (Phase 4+)
- Anchorage suggestion based on bottom type (S-57 has `SBDARE`)
- Routing through tidal channels with timing-aware depth

## Open questions

1. **Vector display vs raster display** — currently chart locker
   ships raster tiles to AvNav. Should ENC GeoJSON also drive a
   vector chart layer on Thalassa's map? Or keep AvNav as the
   chart display and only use the vector data for routing?
   Default answer: routing-only for v1, add display in Phase 3.

2. **Multi-HO conflicts** — if a user imports both AHO and NOAA
   cells covering overlapping areas (e.g. Torres Strait), which
   wins? Default answer: most-recent edition wins per area.

3. **ENC license terms storage** — do we ask the user to
   acknowledge they own the cells they're importing? Probably
   yes, one-time modal on first ENC import.
