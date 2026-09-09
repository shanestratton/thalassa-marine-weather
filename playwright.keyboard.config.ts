import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Isolated source-level layout/theme tests: no account or backend writes. */
export default defineConfig({
    testDir: './browser-tests',
    testMatch: [
        'keyboard-layout.spec.ts',
        'daylight-layout.spec.ts',
        'ui-legibility.spec.ts',
        'split-pane-layout.spec.ts',
        'nmea-daylight.spec.ts',
        'wind-tide-layout.spec.ts',
        'vessel-scroll.spec.ts',
        'public-voyage-mobile.spec.ts',
        'diary-compose-layout.spec.ts',
        'scuttlebutt-layout.spec.ts',
        'sail-plan-layout.spec.ts',
    ],
    outputDir: process.env.CI ? 'test-results/layout' : join(tmpdir(), 'thalassa-keyboard-e2e'),
    workers: 2,
    reporter: 'list',
    use: { baseURL: 'http://127.0.0.1:4199', screenshot: 'only-on-failure' },
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
