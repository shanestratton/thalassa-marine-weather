# Build 112 — Boat Network hardware setup

**Delivered:** 1.2.0 (112) is **Testing** in the existing Skipper internal
TestFlight group. Confirmed September 11, 2026 at **07:26 AEST**.

## Scope

Source commit: `ae5a13b4`. Native counters: **1.2.0 (112)**.

The former Settings → Advanced → Boat Pi setup controls now have one home:
**Vessel → Boat Network → Boat hardware & integrations**. The expandable card
sits below the network status and before chart management. It uses the existing
Pi panel, settings store and save action without changing pairing, installation,
cache, anchor-dashboard or pinned-transport security behavior. Remote Access
remains a single existing section. Stale Settings tab hints fall back safely.

Controls load only when expanded and use the existing page scroll area. The
header follows the day/dark theme and remains inside its tablet pane.

## Verification

- 48 focused tests passed across eight suites, including settings persistence,
  disclosure lifecycle, stale hints, identity isolation and the native Pi gate.
- Eight browser scenarios passed: 320 × 568 phone and 1024 × 768 half-pane,
  light/dark, Chromium/WebKit. The fixture mounts the real lazy Pi panel, blocks
  external requests, and keeps settings changes in memory. No yacht or account
  settings were changed by the tests.
- Browser checks cover horizontal overflow, pane containment, fixed header,
  access to the final Wi-Fi setup button by normal scrolling, and collapse.
  Representative WebKit screenshots were inspected.
- Scoped formatting and ESLint passed with no errors. Five existing AvNavPage
  warnings remain; unrelated connection behavior was not changed.
- `VITE_APP_BUILD=112 npm run ship:beta` passed: TypeScript, production build,
  web-release checks, bundle budget, route audit, iOS sync and artifact scans.
  All 140 final beta contracts passed. Local build log:
  `/private/tmp/thalassa-boat-hardware112.PyLomj/ship-beta.log`.
- All 418 compiled files exactly match their iOS public copies. Main bundle:
  `assets/main-DhqHm82t.js`, SHA-256
  `1b9e3db40f2c1ebe3d808f3b58a0e42504858bf80fb3baa956c655928dfc5846`.
- Full local production browser suite: **177 passed, seven existing skips**,
  zero retries, Chromium and iPhone-profile WebKit (4.2 minutes).
- Full local day/keyboard/split-pane browser suite: **200 passed**, zero
  retries, Chromium and WebKit (4.1 minutes).
- [CI 34527086949](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34527086949)
  passed all four jobs for `6cacb7ba` (only documentation differs from compiled
  source `ae5a13b4`). Unit coverage: **9,990 passed, three expected failures,
  five skips**, across 1,115 passed suites and four skipped suites. Production
  browsers: **177 passed, seven existing skips**. Source-layout browsers:
  **200 passed**. CodeQL and Lighthouse also passed for this commit.

## Native archive and validation

Archived with Xcode **26.6 (17F113)** at **07:03:01 AEST on September 11, 2026**:

`/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-11/Thalassa-1.2.0-112-ae5a13b4.xcarchive`

Archive verification passed: app `com.thalassa.weather`, version 1.2.0 (112),
all **420** native public files byte-identical, all **23 arm64 binaries** with
nonempty UUID sets and matching dSYMs, strict/deep signature verification,
matching privacy manifest, and no Watch, PlugIns or source maps.

Apple validation completed at **07:05:51 AEST**, reporting **Validated App /
EXPORT SUCCEEDED**, exit 0. Automatic build-number management was disabled.
The preserved distribution-signed validation app was independently inspected:
Apple Distribution signature, `get-task-allow=false`, `aps-environment=production`,
Apple sign-in, WeatherKit and time-sensitive capabilities intact. All 420 public
files and the privacy manifest match the archive.

Release logs and independent verification records:
`/private/tmp/thalassa-release112.ijN51c/`.

## Apple upload

After all release gates passed, the same archive was uploaded with automatic
build-number management disabled. At **07:17:01 AEST on September 11, 2026**,
Xcode reported **Upload succeeded / Uploaded App / EXPORT SUCCEEDED**, exit 0,
and Apple began processing the package. No second upload was attempted.

## TestFlight delivery

- Apple processing completed successfully. Build ID:
  `f1337c8a-561d-471a-ad49-c33ee9a4e7c4`.
- The existing automatic assignment added 112 to **Skipper**, the internal
  group with **one tester and 11 builds**. Its build row explicitly shows
  **Testing**. No groups, testers or external access were added.
- English (Australia) **What to Test** notes were saved and read back after
  reloading. They describe the new Boat Network location and checks for
  existing pairing, phone scrolling, day/dark and iPad split-screen layouts.
- Apple briefly returned an empty group list; a fresh reload showed all 11
  builds, including 112 as Testing. No distribution settings were changed.
- [Open Skipper builds](https://appstoreconnect.apple.com/teams/eec47146-40f9-44a4-bb8b-1434c6cf0c5e/apps/6809058745/testflight/groups/443260d3-cb60-4c4d-a115-1613b719f3ef/builds).
  On the device: **TestFlight → Thalassa → Update**.

## Device acceptance

Delivered build 111 and its archive are unchanged. Confirm the moved panel with
an already-paired Pi on the actual iPhone/iPad after installing 112. Automated
layout tests used an unpaired fixture and did not operate physical hardware.
