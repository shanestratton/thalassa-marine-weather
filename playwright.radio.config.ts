import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Real radio flow against source, with external I/O blocked by its spec. */
export default defineConfig({
    testDir: './e2e',
    testMatch: 'radio-console-flow.spec.ts',
    outputDir: join(tmpdir(), 'thalassa-radio-e2e'),
    workers: 2,
    timeout: 60_000,
    expect: { timeout: 15_000 },
    reporter: 'list',
    use: { baseURL: 'http://127.0.0.1:4198', screenshot: 'only-on-failure' },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: { args: ['--use-angle=swiftshader'] },
            },
        },
        { name: 'webkit', use: { ...devices['iPhone 13'] } },
    ],
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 4198 --strictPort',
        url: 'http://127.0.0.1:4198',
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
