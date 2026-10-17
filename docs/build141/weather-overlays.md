# 141-03 / 04 / 05 source work

## Frozen foundations

The shared `scalarGridImage` helper is independent of React, Mapbox, canvas and
network access. It paints Mercator pixel centres, clips/rejects the polar
singularity before projection, keeps missing contributors transparent and handles
a periodic dateline without a duplicated endpoint. It returns owned RGBA pixels
and image coordinates. Limits are 1.1 million source cells and 1024² output pixels;
the caller must retain and recheck its own source lease through encoding and map
publication. The frozen first packet `81b1b789f` passed 36 focused cases and scoped
lint. Its first test-table fixture error is retained outside Git.

The independent THAS v1 atmospheric codec admits exactly two source identities:

- `gfs-atmos`: five original fields (surface gust/visibility/MSL pressure and
  2 m temperature/dewpoint), 29 six-hour frames to +168 h.
- `ifs-pressure`: original IFS `msl`, 41 six-hour frames to +240 h, 00/12 UTC only.

Both are explicitly sampled from a 0.25° source to a 1° display grid, 360 × 181
cell centres with per-field masks. Units remain m/s, m, Pa and K in the codec.
Decoded bytes, model, field order, run/valid clocks, units/ranges and coverage are
bounded and checked. Returned planes own their memory. Complete manifests require
canonical generation hashes and exact source attribution, not a payload-selected
provider. No THCU science or existing seven-source contract was widened.

The additional codecs share the original release proxy's bounded transport,
fixed repository/redirect hosts, dual slots, checksums and cancellation. They have
separate validation and generation adapters and cannot use the legacy bridge.
The original seven retain their full previous checks. `api/atmos` accepts only an
explicit, unambiguous GFS or ECMWF selection; unsupported models do not alias one
of those sources. The generic ISO-week tag helper preserves every existing tag.

The combined first contract/proxy run passed 68 tests across four suites,
including the unchanged release-proxy and marine-publisher regressions; scoped
lint passed. The renderer suite independently passed 36 cases. These are offline
synthetic source/transport checks, not live provider or deployment evidence.

## Source evidence and remaining work

