# Plan Your Day: reviewed guides and worldwide mapped stops

Plan my day proposes one stop from a confirmed yacht or manually entered departure position. Return mode calculates a separate outward and homeward route; overnight mode assesses a stay at that same stop through the chosen end time. It does not plan multiple stops, restaurant visits, marina bookings or mooring reservations.

Reviewed coverage is selected geographically through `services/dayPlanner/regions.ts`, initially with the manually maintained Whitsundays catalogue in `destinations.ts`. Its activity facts and exact existing anchorage references are documented in [day-planner-destinations.md](day-planner-destinations.md). Outside reviewed coverage, the planner offers clearly labelled **mapped stops—local details unverified**, with an Explore preference only. An anchorage reference is not an approved approach, landing, anchor-drop point or permission to visit.

## Worldwide mapped mode

Mapped discovery reuses the existing worldwide OpenStreetMap cruising-reference service, querying at most four nearby one-degree cells and no more than a 30 NM budget-based search radius. It considers exact anchorage nodes only, not approximate feature centres or moorings of unknown capacity. This is a bounded search, not an exhaustive list of cruising stops. Latitude is limited to ±80°; routing, weather and chart availability can further limit results. Unsupported route segments crossing the date line are rejected, even though discovery supports wrapped geographic bounds.

References must be fresh (less than 24 hours old), online, have exact source identities and preserve restriction metadata. Older cached references are refreshed before planner use. Known access or anchoring restrictions are excluded conservatively; missing restrictions are not permission. Conditional restrictions are not interpreted as permission at a particular time. `retrievedAt` is source retrieval, never human review.

Mapped stops have no inferred snorkelling, beach, walking, food, access, holding or shelter claims. Their overall assessment and stop assessment remain **unknown**, regardless of favourable forecast evidence; known adverse evidence still excludes the option. Their limitations persist through ENC review and private saving. Only reviewed regional packs offer documented activity tags. No automatic background catalogue-refresh job is created by this feature.

## Local planning clocks

The departure area's IANA time zone is resolved offline from yacht coordinates, not the phone's location or time zone. Changing cruising area preserves the chosen departure/deadline instants while displaying the new local clock. Default overnight end is 09:00 on the next local calendar date. Nonexistent or repeated daylight-saving wall times must be changed before calculation; the planner never chooses an offset silently.

On-screen itinerary times share the explicitly labelled departure-area clock. Saved schedule notes include the IANA zone, abbreviation and UTC offset for each relevant location; destination closure dates use the destination's local calendar. Destinations across a time-zone boundary resolve their own zone independently.

## What is compared

- Departures may be selected from now through five days ahead. The complete itinerary must fit within 36 hours of departure and the supported forecast horizon.
- Sailing time is calculated from every point of the returned route geometry at the saved vessel cruising speed. The sailing budget is the sum of outward and return time; stop time is additional. A return deadline remains an absolute deadline.
- The entry sits above Trip and Depart controls on Plan. In reviewed coverage, a local destination selector defaults to all local destinations; no activity preference is the default. Selecting a specific destination overrides activity preferences only, never restrictions, closures, depth, weather or timing checks. Changing area clears the selection; changing position invalidates earlier results.
- Up to four destinations are assessed per search, shortlisted by a distance lower bound. Every qualifying assessed option is shown, including the fourth. Stops outside that budget are explicitly labelled **not assessed**, not rejected as unsafe. Choose a local destination to assess one outside the automatic shortlist. Fewer or no options is an expected result, and this is not an exhaustive search of all stops worldwide.
- Optional flexible departure compares only the selected time, one hour later and two hours later. It does not search for an optimal departure window. The overnight end and return deadline are not shifted. The chosen option's actual departure is shown and saved.
- Directional route results and forecast snapshots are shared only within that comparison run. No reversed outward route or straight-line fallback substitutes for a failed return calculation.

Reviewed activities are documented snorkelling, beach visits, walks, bring-your-own picnic lunches and a slower-stop preference. A match does not measure visibility, crowds, swimming safety or availability. Shore transfer and the time required to finish a particular walk remain separate decisions. Unreviewed mapped mode offers Explore only.

## Route and forecast assessment

The live adapter requires an authenticated account and installed navigation charts: since 2026-10-01 every leg is routed on the phone by Thalassa's own router, the same one Auto uses (`services/autoroutingThalassa.ts`), one leg at a time. It uses the saved vessel draft and cruising speed, preserving estimated-field warnings. The retired automatic canal exits are not consulted; the router routes from the berth, and offline the Newport estate refuses in the engine's own words. Catalogue trips with required checkpoints are excluded per stop until legs can be chained through them. Every proposal receives the same local chart review used by the route workspace, and every route check carries "a proposal is never navigation clearance", so it is amber at best. Review fix-ups, later on 2026-10-01: the entry is Pro route planning like Auto (a free account is offered the upgrade; during the public beta every account counts as Pro), and a stop is excluded when its leg crosses charted land, is drawn red with no charted depth behind it, or ends more than 500 m short of the stop with nothing on the chart to explain it.

