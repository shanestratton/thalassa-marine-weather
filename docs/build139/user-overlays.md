# 139-07 — Private overlay files and foreground area entry

## Obs entry point

`Charts & detail` offers `Your overlays · import / manage` only on the foreground
Obs surface. The manager opens above the chart sheet, and closing it returns
focus to its existing button. Its account fence remains active. The lazy map
layer follows the same foreground Obs lifetime; leaving Obs closes the manager
and removes its map data. The entry banner uses a bounded internal scroller.
No new page section or document height is added.

The composed opener passed four real Chrome/WebKit cases at 300/375 px with
130% text, retaining 44 px targets, nested-sheet focus return, exact closed-page
extent and zero unexpected requests/page errors. Eleven focused controls/layer
cases passed. Task logs: `work/validation139-overlay-mount-{browser-final,focused}.log`.
Initial WebKit failures are retained: the synthetic Charts trigger omitted the
production selector's explicit focus before opening; the fixture now matches it.
These checks exercise actual sheets and map components, not a mounted full MapHub.
Final release composition, TypeScript, bundle and native-device checks remain separate.

User overlays are separate reference annotations. They never become ENC cells, route constraints, speed-limit authority, safety scores or a cloud feed. No provider, Pi, backend or native installation is required by this source packet.

## Import and storage

The lazy `UserOverlaysSheet` has a normal Choose → Preview → Import and save flow. Parsing or discarding a preview does not save it. Only normalized geometry and short plain-text labels survive; HTML, URLs, arbitrary properties, original files and XML links are not rendered or uploaded. Known converted chart-pack shapes and source-marked ENC features are refused. A generic file cannot prove its rights or accuracy; the app does not grant either.

