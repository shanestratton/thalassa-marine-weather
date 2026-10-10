# 127-DESKMAP-b Wind on the desk: an option in the desk menu, named, credited, and honest when the models disagree

Written 2026-10-10 ~16:50. Read-only on b127 at 719645bb7. Sits on 127-DESKMAP (the desk menu, `deskPlanner`, the
Light base, the strip, the single owner of the seamark raster) and merges after it.

**Authority.**
- Shane, 2026-10-10, verbatim: "can we include the wind layer on the desktop.?? as an option??"
- Shane, verbatim: "the desktop experience needs to be 2nd to none. the best of the best" and "we work within the
  rules, but we need to make it bang claude. better than what we were going to do".
- Shane's earlier words that bind this package, quoted in the code:
  - 2026-07-23: "any layer that is on in the charts page, shows up on the planning page ... we need our layer to
    show through" (useWeatherLayers.ts:340-347). Desk wind is the planner's own pick; Obs layers never leak in.
  - 2026-07-22: "the models do not match our models in the glass page" (WindModelFieldSelector.tsx:6-8) and "we
    do not need gusts on this page. just wind" (:10-11). The desk offers the Glass's five, wind only.
  - 2026-10-06: "the wind is impossible to see in shore, maybe we could make it white???" (windRamp.ts:108-110).
    White streaks were right on the dark Relief seas; the Light base needs dark ones.
  - 2026-09-05: "i have changed my mind about allowing the layers to persist from app restarts"
    (useWeatherLayers.ts:436-441). Desk wind is session-only.
  - 2026-09-06: credits "all in the same spot below the drop down box at the top middle of the screen"
    (creditsStrip.ts:4-7).
  - Ruling 2026-08-20, as recorded in scripts/check-beta-readiness.mjs:1637-1638: "we are not using tailnet in the
    final product. the wx server should update supabase which in turn updates the app."
- The weather rules in reef-recycling-social/CLAUDE.md, verbatim: "Always pass `&models=`", "Name whichever models
  you actually used", and "Where models disagree, say so."
- 127-VISION §4.3 and Decision 7 (recommendation: the paid Open-Meteo customer API for the web, with model
  credits, UKMO marked CC BY-SA). Standing order: "your recommendations for all work requiring an answer".

## A correction to the brief, first

The brief says the 12-model tailnet server "stays phone-only for now (wxServer.ts hard gate)". In b127 there is
**no wxServer.ts and no client path to the wx server on any platform**: the 2026-08-20 ruling deleted it, and
check-beta-readiness.mjs:1635-1644 fails a build that brings back `services/weather/wxServer.ts`, a `WX_SERVER`
env key or the tailnet host. The wx server reaches every device only as point forecasts it publishes into
Supabase (`wx_point_forecasts`, services/weather/wxPublished.ts:1-14, read at api/openmeteo.ts:240-247). The
`VITE_WX_SERVER_*` types in src/components/vite-env.d.ts:62-66 are dev-only leftovers with no reader.

So the **wind field already comes from the commercial source the vision recommends, on every platform**: the
paid Open-Meteo customer API through the `proxy-openmeteo` edge function, which holds `OPEN_METEO_API_KEY`
server-side. Nothing new to license, no key handling to change, no new endpoint. This package is about the
desk: offering it, drawing it so it can be seen on Light, placing it beside the tracer, naming and crediting
the model, and saying when the models disagree.

## What the skipper sees (the desk planner, a window 768 px wide or more)

- **The desk menu (127-DESKMAP) gains "Wind"** under Seamarks: "Model forecast · ECMWF", OFF. One click turns it
  on; a reload turns it off again, as on Obs.
- **The wind streams over the light chart in dark ink**: slate below 20 kt, deep warning hues from the reef line
  up (amber-brown 20-25, red 25-30, rose 30-34, magenta 34-40, violet above). On Relief + Sat and Hybrid the
  streaks are white below 20 kt, exactly as on Obs today.
