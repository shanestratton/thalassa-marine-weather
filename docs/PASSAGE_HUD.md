# Passage pane on the Obs chart

**Ask — Shane, 2026-09-17, Gladstone, three days north on Serene Summer:** "the only real issue i have is i dont
really know which screen to look at, so i am thinking we need a new layer on the obs page. this layer will show cog,
sog, wind speed, direction and true and apparent. also we need to have a scrubber along the bottom, it needs to also
show the current track that we are on, and the route we are following. i think we need to be able to show the wind
spectrum, as well as squalls or rain depending on where we are. most of the info needs to be on a pane that can be
hidden to one side (left i am thinking). with the scrubber at the bottom, it needs to show the vessel going along the
route at its normal cruising speed - found in the settings vessel profile section - and all of the wind and rain etc
should alter as the yacht progresses along the route."

**Decisions — Shane, 2026-09-18:** (1) the ghost starts from the boat's current position on the route; (2) dead boat
instruments show dashes, the phone never stands in for SOG/COG; (3) the forecast block gets a change-model button;
(4) the scrubber runs out to 7 days.

## Phase 1 — the live strip (built 2026-09-18)

**Off by default.** Settings → Preferences → Chart → "Passage strip on the chart". Three review rounds each found
new chart furniture in the strip's column, so it reaches nobody who did not ask until it has been seen on the water.

| Piece                                                                          | File                                          |
| ------------------------------------------------------------------------------ | --------------------------------------------- |
| Enabled and open/closed switches, remembered on the device                     | `stores/passageHudStore.ts`                   |
| Distance ALONG the followed route, off-track, which stretch of an out-and-back | `services/routeProgress.ts`                   |
| The six instrument values, re-rendering only when one changes                  | `hooks/usePassageHudInstruments.ts`           |
| Numbers and tags, tested against the real GPS status resolver                  | `components/passage/passageHudFormat.ts`      |
| The strip and its closed tab                                                   | `components/passage/PassageHudPane.tsx`       |
| The Preferences toggle                                                         | `components/settings/PassageStripSection.tsx` |
| Mount, the strip's Back action, `data-passage-hud` on the chart `<main>`       | `App.tsx`                                     |
| Geometry, neighbours stepping aside, surfaces that hide it                     | `index.css` (`.thalassa-passage-hud*`)        |

**Shape.** A 4.75rem strip down the left edge, like a chartplotter's data bar — not a card. Two review rounds measured
a 176–200px card against the chart's real furniture: it covered the Copernicus licence credit (121px tall, not a 30px
slot), the wind legend, the ENC notice and the tide scrubber, and on a 393x852 phone left 207px of height with all
six instruments below the fold. Every centred piece of chart furniture starts to the right of 4.75rem, so nothing
carrying a licence condition is ever moved or covered.

What it shows, top to bottom: Back; LIVE; **TO GO** along the followed route with a tag for whose GPS that is (BOAT
GPS, BOAT · CLOUD, PHONE GPS, PHONE 3M, NO FIX, NO ROUTE) and an OFF tag when she is half a mile or more off the
line; SOG, COG, TWS, TWD, AWS, AWA; the instrument lane (VIA PI, CLOUD, GATEWAY, NO INSTR); what the GPS is doing
(GPS LIVE, GPS 3M OLD, GPS WAITING …); then a route-and-track button and Hide. Every tag carries its full sentence
in `title` and `aria-label`.

**Honesty rules.** Dead is a dash, never the phone's SOG/COG (Shane: "show dashes"); stale is dimmed; no COG below
1 kn; a cloud reading is tagged, position included, and the strip never starts the cloud lane; the route figure uses
the boat's fresh fix, else this phone's position only, and a fix is as old as its own timestamp says (fresh to 60 s,
gone after 10 min); "to go" adds the way back to the line once she is 0.5 NM or more off it, so abeam of the far end
from ten miles away never reads 0.0.

