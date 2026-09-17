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

## Phase 2 — the scrubber (next)

One time axis `t` (null = live) in `passageHudStore`; `RouteTimeScrubber` docked above the tab bar; a ghost from
`useGhostRouteMarker(mapRef)` starting at `progressAlongRoute(...).alongNm` and advancing at
`vesselCruisingSpeedKts(vessel)`; `services/routeForecastSampler.ts` (one batched point-forecast call over ≤50 route
samples, hourly wind, gust, direction, precipitation, 7 days, cached per route hash, `beyondForecast` rather than
clamping); the pane flips to a labelled FORECAST block off-now with the model named and a change-model button; the wind
layer follows `t` through one `externalTimeMs` prop. Two small MapHub hook lines, coordinated with the autorouting work.

## Phase 3 — spectrum and rain

Gust and model-spread envelope along the route, precipitation probability, squall imagery synced where available,
polar-backed speed behind a `SpeedModel`.
