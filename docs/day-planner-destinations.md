# Day-planner destination coverage and provenance

## Reviewed packs and mapped references

`services/dayPlanner/regions.ts` is the reviewed coverage registry. It currently contains **only Whitsundays**; the global planning architecture does not imply a globally reviewed activity catalogue. A reviewed pack supplies an IANA timezone, inclusive geographic bounds, a bounded public reference-data query, existing anchorage identities and source attributions. Region selection is geographic, not a nearest-destination guess. Overlapping matches and malformed metadata fail closed.

Outside a reviewed pack, the runtime may discover existing mapped anchorages through the app's worldwide reference service. These are labelled `catalogueQuality: 'mapped-reference'`, offer only the `explore` preference, and have no activity-fact `verifiedAt` date. An optional `retrievedAt` records when source data was obtained; it must never be presented as a review of access, activities, shelter, hazards, permission or availability. A source/map link identifies the record for independent checking. Missing reference, weather, shelter or chart coverage remains unknown; a mapped stop is not a clearance to approach or anchor.

`resolvePlanningArea` computes display context and the origin's geographic timezone offline. It does not promise mapped candidates, routing availability or complete worldwide marine coverage. It never uses the phone/browser timezone to decide a departure's local clock. Dateline-crossing coverage bounds are supported by the registry; that alone does not enable unsupported cross-dateline routing or chart checks.

## Whitsundays reviewed pack

The Whitsundays pack uses six manually reviewed destination records in `services/dayPlanner/destinations.ts`. The existing `WHITSUNDAYS_DAY_DESTINATIONS` export remains available, and the registry uses that same catalogue without changing its source IDs or positions. Activity facts were checked against Queensland Parks on **27 September 2026**. `verifiedAt` is the fact-review date, not a live check of access, weather, water visibility, crowding or opening status. Each destination explicitly uses `Australia/Brisbane`; future packs must supply their actual region and, where needed, destination-local IANA zones for date-based restrictions.

Every position is copied exactly from the corresponding existing OpenStreetMap anchorage feature in `public/anchorages/qld/t-22e148.geojson` (QLD tile index build: 25 August 2026). These coordinates identify a mapped anchorage reference. They are not approved approach waypoints, anchor-drop positions, moorings, beach landings or walking-track entrances. This catalogue must not bypass the route provider or the existing anchorage/environment checks. Existing map attribution to OpenStreetMap contributors remains applicable.

