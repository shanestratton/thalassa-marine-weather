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

## Follow-up — uniform labels across the app

**Follow-up verification:** 70/70 Chromium/WebKit source browser checks passed; formatting, lint (63 existing warnings) and 126 source release contracts passed. The first full unit run passed 9,544 tests and caught two safety-label sizing contracts; restoring the intentionally compact sizing passed all 21 focused follow-up tests. A fresh full unit run and type check are pending. The bundle/identity recorded below is the earlier 107 artifact, not this unbuilt follow-up. Per Shane's direction, wait for the other task's final source commit before the combined build and sync.

The Glass review exposed a real compositing gap: its translucent cells sit over the daylight slate background, not plain white. The live metric headings measured about **3.85:1**, and the clear-weather status about **4:1**. Those labels now use stronger, opaque daylight ink. Forecast captions and canvas time labels are also stronger; the tide plot coordinates and card heights are unchanged.

The app-wide source sweep covered **30 route destinations** (28 registered views plus Dashboard and Map), the seven settings panels, and shared forms/dialogs:

- Main tabs: Glass, Charts, Plan, Ship's Log and Vessel.
- Safety/reference: Warnings, Anchor Watch, Weather Window, Skipper's Reference, Radio and MOB.
- Binder: Stores, Maintenance, Equipment, Documents, Diary, Crew, Checklists and Galley.
- Navigation/hardware: Polars, NMEA Gateway, Instrument Panel, Boat Network, ENC Library and GPX Import.
- Community/settings: Scuttlebutt, Calypso, Music, Guardian and Settings, including the feature-gated hold pages.
- Settings: Preferences, Vessel Profile, Locations, Notifications, Account & Cloud, Voyage Log and Boat Pi.

Shared text roles now provide 20px page titles, 18px dialog titles, 13px section/form labels and 12px captions, with solid theme-aware ink. Existing data/gauge scales are not forced into the title scale. Warm onshore colours, meaningful warning hues, disabled/stale states and the night scrim remain. Hover cues remain distinct from neutral caption text.

Targeted exceptions include gradient settings headings, faded inactive-service descriptions, track labels and log coordinates, polar/anchor chart labels and inline map-popup text. The four dense Vessel safety captions deliberately retain their existing 9.5px sizing: their regression tests preserve the complete word **OVERBOARD** in the narrowest tile. They are not swept into the generic 12px floor. Active-weather warnings and their count badge use deeper red/white contrast; form errors and confirmation actions also remain readable under night dimming. Warning selection, counts, thresholds and confirmation behaviour are unchanged.

New browser fixtures mount the real Glass grids, forecast/tide/warning components and shared page/form/settings/dialog components at **320, 390 and 669px**. They measure composed colours, ancestor opacity, actual canvas fills and night overlays, plus clipping, typography, disabled states, hover cues and live theme changes. Source coverage is **not** a claim to have visually navigated every authenticated or hardware-dependent state on all 30 pages. Physical sunlight/iPad checks remain required.

## Verification

Browser tests use local fixtures with simulated keyboard geometry, not an actual iOS software keyboard or a live yacht connection.

- Full unit suite on Node 24.19.0: **9,550 passed**, 3 expected failures and 5 existing skips; **1,086 files passed**, 4 files skipped (275.19 seconds). No unexpected failures.
- Final local browser run on `1c6571d1`: **58/58 passed** across Chromium and WebKit (1.5 minutes), including conditional-dialog cleanup, nested keyboard focus, slider resize/release ordering and pane-relative gauge dimensions.
- Production-bundle E2E on Node 24: **79 passed, 7 existing conditional skips** (2.8 minutes). The skips are the six hosted-preview-only cases and local-HTTP WebKit geolocation, not disabled regressions.
- Supplementary real-App check at 1366 × 1024 verified both pane bounds and the “Choose Forecast Model” dialog inside the Glass portal (x9/y97, 669 × 854). Charts mounted exactly one Mapbox canvas. Repeated navigation and pointer verification remain **unverified**: the headless actionability/focus probe timed out, although hit-testing found the navigation icon itself rather than an obstructing overlay. The probe used no forced clicks; its preview was stopped. Keep real-device switching/touch checks on the release checklist.
- Source release gates: **126/126**; configured release gates: **132/132**; synced artifact gates: **140/140**. Route and dependency-hygiene audits passed.
- Full-repository lint passed with no errors (64 pre-existing warnings); formatting and TypeScript passed. Production build, byte-identical preview/deep-route checks, Capacitor iOS sync (19 plugins), and client-secret artifact scans passed.

