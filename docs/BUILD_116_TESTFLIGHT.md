# Build 116 — autorouting endpoint coordinates

Status: release preparation; not yet uploaded or verified available in TestFlight.

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