| Destination                      | Existing anchorage ID                 | Position (latitude, longitude) | Primary activity source                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whitehaven Beach                 | `osm-node2982151597` · Whitehaven Bay | −20.26827, 149.05133           | [Queensland Parks: Whitehaven Beach day-use area](https://parks.qld.gov.au/parks/whitsunday-islands/attractions/whitehaven-beach-day-use-area) documents the beach, picnic area and nearby tracks.                                                                                                                                     |
| Tongue Bay / Hill Inlet          | `osm-node13823198736` · Tongue Bay    | −20.24273, 149.01398           | [Queensland Parks: Hill Inlet lookout track](https://parks.qld.gov.au/parks/whitsunday-islands/journeys/hill-inlet-lookout-track) documents the walk and tide-dependent shore access; [things to do](https://parks.qld.gov.au/parks/whitsunday-islands/things-to-do) documents the Lookout Beach connection.                           |
| Chance Bay                       | `osm-node8925547809` · Chance Bay     | −20.30413, 149.04268           | [Queensland Parks: Chance Bay](https://parks.qld.gov.au/parks/whitsunday-islands/camping/chance-bay-whitsunday-island) documents the beach, picnic tables, track and snorkelling, with tide and south-easterly access cautions.                                                                                                        |
| Cid Harbour / Sawmill Beach      | `osm-node3020491514` · Cid Harbour    | −20.24511, 148.94836           | [Queensland Parks: Sawmill Beach day-use area](https://parks.qld.gov.au/parks/whitsunday-islands/attractions/sawmill-beach-day-use-area) documents picnics and walking; [park camping advice](https://parks.qld.gov.au/parks/whitsunday-islands/camping) explicitly warns against swimming in Cid Harbour because of dangerous sharks. |
| Nara Inlet / Ngaro Cultural Site | `osm-node2838871153` · Nara Inlet     | −20.13740, 148.91214           | [Queensland Parks: Ngaro Cultural Site track](https://parks.qld.gov.au/parks/whitsunday-islands/journeys/ngaro-cultural-site-track) documents a short stepped walk and mid-tide shore access.                                                                                                                                          |
| Maureen’s Cove                   | `osm-node2838870585` · Maureen's Cove | −20.06774, 148.93815           | [Queensland Parks: Maureen’s Cove](https://parks.qld.gov.au/parks/whitsunday-islands/camping/maureens-cove-hook-island) documents fringing-reef snorkelling and picnic facilities, plus tide, northerly-wind and reef-marker cautions.                                                                                                 |

## Meaning of activity tags

- `snorkel`: the source documents snorkelling as an activity. Visibility, currents, wildlife hazards, safe entry and suitability for the crew still require checking.
- `beach`: a beach visit on shore. This does not establish swimming safety or landing access. Cid Harbour deliberately has neither `beach` nor `snorkel` tags, to avoid a misleading swimming suggestion.
- `walk`: a documented nearby walking opportunity, requiring a separately assessed shore transfer. A short stop does not promise completion of every available track.
- `lunch`: bring-your-own picnic at a documented picnic location. The pilot does not offer restaurants, restaurant reservations, food service or marina berths.
- `quiet`: an editorial match for a slower picnic stop at Chance Bay or Sawmill Beach. Source descriptions support that style of visit, but neither crowding nor calm water is known. It must not be displayed as a measured condition.
- `explore`: a request to consider a mapped stop. On unreviewed mapped references this is the only available tag; it does not imply beach access, snorkelling, walking tracks, food, permission or shelter.

## Known access notices at review time

[Queensland Parks' southern Hook Island alert](https://parks.qld.gov.au/park-alerts/26934) specifies a 6–15 October 2026 control operation, a maritime exclusion zone extending 200 m seaward around southern Hook Island and daily Ngaro Cultural Site closure from 08:00 to 15:00. The Nara record has an inclusive `knownClosures` interval for those dates. The pilot conservatively omits that candidate for the whole date; the interval is an application exclusion policy, not a claim that the walking site closes for 24 hours.

[Queensland Parks' Tongue Point works alert](https://parks.qld.gov.au/park-alerts/26977) describes partial closures during 12–16 October 2026. It is recorded as an access note and supporting source; the published notice does not justify marking the whole destination closed.

These snapshots are not a comprehensive or automatically refreshed alert service. Current park alerts, maritime notices, on-site signs, mooring restrictions and any charter-vessel limits remain necessary checks. Weather and shelter checks cannot resolve shore access or water-activity suitability.

## Maintenance

Update the matching ID, name and coordinates together when anchorage tiles change. Keep activity evidence distinct from position provenance. Review linked primary sources and current alerts before changing `verifiedAt`; do not advance that date automatically during builds. Record material access changes, and retain uncertainty notes even when a source uses promotional language about calm water or snorkelling quality. Do not infer a marina berth, public access right or mooring permission from a destination's name or mapped position.

`tests/dayPlannerDestinations.test.ts` checks every position against the shipped tile, source attribution, the Cid Harbour restriction and the known Nara closure. These are data-integrity checks, not navigation validation.

`tests/dayPlannerRegions.test.ts` checks registry identities, source metadata, coordinate/query bounds, IANA zones, ambiguity, dateline boundary handling and offline origin-timezone context. Runtime loading must still require exact agreement between each reviewed destination's anchorage ID, name and coordinates and the loaded reference dataset. Structural validation cannot establish that a linked source remains current.

## Adding reviewed coverage

The intended expansion is staged: additional Queensland packs, then Australia/New Zealand/Pacific packs, then Mediterranean/Caribbean packs. This is a source-review roadmap, not a delivery commitment or a list of regions already covered by reviewed activities. No placeholder worldwide destinations are shipped as reviewed data.

For each new pack, review primary park, marine-authority or operator sources; document the review date, access limits and uncertainty; match each destination to an existing source reference exactly; and supply source licensing/attribution and timezone-aware closure dates. Add a supported dataset adapter before introducing a new `reference.dataset` value. The current `qld` adapter uses a public catalogue centre and a query radius no greater than 100 NM, matching its existing geometry assumptions. Keep broader destination discovery separate from reviewed activity facts and do not imply that a new pack grants mooring rights or establishes marina capacity.
