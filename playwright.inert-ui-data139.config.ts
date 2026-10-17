import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './browser-tests',
    testMatch: 'inert-ui-data139.spec.ts',
    forbidOnly: !!process.env.CI,
    workers: 1,
    retries: 0,
    timeout: 30000,
    expect: { timeout: 10000 },
    reporter: [['list']],
    outputDir: process.env.CI ? 'test-results/inert-ui139-mini' : '../inert-ui139-browser-proof',
    use: { baseURL: 'http://127.0.0.1:4307', trace: 'retain-on-failure' },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['iPhone 13'],
                defaultBrowserType: 'chromium',
                channel: process.env.CI ? undefined : 'chrome',
            },
        },
        { name: 'webkit', use: { ...devices['iPhone 13'] } },
    ],
    webServer: {
        command: 'node scripts/serve-inert-ui-fixture139.mjs',
        url: 'http://127.0.0.1:4307',
        reuseExistingServer: false,
        timeout: 60000,
    },
});
