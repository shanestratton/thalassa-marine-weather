import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sourceLayoutConfig from './playwright.keyboard.config';

export default defineConfig({
    ...sourceLayoutConfig,
    testMatch: ['helm-stacking.spec.ts'],
    outputDir: process.env.CI ? 'test-results/helm-stacking' : join(tmpdir(), 'thalassa-helm-stacking-e2e'),
    use: { ...sourceLayoutConfig.use, baseURL: 'http://127.0.0.1:4204' },
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 4204 --strictPort',
        url: 'http://127.0.0.1:4204/e2e/fixtures/helm-stacking.html',
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
