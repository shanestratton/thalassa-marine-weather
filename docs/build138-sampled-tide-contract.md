# Build 138 sampled tide, bridge and holding foundation

This checkpoint prepares the source contracts for 138-05/06/07. It does not
activate a provider, alter the current tide/route/bridge gates or claim those
three roadmap packages complete. The existing official product remains
extrema/observation data. WorldTides navigation permission remains unverified.

`sampledTideContract` is a separate strict protocol for original dense
predictions, provider/product, actual station/datums/epoch, units and clocks.
It admits no extrema/observation extension or payload permission flag. It
copies only bounded primitives, preserves unknown issue time and returns
informational samples. There is no extrapolation, duplicate/unordered knot,
long-gap interpolation, implicit unit conversion or receipt-time replacement
of the original issue clock. Source/reference domains must match the provider.

`sampledTideAcquisition` binds a separately obtained adapter transport record
to an immutable in-process sample object. The adapter must supply its own
actual provider/product, request and final response URL, receipt clock and
response-byte digest. These are never read from fields in a provider payload.
The helper validates and binds that evidence; it does not perform or prove a
fetch. No production acquisition adapter currently calls it. Raw, spread or
JSON-restored DTOs remain informational, even with a reviewed source registry.
Both transport URLs must have the exact reviewed canonical origin and a whole
reviewed path boundary. Lookalike/sibling hosts, sibling path prefixes,
encoded paths, traversal normalization, queries, fragments and credentials
are refused. Supporting a real endpoint that needs other URL semantics needs
its own reviewed adapter policy; the DTO attribution URL cannot grant access.

`sampledTideNavigation` takes an independent trusted review registry. The
production registry is empty and frozen. No account, environment, provider
payload or acknowledgement can add a record. A future separately reviewed
integration can populate it with rights and exact source/product, cadence,
clock, uncertainty, station-to-current-cell datum/epoch, bounded geographic
scope and validity evidence. WorldTides specifically needs a reviewed written
permission reference. Tests exercise a fictional positive review, so the
architecture does not permanently prohibit a future qualified source.

