# Build 108 — OBS defaults and readable wind-versus-tide details

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
- Wind-versus-tide keeps the existing Glass card dimensions. Its details now
  scroll inside the card, with the back button pinned outside the scroller and
  a hint when more content is available. All four +3/+6/+9/+12-hour relationships
  and flood-direction controls are reachable without moving the model strip.
- Ordinary taps on the detail text no longer close it. Flood controls keep real
  44px tap targets even on the narrow-phone font scale. Keyboard opening moves
  focus into the active card's details; keyboard closing restores graph focus.
  Arrow keys do not escape into the day/hour carousels. Pointer opening does not
  move focus. Tide/wind arithmetic and flood-direction semantics are unchanged.

## Verified local candidate — 9 September 2026

- Compiled source: `8e8d233e549f91fd8b5caab9dd2207c58c02f8b0`.
- Version: **1.2.0 (108)**. All four native target/configuration counters are 108.
- Build command: `VITE_APP_BUILD=108 npm run ship:beta` on the supported Node 24
  runtime with the pinned Ruby/Bundler toolchain.
- Main entry: `main-vznoxXiw.js`, SHA-256
  `022aea8a488d9f87009f4ec8910b2348a6685fb926195142a878e35c95e1bd8c`.
  The dist and iOS embedded main files have matching hashes.
- TypeScript, production build, local deep-route/asset verification, route audit,
  bundle budgets, client-secret scans and Capacitor iOS sync passed (19 plugins).
  All **140** embedded-artifact release contracts passed.
- Bundle: **13.30 MB**, JavaScript **9.84 MB**, within the unchanged budgets.
- **80 focused unit tests** passed in this follow-up, covering actual HeroSlide
  open/close/focus behaviour, detail readouts and controls, keyboard isolation,
  Glass dimensions, unchanged wind/tide calculations, daylight surfaces and OBS
  mode/override behaviour. The earlier OBS-only candidate also passed 61 focused
  tests; its evidence is retained in this file's history. Targeted ESLint and
  formatting passed.
- **22/22 source-level browser tests** passed in Chromium and WebKit, covering
  150–197px-high cards at 320px/430px phone and 1024px split-pane viewport widths
  in day/dark/night modes. They measure complete outlook/control bounds, stable
  card/model-strip geometry, pinned close, keyboard focus/scrolling and desktop
  wheel containment. Mobile WebKit was also visually inspected. These browser
  checks do not substitute for testing a physical iPhone's touch gestures.
- **16/16 production browser tests** passed in Chromium and mobile WebKit against
  this rebuilt bundle. They exercise the dashboard, theme roots, real map host,
  light/dark/night defaults, manual base selection, and leaving/reopening OBS
  without losing that choice. These are browser checks, not a physical iPhone
  or live yacht navigation test.
- Current logs: `/private/tmp/thalassa-wind-tide108.aGI0tS/ship-beta.log`,
  `focused-tests.log`, `wind-tide-layout.log` and `production-e2e.log` in that
  same directory. The initial OBS-only candidate was not uploaded and is
  superseded by this rebuild.

This is a built and synced local candidate, **not an archived, Apple-validated or
uploaded TestFlight release**. The full application test suite and remote CI were
not rerun to completion during this narrow change; run the release-wide checks
before submitting 108. The uploaded 107 archive and IPA were not rebuilt or
modified. Later evidence-only commits do not change the compiled source above.
