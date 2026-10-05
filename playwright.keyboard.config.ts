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
        'music-layout.spec.ts',
        'autorouting-trial.spec.ts',
        'cruising-layers.spec.ts',
        // Scale-ordered chart drawing: a detailed chart's water over an
        // overview's land (e2e/fixtures/enc-scale-order.tsx, item f).
        'enc-scale-order.spec.ts',
        'shore-watch-layout.spec.ts',
        'passage-log-layout.spec.ts',
        'passage-recording-layout.spec.ts',
        // "Your draft is set at 2.40 m. Please confirm." (e2e/fixtures/draft-confirm.tsx).
        'draft-confirm-layout.spec.ts',
        // A fixture page (e2e/fixtures/navigation-marker-anchoring.html): it needs
        // the dev server, not the production preview the e2e suite runs on.
        'ownship-label-layout.spec.ts',
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
