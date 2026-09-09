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
- The empty-coverage warning now occupies the usable OBS map area rather than
  the full-bleed map's bottom edge. Short landscape and short split panes leave
  room for Back, MOB, Locate, map credits and the live-tide badge. Its coverage
  conditions, wording and working 44px ENC Library action remain unchanged.
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
- Diary deletion retains uploaded video references when reading its durable
  delete queue, preserves references across repeated deletes, and checkpoints
  cold-cache media before the cloud row disappears. Offline operation ids are
  cancelled through the relay protocol, not sent as invalid UUID row deletes.
  Failed reads/cleanup keep the deletion queued. Shared media is preserved,
  including references on older paginated diary entries; cloud usage refreshes
  after confirmed cleanup and has a manual Refresh control with account fencing.
- The Pi source now retires cancelled synced diary payloads/counts while keeping
  the owner-bound anti-resurrection tombstone. Cancelled video handoffs are
  rejected before and after async creation. This Pi change has not been
  installed on the yacht by this task.
- Diary compose now places the writing box before both **Add video** and the
  selected video preview, for new and edited entries. Attaching a video no
  longer pushes the text field down. The editor keeps a real minimum height,
  and keyboard resize follows the focused field rather than the scroll area's
  tail. Video selection, upload, saving and deletion are unchanged.

## Verified local candidate — 9 September 2026

- Compiled source: `4023fd56a6afdd662f1c3e4232d2264b6bcc9f7f`.
- Version: **1.2.0 (108)**. All four native target/configuration counters are 108.
- Build command: `VITE_APP_BUILD=108 npm run ship:beta` on the supported Node 24
  runtime with the pinned Ruby/Bundler toolchain.
- Main entry: `main-D2XSKEDT.js`, SHA-256
  `698236be9e793782dd6eef7938f3e92c4279c65a5d1d61569ea22a8e2f04827a`.
  The dist and iOS embedded main files have matching hashes.
- TypeScript, production build, local deep-route/asset verification, route audit,
  bundle budgets, client-secret scans and Capacitor iOS sync passed (19 plugins).
  All **140** embedded-artifact release contracts passed.
- Bundle: **13.30 MB**, JavaScript **9.83 MB**, within the unchanged budgets.
  Public entry: `logs-BssyXQOr.js`, SHA-256
  `95751156f02783e24e39276da5456d60170b12686af5f33c835090d9b08960c2`;
  its dist and iOS copies also match.
- **74 focused unit tests across 8 files** passed for the diary compose layout,
  media ownership, workflow, video rail and keyboard/focus regressions. New and
  edited entry tests verify content ordering and retained title/body after a
  video is attached or removed. Targeted ESLint and formatting passed.
- **34/34 source browser checks** passed in Chromium and WebKit: 8 new diary
  cases and 26 existing keyboard cases. Diary cases cover 320×568, 390×650,
  390×844 and a 512px-wide tablet pane. They verify unchanged editor position
  on attachment, no preview overlap, removal, preserved content, and full
  focused-field visibility above the footer during two keyboard heights.
  Hit-testing confirms the editor is not covered. WebKit screenshots were
  visually checked. The fixture uses the real form and keyboard guard with a
  modeled keyboard; this is not a physical iPhone test or a media-upload test.
- The preceding deletion candidate passed **200 focused app tests across 26 files**,
  **23 Pi tests**, and **7 Deno cleanup tests**. They cover video tombstone
  persistence, cold-cache recovery, repeat deletes, offline-id cancellation,
  failed reads/Storage/checkpoints, shared/foreign media, exact operation
  acknowledgements, identity changes, stale delivery and actual usage refresh.
  App/Pi/Edge typechecks and migration audit passed. Targeted lint had no
  errors (one existing unused `CapacitorHttp` import warning in relay transport).