**Which leg.** The strictly nearest leg, always, within one continuous stretch of the route. Only where two disjoint
stretches share water within GPS noise (an out-and-back, a crossing, a return drawn beside the way out) does a hint
choose: first her course — her own COG when she has instruments and is making way, else course made good over 93 m —
then where she was last reckoned, which is remembered outside the component so a trip to another page does not
forget she is homeward bound. The first memory rule passed every single-shot test and, sailed tick by tick, froze at
waypoints, lagged on dense lines and counted UP all the way home; the tests now sail routes fix by fix, in noise.

**The Passage overlay stays the skipper's switch.** One button performs the same ON the layer button does (enabled
for a followed route or an active voyage, as there); OFF stays in the layer button, because only MapHub's own OFF
path clears what it drew. The first cut flipped the overlay with the pane and review found five ways that went wrong.

**What yields while the strip is on screen** (`main[data-passage-hud='open']` and not hidden): App's Back chevron is
hidden — the strip carries Back; the wind legend folds to its chip (the skipper's tap still wins) and moves into the
chevron's vacated slot; the squall/lightning legend stack steps right, and right of the closed tab too; the ENC
coverage notice is re-centred in the remaining width, with its own transform stated in the split and narrow-portrait
contexts. **The strip stands down** for the route tracer and location picker (App gate), the passage planner, the
consensus matrix and a storm card (CSS `main:has(...)`), and on a landscape phone. It sits at z-549, one under the
offline card, so that notice reads whole until dismissed.

**Measured** (headless WebKit, the app's compiled CSS, furniture copied from source; harness in the session
scratchpad): at 393x852 and 430x932 with wind and squall on, the open strip and the closed tab overlap nothing and
nothing scrolls; with SST and rain credits up, nothing is covered; storm card and landscape hide it. Known limits: on
375x667 and in the tablet split frame the strip scrolls (its last cells sit below the fold); an expanded multi-layer
legend dock rises behind the strip if the skipper opens it; the ENC notice overlapping the vessel-search button on
small phones is older than this change.

### Re-test on the boat

1. Settings → Preferences → Chart → turn on **Passage strip on the chart**. Obs → a small HUD tab on the left edge,
   below the Back chevron. Tap: the strip opens and carries Back at its top; the chevron is gone. Hide: both return.
2. Under way with the Pi live: the six numbers match the Instrument Panel; VIA PI; GPS LIVE.
3. Follow a route from the Log page: TO GO leads, tagged BOAT GPS. Tap the route button: the violet route, amber
   track and flag appear and the button lights; turn them off with Passage in the layer button.
4. Pi off or out of range: instruments go to dashes; TO GO keeps working, tagged PHONE GPS.
5. At the berth: SOG reads, COG is a dash.
6. Wind and squall layers on: the wind legend is a chip beside the strip, the squall legend sits right of it, the
   RainViewer and Copernicus credits are whole.
7. Select a storm, start plotting a route, open the passage planner or the consensus matrix, turn the phone to
   landscape: no strip, no tab, and the Back chevron is back.
8. An out-and-back: TO GO counts down all the way home, including after a visit to another page.

## Phase 2 — look ahead (built 2026-09-18)

Shane: "ok next phase". His four decisions: the ghost starts from where she **is**; unknown is **dashes**; a **change
model** modal button; **seven days**.

### What it does

An **AHEAD ▸** button on the strip (enabled when a route is followed, there is a position, and the vessel profile
yields a cruising speed — `vesselCruisingSpeedKts`, which falls back on hull speed from LOA). One tap:

1. turns the chart's Passage overlay ON (the same explicit ON as the button beside it; OFF still lives in the layer
   button) and frames the **rest** of the passage on screen, once — boat to destination, never again while scrubbing;
2. flips the strip from **LIVE** (white under emerald) to **FCST +6 h** (amber under amber). The instruments leave the
   strip — there is no forecast SOG, COG, lane or GPS — and the cells become TO GO (from the ghost, "AT 6.0 KN"), TWS,
   GUST, TWD, AWS EST, AWA EST, RAIN n%;
