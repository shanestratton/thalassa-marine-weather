# Local chart reader foundations

The local whole-file MBTiles reader now refuses an unknown size, a non-file,
an unsafe basename, or a file larger than 32 MiB before reading a URI or loading
SQLite. It reads bounded chunks, requires the stat and actual lengths to match,
and checks the SQLite header and page size. sql.js is a dynamic import reached
only after a local file passes these checks. Files already used by the legacy
reader remain in its existing cache; this change does not silently migrate them.

Concurrent opens are serialized. Exact encoded open-file bytes are capped at
48 MiB with least-recently-used eviction. Closing a chart or all charts fences
an outstanding or queued open. Individual encoded tiles are capped at 1 MiB;
cached tile bytes and created blob bytes each have an 8 MiB cap, with independent
entry limits. PNG/JPEG/WebP raster dimensions must be at most 1024 by 1024;
animated WebP and GIF tiles are refused. Blob creation copies only the selected
tile view, and a chart's URLs are revoked when it closes.

These are encoded-byte limits, not a measured process-memory limit. SQLite's
WASM heap, transient file copies, browser image caches and Mapbox GPU textures
are additional. Revocation does not prove that a browser has erased previously
decoded image bytes.

Validation on this source: 34 focused cases across the original MBTiles service
tests and the new admission tests pass; scoped lint passes. The original
same-origin and transparent-tile checks remain. Their fictional database mock
now supplies a correctly sized SQLite header and filesystem stat, rather than
three arbitrary bytes.

Still required for 142-01: a private owner-scoped retained library in
Directory.Data, the own/open-chart consent and import/list/remove UI, native
Open-in types and scoped copying, bounded KAP/BSB and GeoTIFF workers, complete
map ownership/offline checks, real browser CSP/raster rendering, whole-app types,
and final native/release checks. No import feature, Directory.Data migration,
native distribution or physical phone acceptance is claimed by this foundation.
