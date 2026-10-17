# AROME Outre-Mer source checkpoint

This checkpoint replaces the proposed private point-HTTP ingress with an
**outbound immutable static-cohort design**. It includes a local original-GRIB
decoder/tile builder and the fixed Edge reader. **It is not live native source
admission.** Generated native fixtures, actual original provider acquisition,
resource proof and publication are separate gates. No forecast packet, live
server, R2 object, secret, Edge deployment or timer was changed here. Owned
Overpass 142-07 has its own source/proof and remains separately held for actual
global serving admission.

The three own model IDs are candidates only; they never go to Open-Meteo. The
comparison admits only an original current run on its documented full grid,
with the nearest qualified zero-land-fraction cell from the original constant
mask, within three original grid intervals in each axis. It does not look for a
farther cell whose weather happens to be populated. Unknown mask cells are not
sea. Individual missing values stay unknown and an all-missing wind run stays
unavailable. The 49 original UTC leads align exactly; gusts and precipitation
remain null until their original interval semantics are separately qualified.
The current main Glass best-local selection still needs integration after source
admission; this checkpoint does not claim that work is complete.

No public inbound HTTP into wx is required. The prepared namespace is fixed at
`https://tiles.thalassatiles.com/regional/arome/v1/<model>/`, disjoint from relief
and other weather products. The Edge ignores URL/token overrides. Its sole new
admission flag is `THALASSA_AROME_STATIC_ENABLED`, held unless exactly `true`.
Only a reviewed independently checked first publication may enable it. Missing
objects and unpublished coverage remain HTTP 503, never an empty successful run.

## Immutable storage and consumer

Two <=4 KiB discovery slots refer to content-addressed <=256 KiB manifests. They
can honestly represent different original runs; the reader selects the newest
still-current qualified run. Conflicting manifests for one run refuse. After
selection it never retries a failed manifest/tile or silently borrows another
cohort. Manifests bind full original dimensions, bounds, 0.025-degree steps,
all 49 original packet hashes/sizes, original mask hash, native proof hash and
complete deterministic tile inventory. URLs are constructed locally, not read
from JSON. Object/checksum, source age and final-clock checks are mandatory.

Each tile has a 32 by 32 core plus a three-cell halo, clipped to the original
full grid. It stores the exact native f64 mask and five 49-hour f64 fields in
little-endian order, with deterministic gzip. There is no f32 conversion,
quantisation, coarse grid, field interpolation, direction averaging or missing
zero substitution. Both compressed and decoded sizes are <=3 MiB. Header/model/
run/mask/native-proof/tile identity and exact cardinality bind the binary to the
manifest. Wind uses original earth-relative U/V, canonical meteorological
from-direction and exact unit conversion; genuine calm has unknown direction.

The fixed Edge performs at most four public GETs: two slots, one selected
manifest and one tile. They share the existing ten-second upstream deadline,
including headers, body, hashes and bounded inflation. There is no coordinate
POST into wx, auth credential forwarded upstream, redirect, provider fallback
or dependency change. Objects must have no HTTP `Content-Encoding`; gzip is a
bounded file format, not an automatically decoded HTTP body. The previous
64 KiB bound still applies to the final app point response. The new bounded
internal static-object reads are explicit rather than disguised as point data.

## Local native preparation and held operations

`native.py` admits Météo-France centre 85, original regular 0.025-degree full grids,
exact WMO field/level/units, original run and validity clocks, instantaneous
steps, supported scan directions and actual bitmap values **before** native
value-array expansion. U/V must be earth-relative. It normalises only row/column
order, retaining each original value. Mask provenance is the original constant
packet SHA; its original metadata is recorded without restamping to the forecast
run. Unknown mask/value samples remain NaN in local storage and null at the API.
Unknown/duplicate/incomplete/wrong-grid source fields refuse.

`prepare_static.py` takes bounded stable local catalogue/source-receipt files,
all 49 original local SP1 packets and the original constant packet. Every raw
packet's size/hash and fd identity are checked. It creates a fresh private output
directory, retains failures and never uploads or modifies a live current slot.
At most five full native grids are live, never a 49-hour full-grid ndarray. Local
hour fragments use fsync plus Linux DONTNEED advice after each write; this does
not assert that a loop-backed filesystem's outer dirty-page accounting is
solved. Actual wx filesystem/cgroup proof remains required. Only exclusively
created scratch files are unlinked; all original inputs remain intact.

