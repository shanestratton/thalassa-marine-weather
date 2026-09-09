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

## Delivery checkpoint

Version is 1.2.0 and all four native counters are 110. Final packaging, signed
archive, Apple validation/upload and actual TestFlight availability are not
yet claimed at this checkpoint. Earlier build 110 bundles in the implementation
document are superseded candidates and have not been uploaded.

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