- GeoJSON follows [RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946): WGS84 longitude/latitude degrees. Legacy `crs`, invalid/nonfinite/coerced coordinates and null geometry refuse. Points, lines, polygons, their multi forms and bounded GeometryCollections are supported. Polygon holes, closed rings and noncrossing topology are validated. World-spanning geometry must be split first; adjacent dateline copies render continuously without rewriting saved coordinates.
- KML uses its fixed geographic coordinates, as specified by the [KML reference](https://developers.google.com/kml/documentation/kmlreference). A bounded DOM parse admits Placemark Point/LineString/Polygon/MultiGeometry. DTD/entities, NetworkLink, image/model overlays and tracks refuse. No referenced resource is fetched. Name text remains plain text.
- ZIP shapefiles use the [ESRI technical description](https://www.esri.com/content/dam/esrisites/sitecore-archive/Files/Pdfs/library/whitepapers/pdfs/shapefile.pdf). One matching `.shp/.dbf/.prj` set, optional `.shx/.cpg`, basic 2D Point/MultiPoint/Polyline/Polygon only. Null shapes and DBF-deleted records have no display geometry. WKT1 geographic WGS84 datum/spheroid, degree units and Greenwich prime meridian are required; projected WGS84/UTM, geocentric/compound/vertical CRS, transforms and ambiguous/missing definitions refuse. Re-export unsupported CRS and Z/M variants rather than guessing/reprojecting. DBF labels use explicit UTF-8 or Windows-1252. ZIP paths, encryption, multi-disk/ZIP64, duplicate/overlapping entries, bad CRC/length and oversized expansions refuse; streaming inflation is bounded before retaining chunks. No new dependency is added: this uses the existing `fflate`.

Inputs are at most 4 MiB (KML 1 MiB); ZIP expanded data at most 16 MiB/eight files. Each import and the combined account library are at most 2,000 features/50,000 vertices, each line/ring at most 5,000 vertices and a finite two-million comparison topology budget. Complex files must be simplified. One parsing worker, five-second worker deadline, explicit cancellation/account fence, transferred byte buffer, and no main-thread inflation fallback keep admissions bounded. The KML DOM pass is separately capped at 1 MiB.

Normalized files are immutable SHA-256 objects in `Directory.Data/user-overlays/v1/<account-hash>/`. A small validated index is written through a temporary file/rename; interruptions or corrupt index/data fail closed and are never interpreted as an armed/clear area. The phone filesystem is not claimed to provide a distributed transaction. At most ten overlays/eight MiB per account and four account folders are admitted. The next save reconciles only the current account's unreferenced, hash-named files under the writer lock; another account's bytes are untouched. Remove detaches the index first and deletes the owned object. SHA/UTF-8 byte/count mismatch refuses reading. Native byte sizes and the web filesystem's UTF-16 stat length are bounded separately; exact normalized bytes and geometry counts are always checked after reading. Late account changes cannot publish a read or delete a newly committed valid object as rollback. No position history, chart geometry or derived licensed names are stored here.

## Foreground notices

Visibility and polygon notices are independent explicit choices; notices start off. The selected position source is either original-clock boat gateway/paired-LAN instruments or an explicitly chosen phone GPS for user overlays. It never silently substitutes a phone, cloud row, held fix or direct Signal K snapshot for the boat. Current source/account/vessel identity is part of the episode boundary.

An entry requires a previously observed outside state followed by an inside state from a newer original measurement within fifteen seconds. Starting/resuming inside does not invent an entry. Gaps, invalid/future/repeated/stale positions, accuracy worse than 100 m, polar uncertainty and a boundary band of at least ten metres are unknown; they do not fire, clear or rearm. Holes and the dateline are handled explicitly. Missing areas never count as outside. Separate finite 2,000-identity RAM ledgers for user and chart areas become sticky unknown on capacity exhaustion, until a lifecycle reset; they never evict a latch to fabricate a reentry. Up to five entry lines are presented per update; absence is never an all-clear.

The dismissible banner retains the original position UTC time and source. One 0.4-second soft Web Audio cue follows a fresh episode when the user gesture unlocked audio. It will not start over an owned safety alarm and stops its own oscillator if a safety alarm or background state arrives. It never acquires/releases another alarm's lease, requests notification authority or claims hardware audibility. Native app state and document visibility both gate evaluation; return, source/account/vessel/Pi changes and chart revision changes retire episode state. Only a post-change original measurement is admitted after a binding change.

## Borrowed chart areas

The only production chart seam is a synchronous getter registered by `useEncVectorLayer` for the exact currently applied, visible, registry-current merged data. The overlay code never reads a chart file, triggers a merge/prefetch, contacts the Pi, copies a licensed area into `Directory.Data`, or retains its geometry between ticks. Existing renderer/package lease ownership is unchanged.

Chart notices additionally require current paired boat LAN and fresh paired-LAN boat position. Selected RESTRN codes are 7, 8, 13, 14, 27, using the existing IHO table (13 is no wake; 14 is area to be avoided). The latch key binds cell content revision, bounded LNAM where present and geometry fingerprint, so two unnamed distinct polygons are not collapsed by class/name. References/pending cells, closed/missing/stale displayed cohorts, access changes and scan caps are unavailable, never clear water. Display selection/culling means this is a foreground advisory over the charts open here, not a whole-library/route assessment or a complete regulatory dataset.

## Integration and proof

- Lazy sheet: `components/map/UserOverlaysSheet.tsx`, props `{onClose}`.
- Lazy map child: `components/map/UserOverlayLayer.tsx`, props `{map,mapReady,active,className?}`. The caller must pass Obs-foreground visibility, and may position the banner in its current controls layout. Three `private-overlay-*` layers and `private-user-overlays` source are removed on teardown and reattached after style replacement.
- UI owner will add the opener inside Charts & detail and the narrow map child mount in its separate MapHub checkpoint. This source packet does not edit MapHub or shared style work.

Focused tests cover actual synthetic deflated SHP/DBF/PRJ, KML/GeoJSON refusal/normalization, original-clock episodes, account/storage integrity and capacity, native pause, cancellation/deadline, borrowing and audio priority. Actual browser proof uses a fixed synthetic Mapbox token with session/telemetry responses intercepted locally; no real credential or provider request leaves the harness, and production SDK authorization is unchanged. It exercises the real worker, Capacitor web device storage, Mapbox framebuffer, explicit saved opt-in, outside→inside, style replacement and account retirement at 300/375 px in Chrome/WebKit. Final counts, compiler and inspected screenshots are recorded in the external source receipt. A native filesystem/device smoke check and composed production byte budget remain release gates; parser mocks are not evidence of a live chart/Pi or audible hardware cue.