- **A wind panel at the bottom right**, clear of the tracer on the left: the Glass's five model chips (ICON,
  ECMWF, AIFS, UKMO, JMA), the time scrubber and the legend.
  - With a start time set on the trace, the scrubber opens at that hour and reads "At your 07:00 start" (the
    place's clock). A start beyond the forecast says "Your start is past this forecast" and opens at now.
  - Under the chips, one line in plain words, at the trace's first pin (or the middle of the map when nothing is
    pinned): "Models split here Saturday: strongest wind 12-28 kt across 5 of 7 models", with the agree / some /
    split glyph the Glass day cards use. Or "Models agree…", "Some spread…", "only 4 of 7 models", or "Model
    agreement not known here" when the comparison can't be had. Never a single number as fact when the models
    split.
- **The credit, in the strip under the menu**: "Wind: ECMWF (CC BY 4.0) via Open-Meteo"; picking UKMO makes it
  "Wind: UK Met Office (CC BY-SA 4.0) via Open-Meteo". The same pill now shows on Obs (phone and web) whenever
  wind is drawn: a credit the chart owes today.
- **Turning wind on never moves the map** and never blinks the seamarks.
- Obs's own layer choices still never appear on the desk, and the desk's wind never changes Obs's layers. The
  model chips are one choice for both (one WindStore), as today.

## Today (b127 719645bb7; every line below read)

**Where the wind comes from.**
- WindDataController.ts:1-13: "Global (online): Streams wind data from Open-Meteo commercial API for the current
  map viewport". WindStore defaults: `isGlobalMode: true`, `model: 'ecmwf'` (stores/WindStore.ts:50, :63).
- Non-GFS models: `fetchModelWindGrid` → `fetchOpenMeteoPoints(…, { hourly: 'wind_speed_10m,wind_direction_10m,
  wind_gusts_10m', models: model.openMeteoModel, timezone: 'UTC' })` (services/weather/OpenMeteoWindFetcher.ts:45,
  :100-110): the model is always named in `&models=`.
- The client boundary, services/weather/openMeteoProxy.ts:73-110: "Provider hosts, paths and credentials never
  enter the browser or the Pi." The edge: supabase/functions/proxy-openmeteo/index.ts:31-32 (customer hosts), :49
  (`OPEN_METEO_API_KEY`), :46 (`requireAuthenticatedOrPublicQuota(req, 'openmeteo', 1_200, 120, 3_600)`);
  validation.ts:157-169 (model allowlist, up to 8 per call).
- GFS only: NOAA's GRIB through `fetch-wind-grid` (windField.ts:194-235; fetchWindGrid.ts:96-106), public domain.
- tests/OpenMeteoSecretBoundary.test.ts:41-69 guards the boundary.

**How it draws.**
- MapboxVelocityOverlay: leaflet-velocity-ts in a headless Leaflet map in a div over the Mapbox canvas
  (`z-index:400`, `filter: PARTICLE_HALO`, MapboxVelocityOverlay.tsx:958). `createVelocityLayer` (:215) takes
  `colorScale: WIND_PARTICLE_COLORS` at creation. Halo `drop-shadow(0 0 0.75px rgba(0, 0, 0, 0.55))` (:154).
- `WIND_PARTICLE_COLORS`: white below `WIND_PARTICLE_WHITE_BELOW_KT = 20`, band hues above (windRamp.ts:117-121);
  bands `#ee7a0b` 20-25, `#e63020` 25-30, `#ee2b74` 30-34, `#cf35bd` 34-40, `#a24ef0` 40-48, `#6d28d9` 48+
  (:44-53). Close-in mode: CloseInWindLayer.ts:23, :201 via `windParticleColorForKt` (windRamp.ts:128).
- **Measured on Light** (scratch plan127-work/windcontrast.cjs, WCAG against Light's 2/5/10 m stops, deep stop,
  flat water and land): white 1.28-2.03:1; reef `#ee7a0b` 1.39-2.21:1; heavy `#e63020` 2.15-3.41:1. The streaks
  would vanish on the base 127-DESKMAP makes the desk default.

