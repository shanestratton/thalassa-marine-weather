import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Auto-hide source fixture only; no accounts, feeds, native services or writes. */
export default defineConfig({
    testDir: './browser-tests',
    testMatch: ['weather-controls-autohide.spec.ts'],
    timeout: 60_000,
    workers: 2,
    reporter: 'list',
    outputDir: process.env.CI ? 'test-results/weather-autohide' : join(tmpdir(), 'thalassa-weather-autohide-e2e'),
    use: { baseURL: 'http://127.0.0.1:4205', screenshot: 'only-on-failure' },
    projects: [
        { name: 'webkit-390', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
        { name: 'webkit-320', use: { ...devices['iPhone 13'], viewport: { width: 320, height: 568 } } },
        {
            name: 'chromium-desktop',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1280, height: 800 },
                launchOptions: { args: ['--use-angle=swiftshader'] },
            },
        },
    ],
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 4205 --strictPort',
        url: 'http://127.0.0.1:4205/e2e/fixtures/weather-controls.html',
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