3. puts a scrubber in the chart's bottom row: Play, the clock time she will be there, a change-model button, the track
   (day ticks; the stretch the chart's wind field covers is shaded), and the data credit;
4. draws a **ghost** — hollow, dashed, amber, wearing its own "+6 h" chip — and the dashed line it rides, from the boat
   to the destination. The Obs chart draws no followed-route line of its own since 2026-08-03, and the Passage overlay
   only draws one it can match to an active voyage, so without this the ghost rode a line nobody could see.

The axis is an **offset from now**, zero to whichever comes first: she arrives at her cruising speed, or seven days.
Parked at +6 h it stays +6 h. Play sweeps the whole axis in ~24 s and **stops** at the end.

### The forecast she sails INTO

`services/routeForecastSampler.ts`. ONE batched request per (route, model) through `proxy-openmeteo`: up to 40 stations
fixed along the **whole** route (so the cache stays good as she advances), hourly wind, direction, gust, precipitation
and probability, `forecast_hours=170`, knots, unixtime, and **always `models=`**. The sampler interpolates between the
two stations either side of the ghost and the two hours either side of the moment — speed as a scalar, direction as a
unit vector (a shift from NE to SE is not 14 kn of easterly half way). Rain is the hour she is _in_.

Honesty rules, each with a test:

- past the end of the series → `beyond: true`, **nulls**, the words PAST FORECAST. Never the last hour held;
- HTTP 200 with every wind null → the model is not there (the GFS lesson), not a calm;
- AIFS and JMA publish no gust → "N/A" and a sentence saying so, never a borrowed gust;
- a reply for the model or route just left cannot be shown under the new one's name (held with its key, read back
  through its key); while the new one loads the cells are dashes and LOADING;
- offline / rate-limited → dashes and NO FORECAST, the ghost and its line still drawn; it asks again every 2 min;
- apparent wind is arithmetic on a forecast and a planned speed along the route's bearing: **EST** on the label, "not
  measured" to a screen reader.

### One model on the chart

The change-model dialog (centred, clear of the tab bar, internal scroll) writes `WindStore.model` — the same five under
the same names as the Glass and the chart's own wind chips. The strip's numbers and the wind field under them can never
be two different forecasts. It carries the full CC-BY line; the scrubber carries `Forecast data: <provider>`, which may
wrap on a narrow phone and may never be truncated.

### The wind field follows

`useWeatherLayers` subscribes to the offset (throttled ~8 Hz, a tenth of a frame) and places the wind timeline by the
**grid's own reference time**, through the manual-scrub path and re-applied each minute so the Now auto-tracker never
pulls it back; leaving look-ahead hands it straight back to Now. The grid is 48 hourly frames and the axis reaches seven
days, so the hook **reports** the hours of field it holds and the scrubber says "Chart wind ends +46 h — numbers
continue" rather than parking Tuesday's wind under Friday's ghost. While looking ahead `MapWeatherControls` takes its own
designed hidden state (no second time slider); its credits are not part of that state and stay put.

Rain radar, currents, SST and the rest do **not** follow the offset in this phase (radar reaches ~2 h; CMEMS steps are
8–12 MB each) — and the scrubber now says so by name while any of them is up.

### What an independent review found (2026-09-18, before the first commit)

Three reviewers, each finding separately verified against the code; all seven below were real and are fixed, each with
a test.

1. **The chart's wind was not on the clock.** Every model on offer comes through the Open-Meteo gridded path, which
   published no reference time, so the chart took frame 0 for "now" — and keeps a grid for up to three hours. "+6 h"
   showed the wind for six hours after the _fetch_ under a clock that said otherwise, and the coverage figure was a
   constant 47 h. `OpenMeteoWindFetcher` now publishes `refTime` (UTC — a zone-less ISO time parses as local). This also
   makes the chart's **live** Now index clock-true on a cached grid.
2. **A forecast that could not be refreshed was shown as this hour's.** The old run is still kept (it is worth having
   offshore) but now wears its age: `65 MIN OLD`, `3 H OLD`.