Local dangers, a route whose safety classifications did not arrive intact, required tide clearance, insufficient charted depth, mismatched endpoints and unfinished route reviews exclude a candidate. Missing chart or depth coverage can remain an explicit advisory; an uncertain route never gains clearance from favourable weather. A provider's absence of findings is not treated as a provider clearance.

Weather is evaluated across the exact outward, stop and homeward periods, including both hourly brackets at each interval boundary. Overnight assessment includes the full requested stay. Freshness is measured against the current calculation clock, not the future arrival time. Forecasts older than 15 minutes, missing fields or hours and unrelated locations cannot produce a favourable assessment. Known adverse conditions take precedence over incomplete fields.

Transit samples follow the original route at no more than 5 NM or 30 minutes between samples, with endpoints and significant turns included. Each sample covers a continuous part of the transit interval. The pilot excludes an itinerary needing more than 24 forecast positions, including its stop, rather than silently dropping route sections. Strict planner forecast ingestion also checks the returned provider grid locations. Coarse forecast cells still cannot resolve every channel, headland, squall or shoreline effect.

The form uses conservative ceilings of 20 kn wind, 25 kn gusts and 1.5 m waves, applying lower saved vessel wind/wave limits where available. Wind and gust ceilings apply throughout the transit and stay. The open-water wave ceiling applies during transit; waves at the stop use the existing land-fetch shelter assessment. Reefs are not assumed to provide constant shelter at every tide.

The forecast colours describe favourable, caution, adverse/restricted or unassessed evidence. They do not establish safe navigation, good holding, legal anchoring or suitability for swimming and snorkelling.

## Review and private saving

Selecting an option opens its itinerary details. Each leg must be opened in the existing ENC route review before the planner offers its acknowledged save action. This embedded review displays the exact proposal and reports fresh local checks back to the planner. Its setup, calculation, clearing, standalone saving and waypoint movement paths are unavailable so the reviewed geometry stays tied to the assessed itinerary.

Saving performs a separate preflight against the current account, vessel inputs, proposal geometry, local review basis, chart registry, schedule, sailing budget, deadline and known destination closures. Stale calculation, stop-weather, transit-weather and route-review timestamps block saving. Danger or tide-dependent evidence also blocks saving. Unknown forecast or incomplete depth limitations can be retained as clearly labelled planned-only evidence when the required local review records are complete.

Both return legs are validated before one local route-library write. A capacity or storage failure does not silently discard an existing route or save only the first leg. Private cloud sync follows as best effort; partial or pending cloud sync leaves the complete local copy and is reported separately. Licensed raw provider RTZ/GeoJSON payloads are not stored with the saved plan.

The save action creates private planned routes and, for a return trip, a linked pair of trip legs. It does not activate navigation, follow a route, record a voyage, create a Float Plan, publish an itinerary, or reserve any facility. Editing a saved plan requires reassessing its route, timings and weather.

## Limits and maintaining the catalogue

Times assume constant vessel speed. Currents, tidal progress, manoeuvring, shore transfers and crew-specific activity timing are not modelled. The pilot does not verify live mooring availability, anchoring holding, swimming hazards, fuel range or every current notice and access restriction. Cancellation, account changes, vessel changes and chart-evidence changes prevent stale asynchronous results from being accepted; a planning run also has a four-minute time limit.

The versioned Supabase catalogue foundation is documented separately in [CRUISING_TRIP_CATALOGUE.md](CRUISING_TRIP_CATALOGUE.md). It is not yet deployed or connected to this calculation. Current suggestions still use calculated routes to documented stop references, not a library of reviewed local sailing tracks.

Reviewed destination sources and closure records are snapshots maintained by a person. `verifiedAt` records when the linked activity facts were reviewed; it is not a live access check. No background process refreshes park alerts, closure dates or the source-review date. Catalogue maintenance must check current primary sources, update matching anchorage identities and coordinates together, retain access uncertainty notes, and add documented restrictions conservatively. Recorded closure dates use each destination's IANA zone (Australia/Brisbane for the Whitsundays), independent of the device time zone.

Relevant implementation boundaries are `services/dayPlanner/engine.ts` (deterministic planning), `runtime.ts` (live adapters), `save.ts` (private-save preflight), and the shared anchorage conditions and autorouting review services. Focused regressions cover these boundaries and the read-only workspace in `tests/dayPlannerEngine.test.ts`, `tests/dayPlannerRuntime.test.ts`, `tests/dayPlannerSave.test.ts`, `tests/dayPlanConditions.test.ts`, `tests/dayPlannerDestinations.test.ts` and `tests/AutoroutingTrialWorkspace.test.tsx`.
