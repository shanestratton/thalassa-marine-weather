# Crowd soundings: reviewed sources and separation

Roadmap14209 covers public display-only soundings, conservative QA/grids,
0.5m-spaced contour tiles, a lazy Obs layer and DCDB contribution. Spacing is
not an accuracy claim. No crowd product enters routing, clearance or alarms.
Private phase1 capture and its three canonical core mirrors remain unchanged.

Primary sources checked17October2026:

- The [IHO catalogue](https://iho.int/en/bathymetric-publications) lists
  [B12edition3.0.0](https://iho.int/uploads/user/pubs/bathy/B_12_CSB-Guidance_Document-Edition_3.0.0_Final.pdf).
  Sections2.3 and3.2 distinguish instrument offsets, raw/as-captured depths,
  metadata and tidal reduction. Raw depths with original UTC and offset context
  are preferred for DCDB; a tide-reduced display grid is a separate product.
- The [live NCEI DCDB page](https://www.ncei.noaa.gov/iho-data-centre-digital-bathymetry)
  links the actual [2025submission guide](<https://www.ncei.noaa.gov/sites/default/files/2025-07/Guidance%20for%20Submitting%20CSB%20Data%20to%20the%20IHODCDB_v2.0%20(3).pdf>),
  [format3.0 examples](https://www.ncei.noaa.gov/sites/default/files/2024-04/SampleCSBFileFormats.pdf)
  and [Trusted Node agreement](https://www.ncei.noaa.gov/sites/default/files/2024-04/IHOCSBTrustedNodeAgreementFormTemplate.pdf).
  The earlier `sites/g/files` guide URL returned404. Following the live link
  resolved `sites/default/files`, and all9pages were readable.
- Onboarding requires a reviewed sample, an agreed prefix/UUID identity and an
  issued token. The guide's example API is a **test** endpoint. No production
  admission, prefix, token or provider contact is inferred. No contact or upload
  is performed.
- The [official schema repository](https://github.com/CI-CMG/csbschema) documents
  provisional XYZ/GeoJSON3.0 and newer GeoJSON3.1. Export must name the convention
  actually reviewed during onboarding, not silently adopt a different version.

Legacy private consent2026-10-05 grants no public permission. Map and DCDB/CC0
choices start independentlyOFF, owner/vessel scoped, revision-bound and
future-only. Thirty days must pass after a batch ends. Capture OFF is separate
from publication OFF. Public CC0 copies cannot be recalled; OFF stops future
release and excludes the source from the next active Thalassa generation after
current owner/privacy checks. It does not promise removal from external archives.

Draft confirmation or a reported offset alone is not sounder calibration. The
public policy requires explicitly checked reference/source/product, measured
waterline offset, date, uncertainty and checked depth range. T adds that offset
once; W does not add it again. No boat, draft or model is hardcoded. Existing Pi
captures declare GNSS time; phone captures currently declare device clock and
remain held for this public QA.

Map reduction requires original observed water levels with explicit reviewed
common datum/region, UTC bracket, QC, uncertainty and reusable rights. WorldTides,
unknown datum, zero tide and proximity-only station assumptions cannot qualify.
Cells require independent boats and UTC days; missing cells stay empty. Contours
use only fully qualified neighboring cells of the same datum. Current privacy
zones receive a cell-sized exclusion buffer before aggregation. Public products
carry no owner/vessel/track identifiers.

This first policy/consent/migration packet is source only. Actual PostgreSQL
RLS/concurrency, Linux QA, publication, browser layout, tide-source authority,
DCDB onboarding and physical Pi acceptance require separate evidence. It has
not been deployed or run against a database.

The lazy Public contribution settings sheet now sits beside private capture.
It loads no sharing service until opened, checks actual fresh owned-vessel
records, and keeps map and DCDB choices separate. Saving requires measured
fields and an explicit acknowledgement; editing a measurement retires that
acknowledgement. OFF is available even if the current row cannot be loaded.
An offline OFF intent is retained only in the current owner's vessel namespace;
it is delivered before any later enabling request. The pinned footer keeps
Close and Save within the sheet rather than extending the page.

The new `crowd-sounding-export` function is disabled unless explicitly admitted.
A dedicated 256-bit worker token is verified against its SHA256 before any
privileged read. The service-role key stays inside Edge. There is no browser
quota fallback or request-supplied authority. It lists at most32 candidate IDs,
reads one gzip under2MiB and inflates under2MiB, parses the unchanged canonical
CSV, reapplies current buffered privacy/QC and re-reads the actual owner/consent/
platform source after all awaits. It recomputes the stored object's SHA instead
of confusing it with the legacy sent-object idempotency SHA. A private source
receipt lasts60seconds; the worker must call `check` again immediately before
public emission. This is not a transaction lock across remote publication.

Focused source proof:36cases in5suites, including real gzip, decompression-bomb,
default-OFF/auth refusal, late source replacement, owner A/B/A and offline OFF.
The actual Deno2.9.4 entry check passes with frozen dependencies. The initial
check exposed a stream generic mismatch; a copied ArrayBuffer-backed input
fixed the type while retaining the same2MiB output ceiling. Browser geometry,
actual PostgreSQL/RLS/races, wx native QA and public/DCDB admission remain
separate pending proofs. No production function or schema was deployed.

The final consent lifetime guard admits a boat SHARE lock without waiting, then
tries the account-deletion authority instead of waiting while holding the boat.
The new `aaa_crowd_permission_retirement` BEFORE trigger sorts before the actual
blocking `account_deletion_write_fence`. It tries old/new owner authority for
every update, including ordinary metadata edits; only owner, archive or release
changes delete permission. This prevents a busy account deletion from trapping
a boat row before the older presence/comfort AFTER hooks. Permission clocks are
sampled after all consent waits; expired calibration is excluded from candidate
pages. A/B/A cannot revive a deleted revision.

The prepared `crowd-soundings-db.yml` uses only an empty loopback PostgreSQL17.6
container, pinned isolated pg8.16.3 and no product credentials. Its runner
replays the full unchanged private seabed migration and byte-checked original
account fence, presence/comfort retirement and boat-policy subsets. It includes
owner RLS, future-only/30day admission, independent permissions, CAS, actual
blocking observations and archive/deletion/release/owner A/B/A tests. This
workflow is prepared, **not dispatched**; Node syntax and disposable-connection
refusals pass locally. These are not yet actual PostgreSQL proof results.

The optional Obs layer is lazy and defaultOFF. It reads only the owned
`crowd/v1` public prefix after an explicit toggle, foreground/network-policy
admission and sufficient zoom. A viewport may borrow at most9 tiles,512 line
segments and1.2MB per session; two native fetch slots stay charged until the
actual promises settle. Original expiry, account transitions, cancellation,
clock rollback and network-policy changes remove the owned overlay. The
existing Credits rollup contains its source/datum/uncertainty warning. Nothing
from this layer enters routing, depth clearance or alarms.

Final local source proof:48 Vitest cases across6 suites and2 disposable-URL
Node cases pass; scoped lint, canonical mirror check and diff check pass.
The real Chrome/WebKit phone fixture passes4 cases at300/375px,130% text and
667px height. It checks44px controls, horizontal ancestor clipping, pinned
footer reachability after scrolling, Hide all and unchanged page/map extent.
The fixture uses explicitly fictional source bytes and a synthetic map host,
not a real account, live map paint, provider data or deployed public product.
Screenshots were inspected at the narrow sizes. Earlier selector failures,
fixture wrapping and canceled-animation failures remain preserved; the real
fieldset min-content overflow exposed during that work was corrected.
Ordinary keyboard browser configuration includes these cases. Whole-app
TypeScript, configured bundle size, actual PostgreSQL, Linux native QA and
physical hardware remain root-owned pending proofs; no size PASS is inferred.

The disposable database service is capped at512MiB RAM, zero swap,96tasks and
one CPU. Before SQL runs, the workflow reads its actual own container cgroup
and requires the exact kernel values; a third local Node regression refuses
unbounded, host-scope, extra-field and widened-cap receipts. Every SQL statement
is bounded at15seconds and the complete runner at120seconds with5second kill
grace. Its text proof file is capped at1MiB. These controls have been prepared
and syntax-checked; they are not an executed PostgreSQL result.