Sounding, overhead and holding uses are distinct. A label such as LAT/MLLW or
a country prefix never substitutes for an exact cell-content datum transfer.
The review records retain public evidence references. The current framework
does not claim a real transfer simply because its type is present.
[NOAA datum guidance](https://tidesandcurrents.noaa.gov/datum_options) supports
requiring local transfer evidence.

Accepted estimates retain caller-owned account/boat/request lifetime, exact
query, cell content, epoch, read-time expiry, original issue and adverse
uncertainty bounds. They carry a private in-process symbol and issued-object
membership; spreading, serializing or restoring a DTO loses eligibility.
Consumers must recheck against the current
context and cannot revive an old account/boat A/B/A result with the old key.
The future coordinator must derive that lifetime from the actual account,
boat, route/policy, chart registry and source-review generations, not an input
text field. The pure contract itself does not observe application stores.

`nearbySampledTides` accepts two or three independently eligible station
transfers to the exact same target point/time/plane. One missing/incompatible
station, duplicate station, stale context or serialized result refuses the
blend. Distance weighting never shrinks the complete source/transfer envelope;
the oldest original issue is retained. Split reviewed dateline scopes remain
local. Scope and transfer accuracy are review evidence, not inferred from
distance or a land-blind nearest-station query.

`bridgeTideEstimate` provides an instant estimate using the actual height
plane and adverse high-water bound. It keeps the existing 1 m air margin,
refuses estimated/unknown and open-only clearances, and retains unknown
opening permission. It does not produce a crossing window or route verdict.
Existing router rules remain unchanged.

`reviewedWaterInterval` checks every original knot and intervening bracket
midpoint across a bounded complete interval, including the adverse low/high
envelope. Missing original coverage or a cadence gap refuses the whole result.
It retains the immutable adapter-bound inputs and snapshots the request before
yielding; endpoint-only checks cannot hide an intervening gap or peak. Inputs
are limited to three stations, one day and 512 checked instants. No new knots
are manufactured from official extrema.

`bridgeOperatingWindows` accepts a separate independently reviewed inventory
of explicit UTC slots, exact bridge/current-chart revision, original source
clock, effective dates, current complete closure/deviation check and notice
rules. Its production inventory is empty. It does not join distinct slots,
round a closing time outward or infer a repeating schedule from timezone text.
Required operator notice must be separately bound to the exact boat, source
revision and crossing. `bridgeCrossingAssessment` combines this with the full
overhead water interval, charted closed/open clearances and existing 1 m air
margin. Unknown closed clearance or estimated references stay blocked. An
opening result always says the actual span must open; it never grants an
unconditional passage. The 33 CFR 117.35/117.40 sources are recorded in the
external implementation specification. There are no real operating records.

`tideWaitReview` prepares a read-only proposal/acceptance seam. Its complete
holding reader currently defaults unavailable; the existing point seabed
advice is not that reader. A future separately reviewed adapter must prove the
complete holding circle and approach, minimum charted depth in the exact
datum/epoch, hazards, permission, non-point holding material and exposure/weather
for the complete interval. Unknown facts refuse a proposal. Vessel draft,
under-keel allowance and explicit wind/gust/wave limits are checked against
the adverse full tide interval. The read has an abortable 30-second deadline;
request/policy changes and original-source expiry are checked after the read
using the actual clock. Proposals expire within five minutes. Explicit
acceptance redoes the complete read and returns only a user-chosen point named
Wait; it does not mutate a route or save licensed facts or timing. The future
UI/coordinator still needs an atomic current owner/boat/route/chart/source
check when applying that intent. No current wait proposal is enabled.

All derived licensed values remain aboard RAM. No chart read, geometry,
provider call, persistence, worker message, production SQL, acquisition,
publication or Pi installation is introduced by these pure modules.

Synthetic focused proof: 87 cases in 11 suites pass, with scoped lint passing.
Log: `work/validation138-provenance-interval-opening-holding-final.log`. It
includes existing end-to-end bridge engine, datum, WorldTides and holding
regressions, plus independent transport URL boundaries, storage/spread refusal,
full-interval gaps, operating slots and clock/deadline cases. No child compiler
or configured bundle measurement has been claimed. These modules are not yet
wired into the production chart/router. Remaining work includes real reviewed
sampled assets and datum ties, bounded acquisition/lifetime coordinator and
display adapters, real verified operating intervals, a complete holding-area/
weather reader and UI/atomic acceptance integration. None may use extrema
interpolation or existing seabed advice to turn unknown water/holding into a
safe result.

## Concrete route-review integration

`PassageTideReview` is lazy within the existing Route report scroll area and
unchanged 85dvh cap. Opening it makes no request. Read aboard uses local saved
events and the existing station-specific NOAA harmonic model where applicable.
Separate explicit actions load an official event table or at most three
WorldTides station predictions through existing adapters. No optional paid wind
request is made. Satellite Mode permits aboard references only. Original dense
brackets can supply an informational height at the actual prediction location;
events never supply an invented any-time height. Nearby stations stay separate.
Rights, actual datum, unknown epoch/issue clock and receipt/publication clocks
are exposed. Credits and longer source details are collapsed.

The active wx official publisher was checked read-only on 17 October 2026:
`official-tides-publish.service` works in
`/opt/thalassa-official-tides/tides`. Its NOAA fetcher explicitly requests
`interval=hilo`; its publisher emits events/observations and generation/expiry
clocks. It does not publish dense heights or datum epochs. The Pi tide route
also forwards the WorldTides proxy. The wx2 forecast publication contract is
weather/marine data, not a tide provider. No server/service was modified or
provider activated during this integration.

`readPassageTideContext` reads the complete selected installed navigation-chart
cohort under package leases, with no chart download. It returns only RAM
primitives: actual current cell identities, sounding/height datum metadata,
point depth, nearby bridge clearances and existing bottom advice. It observes
actual licence ownership, the existing 14 cell cap, 16,000 objects and 65,536
vertices, with separate bridge-comparison bounds. Unknown/conflicting datum or
covering depth stays unknown. Missing layers are disclosed. A complete readable
inventory does not claim complete water/holding coverage. Licensed geometry
does not survive the lease and no summary is exported or persisted.

The coordinator captures the actual auth generation, active vessel/policy,
route/timing request generation, chart version, saved-source epoch and aboard
weather identities. Reads stop after 30 seconds. Loaded results retire on any
of those transitions, including account/boat A/B/A, and within five minutes.
Saved-table save/delete now advances its local source epoch. Missing/malformed
charts withhold chart claims while source information remains usable.

The holding form makes radius, duration, UKC and wind/gust/wave limits explicit.
It reads the actual earlier point and reports the genuine missing evidence.
Current adapters still provide no independently admitted original sampled
navigation product or station-to-cell epoch tie. A complete holding circle and
approach, current anchoring permission and full-interval exposure/weather are
also not proved by the existing point reader; the complete holding reader is
not implemented. Current wait proposals remain unavailable. This is a visible
remaining integration/evidence gap, not a claim that 138-05/06/07 are complete.

For a future genuine admitted proposal, acceptance reruns the complete evidence
read and issues a private, one-use point-edit intent. The editor atomically
checks the exact points reference, full geometry, source validity and a
monotonic draft epoch inside its React updater. Every draft mutation advances
the epoch before queuing, so queued A/B/A and a late source cannot revive an
old edit. The current UI chooses an existing earlier route visit: acceptance
labels that exact visit Wait, preserving coordinates and existing user marks.
It does not reinsert earlier coordinates at the gate, create a backtrack,
invent a waiting time, alter a watch or persist licensed derived facts.

Integration evidence: 93 focused tests and source/draft regressions pass in
`work/validation138-tide-review-integration-checkpoint.log`; first weather-alias
failure is retained in `work/validation138-tide-review-integration-first.log`.
Four real Chrome/WebKit cases at 300/375px and 130% text passed in
`work/validation138-tide-review-browser-first.log`, using entirely fictional
transport/chart data through actual client adapters. They check explicit source
actions, no default network, unchanged report cap/page extent, private summary
absence from storage, queued draft refusal and late boat retirement. Artifacts
are in `work/passage-tide138-browser-proof/`. No live navigation proof is implied.

The first whole-app compiler run on 8723e52ce exited 2 with three narrow
contract issues: DEPARE polygon narrowing, optional bridge estimated flag and
operating-interval callback types after array validation. They were corrected
with a real non-area-depth refusal regression; the first log is retained at
`work/validation138-tide-review-checkpoint-tsc.log` and its SHA/timestamps/exit at
`work/validation138-tide-review-tsc-receipt.txt`. No repaired compiler success or
configured production bundle result is claimed at this checkpoint.
