import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
    testDir: './browser-tests',
    testMatch: 'offline-relief.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 90000,
    reporter: 'list',
    use: { baseURL: 'http://127.0.0.1:4209', screenshot: 'only-on-failure' },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'webkit', use: { ...devices['iPhone 13'] } },
    ],
});
