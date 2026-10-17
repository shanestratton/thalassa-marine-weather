# Build 134 routing integration

Local implementation on `codex/build-134-routing`, incorporating the frozen build 133 corrections from `9c0d9f2f2e5ca3a00226bc023b44a850e3666225`. This document records source behavior, not a benchmark success, physical-device check or TestFlight upload. Weather backend deployments are recorded separately in [the integration record](BUILD_134.md).

## 134-02: chart planning environment and vessel rules

The chart planner, voyage enhancement and precompute use one bounded current/wave/cyclone loader. The same loaded fields are reused for alternative wind models and later legs with the original environmental timestamps. Current routing uses one existing provider-confirmed surface-current snapshot, without tidal streams; time-varying current routing remains deferred. Missing current, wave or cyclone fields are named in route caveats. Satellite Mode does not start these discretionary downloads. Date-line routes do not expand into accidental worldwide current/wave fetches; those regional fields remain unavailable there.

Wave sampling is tied to planned departure. Missing publisher values, missing nearest sheltered cells and times outside coverage remain unknown; they are not calm-water values. The existing public-beta hold on global CMEMS current-cube routing is unchanged.

Vessel settings now store a true-wind motoring threshold in knots (default 4; explicit zero permitted) and speed under engine (knots; unset uses that vessel's cruising speed). Calls opt into bounded coastal step sizes while the engine's default six-hour step remains unchanged. These are resolution choices, not calibrated ETA claims. Hops below 15 NM use the existing inshore chart router, say so, and do not receive an offshore substitute when unavailable. Precompute records departure and vessel/comfort/network context so an old route cannot bypass updated choices.

## 134-03: sail/motor estimates and fuel

The engine records incoming-leg propulsion and tack side. Statistics are calculated from the raw computed path before smoothing can remove a motor leg or tack. Missing wind, legacy nodes and synthetic recovery joins have unknown propulsion. `motorHours` is null if any modeled duration is unknown; it is never inferred from SOG or a guessed fixed motoring percentage. Power-vessel calls explicitly select engine propulsion. Separate multi-leg joins do not claim a known tack count.

Passage cards, tablet data, share text and PDFs use the same estimated beating/reaching/running hours, tack count and motor-hours wording. Fuel burn is canonical litres/hour and the Vessel input converts the selected litre/US-gallon display unit. Tank capacity keeps its existing US-gallon storage contract. Reserve is a percentage of tank capacity (default 20, editable including zero). A missing burn or capacity remains unknown. Capacity is not an observation of current fuel aboard.

Inshore/Auto routes without a propulsion model show an explicitly labeled all-engine scenario. Their estimate does not claim that the skipper will motor the entire passage. The unused ResourceCalculator, which guessed 15% motoring for sailboats, is retired. No fuel-rate PGN learning or electric-propulsion model is introduced.

Focused synthetic tests cover field wiring, missing coverage, clock offsets, account/cache ownership, short-hop handoff, raw-path motor attribution, missing-wind uncertainty, unit conversion and reserves. Own-boat tracks and the selected polar are staged privately outside Git; the real Serene Summer performance benchmark still requires as-issued forecast access and execution. Generic/database/chosen-polar synthetic replays are separate evidence. No boat-specific routing constants are introduced.

## 134-04: wave limits and route comfort

The expansion rejects parents above the configured wave cap. A bounded caller retries only the crew wave preference at +15% and +30%, never above the vessel ceiling. Wind and gust limits do not relax. The displayed smoothed path is sampled at most every hour and five nautical miles, including endpoints, so a shortcut through a known storm exclusion or excessive seas is rejected. The same check runs again after chart validation changes a path. Unknown sheltered cells remain unchecked, with explicit partial coverage. Cached routes cannot transfer wave clearance to changed chart geometry without a fresh environment.

The existing 130-04 comfort model provides a labeled beta 0–3 result from the available total-wave height, period and direction, without inventing a wind-sea/swell partition or calibration. The card, share brief and PDF name the known wave maximum and place, missing coverage, and any relaxed preference. Mechanical ceilings never relax. Inshore and chart-modified geometries that lack modeled propulsion retain an explicit unknown/all-engine scenario. Unchanged verified offshore geometry retains its engine clock; later stitched legs use the original departure clock.

## 134-05: departure comparison

The exploratory table compares 3–6 hour departures with at most 24 runs (14 by default) and a 90 second default whole-compute budget, bounded to 180 seconds if a caller supplies another budget. Preparation of chart and forecast data occurs before that compute budget. The window is the actual completed set, not a promise to evaluate all seven days. Exact chosen hours use the existing account-scoped departure handoff, survive Calculate, and are shown beside the calendar date.

One named GFS batch of at most 25 points provides absolute-time wind, actual gust and rain for this explicit operation. Outside the grid, farther than 150 NM from a point, outside forecast times, or with missing hourly brackets, values remain unknown. Satellite Mode starts no such download. Ocean current remains one surface snapshot, without tidal streams. Waves/cyclones reuse the shared environment with a different offset for every candidate departure. A failed absolute-time wind field never ranks the legacy grid's held final hour as a current forecast.

The shared `departureScore` used by Plan Your Day and passage suggestions now also accepts rain, percent upwind, adverse ocean current and beta comfort. Optional terms count only when all comparable candidates have complete coverage; missing data cannot improve an option's rank. These are uncalibrated comparison weights, not ETA or safety guarantees. Missing and omitted terms remain visible. No multi-model spread flag is added.

Hops below 15 NM compare one verified inshore line rather than requesting offshore substitutes. Its chart masks/shallow runs stay only in the local operation closure. Tide timing retains the existing `leaveSpots`, `leaveCurves`, `leaveWindow` and `leaveChosen` contracts and bucket privacy, behind the fixed closed provider-use boundary inherited from build 133. No WorldTides clearance is available. A different geometry cannot inherit a tide verdict. Red chart hazards block the option. An offshore candidate without verified chart tide evidence remains tide-unknown; the weather ranking never clears a tide gate.