- The preceding candidate passed **125 focused unit tests across 12 files** for the Public tracks
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
- Current logs: `/private/tmp/thalassa-diary-compose108.8INFLw/ship-beta.log`,
  `focused-tests.log` and `production-e2e.log`; source-browser screenshots
  are under `browser-results/` in that same directory.
  Diary-deletion revision evidence remains in `/private/tmp/thalassa-diary-delete108.zwafki/`:
  `diary-tests.log`, `pi-tests.log`, `edge-tests.log`, `typecheck.log`,
  `edge-typecheck.log`, `ship-beta.log` and `production-e2e.log`.
  Public-tracks revision evidence remains in `/private/tmp/thalassa-public-tracks108.zhlMPE/`.
  Public-mobile revision evidence remains in `/private/tmp/thalassa-public-mobile108.jVM2Z5/`.
  Static-tide revision evidence remains in `/private/tmp/thalassa-tide-static108.emZsOk/`.
  Vessel-scroll revision evidence remains in `/private/tmp/thalassa-vessel-snap108.DlzhSD/`.
  Departure-button revision evidence remains in `/private/tmp/thalassa-departure108.pPH0pA/`.
  Planner-card revision evidence remains in `/private/tmp/thalassa-comfort108.We11Wh/`.
  Wind/tide revision evidence remains in `/private/tmp/thalassa-wind-tide108.aGI0tS/`.
  The earlier local 108 candidates were not uploaded and are superseded by this
  rebuild.

## Diary cleanup server deployment — 9 September 2026

- Project: `pcisdplnodrphauixcau` (Thalassa Marine Forecasting). Applied only
  migration `20260909110000_diary_deletion_media_cleanup`, recording its exact
  SQL in migration history. No unrelated pending migrations were pushed.
- The cancellation RPC captures photo/audio/video refs atomically on the
  owner/operation tombstone before deleting its row. The Edge removes exact
  owned Storage objects, preserves shared refs and checkpoints only verified
  removal; failed cleanup remains retryable rather than returning false success.
- Executed the full migration and synthetic private fixtures in a rollback-only
  transaction first. Checks passed for capture, row deletion, retries, normalized
  shared refs, checkpoint idempotence, invalid owner paths and service-only grants.
  No real customer records or Storage objects were deleted during testing.
- Downloaded the prior deployed function to
  `/private/tmp/thalassa-diary-live-backup.DHaAx3/`; its entry and shared helpers
  matched HEAD before editing. Deployed only **diary-relay**, now **ACTIVE v15**,
  bundle SHA-256 `9d2fdf342c8d28ecea6ff909033cb101a7b5b1e9c4a4250618c28bb414441177`.
- Post-deploy checks confirm migration history, tombstone RLS, service-only
  cancellation/checkpoint privileges, zero unfinished rollout manifests, and
  HTTP **401** for an unauthenticated cancellation request. Logs and rollback
  test SQL are in `/private/tmp/thalassa-diary-delete108.zwafki/`.
- Existing orphan files were **not** bulk-deleted. An already-issued upload
  finishing after cancellation, or a concurrent new entry attaching the same
  file between reference check and removal, still needs an upload/reference
  fencing design; these changes do not claim to eliminate those races.
- Pi source fixes are tested but **not deployed to the yacht**. Anti-resurrection
  tombstone counts are intentionally cumulative; those rows are deletion
  metadata, not retained diary bodies. Cloud storage counts measure actual files.

## Native delivery attempt — 9 September 2026, upload held

Shane requested uploading 108 to TestFlight. **No TestFlight upload was made**:
the final release-wide browser check reproduced the OBS banner/navigation
blocker. The signed archive and distribution IPA are preserved for evidence,
not approved for submission. Build 107 remains untouched.

- Runtime source remains `4023fd56a6afdd662f1c3e4232d2264b6bcc9f7f`;
  archive-time HEAD was `522dd89d182eeca311cf972caa957c14aaafa847`, differing
  only in this release document. No app code or compiled bundle changed during
  the delivery checks. The later scroll-test adjustment below is test-only.
