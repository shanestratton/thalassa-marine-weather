# Build 140: published Australia and New Zealand relief

This packet enables only already-published illustrative AU250 and LINZ coastal
terrain in the display/offline registry. It does not acquire, publish or replace
provider data, activate NOAA/EMODnet, change routing/depth/clearance/watch sources,
or establish navigational accuracy. Root release review/deployment remains separate.

## Exact published inputs

The publication receipts remain at `outputs/AU relief R2 publication.json` and
`outputs/NZ relief R2 publication.json` in the task workspace. A fresh fixed-target
read downloaded 16 public objects totalling 250,885 bytes: both final manifests,
both sparse availability files, and three DEM/index pairs per region. Every object
matched the prior independently recorded byte length and SHA256. Raw bytes and
response metadata are preserved in `work/relief140-public-replay/receipt.json`.
No bulk extraction, provider download, write, timer or deployment ran here.

| Region | Published pairs | Availability SHA256                                                | Final manifest SHA256                                              |
| ------ | --------------: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| AU250  |          50,308 | `dd66f32ef5981ac8297a3a90627820c3f2ddb1cd5394a8f9afab28309e903727` | `909e1b750158a50fc194ac6e6760c6d34cd8810a15ade45384b5a320b85aa0c2` |
| NZ     |           2,197 | `edf5227268b360cf5f195d4b477e0779faf42da9001ce9bd7fd254effdb2f08b` | `01a15a126e265b25e380d7050522f6145bb582ef26d474ec596ffe3bc8e45978` |

The exact availability bytes are bundled locally; no route or viewport metadata
fetch is needed. A malformed bundled row set is omitted, never treated as dense.
AU250 uses the published 92°E–172°E /60°S–8°S bounds. The NZ final manifest makes
no bounding-box claim: its enclosing tile footprint is derived from original
sparse rows and remains an envelope, not continuous source coverage.

## Display, datum and resource boundaries

The bottom-to-top order is global GEBCO → AU250 → existing GBR 30 m → LINZ patches.
Global/GBR retain their existing v1 URLs. New regions admit only their published v2
generation. AU250 is nominal 250 m composite relief at zoom 8–10, fading 10.5–11.5;
the existing finer GBR remains above it. NZ is 61 surveyed coastal patches at
zoom 8–14, fading 14.5–15.5. Zoom and source resolution do not imply survey accuracy.

AU250 is approximately MSL without vertical conversion. NZ retains native
NZVD2016 heights, explicitly **not MSL**; coarse GEBCO fallback is approximately
MSL. No station/vertical datum transformation or depth sampling is introduced.
Original source URLs, licences, derived-work wording and these limitations remain
in native map attribution and the existing 44 px Credits rollup/capped scroll sheet.
The rollup describes the source catalogue **where available**, not all sources
as currently painted. No extra strip or page extent is added.

New sparse cohorts mount only when the finite current viewport/source zoom
intersects exact availability runs. Both owned sources/layers retire on leaving
coverage or the fade range. Re-entry preserves visibility, palette and catalogue
order. Source object identities are weakly held; serialized layer markers prove
presentation ownership. Foreign replacements are neither adopted, refreshed nor
removed. A partial add failure is tracked for later cleanup; style replacement
does not multiply listeners. A foreign layer preventing retirement is left intact
with its native attribution until its actual owner/map removes it.

The existing per-source retained-tile limit remains 20 on native and at most 28 on
desktop. At overlapping low-zoom coverage there can be two extra two-source
cohorts; this is not a claim that aggregate GPU memory is unchanged. Their
viewport/fade retirement limits retention. No cache, image or saved-area ceiling
has been raised: 128 MiB saved bytes, 4,096 files, 256 KiB per 256×256 tile and the
existing availability bounds remain enforced. Country-sized requests refuse
before allocating their file list. Offline maximum detail derives 14 from the
registry, but all limits and Satellite Mode consent/blocking remain intact.

## Saved-terrain hard reload repair

The first native browser replay rendered both regions and the gap correctly,
then failed its offline reload. The first fixture lacked the actual service
worker; a second harness attempt installed middleware after Vite's HTML fallback
and correctly failed unsupported MIME. Those failures remain recoverable.

The subsequent real-worker diagnostic found a product issue: browser hard reload
also labels Mapbox tile requests `cache:'reload'`. The existing explicit-download
network-only bypass therefore skipped saved terrain. The captured active worker,
exact saved keys/cache modes and persisted 4 files/20,906 bytes are retained in
`work/relief140-sw-failed-diagnostic.json`; earlier traces remain in the numbered
`work/relief140-browser-*-failure` folders.

Current explicit downloads now use standard `cache:'no-store'`, preserving exact
canonical URLs, credentials omission, redirect refusal, CORS and image/byte
validation. Their rejected reads never accept SW fallback. Legacy/Mapbox reload
keeps its fresh-network path, and only after network rejection may consult the
exact URL in the existing saved-cache lane; it never consults ordinary browsing
cache. HTTP errors do not become saved success. Existing legacy online behavior
is preserved. **The downloader validates image format, dimensions and byte limits;
it does not possess or verify a client per-tile SHA inventory.** Publication
digests are evidence about the immutable published snapshot, not an invented
runtime verification capability.

## Validation and practical limits

Final focused validation passes 226 tests in 14 suites; scoped lint is zero and
format/diff checks pass. Focused tests cover actual pinned rows/hashes, strict versions/URLs, sparse gaps,
country refusal, original depth-provider separation, source ownership/style and
partial failure lifetimes, old relief/Log palettes, native/browser storage,
Satellite Mode and fresh/missing/saved/no-store service-worker behavior. Final
counts and exact immutable source/phone artifact inventory are recorded in
`outputs/Build 140 AU NZ relief source proof.json` after the source checkpoint.

Four single-attempt phone cases pass on installed Chrome and WebKit at 300/375×780
with 130% root text. Actual published PNG/WebP bytes feed real Mapbox, actual
credits/modal/planner/downloader/cache and the production SW handler. A surrounding
proof fault refuses every worker WAN fetch; local fixture shell modules remain
available. This proves saved regional tile rehydration and render after a hard
reload, not a completely offline cold app-shell install. The gap replay deliberately
has no global sample tiles, so it shows flat fallback with regional sources absent;
it does not claim a newly downloaded global survey or whole-country visual audit.
No physical iPhone, new full-app budget, App Store upload or TestFlight success is
implied by these fixtures. Root owns final combined compiler/bundle/release checks.
