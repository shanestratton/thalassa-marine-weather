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