- Fresh pre-archive verification passed **140 artifact contracts**. Full Node
  **24.19.0** unit suite passed: **9,626 tests**, **3 expected failures** and
  **5 skips**; **1,092 files passed**, **4 skipped** (377.24 seconds).
  Full lint passed with 0 errors and 61 existing warnings, all **162 migration
  checks** passed, and full formatting passed.
- No full GitHub CI run exists for the exact runtime source or archive-time
  HEAD. This branch is outside the CI push filter; the recorded HEAD status
  also had a failed Vercel deployment and skipped hosted smoke checks. Local
  checks do not certify a hosted deployment or exact-source CI success.
- The first concurrent browser run was stopped after 43 passes, 3 failures
  and 1 interruption, with 81 cases not run. The quieter complete rerun passed
  **120**, skipped **7**, and failed the Chromium 430px Vessel expanded-settings
  return-to-home check (14px remained instead of at most 1px).
- Three unchanged isolated Vessel tests and three geometry probes passed.
  Expanded scroll range measured 118px, not 14px; one probe showed automatic
  scrolling still moving after the test's CSS-animation wait. The exact cause
  of the earlier 14px failure was not established. The test now awaits fonts
  and four stable 100ms scroll intervals, covering SectionHeader's separate
  280ms delayed smooth scroll. Both 24px inputs and all exact-home, tile,
  reachability and fixed-safety-deck assertions remain unchanged. No forced
  input, hidden warning or app change was used.
- The final full browser run passed **120**, skipped the **7 existing
  conditional cases**, and failed **1**: mobile Safari, OBS **dark** revisit,
  `e2e/weather-map.spec.ts:65`. All Vessel cases passed. The Glass tab is visible
  and enabled, but the `aria-live` **No verified ENC charts installed** banner
  (`components/map/ChartDepthControls.tsx:221`) intercepts its click throughout
  the timeout. This reproduces the earlier OBS blocker in another display
  mode; isolated passes do not clear it. **Fix/rebuild/revalidate before upload,
  or obtain an explicit decision to accept the known defect for internal use.**
- Archive completed **17:25:23 AEST**, Xcode **26.6 (17F113)**:
  `/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-09/Thalassa-1.2.0-108-4023fd56.xcarchive`.
  Verified **1.2.0 (108)**, `com.thalassa.weather`, iOS 17 minimum, **419 public
  files** identical to the synced app, both entry hashes recorded above,
  **23 matching binary/dSYM pairs**, no source maps or embedded Watch/PlugIns,
  and strict/deep signature validation with macOS certificate-trust access.
- Apple validation passed **17:29:10 AEST** (`Validated App / EXPORT SUCCEEDED`).
  Distribution export passed **17:30:18 AEST**. Automatic version/build
  management remained disabled; validation is not a TestFlight upload.
- IPA: `/Users/shanestratton/Documents/Temporary Projects/Thalassa Releases/1.2.0-108-4023fd56/Thalassa Marine Weather.ipa`;
  SHA-256 `358d829c0816c2f715c9e128d709e9b6111e838267fba1075f6873b1e7d3c4c0`.
  The exported app passed the same file/dSYM checks and strict/deep signature
  validation. Entitlements include `get-task-allow=false`, APNs `production`,
  `beta-reports-active=true`, and the expected application identifier.
- Delivery evidence: `/private/tmp/thalassa-upload108.VcR5Zy/`, including
  `full-unit.log`, `lint.log`, `format.log`, `full-production-e2e.log`,
  `full-production-final.log`, `vessel430-probe.log`,
  `full-production-settled.log`, `archive.log`, `archive-verification.json`,
  `validation.log`, `export.log`, `export-verification.json` and signatures.
  The final failure screenshot and trace context are in
  `production-settled-results/weather-map-OBS-dark-displ-96b34-oice-when-revisiting-Charts-mobile-safari/`.

No tester-group, public-link, yacht or production-service settings were changed.
The existing Pi deployment and media-upload-race caveats above remain open.
