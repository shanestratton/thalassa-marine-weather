# Build 118 — passage, chart, diary and Log improvements

Status: uploaded once at 12:51:09 AEST on September 23, 2026. Apple returned
“Uploaded package is processing”, “Upload succeeded” and “EXPORT SUCCEEDED”.
TestFlight processing and tester availability are not yet confirmed. Do not
rebuild or reupload 118 while processing.

## Included

- Autorouting trial: ENC display, canal departures, chart-aware route review,
  editable waypoints, fewer display points and full-screen tracer-style controls.
- OBS passage HUD: readable instruments, route-relative forecast playback,
  departure-time selection, stable ETA, route framing and waypoint display.
- Tide stations, pressure-layer improvements, fixed marker anchoring and GPS
  diagnostic presentation where receiver metadata is available.
- Diary comment moderation/highlights, logical-save deduplication and public
  diary/map presentation improvements.
- Passage grouping and consistent departure-based Log durations; no automatic
  deletion of recorded voyages from partial local data.
- Yacht locator on planning charts, with source/age-aware last-known positions.

The installed app includes the current repository app source, not the isolated
older web-release baseline. Building does not deploy backend/Pi services or
restart instruments. Existing backend deployments remain unchanged. Scheduled
holiday tasks remain paused. External TestFlight/public access remains unchanged.

## What to Test — English (Australia)

1.2.0 (118) — Passage, chart, diary and Log improvements

OBS: try the Passage HUD with a route loaded in Log. Check readable instruments,
the purple route, whole-route framing, departure time and ETA, and weather
playback with the HUD minimised. Compare live GPS source/age with your instruments.

Planning: check the yacht-locator button. Test the private autorouting trial's
full-screen chart, canal departure, route review and waypoint editing. Trial
proposals and join estimates are not routes cleared for navigation; check current
charts, notices, depths and local conditions before use.

Log: check the purple passage grouping and durations in days plus hours, including
Longest. Recording may be armed before departure; elapsed time starts from
GPS-confirmed movement, not the moment a route is selected.

Diary: check entries no longer briefly duplicate, pending-comment highlights and
approval beneath the relevant entry. Check day/night modes and phone rotation.

## Release evidence

- Frozen compiled/source commit: `152ce3bba1da2624c24520f33071d7dd7b4c1fd0`.
  Includes all accumulated changes in the working tree, not an earlier subset.
- Local full unit run: 1,214 suites / 12,259 tests passed; 4 skipped suites,
  5 skipped tests and 3 expected-failure tests. No unexpected failures.
  Initial run found two obsolete source checks and two missing daylight colour
  overrides; all fixed before the final run and compiled release commit.
- Fresh `ship:beta` passed: TypeScript, 132 source/release contracts, production
  build/route checks, secret scans, bundle budgets, Capacitor sync and 140 final
  artifact contracts. Pre-commit lint/format checks passed. Full hosted CI was
  not run; this release used local checks and `[skip ci]`.
- Xcode 27.0 (27A266a, the upgraded stable app still named Xcode-26.6.app)
  archived 1.2.0 (118) successfully. Apple validation passed before upload.
- Archive, validation distribution and actual upload distribution all verified:
  422 matching public files, 23 binary/dSYM UUID pairs, strict/deep signatures,
  version/build, privacy manifest, preserved capabilities and no source maps.
  Distribution entitlements include production APNs, no debug entitlement,
  Apple sign-in, Time Sensitive notifications and active beta reporting.
- Main: `assets/main-BBPhTzZX.js`; SHA-256:
  `3d8f0343589613631413141f88328a7e992e302c58c705af316ee53d0902a113`.
- Archive:
  `/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-23/Thalassa-1.2.0-118-152ce3bb.xcarchive`.
- Evidence: `/private/tmp/thalassa-release118.emH6Ra`.
  Verifier SHA-256:
  `3d59463e889794294d0c32ce3d229ae379f7082b128e18da0bde03b9d08fe7dc`.
- Upload delivery UUID: `bf5544ff-99fb-45cb-a576-194553466f94`.
- Browser signed out of App Store Connect; skipper asked to sign in for
  final internal-group verification and testing-note entry.

No physical-iPhone install, hosted web promotion, backend deployment or Pi
restart was performed during this release. TestFlight availability does not
establish navigation safety or replace the on-device smoke tests above.
