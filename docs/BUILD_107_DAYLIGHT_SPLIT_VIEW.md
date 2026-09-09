# Build 107 — sunlight and split-screen polish

## Scope

1.2.0 (107) follows the uploaded 106; do not rebuild or reuse 106. The branch `codex/build-107-daylight-split-view` starts from `00b4e96a`, which adds 106's delivery evidence to the `e9a310d4` source. CI for that 106 source completed successfully: [run 34293373449](https://github.com/shanestratton/thalassa-marine-weather/actions/runs/34293373449).

- Bright instrument faces, dark readable markings, and stronger day-mode labels, form controls, passage panels and map popups. Chart tiles, photographs, nautical symbols and warning meanings are preserved.
- Gauge colours change on an already-mounted panel without waiting for another vessel reading. The tide canvas redraws when the display mode changes.
- iPad split panes own their dialogs, anchored menus, fixed controls and scrolling. Account/global flows outside the panes and critical alarms can still cover the application.
- Nested dialogs preserve pane ownership. Keyboard corrections stop at the pane boundary; the other pane stays usable.
- Slide-to-confirm gestures are bounded by the actual control. Cancellation, lost capture, loading, rotation and resizing invalidate the gesture, including WebKit's release-before-resize-callback ordering.
- Instrument sizes use the pane dimensions in split mode and retain viewport sizing in normal mode. The chart remains one kept-alive Mapbox instance.
- Includes the other task's committed sail-plan simplification (`df75c0fd`) and removal of the instrument-panel dot rail (`42171d60`). Those changes remain in their separate commits; instrument page scrolling and the sail-trim advice remain available.

The future per-screen introductions and “Don't show again” workflow are **not included**. This work changes presentation and interaction containment, not vessel data, navigation calculations, warning thresholds or live service configuration.

## Follow-up — uniform labels across the app

**Follow-up verified and synced:** 70/70 Chromium/WebKit source browser checks, 9,546 unit tests and 79 production E2E checks passed. Formatting, lint (63 existing warnings), TypeScript and all 140 synced-artifact release contracts passed. The first unit run caught two safety-label sizing contracts; restoring the intentionally compact sizing passed all 21 focused tests and the fresh full suite. The final build below includes both tasks' committed source, as Shane requested.

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

- Full unit suite on Node 24.19.0: **9,546 passed**, 3 expected failures and 5 existing skips; **1,086 files passed**, 4 files skipped (329.95 seconds). No unexpected failures. The parallel task's test updates account for the count changing from the earlier 9,550-pass run.
- Final local browser run: **70/70 passed** across Chromium and WebKit (3.3 minutes), including conditional-dialog cleanup, nested keyboard focus, slider resize/release ordering, pane-relative gauge dimensions and the new contrast/typography matrices. Measurements wait for finite theme transitions to settle; infinite decorative animations are not disabled.
- Production-bundle E2E on Node 24: **79 passed, 7 existing conditional skips** (1.5 minutes). The skips are the six hosted-preview-only cases and local-HTTP WebKit geolocation, not disabled regressions.
- After both tasks committed, all **54 focused instrument/sail-plan tests** passed. The built Glass was also inspected at 390 × 844 in light, dark and night modes with an isolated local weather fixture: settled labels visible, expected colours and no horizontal overflow. Initial startup fading clears normally; unavailable tides in this disconnected fixture remain explicitly labelled unavailable.
- Supplementary real-App check at 1366 × 1024 verified both pane bounds and the “Choose Forecast Model” dialog inside the Glass portal (x9/y97, 669 × 854). Charts mounted exactly one Mapbox canvas. Repeated navigation and pointer verification remain **unverified**: the headless actionability/focus probe timed out, although hit-testing found the navigation icon itself rather than an obstructing overlay. The probe used no forced clicks; its preview was stopped. Keep real-device switching/touch checks on the release checklist.
- Source release gates: **126/126**; configured release gates: **132/132**; synced artifact gates: **140/140**. Route and dependency-hygiene audits passed.
- Full-repository lint passed with no errors (63 existing warnings); formatting and TypeScript passed. Production build, byte-identical preview/deep-route checks, Capacitor iOS sync (19 plugins), and client-secret artifact scans passed.