**The panel.**
- MapWeatherControls (lazy, mapHub/lazyOverlays.tsx:79-81) mounts when `weather.activeLayers.size > 0`
  (MapHub.tsx:5667-5679). Its box is placed by `.thalassa-chart-controls-panel` on the LEFT (index.css:4223-4240),
  where the tracer card (left-3, w-72, MapHub.tsx:4171-4216), the chart key and the detail scrubber already live.
- The wind sublabel is "Model forecast · <valid time>" (MapWeatherControls.tsx:339-388). The compact summary names
  the model (weatherControlSummary.ts:101-102). **No licence credit for the wind model appears anywhere on the
  chart**: the strip's pills are radar (MapWeatherControls.tsx:757-820), CMEMS (CmemsAttribution.tsx:74),
  lightning and the satellite cloud (SatelliteIrCredit.tsx), never wind.

**The planner.**
- `activeLayers = planMode ? EMPTY_LAYERS : userLayers` (useWeatherLayers.ts:385-386); `planMode =
  planningSurface` (MapHub.tsx:3213-3221). The overlay mounts only `!planningSurface` (:3855-3867).
- Layer framing reads `weather.userLayers` and is suppressed on planning surfaces (MapHub.tsx:3416).
- Width: `useDeviceMode()` is 'helm' at ≥ 768 px (hooks/useDeviceMode.ts:12-15; MapHub.tsx:2113).
- PlannerVesselLocator sits right-3, bottom 80 px, 48 px tall (PlannerVesselLocator.tsx:170-171).
- The trace's start time: `departureMs` (MapHub.tsx:417-421). `windFrameForForecastHour` (windTimeAxis.ts:81).

**Agreement machinery that already exists.**
- `queryModelSpread(lat, lon, { passive })`: 7 models, one proxy call per leg, memo per 0.1° cell for 30 min,
  in-flight dedupe, passive retry every 5 min (ModelSpreadService.ts:70-215).
- `windAgreementByDay`, `verdictAt`, `AGREEMENT_WORDS`, `AGREEMENT_GLYPH`, thin/members/peak (dayAgreement.ts:83-98,
  :155-190, :276-314).
- The Glass day-card chip runs exactly that chain (components/dashboard/HeroSlide.tsx:180-200, with
  `resolveTimeZone(lat, lon)`, utils/timezone.ts:35).
- `forecastDataCredit(providers, lead)` groups providers by licence; UK Met Office is CC BY-SA 4.0, NOAA public
  domain (services/weather/forecastModels.ts:200-240).

**Rotation.** Map rotation is off today (useMapInit.ts:424-430, :577). The Leaflet overlay mirrors centre and zoom
only. 127-11 (course up / north up, same build) will rotate the map; the field would then point the wrong way.

## Decision (our recommendation)

