import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
    testDir: './browser-tests',
    testMatch: 'noaa-package.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 120000,
    expect: { timeout: 15000 },
    outputDir: './test-results/noaa-package',
    reporter: 'list',
    use: { baseURL: 'http://127.0.0.1:4236', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 375, height: 667 },
                launchOptions: { args: ['--use-angle=swiftshader'] },
            },
        },
        { name: 'webkit', use: { ...devices['iPhone 13'] } },
    ],
    webServer: {
        command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4236 --strictPort',
        url: 'http://127.0.0.1:4236/e2e/fixtures/noaa-package.html',
        reuseExistingServer: false,
        timeout: 60000,
    },
});
