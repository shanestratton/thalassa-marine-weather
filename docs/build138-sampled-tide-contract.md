# Build 138 sampled tide and overhead foundation

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
uncertainty bounds. They carry a private in-process symbol; serializing and
restoring a DTO loses eligibility. Consumers must recheck against the current
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
Existing router rules remain unchanged. Opening windows still need a separate
reviewed operating/closure/notice contract; 33 CFR 117.35/117.40 sources are
recorded in the external implementation specification.

All derived licensed values remain aboard RAM. No chart read, geometry,
provider call, persistence, worker message, production SQL, acquisition,
publication or Pi installation is introduced by these pure modules.

Synthetic focused proof: 75 cases in nine suites, including the real existing
end-to-end bridge engine regression; scoped lint passes. Log:
`work/validation138-sampled-spatial-bridge-final.log`. No child compiler or
configured bundle measurement has been claimed. It is not yet wired into the
production chart/router. Remaining work includes reviewed sampled assets and
datum ties, bounded load/lifetime coordinator and display adapters, opening
intervals, complete holding-area/interval evidence, and an explicit reviewed
wait-waypoint acceptance path. None may use extrema interpolation or existing
seabed advice to turn unknown water/holding into a safe result.
