import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Isolated source-level layout/theme tests: no account or backend writes. */
export default defineConfig({
    testDir: './browser-tests',
    testMatch: [
        'keyboard-layout.spec.ts',
        'daylight-layout.spec.ts',
        // The Glass's compact conditions row: 'Trace' and inch readings stay in their cells.
        'glass-conditions-row-layout.spec.ts',
        'ui-legibility.spec.ts',
        'split-pane-layout.spec.ts',
        'nmea-daylight.spec.ts',
        'wind-tide-layout.spec.ts',
        'vessel-scroll.spec.ts',
        // Menu pages fit one screen; the split-pane Plan and Log front doors fit their pane.
        'menu-pages-fit.spec.ts',
        // The Plan tab's front door fits, fills its screen and keeps every item.
        'plan-page-fit.spec.ts',
        'public-voyage-mobile.spec.ts',
        'diary-compose-layout.spec.ts',
        'scuttlebutt-layout.spec.ts',
        'sail-plan-layout.spec.ts',
        'boat-network-layout.spec.ts',
        // The NMEA Gateway page and the System status box say where this phone
        // is and how the boat reaches it, on one line each (e2e/fixtures/gateway-state.tsx).
        'gateway-state-layout.spec.ts',
        'music-layout.spec.ts',
        'autorouting-trial.spec.ts',
        'cruising-layers.spec.ts',
        // Scale-ordered chart drawing: a detailed chart's water over an
        // overview's land (e2e/fixtures/enc-scale-order.tsx, item f).
        'enc-scale-order.spec.ts',
        // An offline MBTiles chart opens and draws under the app's real CSP,
        // index.html's and vercel.json's (e2e/fixtures/mbtiles-csp.ts, W1-FX).
        'mbtiles-csp.spec.ts',
        // A hazard's name never takes a wreck, rock or obstruction off the
        // chart; the shallower of two touching rocks still wins
        // (e2e/fixtures/enc-hazard-labels.tsx, build 123 HM).
        'enc-hazard-labels.spec.ts',
        'shore-watch-layout.spec.ts',
        'passage-log-layout.spec.ts',
        'passage-recording-layout.spec.ts',
        // A route pulled up on Obs is previewed on the HUD, labelled, with a
        // departure; the open strip clears the Sat cloud and lightning credits
        // at 320 x 568 and 375 x 667 in wide fonts (e2e/fixtures/passage-recording.tsx, build 124 HS).
        'passage-hud-preview-layout.spec.ts',
        // "Your draft is set at 2.40 m. Please confirm." (e2e/fixtures/draft-confirm.tsx).
        'draft-confirm-layout.spec.ts',
        // "Anchor is 33 m from the boat, bearing 212 °T": the Move anchor sheet
        // fits, centred above the tab bar and the keyboard (e2e/fixtures/move-anchor.tsx).
        'move-anchor-layout.spec.ts',
        // Sightings: the page, quick log, species list and detail fit at 390,
        // 320 and in the split pane, centred above the tab bar
        // (e2e/fixtures/sightings.tsx).
        'sightings-layout.spec.ts',
        // A fixture page (e2e/fixtures/navigation-marker-anchoring.html): it needs
        // the dev server, not the production preview the e2e suite runs on.
        'ownship-label-layout.spec.ts',
        // The own-ship boat: glyph, badge words, legibility per palette and base,
        // and the held-position message clear of her (e2e/fixtures/ownship-boat-marker.tsx).
        'ownship-boat-marker.spec.ts',
        // After Plan's route fit, Locate puts the fix at the canvas centre and
        // getBounds() covers the whole canvas (e2e/fixtures/obs-camera-centring.ts, build 124 OC).
        'obs-camera-centring.spec.ts',
        // Her wind vs the models: card fits, centred above the tab bar (e2e/fixtures/model-check.tsx).
        'model-check-layout.spec.ts',
        // The ten-day model comparison: seven models, the member strip and the
        // credit fit one screen, centred above the tab bar (e2e/fixtures/model-compare.tsx).
        'model-compare-layout.spec.ts',
        // Her GPS silent at Start: the stand-in question and the phone notice fit
        // at 320 × 568 with large text, centred above the tab bar (e2e/fixtures/stand-in-question.tsx).
        'stand-in-question-layout.spec.ts',
        // "Following a route?": green, amber "Check now" and red "Tap again"
        // rows fit one screen at 320 × 568 and 375 × 667, centred in the modal
        // band above the tab bar (e2e/fixtures/follow-route-sheet.tsx, build 124).
        'follow-route-sheet-layout.spec.ts',
    ],
    outputDir: process.env.CI ? 'test-results/layout' : join(tmpdir(), 'thalassa-keyboard-e2e'),
    workers: 2,
    // One retry on CI, as the E2E config has two: early in a cold run the dev
    // server can reload a page while it optimises newly seen dependencies
    // ('Execution context was destroyed', run 36348970406, 3.5 s into the 7th
    // test, green in WebKit and locally). A retried pass is reported as flaky.
    retries: process.env.CI ? 1 : 0,
    reporter: 'list',
    // A retry records a trace, so a flaky pass leaves evidence of its first failure.
    use: { baseURL: 'http://127.0.0.1:4199', screenshot: 'only-on-failure', trace: 'on-first-retry' },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 390, height: 844 },
                launchOptions: { args: ['--use-angle=swiftshader'] },
            },
        },
        { name: 'webkit', use: { ...devices['iPhone 13'] } },
    ],
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 4199 --strictPort',
        url: 'http://127.0.0.1:4199/e2e/fixtures/keyboard.html',
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