3. **Rain, currents and the rest sat under the scrubber's clock at their own time, with no label** (their pills are
   stood down). The chart now reports which such layers are up, the scrubber says "Chart rain: still at its own time",
   and their autoplays stop — the pills were the only pause buttons.
4. **A model that runs out before seven days showed bare dashes.** The service pads with nulls rather than shortening
   the axis; "beyond" is now decided from the last hour with a wind _value_. The last hour is held for 30 min at most
   (was 90), and the request brackets the far end of seven days (`forecast_hours=170`).
5. **Off her line, FCST disagreed with LIVE** (83 vs 93 to go), and abeam of the far end from miles off it read 0.0 on
   a dead slider. The plan now sails the way back to the line first: the ghost waits abeam until it is covered.
6. **Losing the fix mid-glance** pulled the strip and scrubber to NOW while the wind stayed parked at the offset. The
   axis now holds its last good length; the note says NO FIX.
7. **Adding another layer mid-glance** reset the wind to frame 0 for up to a minute. Re-applied in the same commit.

Also from that review: a man overboard now ends the glance (no ghost on the recovery chart); the ghost stays under the
boat at NOW past 10 NM (the fix was de-duplicated by its _rounded_ label and lagged up to a mile); the data credit can
never come out nameless; and a test that asserted against a string the strip can never render was made able to fail.

### Where the scrubber stands — measured, twice

The first cut reused the weather scrubber's slot on the theory that everything already cleared it. Run on the **real
chart page in WebKit**, that slot sat its right end on the Locate button, clipped Mapbox's ⓘ (licence-required) and put
its Play button over the Mapbox wordmark. The second cut fixed that at 393 px in plain pixels — and clipped the wordmark
by one pixel at 430 px, because the app's root font is fluid below 768 px and the wordmark is anchored in rem. Final:

