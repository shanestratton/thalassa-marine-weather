# Newport automatic exit review — 13 September 2026

## Scope and decision

Enable a **chart-matched, unsaved trial proposal for the reviewed Newport tidal-canal area only**. The four marked gates are explicitly ordered inside to outside, ending between Newport lateral marks 1 and 2 in Deception Bay. This is not a worldwide marker heuristic, a physical inspection, a hydrographic survey, an official approval, or navigation clearance. Unknown, expired, changed-chart and ambiguous cases require a manual exit.

Review completed `2026-09-12T21:12:59Z` (13 September in Brisbane). Review lease expires `2026-09-19T21:12:59Z`; the seven-day interval is an application re-review limit, not a source guarantee. Expiry must disable this automatic profile until reviewed again. The existing daily OSM refresh does **not** renew marker or chart verification.

## Evidence

- Exact coordinates and lateral categories were read directly, read-only, from the boat's installed/decrypted chart using `GET https://localhost:3001/api/enc/installed/OC-61-10RCS5/data` over the user-authorised SSH connection. Cell `OC-61-10RCS5`, edition 1, issued **7 March 2022**, installed **29 August 2026**, source `pi-decrypt`. A recent installation date is not a recent chart issue date. Tests and old generated marker files were not used as the source of truth.
- Maritime Safety Queensland's currently published [Moreton Bay Beacon to Beacon Guide](https://www.msq.qld.gov.au/-/media/TMROnline/msqinternet/msqfiles/home/boatingmaps/moretonbaybeacon.pdf), **MB-4**, visually inspected in full, establishes Newport's western north–south channel, four paired lateral gates, and open Deception Bay beyond its outer pair. The eastern parallel channel belongs to Scarborough Boat Harbour and is excluded. The map's nautical information date is **26 August 2021**. Exact marker coordinates are taken from the installed ENC, not measured from this small-scale PDF.
- The same guide's **enlargement B, Newport Marina**, was visually inspected. It distinguishes the Newport Lake lock from the tidal Albatross/Jabiru/Falcon/Hawk canals, and shows the **5.5 m Griffith Road bridge** separating southern canals. The bridge and lake cannot be assumed passable from a water polygon.
- [Brisbane Notices to Mariners](https://www.publications.qld.gov.au/dataset/brisbane-notices-to-mariners) was checked live on 13 September; dataset metadata last modified `2026-09-10T21:56:59.677183`. Current Newport entries were [468(T)/2025 — water quality monitoring buoys](https://www.publications.qld.gov.au/dataset/8b809b2e-473b-4f26-8969-ea0a6b58d4ec/resource/57034b1c-f879-4ffd-b195-1aa681a4b784/download/2025-468t.pdf) and [525(T)/2025 — dredging](https://www.publications.qld.gov.au/dataset/8b809b2e-473b-4f26-8969-ea0a6b58d4ec/resource/4f9035d8-8f0e-4ad7-82af-031be97f7d48/download/2025-525t.pdf). Neither changes the Newport lateral pairs. Their continued listing is not proof the works have finished; temporary works and equipment still require skipper review.
- The [published 2023 archive](https://www.publications.qld.gov.au/dataset/brisbane-notices-to-mariners-2023) contained no Newport entry at review. These live listings are not a complete historical changes ledger. No claim is made that every historical notice since 2022 was recovered.
- [Notice 105/2024](https://www.publications.qld.gov.au/dataset/8b809b2e-473b-4f26-8969-ea0a6b58d4ec/resource/26edee2d-d7c3-4916-8626-8a61ffaf4419/download/2024-105.pdf) concerns Scarborough's Port Entry Light in the adjacent channel, not Newport's lateral pairs.
- The broader installed `OC-61-10ENB5` edition 16, issued 27 March 2026, was checked; it has no Newport lateral objects. It cannot independently confirm or replace the detailed RCS5 markers.
- Old `public/data` marker midpoints differ by approximately 55 m and have no trustworthy provenance. They are **not** used or blended with the chart. The working local OSM geometry remains an obstacle/water-shape source, never marker authority or depth evidence.

## Registered chart gates

Coordinates are longitude, latitude in decimal degrees. `CATLAM=1` is the port lateral category; `CATLAM=2` is starboard. Marker identity is `cellId/objectClass/rcid`, not the renderer's array position. Pair labels are descriptive only; selection does not sort or infer from their numbers.

| Outbound order         | Port BCNLAT rcid, position  | Starboard BCNLAT rcid, position | Centre                  |
| ---------------------- | --------------------------- | ------------------------------- | ----------------------- |
| 1 — marks 8/7          | 2: 153.093312, -27.203197   | 17: 153.092770, -27.203153      | 153.093041, -27.203175  |
| 2 — marks 6/5          | 14: 153.093717, -27.196733  | 427: 153.093083, -27.196650     | 153.093400, -27.1966915 |
| 3 — marks 4/3          | 16: 153.094078, -27.190338  | 13: 153.093475, -27.190342      | 153.0937765, -27.190340 |
| 4 — terminal marks 2/1 | 430: 153.094383, -27.183017 | 15: 153.093783, -27.183033      | 153.094083, -27.183025  |

The outward bearing from the third centre to the terminal centre is **2.134563276° true**, consistent with the northbound exit shown on MB-4. This does not invent an offshore extension or permit a land-crossing join. Every mandatory centre and the provider seam must still pass the strict local water/obstacle checks. Route simplification must preserve all gate centres.

The profile's `centreline-permitted` rule is a trial plotting policy for this reviewed small-craft channel, **not an instruction to ignore traffic or a regulatory clearance**. MSQ's [navigation marks guidance](https://www.msq.qld.gov.au/Safety/Navigation-buoys-marks-and-beacons) advises passing between opposed lateral marks and warns that small craft should keep to starboard of leading lines in larger shipping channels. Do not generalise this profile to those channels or to unpaired, missing or shifted marks.

## Conservative departure polygon

The profile boundary is an inward-only subset of the controlled `newport-v1` **water=canal** polygons, not the regional rectangle and not a navigation corridor. Source OSM PBF timestamp **2026-09-11T20:22:01Z**; bundled overlay payload SHA-256 `e583d1ab43642919e6ff48f54a1e7bf4a16dbc29b3adb194b0ab2a81b97dab62`. Attribution: © OpenStreetMap contributors, ODbL; see the regional-data runbook for source URL and maintenance details.

Reproducible derivation, using Shapely 2.1.2:

1. Read the bundled `overlayJson`; union `water` features whose `water` tag equals `canal`, excluding OSM relation **9093123** (elevated Newport Lake) and way **722856950** (the lock).
2. Split the union with the Griffith Road bridge span in `public/notices/bridges-au.json`, extended by one span vector beyond each end. Its published span is `[153.0940954,-27.2123043]` to `[153.0947812,-27.2118978]`. Retain only the connected polygon containing `[153.09295,-27.205]`, on the northern/tidal exit side.
3. Project to local planar metres using x scale `111320*cos(-27.21°)` and y scale `111320`; erode **1.5 m** with mitre joins, then apply topology-preserving simplification with **0.5 m** tolerance.
4. Convert back and round to eight decimal places. Assert the resulting polygon is valid, contains no holes, and is entirely covered by the original unsimplified selected tidal component. No outward replacement or convex hull is permitted.

Results: **237 exterior coordinates**, no holes, **95.762%** of the selected tidal water area retained. It remains within `[153.08680422, -27.21508997, 153.10062589, -27.20415262]`. Compact JSON coordinate-ring SHA-256: `3ad262825791e420c4c3a6602c6b6f08c8023785f9669cc2b4cbd2c2ed04eed7`. The inward boundary is only used to choose the profile; it does not overwrite live water/obstacle geometry.

Verified membership:

- Both successfully trialled departure pins `[153.0897666667,-27.2145]` and `[153.0878,-27.2144833333]`: **inside**.
- Marina example `[153.094,-27.21]`: **inside**.
- Elevated lake `[153.088,-27.209]`, southern bridge-separated canal `[153.098,-27.215]`, open bay `[153.094,-27.18]` and Scarborough Harbour `[153.106,-27.194]`: **outside**.
- Boundary points do not auto-select. A destination within the departure area or at the handover requires a local/manual route, not an unnecessary offshore exit and return.

## Runtime gates and non-goals

Require the registered cell ID, edition and issued date, and all eight exact real BCNLAT identities/categories/positions, before resolving. Missing or changed chart evidence, stale review, malformed geometry, conflicts and out-of-region departures leave the manual exit option available. No nearest-marker, numeric-order, last-distance or OSM-marker fallback is authorised.

The existing tile, geometry, worker, bridge, water, obstacle, timeout, cancellation, authentication and provider-seam guards remain in force. A displayed ENC or a centre between lateral marks is not evidence of depth, air clearance, current works, tide or passage availability. The local route remains a review-required unsaved proposal. No route activation, deployment or TestFlight upload is part of this data review.