The unchanged proposed acquisition caps remain 16 MiB/object,512 MiB/cohort,
2.5 GB/day,20s/read,1200s/cohort and 2 GiB native memory. A controlled process must
enforce the hard memory/elapsed limits; between-operation monotonic checks also
refuse at 1200s. The 49 forecast-read plan does not silently include unreviewed
catalogue/constant bootstrap requests. No acquisition controller has been armed.

New explicit storage proposals are <=1 GiB compressed/cohort, <=1200 MiB temporary
native fragments, and at most two public cohorts per domain (<=6 GiB for three
domains), plus retained input packets. Admission must inventory actual free
space and workloads and prove serial resource/rate accounting before deployment.
These are proposed storage envelopes, not silently granted resources. Publication
still needs a durable once marker, source/native proof, exact immutable upload
hash/metadata checks, final freshness and publish-last inactive-slot switch.
There is no publisher, retention timer or storage deletion action in this packet.

## Source facts

The official technical description dated 25 June 2024 specifies an hourly
0–48 h horizon, correcting the earlier 42 h description. Captured official
catalogue metadata on 17 October 2026 independently lists all 49 SP1 leads for
the 00Z cycle in each requested domain. No GRIB body was downloaded for that
inspection. The documented Antilles grid is called CARAIB; its current official
forecast object key is **ANTIL**. They are tied explicitly rather than guessed.
The current Polynesia catalogue describes two daily publications; the planner
admits its 00/12 cycles, while NC and Antilles admit 00/06/12/18. There is no
automatic latest-run selection or alternate-host fallback in this planner.

| Domain         | South/north/west/east         | Grid              | 00Z SP1 catalogue bytes |
| -------------- | ----------------------------- | ----------------- | ----------------------: |
| NCALED         | −30, −10, 156, 174            | 721 × 801, 0.025° |             137,377,011 |
| ANTIL / CARAIB | 9.7, 22.9, −75.3, −51.7       | 945 × 529, 0.025° |             271,292,376 |
| POLYN          | −25.25, −12.6, −157.5, −144.5 | 521 × 507, 0.025° |             136,619,068 |

The current advertised packet sizes suggest 1,907,915,684 bytes/day at 4/4/2
cycles, before constants/metadata and changing weather. This is an estimate
from metadata, not actual transferred bytes or a guaranteed future size.
The prepared policy caps are 16 MiB/object, 512 MiB/domain/cohort and **2.5 GB
across the ingest day**, with 49 forecast reads/cohort, 20 s/read, 1200 s/cohort
and a 2 GiB native ceiling. These are proposed limits, not grants of resources
or an activated downloader. Acquisition must charge actual traffic and refuse
before exceeding the admitted envelope; the missing controller must prove it.

The pure planner requires the exact original catalogue, Open Licence 2.0,
complete nonduplicated SP1 membership, fixed official HTTPS object paths,
original source date, bounded declared sizes and an unambiguous original
constant-grid resource. It does not treat planning as native admission. ACCESS-C
remains parked. Coverage hints do not add islands beyond the actual grid.

Primary references:

