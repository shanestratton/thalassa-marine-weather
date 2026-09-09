# Build 108 — OBS defaults, layout polish and public mobile views

## Behaviour

- The main OBS map defaults to **Ocean** in daylight and **Satellite** in dark
  and night mode. It consumes App's resolved display mode, so Auto uses the same
  daylight decision as the rest of the app, without a second clock or sun rule.
- The existing Hybrid / Satellite / Ocean selector remains available. Explicit
  choices are remembered independently for day and non-day mode during this map
  session. Ordinary rerenders, weather updates and leaving/reopening OBS do not
  replace a user's choice. A newly mounted map starts with the mode's default.
- Separate embedded/planning map instances retain their previous Satellite
  default. The existing OBS map stays mounted; there is no `setStyle` reload.
- Only the raster background selection changes. ENC safety layers, depth
  treatment, navigation marks, routes and warning rules are unchanged.
- Wind-versus-tide keeps the existing Glass card dimensions and no longer
  scrolls. The +3/+6/+9/+12-hour outlook is removed; the selected time's full
  verdict, wind/stream readings, direction-source label and flood controls all
  fit in place. There is no scroll hint or change to the model strip's position.
- Ordinary taps on the detail text no longer close it. Flood controls keep real
  44px tap targets even on the narrow-phone font scale. Keyboard opening moves
  focus into the active card's details; keyboard closing restores graph focus.
  Navigation keys do not scroll an ancestor or escape into the day/hour carousels;
  Tab and normal button activation are preserved. Pointer opening does not move
  focus. Current tide/wind arithmetic and flood-direction semantics are unchanged.
- The top Route Planner comfort card is temporarily hidden in standalone and
  embedded planners, with no empty wrapper gap. Saved comfort parameters and
  their routing effects are unchanged, as are trip, departure and route controls.
  Restore `SHOW_PLANNER_COMFORT_CARD` in `components/RoutePlanner.tsx` to bring
  back the existing controlled accordion.
- The Departure card has one full-width **Now** button and no **OK** button.
  Now remains visible and enabled after a reset or repeated presses. Date/time
  edits still apply immediately; Now keeps the existing picker-dismissal,
  account-scoped reset and identity-tagged event behaviour.
- The Vessel page's Diary/Scuttlebutt row has a native proximity snap point at
  its original top inset. The lower Settings group has an end target so Safari
  can reach its controls without pulling every scroll back to the top. Existing
  page dimensions, tuck-under scrolling and the separate fixed safety deck are
  unchanged; no mandatory snapping, touch interception or extra spacer is added.
- The public voyage page opens on the **Map** on phones and small tablets,
  with persistent **Map / Instruments / Diary** navigation. Each panel has its
  own reachable scroll area; instruments and diary remain mutually exclusive.
  Desktop retains the simultaneous map and folding side panel at 1024px+.
- The public header and voyage selector are compact. The mobile progress strip
  shows destination and distance remaining on the map, without crowding diary
  or instruments. **Expand map** hides the header while retaining navigation;
  short landscape phones start expanded and can restore the header/selector.
- Map camera, basemap and canvas survive view changes. Destination markers are
  compact on phones; diary pins and zoom controls have 44px touch targets.
  Keyboard pin activation moves focus into its now-visible diary entry.
  Existing reef imagery, attribution, consent and freshness rules are unchanged.
- Public-page typography no longer inherits the native app's fluid root scale.
  Phone safe areas and dynamic viewport height are respected. The fast public
  instrument poll pauses while its panel is off-screen; historical voyages
  still cannot display present-tense instruments.
- Settings → Voyage Log no longer has a **Public tracks** section. The
  per-voyage visibility switches, manual passage picker and its replacement
  dialog are removed, together with their now-unused state and loading calls.
  The main **Public Voyage Log** opt-in/out switch remains. Existing hidden
  voyages are not made public, no logs or privacy settings are deleted, and
  automatic passage links and separate instrument consent are unchanged.

## Verified local candidate — 9 September 2026

- Compiled source: `6d85014915462d2bf9b2a328b39500d7858d432f`.
- Version: **1.2.0 (108)**. All four native target/configuration counters are 108.
- Build command: `VITE_APP_BUILD=108 npm run ship:beta` on the supported Node 24
  runtime with the pinned Ruby/Bundler toolchain.
