# Build 109 — Glass split-screen gestures

The gestures below remain included. The newer weather-location fixes and latest
build 109 artifact are recorded in [BUILD_109_WEATHER_LOCATIONS.md](BUILD_109_WEATHER_LOCATIONS.md).

Runtime source: `86d09a88`. This follows the unreleased build 109 Sail Plan and
Scuttlebutt fixes; it does not upload or distribute a TestFlight build.

- Long-press The Glass to turn dual screen on; long-press again to turn it off.
  The existing 500ms threshold, width gate and remembered preference are retained.
- A short press while dual screen is visible resets the pinned Glass to live/now
  without navigating or replacing its neighbour and without clearing the split
  preference. It uses the existing `hero-reset-scroll` action, not a new weather
  network request.
- Outside dual screen, the first short press navigates to Glass, and a subsequent
  press performs the normal reset. Releasing a long press does not also do the
  short-press action. Turning dual screen off leaves the existing right-hand page
  full width, as the prior long-press toggle already did.
- No layout, chart-instance, GPS-source, connection-status or backend changes.

Verification: 49 focused unit tests passed, including repeated holds, short taps,
cancel/move/leave, phone-width behavior, pinned-pane reset and ordinary navigation.
TypeScript and changed-file ESLint passed without errors or warnings.

**8/8 packaged-app executions passed** (45.8 seconds), both Chromium and mobile
WebKit, each repeated twice with zero retries/skips. These exercise real pointer
holds and their browser-generated release clicks on the immutable built bundle,
plus tablet short taps and ordinary phone navigation. See `positive.log`.

The prior production bundle reproduced the short-press regression: enabling
dual screen worked, then tapping Glass produced no reset event and collapsed
the layout. See `shortpress-negative.log` in the evidence directory. The new
packaged-app test also checks persistence, the unchanged neighbouring page and
suppression of release clicks, with external network traffic and device GPS
disabled in its isolated browser context.

Evidence directory: `/private/tmp/thalassa-glass-nav.LeHek2/`.

## Latest build 109 artifact

`VITE_APP_BUILD=109 npm run ship:beta` completed: production build, local release
verification, route/bundle/client-secret gates, iOS sync with 19 plugins, and
140 release contracts. All four Xcode counters remain 109. Build 108 is untouched;
there has been no archive, Apple validation/upload or TestFlight distribution.

- Main entry: `main-DJuwhH8P.js`, SHA-256
  `26bf95fb6dcf1aa148a2bde92d4237570c6aa98c6197ba7485c8af00fec67131`.
- Instrument page: `TheGlassPage-Ds420gDY.js`, SHA-256
  `e403a188edbc5cc68a927943dfc1a89d8b998ca20abf6f42dbfce63012edd6f1`.
- Instrument stylesheet remains `TheGlassPage-B2f-6tpG.css`, SHA-256
  `bff3905e4bb3a92d643f7d977537976a3497b5fbcbe2cb11b73bb27c5dee59c4`.
- Public logs entry remains `logs-BAlJ4052.js`, SHA-256
  `ff4a57aaa0b482aa07989eaaafe3e37341b946157de6b5bc078a39606501339e`.
- Each asset matches its synced iOS copy byte-for-byte. Main stylesheet remains
  `index-ZFrs0ZGH.css`. Total bundle 13.31 MB, JavaScript 9.84 MB / 9.90 MB budget.

Successful build log: `ship-beta109-verified.log` in the evidence directory. The
initial attempt correctly stopped at a type error in the new test-only browser
probe; that annotation was fixed before this successful release build.

## Physical check

Physical beta check: on an iPad, hold Glass to open two panes; tap Glass to return
its forecast/carousel to live without losing the other page; hold Glass again to
return to one pane. Ordinary phone navigation should be unchanged.
