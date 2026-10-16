# Build 138 holding reader: source and admission limits

The passage report now calls a real installed-chart and aboard-environment reader before showing wait evidence. The former `async () => null` application reader has been removed. The pure review contract still defaults to unavailable when a caller supplies no trusted reader.

## Complete footprint and source lifetime

- The selected holding visit must have an actual incoming route leg. The initial route point has no inferred boat-to-point approach. Incoming legs over 10 km, polar locations and unsplit dateline windows remain unavailable in this bounded reader.
- A spherical disk centred on the holding point, with radius equal to the complete incoming shortest-arc length plus the holding radius and an outward margin, encloses the entire approach corridor and circle. Its enclosing rectangle deliberately over-reads. There is no sampled ring or point-to-area promotion.
- A single original DEPARE/DRGARE, suitable SBDARE and acceptable M_QUAL polygon must contain the whole envelope. Every ring boundary and hole is checked. Unclosed, degenerate, crossing, ambiguous or over-budget geometry remains unknown. Polygon unions are not assumed to cover gaps.
- Every installed cell in the complete envelope cohort must be readable at the current identity, edition and update. Existing public package leases are released even after a late read, cancellation or malformed data. Protected chart geometry never leaves the leased reader; only primitive, RAM-only disclosures leave it.
- Bounds remain 14 cells, 16,000 objects, 65,536 vertices and 500,000 boundary comparisons. Initial review and acceptance rereads have 30-second deadlines. Route revision, auth generation, boat policy, chart revision, saved tide sources, wind selection and CMEMS ownership transitions retire the review. Retained marine verification expiry can shorten the report's five-minute lifetime.

## Chart evidence actually read

The reader examines original bottom NATSUR/CATWED, DEPARE/DRGARE, survey/datum areas, land/coastline, soundings, rocks/wrecks/obstructions, shoreline structures, bridges/pontoons/overhead cables/pipes/conveyors, anchorage/cable/pipeline/restricted/caution areas, marine farms and all current traffic-area classes. An absent extracted class is reported as missing, never as an empty hazard inventory.

Intersecting physical or overhead objects conservatively hold clearance. Original RESTRN prohibiting anchoring is read even on ACHARE. A designated anchorage alone does not establish current permission. Point bottom observations do not establish full-area holding. Known poor bottom and unknown original attributes remain distinct. The reader does not infer a sounding epoch, bridge height tie, tide allowance or opening permission.

## Aboard forecasts actually read

The environment reader uses the existing WindStore/owner-selected imported GRIB and a synchronous borrowed view of already retained, verified CMEMS wave/current frames. It performs no fetch, cache renewal, LRU touch or extra decoded-frame retention. The existing global two-frame / 32 MB marine cache is unchanged.

Every enclosing grid cell vertex and required temporal bracket contributes to a conservative maximum, capped at 250,000 node visits per field. Missing frames, masks, finite values, actual gust fields or spatial/time coverage stay unknown. Descending CMEMS rows are handled explicitly. Grid-node bounds describe the forecast representation, not measured local conditions or shelter.

Original issue, publication, verification and validity clocks are displayed separately. Only the actual owner-selected imported GRIB adapter currently establishes an original wind run clock. CMEMS publication/verification/data-start clocks are not substituted for an original model issue. Ocean uo/vo does not include tidal streams or local harbour flow; missing currents never become zero. A current limit and explicit tidal-stream evidence are now required by the complete admission contract.

## Genuine remaining evidence blockers

Current sources do not establish all of: an original navigation-authorized sampled tide interval, station-to-current-chart datum/epoch transfer, current anchoring permission, complete fresh original issue clocks, local exposure and tidal/local current coverage. The production reviewed tide/source-tie and bridge-operation registries remain empty. WorldTides remains informational because written navigation permission was not supplied.

The active wx official publisher was inspected read-only at `/opt/thalassa-official-tides/tides`. Its NOAA request uses `interval=hilo`; the actual published schema contains events, not original any-time samples or datum epochs. Existing saved/offline tables also retain events. NOAA local harmonic comparison remains explicitly a station-model reference, not an activated navigation product or a chart transfer. The existing WorldTides proxy supplies original dense station predictions but not the missing rights/epoch proof. No source was activated or deployed by this packet.

These are evidence gaps, not an unimplemented chart/forecast reader. The UI presents actual partial facts and precise missing classes/clocks/sources inside the existing report scroll area. A checked Wait cannot qualify until the independent gates pass. Future explicitly reviewed providers can use the existing sampled-product, datum-transfer and complete-holding contracts; payload strings, acknowledgements and chart designation cannot authorize themselves.

Acceptance rereads the real complete reader and uses the existing one-use atomic editor intent. It only labels the selected existing holding visit `Wait`; it does not insert a backtracking leg, set a departure time, change the watch or persist derived chart/tide/weather facts. PDF, GPX and saved/cloud route DTOs remain unchanged.

Focused tests and Chrome/WebKit fixtures use explicitly fictional source data. They prove client behavior and layout, not live navigation qualification, native installation, deployment or TestFlight availability. Whole-app compilation and the unchanged configured release budget remain root release checks.
