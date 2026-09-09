# Build 108 — OBS display-mode defaults

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

## Verified local candidate — 9 September 2026

- Compiled source: `8e4d34b3c709a1aae883d211a88459041b5f5443`.
- Version: **1.2.0 (108)**. All four native target/configuration counters are 108.
- Build command: `VITE_APP_BUILD=108 npm run ship:beta` on the supported Node 24
  runtime with the pinned Ruby/Bundler toolchain.
- Main entry: `main-DmwrtnTr.js`, SHA-256
  `5944118f01b76c8bb7d378246426cf407ca5864283bae70a2890b78b7fa8492e`.
  The dist and iOS embedded main files have matching hashes.
- TypeScript, production build, local deep-route/asset verification, route audit,
  bundle budgets, client-secret scans and Capacitor iOS sync passed (19 plugins).
  All **140** embedded-artifact release contracts passed.
- Bundle: **13.30 MB**, JavaScript **9.84 MB**, within the unchanged budgets.
- **61 focused unit tests** passed, including the new mode/override tests and
  existing map selector, ENC master switch, imagery ordering, planning-surface,
  attribution and hook dependency coverage. Targeted ESLint has no errors; the
  three existing MapHub warnings remain. Formatting passed.
- **10/10 production browser tests** passed in Chromium and mobile WebKit. They
  exercise the real map host, light/dark/night defaults, manual base selection,
  and leaving/reopening OBS without losing that choice. These are browser checks,
  not a physical iPhone or live yacht navigation test.
- Logs: `/private/tmp/thalassa-build108.1Gzw8Z/ship-beta.log` and
  `/private/tmp/thalassa-build108.1Gzw8Z/weather-map-e2e.log`.

This is a built and synced local candidate, **not an archived, Apple-validated or
uploaded TestFlight release**. The full application test suite and remote CI were
not rerun to completion during this narrow change; run the release-wide checks
before submitting 108. The uploaded 107 archive and IPA were not rebuilt or
modified. Later evidence-only commits do not change the compiled source above.
