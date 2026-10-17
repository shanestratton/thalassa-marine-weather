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
