import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sourceLayoutConfig from './playwright.keyboard.config';

/** Source-only grid verification; separate port from the other layout suites. */
export default defineConfig({
    ...sourceLayoutConfig,
    testMatch: ['stores-category-grid-layout.spec.ts'],
    outputDir: process.env.CI ? 'test-results/stores' : join(tmpdir(), 'thalassa-stores-e2e'),
    use: { ...sourceLayoutConfig.use, baseURL: 'http://127.0.0.1:4201' },
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 4201 --strictPort',
        url: 'http://127.0.0.1:4201/e2e/fixtures/stores-category-grid.html',
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
