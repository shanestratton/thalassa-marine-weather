# Build 110 — final native release

Shane authorised internal TestFlight delivery after the End Voyage, Pi-aware
NMEA status, rolling wind history, transient GPS recovery, route-picker,
abandoned Cast Off setup and split-pane attribution corrections. See
[implementation and activation evidence](BUILD_110_LOG_STOP.md).

## Source and checks

Application changes through `21443c79` are committed and pushed. Full lint
passed with zero errors and 60 existing warnings; all 163 migration checks
passed. Full Prettier checks passed. The dependency audit passed the existing
high/critical gate with four moderate findings in the development Vitest
dependency chain. Dependencies were not upgraded during this release.

The first frozen full run passed 9,931 tests, with three existing expected
failures and five skips, but one source-contract assertion failed because it
expected `tracedRouteFollowGeometry(logRoute)` rather than the new
identity-enriched `linkedRoute`. The same checked `steerRoute` still reaches
the verifier, plan builder and follower. The test now checks the new ordering
and proven identity; it is not skipped or quarantined. Seven focused contract,
picker and gate suites passed all 50 checks after the test-only correction.
Evidence: `full-unit-final.log` in the directory below.

The complete quiet rerun on `f7373bee` passed **9,932 tests**, with three
existing expected failures and five skips: 1,109 files passed, four skipped,
exit zero in 180.58 seconds. Evidence: `full-unit-verified.log`.

The first packaging attempt then stopped before compilation because its
source gate hardcoded Mapbox's old `attributionControl: true` arrangement.
The new pane-aware implementation explicitly installs a native attribution
control instead. The gate now requires that installation, resize refresh,
all four provider-credit declarations and absence of global CSS hiding the
attribution or logo. Its 126 source and 132 release contracts pass; 38 focused
gate/attribution tests pass. No app runtime changed and no gate was bypassed.
The failed attempt remains in `ship-beta-final.log`.

## Final packaged candidate

`VITE_APP_BUILD=110 npm run ship:beta` passed from **06de151d** using Node 24,
including TypeScript, source/release gates, production route/byte-identity
verification, bundle budgets, iOS sync with 19 plugins, secret checks and all
140 artifact contracts. The working tree was clean before packaging/archive.
Application runtime changes remain those verified by the full quiet suite;
the later gate correction changes only release validation and its test.

- Main: `main-BvJp9eof.js`, SHA-256
  `b00ab5adebc4f7964f29f78495eaed187ca52ef83b0f5b919e68a0e3eaaac6eb`.
- Public logs: `logs-KJwlmHsF.js`, SHA-256
  `aad4cbdbec2e4761c6b3e60dc1fc7ef36dd9f9063b9d2a4a6ad29e0d0f9932d8`.
- Entry carries source `06de151d` and release `thalassa@1.2.0+110`.
- Total bundle: 13.33 MB / 18.00 MB; JS: 9.86 MB / 9.90 MB. The JavaScript
  budget has little remaining headroom; no budget was increased here.

The four focused production attribution checks passed in 22.6 seconds on phone
and 1500-pixel iPad split layouts in Chromium and mobile WebKit. They verify
one compact native control, expandable accessible credits, pane containment,
logo hit targets and provider updates after switching to Ocean. The split-pane
collapsed and phone-expanded screenshots were inspected. Imagery/remote APIs
were intercepted by the fixture; these are layout checks, not live chart or
physical iPad acceptance.

The full immutable production-browser matrix passed **167 checks**, seven
existing conditional skips, zero retries, in 3.6 minutes. It includes Glass GPS
retention/recovery, Scuttlebutt/PM layout, Log, split navigation, vessel scroll,
location selection, wind/tide layout, public voyage views and OBS defaults.
Evidence: `ship-beta-verified.log`, `attribution-browser.log`,
`attribution-results/`, `full-production.log` and `production-results/`.

## Signed archive

Xcode 26.6 (17F113) completed the signed archive at **09:39:52 AEST** on
10 September 2026:

`/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-10/Thalassa-1.2.0-110-06de151d.xcarchive`

Verification confirmed identifier `com.thalassa.weather`, version 1.2.0 (110),
minimum iOS 17.0, all 420 public files byte-identical to the synced bundle,
zero source maps, no Watch or PlugIns, and 23 binaries with matching dSYM UUIDs.
Background modes remain audio/location/fetch; non-exempt encryption is false.
Strict/deep code-signature verification passed. Evidence: `archive.log`,
`archive-verification.json` and `archive-signature.log`.

## Apple delivery

Apple validation passed at approximately **09:42 AEST** on 10 September 2026:
Xcode returned `Validated App` and `EXPORT SUCCEEDED`, exit zero. Version is
1.2.0 and all four native counters remain 110; automatic version/build-number
management was disabled. Evidence: `validation.log`.

The exact validated archive uploaded successfully at **09:44:46 AEST** on
10 September 2026. Xcode returned `Uploaded package is processing`,
`Upload succeeded`, `Uploaded App` and `EXPORT SUCCEEDED`, with exit zero.
Evidence: `upload.log`. **Do not rebuild or reuse build 110 after this upload.**
All earlier 110 bundles in the implementation document were superseded and
were not uploaded.

Processing completion and actual TestFlight availability are not yet independently
verified. The Skipper internal group was previously verified during 109 as
having Automatic for Xcode Builds enabled; its current settings have not been
changed or re-read here. The current session has no attached-browser control
or App Store Connect API credential, so its signed-in tab cannot be inspected.
Shane has been asked to confirm the 110 Update button in TestFlight. The narrow
Apple mail check has not returned a processing-completion message. Prepared
testing notes remain local and are not claimed saved in App Store Connect.

App: `6809058745`; Skipper group: `443260d3-cb60-4c4d-a115-1613b719f3ef`.

Evidence directory: `/private/tmp/thalassa-upload110.KhRZL0/`.
Prepared internal testing notes: `What-to-Test.txt` in that directory.

The separately approved yacht cache wind update is already active. Anchor
relay was off before and after activation; no new anchor assignment was made.
The software rollback backup is not a track-database backup. Existing stored
track points were preserved and recording resumed. Physical phone/native GPS,
long-recording stop and cloud-only wind-history acceptance remain distinct from
local browser, unit and packaging checks.

External-beta groups, public links, website deployment and other vessels'
settings are outside this internal TestFlight delivery.
