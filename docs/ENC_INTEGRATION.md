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

### Phase 13 — Inshore A\* router (shipped 2026-05-09)

The ocean routers (isochrone, corridor, bathymetric) all bail on
short coastal/river/harbor passages — isochrone explicitly skips
under 100 NM, corridor needs open water for its 30 NM-wide A\*
graph, and GEBCO at 15 arc-sec smooths over channels narrower than
~460m. Result: typing "Savannah, GA → Port Wentworth" produced
nothing on the chart even with a Savannah ENC imported.

Phase 13 closes that gap with a Pi-side A\* router that operates
directly on the ENC vector data:

- [x] **Pi: `pi-cache/src/services/inshoreRouter.ts`** — pure-JS
      polygon rasterizer + 8-neighbor A\* + line-of-sight smoothing + Douglas-Peucker. Loads no extra deps. Synthetic-geometry
      tests at `inshoreRouter.test.mts` (9 cases, all passing).
- [x] **Pi: `POST /api/enc/route`** — accepts `{from, to, draftM}`,
      auto-selects installed cells whose bbox covers the route,
      merges layer FeatureCollections, returns
      `{polyline, distanceNM, cellsUsed, elapsedMs}`.
      422 with codes (`origin-on-land`, `no-path`, etc.) when
      grid built but no path exists.
- [x] **Device: `services/InshoreRouter.ts`** — wraps the Pi call,
      gates on Pi reachability + ENC coverage at both endpoints +
      ≤50 NM straight-line distance. Returns null silently when
      gates fail (caller falls through to ocean pipeline);
      surfaces 422 failures via `__inshoreRouting` for UI.
- [x] **Pipeline integration** — `useVoyageForm.ts` runs the
      inshore router as Step 0. On success, the
      bathymetric/isochrone/corridor steps are SKIPPED so they
      can't overwrite the channel-following polyline with a
      straight line through land.
- [x] **UI surface** — `VoyageResults.tsx` shows an
      "Inshore Routing" accordion when the inshore router was
      attempted. Green chip on success ("US5GA22M, 7.8 NM"),
      amber on failure with actionable copy
      ("Try a marina or anchorage near the dock").

Algorithm details:

- **Grid resolution**: 50 m default (configurable via
  `resolutionM`). Wide enough to keep build time under 1s for a
  typical harbor cell on Pi 5; tight enough for 200 m channels.
- **Cell encoding**: Float32, `NaN` = blocked, ≥0 = depth in
  meters (0 = open with unknown depth — outside DEPARE coverage).
- **Cost shaping**: All multipliers ≥ 1.0 (haversine heuristic
  stays admissible). 1.0 for ≥10 m DEPARE (preferred channel),
  1.05 for ≥5 m, 1.2 for shallow-but-open, 1.5 for unknown.
  Result: A\* prefers staying inside marked deep water even when
  a slightly shorter route exists outside it.
- **Endpoint snapping**: BFS up to 5 km from the geocoded
  origin/destination — handles the common "Savannah, GA"
  geocoding to a city center on dry land, where the actual
  departure dock is on the river ~1 km away.
- **Smoothing**: Line-of-sight string-pulling (Bresenham clear-line
  test) post-A\*. Without this, A\* on uniform-cost grids produces
  stair-stepped paths that can be 1.5× longer than the geometric
  optimum after sum-of-haversines on the polyline.

What's deferred to Phase 13.x:

- **Multi-cell stitching at boundaries** — currently we merge
  feature collections across cells, which works but doesn't
  de-dupe boundary polygons (rare visible artifact).
- **Tide-aware draft** — Phase 13.3. Currently uses static DRVAL1
  from chart datum; should subtract current tide height from the
  vessel draft for cells where a tide station is nearby.
- **ENC update awareness** — when a cell's edition/UPDN
  increments, persisted nav grids should be invalidated. Not yet
  cached anyway, so harmless for now.
- **Channel preference using DEPCNT** — current cost shaping uses
  DEPARE.DRVAL1 only. Could use DEPCNT (depth contour lines) to
  build a centerline-distance penalty, which would hug the marked
  channel even more strictly.

### Phase 14 — S-63 encrypted ENC import (deferred until license in hand)

