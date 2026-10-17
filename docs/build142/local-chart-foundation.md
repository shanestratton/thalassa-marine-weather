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

## Private retained library and display source

The new Charts & detail → Import a chart file action opens a capped sheet with
an explicit own/open declaration, import, closed-file listing, Display/Close and
Remove. It copies admitted files to `Directory.Data/chart-library/<owner hash>/`
under generated UUID names. The small schema-checked index binds original
filename, kind, exact bytes and SHA-256. Listing stats files without opening
SQLite or raster workers. No automatic copy from the old Cache library occurs.
Rights declarations and filenames are user attestations, not verified licences
or content. This is display only: imported pixels never enter routing, depth,
clearance, tide, watch or alarm inputs.

The library limits the whole device to eight chart files and 64 MiB, with a
32 MiB per-file cap; owner indexes are independently capped at 16 KiB. Account
generations are captured before queued operations. A/B/A cannot revive a prior
copy, read or result. Pending writes use an owner-scoped temporary index; a
rename completing after retirement is rolled back before a later queued read.
Removal immediately retires existing read proofs, then removes the index entry
and immutable owner/UUID file. Failed unlink restores the entry for retry.
Other accounts' quota accounting reads only stat/list metadata, never content.
No chart is copied to cloud storage, providers or a server.

