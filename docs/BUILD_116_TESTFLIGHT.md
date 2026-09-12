# Build 116 — autorouting endpoint coordinates

Status: delivered — 1.2.0 (116) is Testing in the existing Skipper internal
TestFlight group. Verified September 12, 2026; English (Australia) notes saved
and read back after reload. Apple build ID: e4760678-7cd2-4302-b533-5c6648b53ac0.

## Final release evidence

- Compiled/source commit: `8dd6946c935a03008354e595ac902e2955902bdf`.
- Fresh `ship:beta` passed, including 140 final contracts; 168 focused tests,
  24 source-browser cases and 14 exact-production browser cases passed.
- Exact-source CI 34658651305, CodeQL 34658651294 and Lighthouse 34658651290
  passed. CI: 10,501 unit passes, 3 expected failures, 5 skips; 1,136 passed
  suites and 4 skipped. Production browsers: 223 passed, 7 existing skips;
  source-layout browsers: 246 passed. No reported retries/flaky classifications.
- Main `assets/main-B-sWuygH.js`; SHA256
  `770a0539db61178460dab247f14d38571e18b91a6f6ab78d384ae794fac2fe80`.
- Xcode 26.6 archive and Apple validation succeeded. Archive, validation and
  actual upload distribution-package verifications passed independently with
  zero failures/warnings, 422 matching public files, and 23 matching binary/dSYM
  UUID pairs. Frozen verifier SHA256:
  `2adfac0af9d825c633652c824edc5dc906388ab40881511f813ce60000bb9dba`.
- Uploaded once, successfully, September 12 at 10:40:57 AEST; Apple displays
  10:41 AM. Skipper automatically received it: 15 builds, one existing tester.
- Evidence: `/private/tmp/thalassa-release116.nyZxs3`. Archive:
  `/Users/shanestratton/Library/Developer/Xcode/Archives/2026-09-12/Thalassa-1.2.0-116-8dd6946c.xcarchive`.

No rebuild or repeat upload is required. Subsequent source edits belong to 117.

## Scope

Departure and destination cards in the isolated autorouting trial now show their
selected latitude and longitude instead of “Position set”. Coordinates use the
existing radio/MOB degrees-and-decimal-minutes formatter, with N/S and E/W on
separate readable lines. Chart selections and manual edits update the labels;
cleared or invalid positions do not leave old coordinates visible. Display
rounding does not change the coordinates sent for calculation.

The four native build configurations are 116; the marketing version stays 1.2.0.
No provider, entitlement, chart-engine, yacht or database changes are included.

## Checks before release preparation

- 166 focused autorouting unit/contract tests passed.
- 24 Chromium/WebKit phone and split-pane browser cases passed, covering
  day/dark/night layouts, populated coordinate cards and keyboard handling.
- Full TypeScript, targeted ESLint, formatting and diff checks passed.
- Screenshots were inspected for phone and daylight iPad split-pane readability.

These local source/fixture results do not replace the new build's production,
native archive, Apple validation or exact-candidate CI gates. Final release
identities and delivery receipts will be recorded after those checks complete.

## Known trial limitations

The trial remains an unsaved proposal, not activated navigation. The display is
a satellite/Ocean basemap, not an ENC chart. The September 12 09:06 AEST request
returned HTTP 504 after 35.528 seconds; the client currently reports that as
“trial unavailable”. This build does not implement the separately discussed
timeout/error-reporting or ENC-display improvements. Provider authentication
versus calculation latency was not distinguishable in the incident logs.

## What to Test — English (Australia)

> 1.2.0 (116) — Autorouting endpoint coordinates
>
> Planning: Slide to Start Plotting, then choose Auto routing. After selecting
> departure and destination, both cards should show latitude and longitude in
> degrees and decimal minutes, with N/S and E/W. Check that tapping a new point
> or editing coordinates updates the correct card. Clear should remove both
> positions. Confirm readability on iPhone and iPad split view in day, dark and
> night modes, including with the keyboard open.
>
> This update changes endpoint labels only. Autorouting remains a private trial:
> proposals are not saved or activated for navigation. The basemap is not an ENC
> chart. The reported calculation timeout and generic “trial unavailable” message
> are not fixed in this build. Do not use trial proposals for navigation.