- Main entry: `main-B1iG77Vx.js`, SHA-256
  `ece9abff33229ee7faee5df29186dd568ddfeedee9f8665ef0aaf0e12dc12d78`.
  The dist and iOS embedded main files have matching hashes.
- TypeScript, production build, local deep-route/asset verification, route audit,
  bundle budgets, client-secret scans and Capacitor iOS sync passed (19 plugins).
  All **140** embedded-artifact release contracts passed.
- Bundle: **13.30 MB**, JavaScript **9.83 MB**, within the unchanged budgets.
  Public entry: `logs-ukiRNjW9.js`.
- **125 focused unit tests across 12 files** passed for the Public tracks
  removal: absence/no retired reads or writes, confirmed opt-in/out and failed
  saves, retained instrument/AIS/live-track choices, account-switch races,
  backend exclusions, published-diary privacy, automatic passage linking,
  author stamps, durable retries and live-trickle consent. Targeted lint and
  formatting passed; the build's TypeScript check passed.
- **22/22 compiled-build browser smoke checks** passed in Chromium and mobile
  WebKit: app startup/navigation/theme roots and the 16 public mobile/desktop
  cases. These are targeted checks, not a rerun of the full application suite;
  the separately recorded OBS banner/navigation issue below remains open.
- The preceding public-mobile revision passed **161 unit tests across 20 files**, including mobile
  navigation, keyboard marker focus, map persistence, historical restrictions,
  consent revocation, fast-feed activation/abort, stale data and host routing.
  Targeted ESLint, formatting and the build's TypeScript check passed.
- That revision passed **16/16 source browser tests** in Chromium and WebKit at 320×568,
  390×844, 430×932, 740×360, 844×390, 768×1024 and desktop 1280×900.
  They verify compact phone headers, expansion/restoration, 44px controls,
  no document overflow, long diary/detail scrolling, persistent bottom tabs,
  retained map canvas/basemap, keyboard marker focus and historical privacy.
  Screenshots were visually inspected. Local API/Mapbox-style fixtures are
  used without external writes; this does not revalidate live reef imagery
  or replace a physical iPhone check.
- Its first broader production run passed 51/52, with a WebKit native-wheel
  test racing card entrance/scroll settling. A test-only follow-up waits for
  entrance animations and a stable down-scroll before computing its reverse
  delta; the original home-position assertions are unchanged. Six isolated
  repeats passed across Chromium/WebKit. No Vessel app code or compiled
  runtime artifact changed during that correction.
- Its final compiled-build batch passed **51/52**: all **16 public mobile
  scenarios** passed, as did the corrected Vessel wheel test. The remaining
  failure is WebKit's OBS night-mode revisit: the existing **No verified ENC
  charts installed** banner intercepts the bottom **The Glass** tab click
  (`e2e/weather-map.spec.ts:65`, `components/map/ChartDepthControls.tsx:221`).
  No forced click, skipped test or suppressed warning was used. This separate
  native-app layout issue remains open and must be resolved before claiming
  a completely green release-wide browser batch for 108.
- The preceding static tide-card revision passed **74 focused unit tests**, covering
  current readouts, missing data, controlled flood-direction adjustments,
  open/close/focus behaviour, keyboard isolation, unchanged wind/tide engines
  and Glass layout/forecast contracts. Targeted lint and formatting passed.
- That revision passed **32/32 source-level browser tests** in Chromium and WebKit for the
  static card: day/dark/night at 320px, 430px and 1024px split-pane widths,
  150–197px card heights, full long warning/unavailable verdicts, 12/14/16px
  minimum label/reading/verdict fonts, 44px controls, Auto and 345° wraparound.
  They measure zero content overflow and unchanged card/model-strip geometry,
  including after adjustments. Keyboard activation and traversal are covered
  (macOS WebKit uses Option+Tab for all controls). Mobile WebKit previews were
  visually inspected; a physical iPhone has not been tested.
- That revision passed **36/36 production browser tests** against its rebuilt bundle in
  Chromium and mobile WebKit. They include the actual 390×844 Glass page with
  cached coastal tides: all current text and controls fit, no inner scrolling
  or hidden clipping remains, flood/Auto and close work, and the card does not
  resize. The other 34 cases recheck Vessel scrolling, the planner and OBS.
