# One older-advertised GIBS diagnostic — prepared, not dispatched

This packet follows the immutable first failed/partial source observation at
`5f9da29ac` and the reviewed client no-detail guard/actual Obs integration at
`b29359a595f29831f091e7a11451cf0a50aa0c6b`. No further provider read was made while
preparing it. The first four-of-six visible-PNG result remains unchanged; usable
varying detail was demonstrated only for Meteosat, VIIRS and upper water vapour.
Uniform East imagery is not promoted to usable cloud detail.

## Exact hypothesis and bounds

The original metadata advertised recent Himawari and GOES East/West instants
whose WMS images were transparent or uniformly black. Retained headers, XML and
PNGs cannot distinguish delayed raster publication, projection-product coverage
or a source-window problem. This diagnostic can test whether slightly older,
**still currently advertised** instants contain usable detail in the same fixed
small windows. It does not assume a cause or widen any clock.

The helper's explicit `older-gibs` mode selects only these fixed products:

| Product           | Unchanged window (west, south, east, north) |
| ----------------- | ------------------------------------------- |
| Himawari Band 13  | 140, −35, 160, −15                          |
| GOES West Band 13 | −160, 10, −140, 30                          |
| GOES East Band 13 | −85, 10, −65, 30                            |

For each, the actual existing metadata parser still returns at most six recent
listed frames. The helper excludes the newest two, then chooses at most the two
oldest remaining members. With fewer than three listed frames it holds that
product; it never invents an older request. The original six-hour metadata window,
three-hour geostationary latest-frame freshness check, two-minute read lifetime
and exact post-image membership checks remain unchanged. Actual gaps remain gaps.

There are at most three products, six 256² PNG reads and 15 requests total. The
existing 512 KiB metadata, 2 MiB image, 32 MiB aggregate body admission/directory,
25-second per-read and 600-second original overall deadline stay in force. The
same fixed URL/target builder and no-redirect, no-credential transport are used.
No retry or full-disk acquisition, provider key, flag activation, publication,
deployment, schedule, Pi/R2/database change is included.

## Meaning of the result

Original bytes/headers/listed clocks, strict bounded PNG/critical-CRC diagnostics
and all 17 Git-byte inputs are retained. The decoder converts the bounded
grayscale/RGB/palette/RGBA samples into one 256² RGBA plane, then calls the **actual
client** `satelliteViewportAlphaFraction` guard. Zero alpha or one visible RGB
value is held as unavailable detail. Hidden RGB changes and varying alpha alone
do not qualify. Partial visible coverage stays an explicit fraction, not clear sky.

`completeSixProductObservation` is null in this three-product mode. The first
proof's visible-PNG criterion remains separate from the new
`completeSelectedProductsWithUsableDetail` criterion. The diagnostic process exits
zero only when each of the three selected products has at least one currently
listed, post-read-confirmed PNG that passes the actual client detail guard.
Missing/unsupported/no-detail products retain their errors and produce exit one.
Differing bytes and a listed/requested time do not prove independent acquisition
clocks, nearest-value identity or scan timing; those remain unknown.

The exact CLI is `node --import tsx scripts/prove-sharper-satellite-source.mjs
--read-reviewed-older-gibs NEW_OUTPUT_DIR`, with `SOURCE_SHA` equal to the exact
reviewed checkout. Default/malformed CLI paths still refuse before reads/writes.
The manual `.github/workflows/sharper-satellite-older-gibs-proof.yml` remains
contents-read-only, default false, without secrets/schedules/write permissions.
Root will review and prepare a source-pinned, trusted, single-attempt isolated
control if this workflow is not registered on the default branch. Preparing this
packet is not permission to dispatch it repeatedly or enable a product afterward.
