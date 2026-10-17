# Leaflet retirement (140-09 brought forward into 135)

The remaining provider-wind bridge and Sightings map now use the existing Mapbox renderer. No Leaflet runtime, plugin, package declaration, global type or CSS remains. No native project changes or backend deployment are included.

## Wind behavior

`MapboxWindField` attaches one Canvas2D surface to the existing chart. It consumes only the selected model's `windGridFrameToVelocityData` records. The existing north-to-south row conversion and fractional-hour interpolation remain the coordinate contract. Longitude sampling wraps at 180°; missing vectors remain unknown rather than becoming calm.

The field preserves the windRamp buckets, Light source-over versus dark additive blending, 1/1.5 CSS px strokes, carried trail fade, 30 fps cadence, 60-frame life, zoom speed/density curves and rotated-diagonal population cap. Its backing raster is Retina-aware, capped at 2x and 16 million pixels. Projection work is bounded to a 16 CSS px lattice when data/camera settles (coarsened for very large displays), rather than projecting every particle every frame. It owns one cancellable RAF and releases its observer, listeners, ink and particle arrays on teardown. Hidden/zero-size views pause; the renderer makes no network requests.

The old renderer used a five-degree projection secant, which bent the direction of equal east/north winds at high latitudes. The native field uses a local derivative. Independent 45° NE tests at 80°N and chart rotation verify the physical direction without repeating the renderer's derivative calculation.

The close-in field, instrument source/age/viewport gates, boat icon handoff, model fallback and imported-GRIB WebGL/bitmap path retain their existing behavior. Clearing/replacing a grid removes the previous model's ink immediately. Existing boat/page-return, current-frame, cloud/LAN age and account regressions remain in the focused suite.

## Sightings and offline areas

Sightings uses `createLogMap` and local DOM markers with the existing mine/crew colours, selection card and detail action. The smallest circular longitude interval frames dateline groups. Markers and exact private coordinates are not uploaded as a data source. Offscreen maps are removed. Offline, missing-token and failed-style views retain local markers on an honest plain-sea fallback; known offline mode adds no remote style/tile sources. Shared native credits remain accessible.

`OfflineTileControl` had no production importer. Its unused Leaflet bulk-tile wrapper was removed after confirming the reachable MapHub **Download offline relief** action opens `OfflineAreaModal`. That existing workflow still estimates, explicitly downloads, cancels and deletes only owned terrain; Mapbox imagery, public OSM tiles and licensed charts are not added to its bulk-download capability.

## Verification and release limits

- Focused wind/boat/source/offline regressions: 287 tests across 17 suites pass; the added rotated-4K bound regression passes in the 53-test native field/camera/blend subset.
- Sightings/shared-map/attribution regressions: 65 focused tests pass.
- Actual Chrome and WebKit Light/Relief+Sat on/off pixel pairs pass the existing contrast and red-edge thresholds; thresholds are unchanged.
- Camera projection checks retain the two-pixel browser limit through bearings, pan/turn and portrait/landscape; unit checks cover nine frame points at high/mid latitude and the dateline during pan/pinch/turn.
- Actual Sightings browser checks cover 300/375 px, markers, selection, credits, remount, failed style and zero offline WAN.
- Scoped ESLint and the isolated full-app TypeScript compiler pass. Final source and exact run receipts are reported with the checkpoint.

Plugin-private startup/mocks and obsolete Leaflet tile-template tests are replaced by native RAF/data/geometry/lifecycle tests and the shared map's real fallback/attribution/browser checks. Leaflet, leaflet-velocity-ts, leaflet.offline and @types/leaflet are removed from package.json and the lockfile. The only Vite change removes the retired Leaflet manual-chunk branch.

Exact configured JS savings and the final whole-app budget are measured by the integrating release build. Software-browser rendering is verified; sustained battery/thermal behavior on older physical phones remains a TestFlight device check.