- The preceding Vessel revision passed **38 focused unit tests**, covering scroll
  targets, layout ordering, fixed safety controls, anchor/underway presentation,
  passage-planning placement and Skipper-device identity/GPS/Pi behaviour.
  Targeted ESLint, formatting and the build's TypeScript check passed.
- That Vessel revision passed **14/14 source-level browser tests** in Chromium and WebKit. The real
  app is exercised at 390×650, 390×844, 430×932 and 768×768, plus daylight/night
  phone cases. Checks measure complete return-to-home geometry, unchanged safety
  deck position and reachable expanded Settings controls, with native desktop
  wheel gestures in both engines. Mobile WebKit's geometry is tested, not a
  physical iPhone's touch momentum.
- That Vessel revision passed **34/34 production browser tests** in
  Chromium and mobile WebKit: the same 14 Vessel cases, plus the 20 dashboard,
  route-planner and OBS regressions described below. The desktop-wheel case
  deliberately disables mobile emulation because mobile WebKit has no wheel API.
- The preceding departure revision passed **25 focused unit tests**, covering the
  persistent Now action, immediate edits, account-scoped resets/events, remount,
  route-planner interactions, departure-window identity and timezone handling.
  Targeted ESLint and formatting passed; the build's TypeScript check passed.
- The preceding planner revision passed **72 focused unit tests**, including both
  standalone and embedded planner interactions, unchanged saved comfort limits,
  the comfort engine, isochrone routing and prior audit regressions. Targeted
  ESLint and formatting passed; the build's TypeScript check passed.
- The earlier scrolling wind/tide revision passed **80 focused unit tests**, covering
  actual HeroSlide
  open/close/focus behaviour, detail readouts and controls, keyboard isolation,
  Glass dimensions, unchanged wind/tide calculations, daylight surfaces and OBS
  mode/override behaviour. The earlier OBS-only candidate also passed 61 focused
  tests; its evidence is retained in this file's history. Targeted ESLint and
  formatting passed.
- That wind/tide revision also passed **22/22 source-level browser tests** in
  Chromium and WebKit, covering
  150–197px-high cards at 320px/430px phone and 1024px split-pane viewport widths
  in day/dark/night modes. They measure complete outlook/control bounds, stable
  card/model-strip geometry, pinned close, keyboard focus/scrolling and desktop
  wheel containment. Mobile WebKit was also visually inspected. These browser
  checks do not substitute for testing a physical iPhone's touch gestures.
  That scrolling design is superseded by the current-only face above.
- The preceding departure revision passed **20/20 production browser tests** in
  Chromium and mobile WebKit. They verify that the planner's comfort card is absent
  while its departure, route and header-menu controls remain available. Now
  remains enabled and the same size after repeated resets, with OK absent.
  They also exercise the dashboard, theme roots, real map host, light/dark/night defaults,
  manual base selection, and leaving/reopening OBS without losing that choice.
  These are browser checks, not a physical iPhone or live yacht navigation test.
- Current logs: `/private/tmp/thalassa-public-tracks108.zhlMPE/ship-beta.log`,
  `focused-tests.log` and `production-e2e.log` in that same directory.
  Public-mobile revision evidence remains in `/private/tmp/thalassa-public-mobile108.jVM2Z5/`.
  Static-tide revision evidence remains in `/private/tmp/thalassa-tide-static108.emZsOk/`.
  Vessel-scroll revision evidence remains in `/private/tmp/thalassa-vessel-snap108.DlzhSD/`.
  Departure-button revision evidence remains in `/private/tmp/thalassa-departure108.pPH0pA/`.
  Planner-card revision evidence remains in `/private/tmp/thalassa-comfort108.We11Wh/`.
  Wind/tide revision evidence remains in `/private/tmp/thalassa-wind-tide108.aGI0tS/`.
  The earlier local 108 candidates were not uploaded and are superseded by this
  rebuild.

This is a built and synced local candidate, **not an archived, Apple-validated or
uploaded TestFlight release**. The full application test suite and remote CI were
not rerun to completion during this narrow change; run the release-wide checks
before submitting 108, including the OBS banner/navigation issue above. The
uploaded 107 archive and IPA were not rebuilt or
modified. Later evidence-only commits do not change the compiled source above.
This record verifies local artifacts; it does not certify a live production
website deployment.