NOAA cells are public-domain `.000` files — drop them on the Pi, GDAL
parses them, done. AHO (Australian Hydrographic Office) and most
non-US offices ship their cells **S-63 encrypted**: the `.000` file
is wrapped in IHO's standard chart-protection scheme, decryption keys
arrive as text-file permits tied to a hardware fingerprint.

This phase adds S-63 import to the existing pipeline so users with
licensed AusENC / UKHO / etc. cells can import them the same way
they import NOAA today.

**What the user has to provide:**

S-63 distributions ship as a directory tree containing:

- `.000` (and update `.001`/`.002`) — the encrypted ENC cell files
- `PERMIT.TXT` — per-cell decryption keys (CRC-checked, format
  documented in IHO S-63)
- `SERIAL.ENC` — distribution catalogue
- A separate `userPermit.txt` (or printed/emailed by the HO when
  the license was issued) — 28-character hex string tied to the
  user's hardware fingerprint

The first three live alongside the cells; the userPermit is a
one-time setup on the Pi.

**Implementation plan:**

- [ ] **Pi: GDAL S-63 driver** — most distros ship `gdal-bin`
      without S-63 (it's behind a build flag because IHO requires
      a license-distribution agreement). On Pi OS we either:
      a) Build GDAL from source with `-DGDAL_USE_S63=ON` —
      ~30 min compile but stable.
      b) Use a community APT repo with S-63-enabled GDAL —
      faster but trust-the-third-party.
      Recommend (a) — script it into `install.sh` behind a
      `--with-s63` flag so default installs stay fast and only
      users who want it pay the build time.
- [ ] **Pi: userPermit storage** — drop into
      `${INSTALL_DIR}/.s63/userPermit.txt` (mode 0600). New
      endpoint `POST /api/enc/s63/userpermit` `{userPermit: string}`
      validates the format (28 hex chars + 8-char manufacturer
      key) and writes it.
- [ ] **Pi: `POST /api/enc/install-s63`** — accepts a ZIP
      containing the cell files + `PERMIT.TXT` + `SERIAL.ENC`.
      Calls `ogr2ogr -oo USERPERMIT=$KEY -oo CELL_PERMIT=...` per
      cell. Same downstream pipeline as the public NOAA flow —
      writes decrypted GeoJSON to the chart store.
- [ ] **Device: import UI** — extend `EncCellManager.tsx` with a
      new "Install S-63 (encrypted)" button next to the existing
      "Install on Pi from URL" / "Upload from this device". First-
      run prompts for the userPermit; subsequent imports just
      need the cell ZIP.
- [ ] **Source attribution** — IHO requires displaying "Source:
      AHO" (or whichever HO) when a chart's data is shown. The
      EncCellManager and the route-results panel already track
      `sourceHO`; just need to ensure it's visible.

**Tested-on prerequisite:**

This phase is gated on having a real AusENC license to test against.
Without actual encrypted cells + permits, we can scope-out the API
shape but can't verify the GDAL S-63 driver actually decrypts
properly. Recommended order: user buys an AusENC subscription →
ships me one cell + the permits → I plumb it through end-to-end →
ship.

**Out of scope for this phase:**

- o-charts (oeSENC) format — closed proprietary, dongle-decryption
  inside OpenCPN only, no extraction path. Users who only have
  o-charts must keep using OpenCPN for AU vector chart routing
  until they license direct AusENCs.

### Phase 12+ — Small polish (deferred, captured 2026-05-09)

- [ ] **Surface DSID_UPDN alongside edition** — NOAA cells often
      ship at "edition 0" with N updates applied. The cell row
      currently shows "ed.0" with no signal that updates have
      happened. Show "ed.0u2" or "Update 2" so users know the
      chart isn't actually pristine-base.
      Touches: pi-cache enc.ts (capture UPDN), services/enc/types.ts
      (EncCell.updateNumber), components/vessel/EncCellManager.tsx
      (cell-row label).
- [ ] **Prefer DSID_ISDT over DSID_UADT for the displayed date** —
      ISDT is the chart's issue date (what cruisers mean by "the
      chart is from..."); UADT is the date the latest update was
      applied. Currently we show UADT as `issued`. Switch to ISDT
      when present, fall back to UADT.
      Touches: pi-cache enc.ts (capture ISDT into the persisted
      record), staleness logic in EncCellManager.tsx — staleness
      should be relative to the SOURCE chart age, not the patch
      delivery date.

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