1. **Source: unchanged.** `proxy-openmeteo` (commercial customer API, key on the server) for the five models, NOAA
   GRIB for GFS. **No Cloudflare tunnel to the wx server** (the vision's "later" idea): it would undo the
   2026-08-20 ruling and trip check-beta-readiness. If Shane ever wants all 12 models as a web field, the route is
   the existing publishing contract (wx → Supabase), not a tunnel; nothing in 127.

2. **The desk Wind row.** One entry in 127-DESKMAP's `toggles`, after Seamarks: label "Wind", detail
   `Model forecast · ${label}` (the Glass label of the current model), OFF by default. State is
   `useState(false)` in MapHub: session-only, no storage (Shane 2026-09-05). Offered when `deskPlanner &&
   deviceMode === 'helm' && !pickerMode && !embedded && !isPinView`. Below 768 px the row is absent (a phone-sized
   window has no room beside the tracer; the desktop is what was asked).

3. **The planner's own layers.** useWeatherLayers gains a trailing `planLayers?: ReadonlySet<WeatherLayer>`;
   `activeLayers = planMode ? (planLayers ?? EMPTY_LAYERS) : userLayers`. MapHub passes a memoised `{'wind'}` while
   the desk wind is on, else the empty set. Consequences, all by construction:
   - every existing add/remove effect paints and tears wind down through its usual path;
   - `userLayers`, the persisted Obs selection, is never written, so Obs comes back exactly as left;
   - framing reads `userLayers`, so the camera never moves;
   - seamarks are untouched (127-DESKMAP B1 made useOpenSeaMapRasterHide the raster's only writer).

4. **The overlay on the desk.** Mount gate `!isPinView && !embedded && !pickerMode && (!planningSurface ||
   deskWindOn)`. On the desk `boatInstruments={false}` and `boatLookUp={false}`: planning is a forecast question,
   and her own wind stays an Obs feature.

5. **A streak palette for a light base.** windRamp exports `WIND_PARTICLE_COLORS_LIGHT`, same one-knot buckets:
   - below 20 kt `#1e2b38` (≥ 7.1:1 on every Light colour);
   - 20-25 `#984e07`, 25-30 `#ba271a`, 30-34 `#b72159`, 34-40 `#a62a97`, 40-48 `#823ec0`, 48+ `#6d28d9`: each band's
     own hue darkened until it reaches 3:1 against every Light water and land colour (scratch winddark.cjs;
     starting values, the tests own the bar);
   - halo `drop-shadow(0 0 0.75px rgba(255, 255, 255, 0.7))`;
   - `windParticleColorForKt(kt, palette = 'dark')` and a legend-gradient twin.
   MapboxVelocityOverlay and CloseInWindLayer take `palette: 'light' | 'dark'`; MapHub passes
   `shownBase === 'light' ? 'light' : 'dark'`. Because `colorScale` is a creation option (:215), a palette change
   recreates the Leaflet layer once; an unchanged palette never does. Obs and every dark base: unchanged.

6. **The panel on the desk, at the right.** MapWeatherControls gains `placement: 'chart' | 'desk'`. Desk adds
   `.thalassa-chart-controls-panel--desk` (and its pill twin) in index.css: `right: max(16px,
   env(safe-area-inset-right)); left: auto; bottom: calc(140px + env(safe-area-inset-bottom))` (above
   PlannerVesselLocator's 80 + 48 px), `width: min(380px, calc(100% - 324px))` so it never reaches the tracer's
   300 px column, `max-height` bounded under the strip's third slot. CSS, not JS.

7. **Wind at your start time.** When the desk wind turns on, or `departureMs` changes, and the start falls inside
   the grid's hours, the scrubber opens at `windFrameForForecastHour(...)` and the frame label reads "At your
   07:00 start" in the place's clock (`resolveTimeZone` at the first pin). Outside the grid it opens at now with
   "Your start is past this forecast". A hand scrub wins afterwards (the existing `windUserScrubbedRef`).

8. **Where the models disagree, say so.**
   - Extract HeroSlide's effect (HeroSlide.tsx:180-200) into `hooks/useWindAgreementAt.ts` (`lat, lon, ms,
     wanted`) and use it in both. Behaviour-identical for the Glass; the GlassDayAgreement tests guard it.
   - Point: the trace's first pin, else the map centre once the camera has been still for 1.5 s at zoom 5 or
     closer. Day: the one holding the scrubbed hour's valid time.
   - Words: `${AGREEMENT_WORDS[level]} here ${weekday}: strongest wind ${lo}-${hi} kt across ${members} of ${peak}
     models` with `AGREEMENT_GLYPH[level]`; a thin day says "only 4 of 7"; null (offline, unreachable, one model)
     says "Model agreement not known here".
   - Asked only while the desk panel is open, always `passive`, and not again after a 429 from the proxy until
     the panel is next opened, so the comparison can never starve the field's own requests.
   - **Desk only in 127** (`showAgreement` prop). The phone already has the Glass chip.

9. **The credit, on every surface where wind draws.** A strip pill (credits-strip classes, `data-map-credit`):
   `forecastDataCredit([provider], 'Wind') + ' via Open-Meteo'` for the five models; GFS from the NOAA GRIB reads
   "Wind: NOAA (public domain)". Desk: slot 2. Obs: after the radar and CMEMS pills (`satelliteCreditOffsetPx`
   gains `wind`). It stays during look-ahead, as every licence credit does (MapWeatherControls.tsx:118-120).
   This is a phone-visible addition; if it fails phone fit review, the desk keeps it and the Obs pill follows in
   128 (the credit is owed either way; say so in the merge note).

10. **Rotation: 127-11 owns it; a stopgap only if 127-11's 11a is not in b127 (critic pass 2).** 127-11 (A1, A2,
    decision 7) makes the Leaflet field and CloseInWindLayer turn TRUE with the chart (the div is rotated about the
    camera centre; the close-in flow re-aims on 'rotate'), and its own "What the skipper sees" promises "the wind
    streaks all turn together and stay true". So this package does NOT fade the field or rotate the close-in flow.
    Only if this package would ship in a build where the map can turn and 11a has not merged does it carry the
    stopgap: when `Math.abs(map.getBearing()) > 0.5` the Leaflet field fades to 0 and the frame line reads "Wind
    streaks show with North up". 11a deletes that stopgap and its test when it lands. In 127's planned order
    (lane 2 runs 127-11 after this package), the map cannot turn before 11a, so the stopgap is expected to be
    unnecessary: build it behind one constant and decide at 11a's merge.

11. **Never:** no new data source or endpoint; no key or provider host in the browser or the Pi; no wx-server
    path; no gust field; no blend (UKMO is shown as itself, credited CC BY-SA); no new storage of wind data
    (WindDataController's in-memory grid cache and windGridPersist are unchanged); no change to Obs's layer
    menus.

## Not in this build

- Wind on the planner below 768 px.
- Her own wind on the desk (Obs keeps it; the boat's cloud row on the planner is a 128 question).
- A desktop hover readout ("14 kt SE here at 15:00" under the cursor): 128, with a grid sampler test.
- The 12 models as a web field (see Decision 1).
- Gusts (Shane 2026-07-22).
- The agreement line on the phone's chart panel.

## Gates

- None. No edge change: `proxy-openmeteo` already accepts the five models and the hourly wind names, and
  `queryModelSpread` is live for the Glass. The web goes live with the master push (Shane). The iOS build carries
  the palette and the credit pill live (the rotation stopgap only if 127-11 11a is absent, decision 10), the desk parts inert (native is not a desk).
- Order: after 127-DESKMAP (needs `deskPlanner`, `toggles`, the strip's slots, the single seamark owner); with or
  before 127-11 (Decision 10).
- Watch, not a gate: desk sessions add viewport wind fetches on the paid plan. For the first week after the master
  push, Shane glances at the Open-Meteo dashboard's daily call count; WindDataController's cell memo and the
  world floor (WindDataController.ts:85-125) already keep a pan from re-downloading.

## Tests (failing first)

vitest `--maxWorkers=1`; Playwright `--workers=1`, a free port, Chromium and WebKit, wide fonts
(e2e/helpers/wideFonts.ts). All weather data fictional; no live proxy in CI.

**tests/windRamp.test.ts** (extended)
- `WIND_PARTICLE_COLORS_LIGHT` keeps WIND_COLORS' bucket edges (20, 25, 30, 34, 40, 48 kt).
- Every bucket's ink reaches ≥ 3:1 against every Light water and land colour, imported from reliefBase's LIGHT
  (no copied hexes); below 20 kt ≥ 7:1.
- Each warm bucket keeps its band's hue family (hue within ±15° of the band hex).
- `windParticleColorForKt(kt, 'light')` matches the palette at the bucket edges; `'dark'` is today's behaviour
  exactly; the light legend gradient is derived, hard stops, bottom-up.

**tests/MapboxVelocityOverlayLifecycle.test.tsx** (extended)
- `palette='light'` creates the layer with the light colour scale and the white halo; switching palette recreates
  it once; re-rendering with the same palette never recreates it.
- Only while the decision-10 stopgap constant is on: bearing 12° fades the field to 0 and sets the North-up note;
  bearing 0 restores it. (The true-rotation tests of the field and the close-in flow are 127-11's.)

**tests/useWeatherLayers plan layers** (new file beside the existing hook tests)
- `planMode` + `planLayers {wind}` → `activeLayers {wind}`; `planMode` + Obs `userLayers {rain, wind, sea}` + no
  plan layers → empty.
- Changing `planLayers` never writes the session layer key (sessionStorage spy) and never calls the frame snap.
- Turning plan wind on and off never writes `openseamap-permanent` visibility (spy).

**tests/MapBaseSelector.test.tsx / desk wiring**
- The Wind row appears on a web desk surface at 1024 and 768 px, not at 390, not in picker mode, embedded or pin
  view; OFF by default; a toggle never touches localStorage; Obs wind on leaves the desk row off.

**tests/MapWeatherControls.test.tsx** (extended)
- `placement='desk'` uses the desk class for the panel and the pill.
- The credit pill names the provider and licence per model: ECMWF and AIFS "ECMWF (CC BY 4.0) via Open-Meteo";
  UKMO "UK Met Office (CC BY-SA 4.0) via Open-Meteo"; JMA, ICON; GFS "NOAA (public domain)" with no "via". It
  stays during passage look-ahead.
- Start time inside the grid → "At your 07:00 start" at the right frame (a grid whose first hour is not on the
  hour, to catch the off-by-one); outside → "Your start is past this forecast"; a hand scrub is not overridden.
- The agreement line for agree, some, split, thin ("only 4 of 7") and null; `showAgreement` false renders none.
- After a 429 from the proxy the line stops asking until the panel reopens (fake timers).

**tests/GlassDayAgreement.test.tsx, tests/GlassDayAgreementSwipes.test.tsx, tests/dayAgreement.test.ts**: unchanged and green after the extraction to `useWindAgreementAt` (they drive the HeroSlide chip).

**tests/OpenMeteoSecretBoundary.test.ts**: unchanged and green (no host or key enters the client).

**Playwright: browser-tests/desk-wind-layout.spec.ts (new; added to playwright.keyboard.config.ts `testMatch`)**,
on 127-DESKMAP's e2e/fixtures/desk-map.tsx with a fictional `WindGrid` (12 kt SE everywhere, a 26 kt band through
the middle, 48 hourly frames) and a stubbed `proxy-openmeteo` for the 7-model comparison. At 1440x900, 1024x768
and 768x1024:
- Light: sampled streak pixels reach ≥ 3:1 against the base pixel beside them; pixels in the 26 kt band are in the
  red family. Relief + Sat: white streaks, as today.
- The panel's box intersects none of: the tracer card, the chart key, the detail scrubber, PlannerVesselLocator,
  the Mapbox ⓘ, logo and scale bar, the desk menu, the strip's three slots, the mic and status pair.
- Strip slot 2 reads the ECMWF credit; picking UKMO changes it to CC BY-SA.
- A trace with a start set 6 h ahead: the scrubber opens at +6 h with "At your … start".
- The Solent (England) with a fictional split (one model 12 kt, another 28 kt) reads "Models split here …"; a
  fictional Noumea point with seven models within 2 kt reads "Models agree here …"; the comparison answering 503
  reads "Model agreement not known here".
- Only with the decision-10 stopgap on: bearing 15° (map.setBearing in the fixture) hides the field and shows the note. With 127-11 11a merged, 127-11's chart-orientation.spec.ts owns the rotated-wind probes.

**Playwright: the real app planner** (127-DESKMAP's harness: plan-page-fit's way in, `ONBOARDED_STORAGE`, all tiles
synthetic, `proxy-openmeteo` stubbed with fictional JSON): turning Wind on leaves the camera's centre and zoom
unchanged and the seamarks visible; reload → Wind off; at 390x844 there is no Wind row.

**Playwright: Obs credit** (obs-layer-key-layout's harness, 320x568 and 390x844, wide fonts): with wind on, the
wind pill sits in the strip under the base picker and clears the zoom pill and the mic; with rain and wind on,
two pills, no overlap. Re-baseline any Obs case that turns wind on; never delete an assertion.

**Manual, not CI** (attach to the review): the live proxy on the desk at Airlie and the Solent; each of the five
models; the agreement line against the Glass chip for the same place and day; DevTools performance at 1440x900,
z6 and z10, frame time under 16 ms.

## Key files

- components/map/MapHub.tsx: the desk wind state and row, plan layers, overlay gate, `palette`, `placement`,
  `showAgreement`, the start-time hand-off.
- components/map/useWeatherLayers.ts: `planLayers`.
- components/map/windRamp.ts: the light palette, `windParticleColorForKt(kt, palette)`, the legend twin.
- components/map/MapboxVelocityOverlay.tsx, components/map/CloseInWindLayer.ts: `palette`, the halo, the bearing
  guard.
- components/map/MapWeatherControls.tsx: `placement`, the credit pill, the start-time label, the agreement line.
- components/map/creditsStrip.ts: the wind slot in the offset helper.
- hooks/useWindAgreementAt.ts (new) and components/dashboard/HeroSlide.tsx (the extraction).
- index.css: `.thalassa-chart-controls-panel--desk` and the pill twin.
- Read only: services/weather/{WindDataController,OpenMeteoWindFetcher,openMeteoProxy,ModelSpreadService,
  dayAgreement,forecastModels,MultiModelWeatherService}.ts, stores/WindStore.ts, windTimeAxis.ts,
  supabase/functions/proxy-openmeteo/*.
- Tests above.

## JS estimate

About **+2.1 KB** minified (≈ +0.8 KB gz). Budget 2.5 KB. No new dependency; most of it lands in the lazy
MapWeatherControls chunk (the tripwire counts lazy chunks too, so it is in the total).

| Item | Size |
| --- | --- |
| `planLayers` in useWeatherLayers | 0.1 KB |
| Desk wind state, row entry, overlay gate, props | 0.35 KB |
| Light streak palette, `palette` prop and recreate, halo, legend twin | 0.45 KB |
| Bearing stopgap (likely 0: dropped if 127-11 11a merges first, decision 10) | 0-0.2 KB |
| Desk placement prop | 0.05 KB |
| Credit pill (all surfaces) and slot | 0.25 KB |
| Start-time hand-off and label | 0.2 KB |
| Agreement line (the hook is moved from HeroSlide, not copied) | 0.5 KB |

## Sceptic pass

1. **"Use the paid customer API" was already done.** The value here is the desk, not the plumbing; the plan says
   so instead of re-plumbing.
2. **"The wx server stays phone-only" was stale**: it reaches no client. A tunnel would break a standing ruling.
3. **White streaks on a light base are invisible (1.3-2.0:1).** Without Decision 5, "wind on the desk" would ship
   as an empty map on the default base.
4. **The panel's home is the tracer's column.** Moved right, above the locator, with a width that cannot reach the
   tracer.
5. **Re-enabling weather on the planner the obvious way (drop planMode) would bring back every Obs layer**, the
   exact 2026-07-23 complaint. Plan layers are the planner's own, and the Obs selection is never written.
6. **A second writer would have blinked the seamarks**; 127-DESKMAP B1 removes it, and a test holds it.
7. **"Where models disagree, say so" for a field of one model.** The chips let him see each model; the one line
   says whether they agree at the place he is planning, using the same thresholds as the Glass, so the two can
   never contradict each other.
8. **The comparison could eat the proxy quota** (1,200 an hour signed in, 120 signed out). Passive, open-panel
   only, cell-memoised, and silent after a 429.
9. **127-11 will rotate the map under a field that could not rotate.** 127-11 11a makes it rotate true; this package carries only a stopgap, behind a constant, for a build without 11a (decision 10, critic pass 2).
10. **The credit pill is a phone change.** It is owed today; it is separable if phone fit review objects.