|                                     |                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `bottom: calc(4rem + 38px + inset)` | the wordmark's own units: 8 px clear at 320, 375, 393, 430 and 1180 px                                                          |
| `right: 116px`                      | clear of Locate, the ⓘ and a full-width (100 px) scale bar at any zoom                                                          |
| strip `max-height` in forecast mode | `… − 4rem − 175px` since phase 3 (the scrubber's credit wraps to two lines); the two warnings stand outside the scrolling cells |
| "This is a passage" nudge           | steps **up** over the scrubber (`body:has(...)`) — the control in use does not move                                             |

Zero overlaps between the scrubber and any credit, button or the strip at all five sizes. The one remaining overlap is
the transient nudge card over the strip's lower cells until Not now is tapped.

### Never remembered

Look-ahead is not written to storage. Leaving the chart, hiding the strip, switching it off in Preferences, stopping the
route, or the strip standing down by CSS (storm card, planner, landscape phone) all return to LIVE and take the ghost
and its line off the chart.

### Known limits

- The ghost rides the **route**, from the point abeam of the boat. A boat well off her line starts the ghost on the
  line, not under her keel; it waits there while the way back is sailed, so the times and TO GO are right.
- A model's own horizon can be shorter than seven days (UKMO global ≈ 7 d, ICON ≈ 7.5 d): past it, PAST FORECAST.
- Speed is the profile's one cruising speed. No polars, no current, no leeway (phase 3).
- iPhone SE-class heights still scroll the strip; a landscape phone has no strip and therefore no look-ahead.
- Measuring with repeated anonymous page loads trips the proxy's public rate limit (HTTP 429). It is a test artefact —
  a signed-in skipper has ten times the allowance — but it is why NO FORECAST retries every two minutes.

### Re-test on the boat

1. Settings → Preferences → Chart → Passage strip ON. Follow the route to Mackay. Open the strip: **AHEAD ▸** is amber.
2. Tap it: the chart pulls back to show boat → destination, the strip turns amber **FCST NOW**, the ghost sits on the
   boat, a dashed amber line runs to the destination, and the weather controls' pill is gone from the bottom row.
3. Drag the track: the ghost runs up the line, the chip and the header count hours, TWS/TWD/GUST/RAIN change, and with
   the Wind layer on the particles change with it. Past ~46 h the scrubber says the chart wind has ended.
4. Tap **ECMWF ▾**: a centred dialog; pick ICON. Dashes and LOADING, then ICON's numbers; the wind layer reloads as
   ICON; the credit reads `Forecast data: DWD`. Pick JMA: GUST reads N/A.
5. Play: it sweeps to arrival and stops there. Tap Play again: it starts from NOW.
6. **LIVE ‹**: white numbers, emerald LIVE, no ghost, no dashed line, weather controls back, wind back at Now.
7. Look ahead again, then go to The Glass and come back: you are LIVE.
8. Airplane mode, then AHEAD: dashes, NO FORECAST, ghost and line still there. Signal back: numbers within two minutes.

## Phase 3 — spread, speed and rain (built 2026-09-19)

Shane: "phase 3 - go". Three things: **where the models disagree, say so**; the ghost **slows on the nose** and the ETA
moves with the forecast; **rain follows the scrubber** where a product reaches that far. A read-only survey of the four
subsystems came first (polars, the multi-model services, the rain pipeline, marine point forecasts) and changed the plan
in three places — noted below.

### Where the models disagree

`services/routeForecastSpread.ts`. **One** request for all five models along the route — probed live off Gladstone
while building this: ECMWF 3.9 kn from 198°, JMA 11.0 kn from 143°, same place, same hour. It is a **superset** of
phase 2's request: every member is handed to the sampler's cache, so the pinned model needs no request of its own
(1 quota unit an hour, not 2) and **changing model in the dialog is instant**. If it fails, the strip falls back to
phase 2's single-model request — the spread is extra, never a precondition.

- The strip's **headline stays the chart's one named model**. The spread is the range around it — `5–10` under TWS,
  rounded **outward** so it always contains the headline, with a count (`4/5`) only when someone did not answer. A
  five-model mean would be a number that matches no field on the chart and no provider.
- Each member is taken to the ghost's place and moment **first**, then compared. Members are **counted**: a model that
  runs out (UKMO ≈ day 7) or answered nothing drops out by name, so a band that narrows late in the axis is not read as
  agreement. Fewer than two members is no spread.
- **Only suffixed keys** are read: a degraded unsuffixed reply read five times would be a perfect, false zero.
- Thresholds are the Glass convergence sheet's (4 / 8 kn; 20° / 45°), so the two cannot contradict each other. Direction
  is the short way round and is **not judged under 6 kn** — light air from anywhere is not a disagreement. Gust is
  compared only among the three models that publish it.
- At 8 kn or 45° apart the strip says **MODELS SPLIT**, in red, on its own line.
- The scrubber draws **the band**: the five models' wind along _her plan_, the pinned model's line through it, red where
  they are split, broken (not stretched) where models ran out. It lives inside the track and costs no height. The
  credit then names **every** provider in it.

Deliberately **not** reused: `ConsensusMatrixEngine` (turns a null into a 0-knot calm, fabricates a gust as speed × 1.4,
and on fetch failure invents four "models" from sin-noise) and `MultiModelWeatherService` (`?? 0` on missing data).

### The ghost sails by the wind

`services/passagePlan.ts`. Phase 2 ran the ghost at one flat speed, so offset → distance was a multiplication done in
five places. By the wind it is non-linear **and sequential**, so it is walked **once** into a table (15-minute rows) and
everything reads that table: the axis length, the ghost, TO GO, the speed tag, the apparent-wind estimate, the
screen-reader sentence.

**Why the polar is scaled.** The app holds three polars for the same boat that disagree by about 2× (a 55-footer: 4.2 kn
peak from the yacht database's _generated_ table, 6.8 from the generic default, 8.2 in the edge router's bundled curve),
while the one speed the skipper has actually set — and asked for by name — is the profile's cruising speed. An unscaled
table would silently move the ETA by hours. So the polar supplies only the **shape**; it is scaled so a fair reaching
breeze (mean of 60/90/120/150° at 15 kn) gives exactly her cruising speed. A table that would need scaling by more than
2.5× or less than 0.4× is about another boat and is not used. The skipper's own `settings.polarData` when she has chosen
one, else the generic cruising polar; **never** the learned "smart" polar (it loads async, only after the Polars page is
opened, and its unfilled cells are literal zeros).

- Inside her close-hauled angle she **tacks**: `v(θc)·cos θc / cos α`. (`createPolarSpeedLookup` alone clamps and
  _holds_ — dead on the nose it returns close-hauled boat speed, the opposite of slowing on the nose.)
- She **motors** under 4 kn of wind (the isochrone router's own rule) or when sailing would give less than 60% of her
  cruising speed; motoring loses way into a headwind (the edge router's factor).
- A **power vessel** does her cruising speed and the tag says CRUISE — there is no client-side power model worth trusting.
- **No wind forecast is not a speed**: she is _assumed_ at cruising speed, the plan records from when, the tag reads
  `NO WX` and the scrubber says "No wind forecast here — 6.0 kn assumed".
- The tag reads `5.2KN SAIL / TACK / MOTOR / CRUISE / NO WX`. An arrival worked from the wind is called an estimate.

**Flat cruising speed is one tap away** — it is what Shane first asked for. The dialog (now "Forecast model and ghost
speed") offers both and says in plain words what "by the wind" assumes. The choice is a remembered preference; the
look-ahead itself still is not.

### Rain follows, as far as it reaches

The survey found the forecast frames carried **no clock time** and that the steps are uneven (10/20/30 min) — the
existing wind+rain combo's "frames are 10 minutes apart" arithmetic is wrong past +1 h. One live probe settled it: the
Rainbow snapshot id **is** a unix time (on the hour, ~16 min old). So frames now carry `timeMs`, and
`components/map/rainTimeAxis.ts` picks a frame by **clock**, never by index:

- at NOW (and for ten minutes) it is the newest **observed** radar frame — the clock-nearest frame at 03:16 is the 03:20
  _forecast_, and now is not a forecast;
- within reach (~3 h 45 — four hours less the snapshot's age) it is the frame for that moment;
- past the reach it goes **back** to observed radar and the scrubber says `Chart rain ends +3.7 h`. The last forecast
  frame is never held under a clock reading tomorrow;
- the index only moves when the integer target changes and never while a frame is still warming up — every request
  cancels the one in flight, so a follower at drag rate would cancel for ever and paint nothing;
- it re-applies when the frames are rebuilt (every ten minutes) and hands back to Now when the glance ends. This also
  fixes a phase 2 flaw: rain used to be **frozen wherever its autoplay happened to be**, with no label, under the words
  "still at its own time".

`rain` is on the scrubber's "still at its own time" list only when it has no timed reach at all (radar alone, a snapshot
that is not a clock, forecast still loading).

**A credit that was missing.** Until now nobody was named while a _forecast_ rain frame was on screen (the RainViewer
credit is, rightly, for radar frames only). Look-ahead shows forecast frames far more often, so the gap is closed:
`Rain forecast by Rainbow.ai`, same slot, never gated on the time controls or on look-ahead, and the Copernicus credit
stacks under either.

### What the independent review found (before the first commit)

Three reviewers, each finding separately verified; **all eleven were real** and are fixed, each with a test.

1. **Changing model dragged a parked scrubber to a different arrival — for good.** A model change passed through one
   render with no forecast; that walked the flat "assumed" plan, shortened the axis, and the clamp wrote the shorter
   offset into the store. Now a cached member is read _in render_, the axis is held while a series loads, and the store
   is never written from a plan walked while loading.
2. **The polar was held at both ends.** The yacht database's tables start at 6 kn of wind, so in a 4-knot drift the
   lookup handed back the 6-kn speed: "6.1KN SAIL". Boat speed now runs down to nothing at no wind (and the 60% rule
   sends her to the engine); above the last column she is never credited more than her cruising speed.
3. **Tacking, the apparent wind was worked dead along the rhumb line at VMG** — "AWA EST 0°S" beside the word TACK. It
   is now worked on her close-hauled heading at her speed _through the water_, and shows an angle with no P or S (the
   side alternates).
4. **A close-hauled angle below the polar's first row** was credited the 45° speed at 40°: 8–28% too good upwind. She
   is never priced pointing higher than the table can price.
5. **A stale five-model bundle blocked the single-model fallback**, so after the first hour a spread outage became a
   headline outage. The strip goes back for its one model, and never shows an un-aged old range under a fresher headline.
6. **A split that is all about direction** (five models at 18 kn, 80° apart) drew no red on the band — its range is
   zero knots wide — and painted the _speed_ range red on the strip. Every split stretch now gets a red rule along the
   top of the band; the TWS range is coloured by speed alone; the direction split is named on TWD (`80° apart`).
7. **A split shorter than two band samples drew nothing** — one sample is 4.2 h of a seven-day axis. A single sample
   now paints, and each band point's level is the worst found anywhere in its interval, hour by hour.
8. **The rain follower trusted the frame it asked for, not the one painted.** A stage that misses its 6 s deadline fails
   open and leaves the old image up: observed radar under a +2 h clock, credited to the forecast's provider. The follower
   now records committed frames, puts the index back where the image is, and reports rain as not following.
9. **Past the wind field, the rain note was swallowed by the wind note**, leaving observed radar unlabelled under a
   two-day clock. Past both reaches rain goes back on the "still at its own time" row.
10. **MODELS SPLIT and the age of a stale run were the two lines below the fold** on a 393×852 phone paying both insets.
    They now stand outside the scrolling cells: whatever overflows is a cell, never a warning.
11. **At the end of the axis the strip read "0.0KN SAIL"**, and every 30-second re-walk un-arrived her so Play did
    nothing. It reads ARRIVED; a skipper parked at the end stays at the end; Play offers to start again.

Also: a five-model request that keeps failing now backs off (1, 2, 4 … 30 min) instead of costing a quota unit every
two minutes for ever, and during the back-off the strip goes straight to its one model; the spoken range rounds outward
like the visible one; and an assertion that could not fail (`/3\d/` also matched the range "12–33") was anchored.

### Deliberately not in this phase

**Sea state and current at the ghost.** The survey found traps that need a measured probe first: Open-Meteo marine
**snaps** a harbour or river station to open-water waves up to 10+ km away with no null and no warning (route ends are
usually berths); wave height arrives in metres while the app's report path expects feet; current arrives in km/h where
the legacy path assumes m/s; wave direction is FROM and current direction is TO; the atmospheric model pin does not
exist on the marine API, so a wave number under "ECMWF" would break the one-model rule; and the strip's height was
measured for seven cells. It is phase 4, with the probe list in the survey.

### Re-test on the boat (phase 3)

1. AHEAD ▸. Under TWS there is now a small range (`5–10`). Scrub along: where it turns amber then red, the strip says
   **MODELS SPLIT** and the band on the scrubber is red there.
2. The tag under TO GO reads e.g. `5.2KN SAIL`. Scrub to a stretch where the forecast wind is on the nose: `TACK` (or
   `MOTOR`), a lower number, and the arrival moves later than the flat-speed one.
3. **ECMWF ▾** → the dialog is now "Forecast model and ghost speed". Pick ICON: the numbers change **at once**, no
   LOADING. Pick _Cruising speed — 6.0 kn_: the tag reads `6.0KN CRUISE` and the axis is phase 2's again. It stays that
   way next time.
4. Rain layer on, scrub inside four hours: the rain imagery steps with the scrubber and the top-centre credit reads
   _Rain forecast by Rainbow.ai_. Past ~3.7 h: observed radar comes back and the scrubber says where the rain ended.
5. LIVE ‹: rain is back on its newest radar frame, wind at Now.

## Phase 4 — sea state, and what is left

Sea state and current at the ghost (behind the probe described above); SPITFIRE as its own labelled band where the
ghost is inside one of its sites; squall cells following the scrubber (the proxy already serves `forecast=600…14400`);
a motoring-speed and motor-below setting in the vessel profile instead of the two constants; polar-aware reefing above
the table's last column.
