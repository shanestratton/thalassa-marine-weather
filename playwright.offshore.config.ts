import { defineConfig, devices } from '@playwright/test';

/** Public-only offshore worker smoke; no account, chart installation or backend calls. */
export default defineConfig({
    testDir: './browser-tests',
    testMatch: ['offshore-worker.spec.ts', 'offshore-comparison.spec.ts'],
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    timeout: 90_000,
    reporter: [['list'], ['json', { outputFile: 'test-results/offshore-evidence.json' }]],
    use: { baseURL: 'http://127.0.0.1:4208', trace: 'on-first-retry', screenshot: 'only-on-failure' },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'webkit', use: { ...devices['iPhone 13'] } },
    ],
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 4208 --strictPort',
        url: 'http://127.0.0.1:4208',
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
