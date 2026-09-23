# GPS marker anchoring and diagnostics — 2026-09-21

## Report and cause

OBS screenshots at zoom 12.7 and 19.0 showed apparent ownship displacement. The ownship, destination flag and MOB DOM marker roots overrode Mapbox's absolute positioning with `position: relative`. A preceding 44-pixel marker could therefore move ownship in normal document flow. That fixed screen offset represents a much larger geographical distance when zoomed out.

The marker roots now leave positioning and transforms to Mapbox. Inner arrow/label layout is unchanged. No GPS smoothing, position correction, or coordinate rewriting was introduced. This fixes rendering displacement, not receiver wander or satellite-imagery registration differences.

## System Status GPS quality

- Separate boat and phone cards identify the feed and actual position observation age.
- Boat diagnostics show reported satellite count, fix type, HDOP and measured horizontal accuracy where available. Phone accuracy is not attributed to the boat receiver.
- HDOP remains dimensionless; it is not converted into an accuracy-in-metres claim. The current yacht receiver does not report metre accuracy.
- Each diagnostic retains its own observation timestamp and expires independently. Missing, stale, invalid and future data do not look like a fresh fix. A reported zero-satellite/no-fix state is retained honestly.
- Pi diagnostic leaves must belong to the exact Signal K source that supplied the selected position. A newer clock sentence or telemetry row cannot re-date old coordinates in this panel.
- The pre-existing Pi navigation-accuracy fallback is preserved, so newly available HDOP does not silently change navigation or alarm precision. This change does not certify the older direct-NMEA accuracy heuristic.

## Verification

- Focused app regression run: 35 suites, 302 tests passed.
- Updated backbone fixture: 27 additional tests passed.
- Independent diagnostics/parser/provider/UI review: 62 overlapping tests passed.
- Pi GNSS/track/telemetry/LAN tests: 26 passed.
- Scoped ESLint and Prettier checks passed.
- Real Mapbox browser fixture, using production marker DOM, passed on desktop and a 430-pixel phone viewport. Twelve states cover zooms 8, 12.7 and 19, flat and rotated/tilted cameras, and both marker insertion orders. Maximum measured displacement from `map.project()` was 0.000 pixels in both viewport runs.
- GPS cards were visually checked at phone size in fresh, stale and missing-data states, with synthetic data and no GPS permission requests.
- Production `npm run build` passed, including TypeScript and client-secret checks. Existing bundle-size advisories remain.
- `npm run cap:sync` completed successfully. Built and iOS-copied `index.html` hashes match: `2029fc0931c8efa1124d60fcdff3d47d775cf3b0e393fbf58d540df2e40c0fb5`.

The app is built and synced into the local Xcode project; it has not been installed on the phone or uploaded to TestFlight in this task.

## Live Pi

The user explicitly approved a brief service restart. Deployment and backup evidence are recorded in [GNSS telemetry deployment](GNSS_TELEMETRY_DEPLOY_2026-09-21.md). The healthy post-deployment feed reported 31 satellites, a differential GPS fix and HDOP 0.50. Matching source was aligned afterward without another restart.