[NOAA's current field inventory](https://www.nco.ncep.noaa.gov/pmb/products/gfs/gfs.t00z.pgrb2.0p25.f000.shtml)
identifies the original parameters and levels. Its
[April 2026 retirement proposal](https://www.weather.gov/media/notification/pdf_2026/pns26-30_CommentsGFSv17_ProductRemoval.pdf)
includes the coarse GFS files/filters, so the new producer uses selected byte
ranges from the retained 0.25° source and does not depend on the 1° endpoint.
[ECMWF's current open-data catalogue](https://www.ecmwf.int/en/forecasts/datasets/open-data)
specifies the open-data licence and cycle horizons. This display must never label
that public source as the paid 9 km forecast or treat IFS 06/18 UTC as ten days.

The separate publisher repository has no existing GFS publisher at its reviewed
`753d34b` base. A new source-only producer and manual workflow are being prepared;
provider downloads and publication independently default false. Actual provider
range/CLI readbacks and a complete generation must pass before activation.

Gust/visibility UI, low-skill point T−Td disclosure, lazy pressure frame loading
and selected-model integration remain in progress. Sharper satellite source,
exact advertised observation clocks, product licences and memory limits are still
being reviewed. No new layer, timer, paid credential, live forecast, release,
provider download or publisher schedule has been activated by this packet.

## Isolated native source proof

Actual Linux run `38995552532` checked literal producer source
`9a1774e2c8eb2750e085015542c8fb5b26b0e53d` using control
`13803e96723429eba7407db8c11cc0ff5d3abfe0`. The original/composed publisher
process passed 98 checks under the CMEMS hash lock; a separate process passed
three unchanged native ecCodes fixtures under the eight-package atmospheric
hash lock. Both interpreters genuinely exited zero after their assertions. Both
artifact digests/sizes, all eleven Git input hashes, Python 3.11.15, installed
versions, zero skips and the separate post-process shell exit sentinels were
independently verified. Native maps resolve the expected wheel-owned ecCodes and
eckit libraries, with no xarray/NetCDF/HDF5/GDAL import in that process.

The earlier mixed-library process passed its assertions but aborted at exit 134;
that failure remains preserved and is not counted as a pass. Its exact cause has
not been conclusively assigned. Production atmospheric and CMEMS pipelines use
separate dependency closures, which the successful proof reproduces. No test was
skipped, no assertion changed and no forced process exit was introduced. The
immutable source receipt is `outputs/Build14103 atmosphere native process proof.json`
(SHA-256 `bbc5ebbcd8eb436a8cf3ab07dffcabe3fbae11a4c2ee3a015abd6a4230df6d2a`).
This proves offline synthetic GRIB handling, not actual provider ranges or a
complete published generation.

The atmospheric session lazily reads only the selected six-hour bracket. It
keeps at most two raw decoded frames, masks missing temporal contributors and
refuses out-of-coverage times instead of clamping. Every new selection retires
the prior view, including a refused selection. Adoption proofs check the original
owner, cancellation, metered-link setting and both wall/monotonic lifetime;
cleanup of a successful read does not cancel its returned proof. Closing or
retiring the session clears its cache. T−Td remains an indicative point spread,
never a fog probability or observed visibility.

## Actual atmospheric source/UI integration checkpoint

The literal `VITE_ATMOSPHERE_ENABLED === 'true'` gate controls the lazy Obs
component and the two new Sky entries. No public-beta profile or deployment
configuration was changed. When the gate is absent/false, the old pressure
source and controls retain their existing path. When explicitly enabled, public
pressure uses only the selected GFS or public IFS cohort; a private imported GRIB
retains its own existing pressure owner. Returning online retires that old
presentation and eager cache before the lazy public owner proceeds. Other
selected models show a held explanation without aliasing to GFS/IFS.

Gust and model visibility share one GFS reader. Selected IFS pressure can use a
second reader; each keeps at most two raw frames and a single selected blended
view. Pressure conversion uses native Pa→hPa, masked corners and bounded
selected-frame contours/H/L symbols, never invented wind barbs or future tracks.
GeoJSON is capped at 6,000 line features / 120,000 vertices and the polar image
singularity remains clipped. There is no forecast-wide image/geometry cache.

Controls live inside the existing internally scrolling chart panel. Run/source,
requested valid UTC, exact source coverage, low-skill visibility wording and
point T−Td are disclosed. Independent hourly scrubbing loads the chosen bracket;
play waits for the actual image/vector content and stops at the real endpoint.
When wind is active, its actual valid UTC is the only time authority; missing or
out-of-coverage clocks hold the field. Full credits and lifecycle warnings join
the existing one-row Credits rollup. Unknown hiding/removal retains an attributed
warning, including after user-off or React unmount. A real regression found a
map-remove callback ordering issue in the new vector owner; the repaired test
requires proven scene removal to remain `off` after every retirement callback.

The current checkpoint passed 82 focused cases across nine suites, including
actual picker/control/credit, source-lifetime, selected-model/horizon, private
pressure transition and existing community/facility composition regressions.
Network/Mapbox boundaries are mocked in these unit cases. The failed first vector
ownership receipt remains outside Git. Phone browser layout, full compiler,
configured bundle and real provider/cohort publication are still pending; no
readiness or live-source availability is inferred from these focused checks.

## Phone fixture before generic vector extraction

The actual Mapbox 3.19 local-fixture check passed Chrome and WebKit at 300/375 px
and 130% text (four cases). The app kept the same 780 px document/canvas extent,
44 px credit opener and internally scrolling chart panel. Tests exercised actual
source installation, both selected-model endpoints, refused out-of-coverage UTC,
unsupported model, credits, and delayed old response after user-off. Provider
manifests/bytes and glyph bitmaps were synthetic loopback fixtures; there were no
provider requests, publication checks or device-memory measurements. Screenshots
were visually inspected at 300 px Chrome and 375 px WebKit.

The first native run exposed distinct image and GeoJSON readiness assumptions.
Image content can precede metadata/loading completion; a first successful GeoJSON
worker parse emits metadata and subsequent parses emit content. Exact source,
layer and original-lifetime checks remain mandatory. The preserved failed runs
also include two fixture interaction corrections (opening the collapsed layer
key and reopening it after all layers were off), and a synthetic glyph bitmap
border correction. The pre-extraction four-case receipt is retained at
`work/atmos141-browser-pre-extraction-pass.json`; shared vector extraction will
require another actual four-case run, including source-cleanup map errors.

## Shared bounded GeoJSON owner

`components/map/useOwnedGeoJsonOverlay.ts` exports
`useOwnedGeoJsonOverlay(mapRef, mapReady, options)`. Options bind a fixed namespace,
label/credit, enabled state, original owner object/revision/current-source proof,
stable `createData(map)` factory, fixed `{suffix, specification}` line/symbol
layers and caller feature/vertex caps. Optional `refreshOnMoveEnd` coalesces a
viewport burst for 100 ms, replaces one frame and requires a new actual worker
completion. The hook neither fetches nor retains a geometry history. It installs
`${namespace}-source` and `${namespace}-${suffix}`; callers must reserve distinct
image/vector namespaces.

The owned snapshot accepts only bounded Point/LineString/MultiLineString
coordinates and plain bounded properties, rejects latitude beyond Mercator
±85.05112878 and caps aggregate serialization at 4 MiB. It checks original source
currentness before and after construction and before every presentation/adoption.
Readiness requires an owned successful GeoJSON worker metadata/content event,
current original proof, matching dependent layers and a loaded source. No such
event within ten seconds retires the presentation. Restyle/removal/foreign source
and layer behavior retains the existing conservative ownership rules.

Pressure is a thin adapter using `atmos-pressure-symbols`; its standalone image
retains `atmos-pressure`. The first extraction browser run caught a collision
between those two sources and is preserved. A regression now installs the image
owner first and proves that vector mounting/retirement never mutates it. Shared
retirement removes or verifies hidden every dependent layer before attempting
the source; it never attempts source removal while another owned layer uses it.
Uncertain removal still retains the attributed persistent warning after unmount.

Final extraction proof passed 81 cases across five focused suites, scoped lint,
format/diff checks, then all four actual Chrome/WebKit phone cases at 300/375 px
and 130% text. Those cases now also require zero native Mapbox errors throughout
model, UTC, user-off and late-response transitions. Both selected screenshots
were inspected again. The generic arrow shape in unit tests is synthetic;
actual SSH source/arrows are integrated separately by the parent. Full compiler,
configured bundle, native device memory and real atmosphere publication remain
separate requirements.
