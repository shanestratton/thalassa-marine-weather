# Build 119 — voyage, OBS and Shore Watch polish

Status: **available to the existing internal Skipper TestFlight group** on
25 September 2026. Apple processing is Complete; the group's Builds page shows
1.2.0 (119) as Testing for one internal tester, expiring in 90 days. The general
build table's Ready to Submit status concerns external review, not internal
availability. The external Beta Skippers group was not changed.

## Included

- OBS vessel-status label placed below the vessel-name row; heading-aware
  ownship presentation and explicit anchor-watch state.
- More specific marine Log endpoint names, including a maintained Queensland
  place-name bundle and conservative, paced detailed-geocoding fallback.
- Just-recording resume, undeparated-session handling, passage archiving,
  lifetime statistics including archived voyages, and reversed route names.
- Automatic recording HUD, track/route framing, departure and ETA controls.
- Compact Shore Watch readings and connection information, consolidated GPS
  diagnostics, Radio Console presentation and float-plan fuel-unit fixes.
- Mooring/anchorage and weather-layer presentation improvements.

The source freeze includes accumulated repository app changes, not an older
subset. This release did not deploy the website/backend, restart the Pi, push
Git commits remotely, or change paused holiday automations. Today's diary
publication and historical track recovery were separate scoped operations.

## Validation and evidence

- Frozen application source: `b6c9668207b0195fe0d9a0e9b6112db718a0156c`.
  Preceded by `1bb3b8b0` (accumulated release source) and `1424c2f5`
  (regression-contract repairs and a daylight text-colour rule).
- Full unit run at `1424c2f5`: 1,250 suites / 12,896 tests passed, four skipped
  suites, five skipped tests and three expected failures. The only subsequent
  source change updated the release check for extracted Shore Watch readings.
- Final `ship:beta` at `b6c96682`: all 132 source contracts and 140 artifact
  contracts passed, alongside TypeScript, production build, routes, bundle
  budgets, secret scans and Capacitor/Pods sync. Node 24 was used throughout.
- Manual equivalent staged formatting/lint checks passed before the release
  freeze after the parallel pre-commit hook failed. Commits used `[skip ci]`;
  no claim of a hosted CI run is made.
- Xcode 27.0 (27A266a) archive and Apple validation succeeded. The same archive
  was uploaded exactly once; upload accepted at **16:53:00 AEST**.
- Apple build/delivery ID: `3243b00d-5336-4740-9925-1852d613518f`.
- Internal Skipper group ID: `443260d3-cb60-4c4d-a115-1613b719f3ef`.
- Archive: `/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-25/Thalassa-1.2.0-119-b6c96682.xcarchive`.
- Working evidence: `/private/tmp/thalassa-release119.rH7Wp9/`, including
  `unit-tests-final.log`, `ship-beta-final.log`, `archive-verification.txt`,
  `distribution-verification.txt` and `upload.log`.
- Locally exported App Store IPA SHA-256:
  `0031b099b864afd90d5245fd693bec111afd16e439f330d3d88a7936105b4122`.
- Distribution verified: production APNs, no debug entitlement, beta reporting,
  Apple sign-in, WeatherKit and Time Sensitive capability; 426 byte-identical
  web files, matching privacy manifest, no source maps, 23 binary/dSYM pairs.
- Main asset: `assets/main-C43QOU0J.js`, SHA-256
  `7678a54735dfedb47d8c508111de981deae6088e9ef0b1e13874cea657c2aadf`.
- Bundled anchor WAV SHA-256:
  `1afa9c671792a3e49532b357ee911dd1c20c08926599e6113e32e1d23d741036`.
  This is the 24-second notification sound, not continuous audio or Critical
  Alerts. Notification settings, volume, Silent/Focus and connectivity matter.

## On-device checks still required

Install 119 from TestFlight and check OBS label spacing and heading, new/archived
Log names, recording resume, the HUD, Radio Console and float-plan units. Test
Shore Watch notification delivery with the phone locked and the intended sound
settings. Mooring/weather guidance and routing proposals do not establish safe
navigation or replace current charts and local checks.

No physical-phone installation was performed during this release. The per-build
What to Test field was left empty; this checklist is a local release record,
not a claim that tester-facing notes were saved.