- New regression coverage includes live theme switching, contrast, unchanged dark gauge rendering, pane sizing, nested dialogs, focus ownership, keyboard scrolling, slider bounds and cancellation.
- The source-level browser suite is now part of CI as well as the production-bundle E2E suite. Chromium and WebKit both run it.
- Before the parallel sail-plan simplification, a read-only comparison of the original `e9a310d4` gauges and the daylight-updated gauges produced pixel-identical dark screenshots with the same surrounding stylesheet. The sail-plan drawing now intentionally differs as described above; the gauge colour-preservation browser checks still pass.
- The full test sweep exposed an existing-tutorial handoff regression caused by moving focus capture earlier. `1c6571d1` restricts early capture to pane-owned dialogs; app-wide and critical dialogs keep their original timing. All 148 focused accessibility/focus tests passed, including a new regression for successive critical dialogs opened from a pane.
- A local run on unsupported Node 26 reproduced a storage-enumeration failure in `weatherPosition.test.ts`: the test setup's fallback stores keys in a `Map`, which `Object.keys(localStorage)` does not enumerate. Node 24 passed all 21 tests in that file. No weather/storage production code or test assertion was changed to mask it; release verification uses the supported Node 24 runtime.

## Build identity

- Source commit: `75e3a901e5715245c74f0c329e6dd32e43d26957`, combining contrast commit `d11548e9` with the other task's instrument/sail-plan commits. The earlier daylight/split implementation and focus fix remain in its history.
- Branch and draft review: [`codex/build-107-daylight-split-view`, PR #38](https://github.com/shanestratton/thalassa-marine-weather/pull/38).
- Production command: `VITE_APP_BUILD=107 npm run ship:beta`, using Node 24.19.0. This builds, checks the production routes and bundle budgets, syncs Capacitor, and verifies the embedded release artifacts.
- Bundle: `main-COcM6iqV.js`; main-entry SHA-256 `727e65f490a644113238d175c2ac81ab6213e950a6c14b7c02967409337986c7`. All **417 built files** were byte-compared with their iOS embedded counterparts and are identical. The generated JavaScript contains the source commit stamp.
- Payload: **13.30 MiB / 18 MiB** total; **9.84 MiB / 9.90 MiB** JavaScript. No budget increase. Main entry: 18.0 KiB raw / 7.8 KiB gzip. Vite's advisory about larger lazy chunks remains; the enforced budgets passed.
- All four iOS target/configuration build counters are 107; marketing version remains 1.2.0. No native source or dependency-lock changes were produced by sync.

## Suggested What to Test

**1.2.0 (107) — Sunlight, consistent text and iPad split-screen polish.** Day mode has bright instrument faces and stronger labels; page titles, forms, dialogs and captions share a consistent hierarchy. Coloured actions remain readable in all display modes. Dark and night gauge colours are preserved. Split-screen dialogs and controls stay in their own pane; slide-to-confirm stays within its track and cancels safely on resize. Includes the cleaner sail-plan drawing and removal of the instrument dot rail. No new introductory help screens in this build.

On the real iPad, open and close dialogs in both panes, open a nested confirmation, use the first and second input fields, rotate and resize with the keyboard open, and interrupt a slider gesture. Check focus returns to the intended control and the other pane does not move. Switch between day, dark and night on an already-open instrument screen, including absent/stale readings. Check in direct sunlight on the actual device; browser contrast checks cannot prove outdoor legibility.

Archiving, Apple validation, upload, TestFlight processing and installation are separate steps, not authorized or completed by this implementation pass. Existing external-beta and physical-device release gates remain in force.
