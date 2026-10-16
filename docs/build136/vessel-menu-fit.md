# Build 136 Vessel menu fit

Base: `25d7ec215acbe48e97560dd0b5e44a5c894e576b`.

The intended Systems entry made the menu box six controls tall. The old layout
still allocated the crew card one fifth of the box's growth and the browser
fixture expected only five box controls. Correcting the fixture exposed actual
35–44 px phone overflow, a lost stacked Diary/Scuttlebutt layout, and an oversized
crew row. A focused local baseline reproduced 16 failures across Chrome and WebKit.

Under an 820 px page-container height, Systems and Music share one visual row.
Taller pages retain six full-width rows. Every control remains a 44 px target;
accessible names and full descriptions remain intact. The crew card shares spare
height at one fifth of the compact box, or one sixth of the full-height box. At
300 px with 130% text, only the paired actions' decorative chevrons yield space so
both short labels remain whole.

The original no-scroll, lower-edge, Diary pair, card-gap and crew-row tolerances
are unchanged. The selector now measures all six logical box controls, including
the nested pair. Added actual-app checks use the existing scroller at 300/375 px
with 130% text, hit-test both buttons, open Boat systems, verify Escape/focus
return, and open Apple Music. No provider calls or private positions are used.

Focused unit proof:

```sh
node node_modules/vitest/vitest.mjs run tests/MenuPageFit.test.ts tests/VesselHubMenuBox.test.tsx tests/VesselHubLayoutOrder.test.ts tests/SystemsPage136.test.tsx tests/VesselHubScrollPort.test.ts tests/VesselHubSafetyControls.test.ts tests/VesselHubAccessibleStructure.test.tsx tests/VesselHubCrewCount.test.tsx
```

68 tests across eight suites pass. Scoped ESLint and formatting checks pass.

The source-level browser cases remain in the standard keyboard suite:

```sh
npx playwright test --config playwright.keyboard.config.ts --grep "Vessel page"
```

Local browser proof: 91 existing cases pass, with the pre-existing WebKit skip
for Chromium's typed-date field unchanged. All four new navigation cases pass in
a separate final run without retries. Earlier cold dev-app startup timeouts are
retained in the task logs; startup and geometry limits were not raised.

Local proof uses the existing installed Chrome and Playwright WebKit 2248, fake
public service configuration, and refused off-origin requests. Receipt logs and
screenshots are retained outside the repository in the task workspace. This is
browser evidence, not an iPhone hardware or TestFlight upload claim.
