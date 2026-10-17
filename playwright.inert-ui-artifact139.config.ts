import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './browser-tests',
    testMatch: 'inert-ui-artifact139.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 30000,
    expect: { timeout: 12000 },
    reporter: [['list']],
    outputDir: '../inert-ui139-actual-artifact-proof',
    use: { baseURL: 'http://127.0.0.1:4309', trace: 'retain-on-failure' },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['iPhone 13'],
                defaultBrowserType: 'chromium',
                channel: 'chrome',
                launchOptions: { args: ['--use-angle=swiftshader'] },
            },
        },
        { name: 'webkit', use: { ...devices['iPhone 13'] } },
    ],
    webServer: {
        command: 'node scripts/serve-inert-ui-artifact139.mjs',
        url: 'http://127.0.0.1:4309',
        reuseExistingServer: false,
        timeout: 60000,
    },
});