- [Météo-France technical AROME-OM description](https://donneespubliques.meteofrance.fr/client/document/descriptiontechnique_paquetsaromeom_donneespubliques_v3_20240625_377.pdf)
- [Official NC catalogue](https://www.data.gouv.fr/datasets/paquets-arome-outre-mer-nouvelle-caledonie-resolution-0-025deg)
- [Official Antilles catalogue](https://www.data.gouv.fr/datasets/paquets-arome-outre-mer-antilles-resolution-0-025deg)
- [Official Polynesia catalogue](https://www.data.gouv.fr/datasets/paquets-arome-outre-mer-polynesie-resolution-0-025deg)
- [Météo-France documentation index](https://confluence-meteofrance.atlassian.net/wiki/spaces/OpenDataMeteoFrance/pages/621019138/Mod%2Bles%2Bet%2Bdonn%2Bes%2Bde%2Bpr%2Bvision)

## Checkpoint verification

Current local source checks: 93 app/Edge fixture cases in five suites, 17 pure
Python methods (including original catalogue guards), scoped ESLint 0 and frozen
Deno Edge type check 0. The first static-source run retained a test clock-counting
mistake: the fixture waited for a fifth clock call, but the real reader used only
three. It now advances the controlled clock explicitly at the tile read, retaining
the final expiry guard. No product clock was restamped or deadline changed.

The frozen static source `9f2364baa85ed1ef4b796379789b8140616fa721` subsequently
passed actual isolated Linux run `39028187437`, job `117383228988`: 17 pure Python
methods, four actual ecCodes generated-fixture tests, and a Node24 native-file-to-
Edge interoperability check, with no skips. The process enforced a 2GiB address
space ceiling and recorded 121,972KiB maximum RSS, 15.60s elapsed and zero swaps.
The full 264,147-cell POLYN grid and all49 leads produced272 immutable tiles.
This exercises the original dimensions, CCSDS, scan/bitmap handling and all49
leads without provider access. The dependency lock is byte-identical to the
reviewed atmospheric ecCodes2.50.0/NumPy2.4.6 Linux closure. The independent proof
is `outputs/Build14206 actual Linux native static fixture proof.json`, SHA256
`714a8656877ce9629c839622a8292dd23a2205ffbf4caccf5c883f310e31897d`.
Generated native fixtures do not prove original Météo-France masks, parameters,
coverage or current source availability. Original native acquisition/publication,
and whole-app compiler/configured budget remain outstanding.

## Explicit Glass preference

`best_local` is an app strategy, never a provider model-domain ID. It is offered
as Best local inside a documented AROME region, and stays visible if already
selected when the location moves elsewhere. All manual/global choices and Auto
keep their existing paths. The ordinary global request remains DWD ICON as a
named fallback; no preference is automatically changed. The source remains held
by `THALASSA_AROME_STATIC_ENABLED`, with no publication/activation in this packet.

Glass adoption revalidates the original run, domain, sea mask/cell, exact49 UTC
hours, source age and current account/preference context after asynchronous
classification/assessment. The legacy hourly DTO requires numeric temperature,
so Glass additionally requires all49 native temperatures; the comparison keeps
its independent nullable series. Missing native temperature refuses Glass
adoption instead of borrowing a global value. Wind, pressure and humidity gaps
remain unknown; gusts, rain and weather codes are never invented. Independent
marine data still uses the existing marine-v2 path. UV/visibility may come only
from an exact-point/hour-matched independent forecast, labelled as supplements.

Only complete native local calendar days receive daily temperature extrema.
Today’s partial day keeps its extrema unknown; the actual Hero resolver cannot
borrow tomorrow’s pair. Partial future days are backed by their own original
hourly buckets, so all49 original hours stay accessible without a global tail or
an invented daily summary. Native run age,48h horizon, actual domain and Etalab
rights are available in the model sheet. The fixed footer uses a shorter source
line; full domain/supplement credits live in its existing Data sources rollup,
preserving usable controls at300px/130% and the original sheet/page bounds.

The first phone matrix retained a genuine31.1875px scroll-body exposure at300px/
130% caused by the long fixed native credit; no geometry guard was relaxed.
It also retained WebKit pointer-entry focus expectations: Safari does not focus
a button on a touch click. The keyboard restoration test now establishes and
asserts its real focused opener before Enter activation, retaining the original
focus-restoration check. No shared focus-trap behavior changed.

Primary native field references supplement the Météo-France specification:

- [WMO parameter categories and numbers via NOAA](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_table4-2.shtml)
- [WMO land cover: 0 sea, 1 land](https://www.nco.ncep.noaa.gov/pmb/docs/grib2/grib2_doc/grib2_table4-2-2-0.shtml)
- [ECMWF ecCodes GRIB2 keys](https://codes.ecmwf.int/grib/format/grib2/)

The actual 25 June 2024 technical PDF was retained outside source: 226,561 bytes,
SHA256 `0ef47906b303365b64f6fc12bec195f272ac10a7148de96ce277169ba3104b73`.
Its SP1 list confirms the five instantaneous variables and its current CARAIB
box matches the admitted 9.7/22.9/-75.3/-51.7 grid. The older 2 January 2024 PDF
has a different Antilles grid and is preserved only as historical evidence;
it is not the current-grid authority. Neither PDF read acquired forecast data.
