# Build 109 — phone/vessel location integrity

This candidate was superseded during the full pre-upload browser checks. See
[build 109 TestFlight delivery](BUILD_109_TESTFLIGHT.md) for the correction and
current release status. The evidence below describes the earlier candidate.

Runtime commit: `f40e0e0e`, following `147f8a83` and `0747d93d`.
This supersedes the bundle identifiers in `BUILD_109_GLASS_GESTURES.md`.
At this checkpoint, build 109 remained unreleased; archive and TestFlight delivery
are recorded separately in the release document linked above.

## Behaviour

- Current Location follows only this phone. Selecting the vessel follows only
  the instrument bus, Pi GPS, genuine Pi cloud telemetry, or a clearly labelled
  last-known vessel fix. Neither choice silently substitutes the other receiver.
- Phone-uploaded cloud rows and old phone-derived records stored as boat fixes
  are rejected. Malformed/future timestamps are not manufactured into live fixes.
- Auth-scoped in-flight and cached GPS answers cannot leak across account changes.
  Explicit source selection still works when browser storage is unavailable.
- Locality naming has its own coordinate baseline, separate from forecast reuse.
  The old 2 km weather proximity rule no longer authorises reusing a suburb name.
  First-follow naming verifies legacy labels, subsequent movement naming retains
  the 0.5 NM cadence, and temporary geocoder failures retry after 60 seconds.
  Failed geocoding displays coordinates rather than inventing a place name.
- New selections cancel older GPS, naming, forecast and tide work. Cached
  favourites also cancel in-flight fetches. Boot and cloud restoration respect a
  later user choice; Retry, wake, model changes and the Vessel page use the
  selected source rather than injecting phone or legacy coordinates.
- The actual location box uses the resolved display label, not an older search
  string. The info panel identifies unavailable and last-known sources with age.
  No new location/status row is added to the Glass forecast strip.

## Verification

234 focused tests across 24 suites passed, covering source isolation, provenance,
timestamps, account boundaries, deferred selection races, naming, permission
boundaries, tide refreshes, GPS indicators and related navigation. An additional
39-suite integration-contract sweep passed (252 checks; overlapping suites).
Changed-file ESLint, formatting and source-only release contracts passed.

Evidence: `/private/tmp/thalassa-weather-gps.6j9d6K/`.
`unit-verified.log`, `header-test.log`, `lint.log`, and `beta-source.log` contain
the corresponding results. The first artifact build was intentionally stopped
before sync after finding the header/query mismatch. The next completed build
reproduced a startup race in mobile WebKit: after a source change, a newly started
cache load repainted the legacy Sydney report. `browser.log` records that failure.
The fix fences both late cache completion and late cache initiation after user
intent; its direct regression is also recorded in `late-cache.log`. Only the
rebuilt artifact from `f40e0e0e` was considered eligible at that checkpoint;
the later full-matrix findings superseded it before upload.

**16/16 packaged-browser executions passed** in 55.8 seconds, with zero retries
or skips: Chromium and mobile WebKit, both journeys repeated twice. They cover
Phone/Vessel unavailable states, Retry, suppression of the legacy Sydney label,
late-follow-tick persistence, and the existing phone/tablet Glass gesture flows.
All external traffic, WebSockets and real GPS were blocked in isolated contexts.
See `browser-verified.log` and `e2e/weather-location-selection.spec.ts`.

## Verified build artifact

`VITE_APP_BUILD=109 npm run ship:beta` completed successfully from `f40e0e0e`:
TypeScript, production build, byte-identical local release preview, bundle and
route checks, iOS sync with 19 plugins, artifact secret checks and all 140 release
contracts. See `ship-beta109-verified.log`.

- Entry: `main-Dij0BC0x.js`, SHA-256
  `ce01ef9b728254142f9e14e1b7a35d80dd44deaa6125c5717c32af5c26c73a6e`.
- Application shell: `ApplicationShell-Bnrx-Zes.js`, SHA-256
  `9e6be252c95b02c4944f7828d68484b13fd0f8abb2b094ab3e9fb5ae6f3ed9b6`.
- Instrument page: `TheGlassPage-VvdAVdlp.js`, SHA-256
  `4ad095f4396e324d947f106008e6546666338d25f4dfd4b73bf8b065568fbcc4`.
- Public logs remain `logs-BAlJ4052.js`, SHA-256
  `ff4a57aaa0b482aa07989eaaafe3e37341b946157de6b5bc078a39606501339e`.

Every file in `dist/assets` matches the synced iOS assets. All four Xcode counters
remain 109. The runtime commit is present in the built entry. Total bundle is
13.31 MB; JavaScript is 9.84 MB against the unchanged 9.90 MB limit. No archive,
Apple upload, website deployment or backend mutation was performed.

## Device check

On the installed build, choose Current Location with phone location permission
enabled and compare its place/coordinates with the phone's actual fix. Then
select the vessel while ashore and verify her own location. Deny phone permission
and check that Current Location reports unavailable rather than showing the boat.
Switch quickly between the two and a favourite; the last selection must stay put.

These tests use controlled positions, not a reading from Shane's physical phone.