- New regression coverage includes live theme switching, contrast, unchanged dark gauge rendering, pane sizing, nested dialogs, focus ownership, keyboard scrolling, slider bounds and cancellation.
- The source-level browser suite is now part of CI as well as the production-bundle E2E suite. Chromium and WebKit both run it.
- A read-only comparison of the original `e9a310d4` gauges and the updated gauges produced pixel-identical dark screenshots with the same surrounding stylesheet.
- The full test sweep exposed an existing-tutorial handoff regression caused by moving focus capture earlier. `1c6571d1` restricts early capture to pane-owned dialogs; app-wide and critical dialogs keep their original timing. All 148 focused accessibility/focus tests passed, including a new regression for successive critical dialogs opened from a pane.
- A local run on unsupported Node 26 reproduced a storage-enumeration failure in `weatherPosition.test.ts`: the test setup's fallback stores keys in a `Map`, which `Object.keys(localStorage)` does not enumerate. Node 24 passed all 21 tests in that file. No weather/storage production code or test assertion was changed to mask it; release verification uses the supported Node 24 runtime.

## Build identity

- Source commit: `1c6571d1775634f69f35efa004ede58aa20abf2b` (implementation `af9d362d` plus the focus handoff fix).
- Branch and draft review: [`codex/build-107-daylight-split-view`, PR #38](https://github.com/shanestratton/thalassa-marine-weather/pull/38).
- Production command: `VITE_APP_BUILD=107 npm run ship:beta`, using Node 24.19.0. This builds, checks the production routes and bundle budgets, syncs Capacitor, and verifies the embedded release artifacts.
- Bundle: `main-D6SkvwMV.js`; main-entry SHA-256 `e8f129d92c937f7402f064696341c04e5c59edb885526ff6963357bd7534af0d`. All **417 built files** were byte-compared with their iOS embedded counterparts and are identical. The generated JavaScript contains the source commit stamp.
- Payload: **13.30 MiB / 18 MiB** total; **9.84 MiB / 9.90 MiB** JavaScript. No budget increase. Main entry: 18.0 KiB raw / 7.8 KiB gzip. Vite's advisory about larger lazy chunks remains; the enforced budgets passed.
- All four iOS target/configuration build counters are 107; marketing version remains 1.2.0. No native source or dependency-lock changes were produced by sync.

## Suggested What to Test

**1.2.0 (107) — Sunlight and iPad split-screen polish.** Day mode now has bright instrument faces and readable labels, forms, charts and map popups. Dark and night instrument colours are preserved. Split-screen dialogs and controls stay in their own pane; slide-to-confirm stays within its track and cancels safely on resize. No new introductory help screens in this build.

On the real iPad, open and close dialogs in both panes, open a nested confirmation, use the first and second input fields, rotate and resize with the keyboard open, and interrupt a slider gesture. Check focus returns to the intended control and the other pane does not move. Switch between day, dark and night on an already-open instrument screen, including absent/stale readings. Check in direct sunlight on the actual device; browser contrast checks cannot prove outdoor legibility.

Archiving, Apple validation, upload, TestFlight processing and installation are separate steps, not authorized or completed by this implementation pass. Existing external-beta and physical-device release gates remain in force.
