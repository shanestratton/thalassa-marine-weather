# Build 107 — sunlight and split-screen polish

## Scope

1.2.0 (107) follows the uploaded 106; do not rebuild or reuse 106. The branch `codex/build-107-daylight-split-view` starts from `00b4e96a`, which adds 106's delivery evidence to the `e9a310d4` source. CI for that 106 source completed successfully: [run 34293373449](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34293373449).

- Bright instrument faces, dark readable markings, and stronger day-mode labels, form controls, passage panels and map popups. Chart tiles, photographs, nautical symbols and warning meanings are preserved.
- Gauge colours change on an already-mounted panel without waiting for another vessel reading. The tide canvas redraws when the display mode changes.
- iPad split panes own their dialogs, anchored menus, fixed controls and scrolling. Account/global flows outside the panes and critical alarms can still cover the application.
- Nested dialogs preserve pane ownership. Keyboard corrections stop at the pane boundary; the other pane stays usable.
- Slide-to-confirm gestures are bounded by the actual control. Cancellation, lost capture, loading, rotation and resizing invalidate the gesture, including WebKit's release-before-resize-callback ordering.
- Instrument sizes use the pane dimensions in split mode and retain viewport sizing in normal mode. The chart remains one kept-alive Mapbox instance.

The future per-screen introductions and “Don't show again” workflow are **not included**. This work changes presentation and interaction containment, not vessel data, navigation calculations, warning thresholds or live service configuration.

## Verification

Browser tests use local fixtures with simulated keyboard geometry, not an actual iOS software keyboard or a live yacht connection.

- Final local browser run: **58/58 passed** across Chromium and WebKit (48.1 seconds), including conditional-dialog cleanup, nested keyboard focus, slider resize/release ordering and pane-relative gauge dimensions.
- Source release gates: **126/126**; configured release gates: **132/132**. Route and dependency-hygiene audits passed.
- Full-repository lint passed with no errors (64 pre-existing warnings); formatting passed. Final production-build, native-sync and full-suite results follow below when complete.

- New regression coverage includes live theme switching, contrast, unchanged dark gauge rendering, pane sizing, nested dialogs, focus ownership, keyboard scrolling, slider bounds and cancellation.
- The source-level browser suite is now part of CI as well as the production-bundle E2E suite. Chromium and WebKit both run it.
- A read-only comparison of the original `e9a310d4` gauges and the updated gauges produced pixel-identical dark screenshots with the same surrounding stylesheet.

## Suggested What to Test

**1.2.0 (107) — Sunlight and iPad split-screen polish.** Day mode now has bright instrument faces and readable labels, forms, charts and map popups. Dark and night instrument colours are preserved. Split-screen dialogs and controls stay in their own pane; slide-to-confirm stays within its track and cancels safely on resize. No new introductory help screens in this build.

On the real iPad, open and close dialogs in both panes, open a nested confirmation, use the first and second input fields, rotate and resize with the keyboard open, and interrupt a slider gesture. Check focus returns to the intended control and the other pane does not move. Switch between day, dark and night on an already-open instrument screen, including absent/stale readings. Check in direct sunlight on the actual device; browser contrast checks cannot prove outdoor legibility.

Archiving, Apple validation, upload, TestFlight processing and installation are separate steps, not authorized or completed by this implementation pass. Existing external-beta and physical-device release gates remain in force.