Browsers first store a fresh, bounded private Blob. A specific IndexedDB
Blob-preparation refusal can use the official Filesystem binary-string
representation instead, under an explicit `.base64` path/index marker. The
original decoded length/header/SHA remain required. Quota accounting charges
two bytes per base64 character; this overhead can reduce available browser chart
payload, without increasing the 64 MiB cap. Arbitrary/quota errors do not retry
as a different encoding. This addresses the actual WebKit failure and follows
the [Filesystem binary representation](https://capacitorjs.com/docs/apis/filesystem),
with the [WebKit Blob storage failure](https://bugs.webkit.org/show_bug.cgi?id=188438)
kept as evidence, not waived.

The existing native `GribDocument` plugin now has chart-only copy/picker methods,
still using serial 64 KiB security-scoped copies. New imported UTIs and Viewer
document types cover MBTiles, KAP and TIFF. `.bsb` is a catalogue: the user must
select the KAP image. Native chart copies enforce the same file/device quotas,
exclude the library from backup and refuse the app's own Documents/Cache as
Open-in sources, except iOS's incoming Inbox. GRIB/GPX limits and destinations
remain separate. A chart-only monotonic copy clock checks between reads; an OS
file-provider call itself cannot be interrupted by that check. Late native
completion is fenced and cleans only its captured owner's generated file.
**Swift/UTI changes are source only until a real Mac compile and device test.**

SQL initialization is reached only after retained file size/header/checksum
admission. Retained SQLite accepts ordinary `metadata` and `tiles` tables with
the expected columns, rejecting views, virtual tables, generated/hidden columns
and vector MBTiles. Read-only/trusted-schema pragmas precede metadata access.
The original legacy Cache reader remains available unchanged as a separate
path. Bounded SQL/module waits retire on owner loss or 15 seconds; native file
stream waits have a shared 30-second deadline. These limits do not measure or
cap SQLite's internal heap or synchronous query duration.

Only one caller-owned retained overlay is installed. Exact source-object and
layer-owner identity are required for update/removal. A failed or foreign
replacement cannot be declared off or revoke a potentially visible image URL;
it retains a clear warning. Account retirement hides already drawn private
pixels synchronously and waits for source/layer absence plus a clean map render
before restoring the container. Credits use the existing 44 px rollup, with no
additional page strip or screen extent.

## Explicit raster subset and limits

KAP v2/v3 supports original palette/RLE, bounded row indexes, optional PLY mask,
explicit WGS84 north-up Mercator and 3–64 non-collinear REF points agreeing to
half a source pixel. It refuses missing registration, datum shifts, skew and
unknown projections. Ellipsoidal WGS84 Mercator source rows are resampled into
the map's Web Mercator rectangle. Nothing infers a sounding datum from WGS84.
The [.kap versus .bsb distinction](https://gdal.org/en/stable/drivers/raster/bsb.html)
and the [primary BSB record/RLE description](https://libbsb.sourceforge.net/bsb_file_format.html)
define this deliberately narrow reader.

Classic GeoTIFF supports explicit EPSG:4326 or EPSG:3857, north-up scale plus
one tiepoint, PixelIsArea/PixelIsPoint, contiguous 8-bit unsigned gray/palette/
RGB/unassociated RGBA strips, and raw, PackBits or bounded zlib Deflate. Unknown
or conflicting CRS/datum/units, BigTIFF, rotation, tiled/multiple images, LZW,
JPEG and other encodings return concrete unsupported errors. It uses the
[OGC GeoTIFF 1.1 keys and raster conventions](https://docs.ogc.org/is/19-008r4/19-008r4.html)
without custom CRS transforms. It reuses the already installed `fflate` 0.8.3
[streaming Unzlib API](https://github.com/101arrowz/fflate/blob/master/README.md),
adding no dependency.

Both source dimensions and output are capped at 1024 × 1024 / 1,048,576 pixels.
Decoded strips and the aggregate RGBA destination are capped at 4 MiB. TIFF
metadata is capped at 128 KiB; KAP headers at 64 KiB/512 records. Strip lengths,
offsets, counts, run lengths, compression expansion, exact decoded bytes and
Deflate Adler-32 must agree before the image is usable. Deflate is fed in 1 KiB
input chunks, never inflated as one untrusted whole file. A dedicated lazy
worker is terminated on error, abort, ownership loss or a shared 15-second
decode deadline. Image preparation/PNG encoding shares a 15-second budget and
caps the encoded PNG at 5 MiB. Original no-data/alpha/cutline masks remain
transparent. Larger source images must be exported as a bounded MBTiles pyramid;
the reader does not pretend an output-size cap bounds a huge source decode.

These remain encoded/decoded admission limits, not measured peak process/GPU
memory. Worker input transfer, transient copies, SQLite, canvas, browser image
caches and Mapbox textures add working memory. No native memory-pressure or
physical-phone claim is made.

## Evidence and remaining gates

The original 57 foundation/manifest cases remain. The combined focused packet
currently passes 187 cases in 13 suites, including actual late copy/index/remove
ownership races, read timeout, SQL schema refusal, worker termination, live React
controls, URI queues, original raster pixel equality and decompression bombs.
The own fictional binary fixtures are reproducibly generated in
`tests/fixtures/local-charts142/generate.py`. GeoTIFF bytes and original RGBA use
Pillow/libtiff readback; expected map rows are independently calculated. KAP
bytes use this repository's own documented encoder, **not an independent GDAL
decoder oracle**. They contain no published nautical content.

The actual Chrome/WebKit phone matrix passed eight cases: 300/375 px at 130%,
under the unmodified native-meta and web-header CSPs, with actual storage,
SQLite/worker pixels, transparent holes, original unsupported CRS refusal,
already-drawn A→B retirement, A/B/A listing and closed reload without SQLite.
The 44 px credit row and capped sheets leave the document extent unchanged.
Exact frozen-source replay and the whole-app compiler receipt are collected
before handoff. Earlier browser diagnostic failures are
preserved: stale save text masked status; a harness fake-token auth request
cleared its GL canvas before WAN was blocked; one hand-transcribed KAP colour
was corrected to the immutable fixture's expected RGBA; WebKit's actual Blob
storage rejection required the charged binary-string fallback. Pixel/readiness
assertions were retained. Final native compilation, physical import/Open-in,
configured production budget and release distribution remain required gates.
No signing, upload, master update or hardware activation occurs in this packet.

The first whole-app compiler on `5ef4d5dd8` failed with 16 genuine diagnostics:
13 repeated fixture window-boundary casts, one unknown Mapbox metadata property
and two native reply-name union checks. The source repair adds runtime name
admission/cleanup and an explicit metadata property guard; no assertions are
removed. A retained raster tile also refuses disguised gzip/vector bytes while
the legacy vector reader keeps its prior behavior. The repair's first unit run
exposed a leaked URL test mock; its eight failures and the corrected 187-case
run are retained separately. The repair compiler remains a separate receipt.
