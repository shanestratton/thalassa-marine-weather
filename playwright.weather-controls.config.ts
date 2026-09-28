import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sourceLayoutConfig from './playwright.keyboard.config';

export default defineConfig({
    ...sourceLayoutConfig,
    // Exercises every model and layer plus nested key scrolling in one journey.
    timeout: 60_000,
    testMatch: ['weather-controls-layout.spec.ts', 'obs-layer-key-layout.spec.ts'],
    outputDir: process.env.CI ? 'test-results/weather-controls' : join(tmpdir(), 'thalassa-weather-controls-e2e'),
    use: { ...sourceLayoutConfig.use, baseURL: 'http://127.0.0.1:4203' },
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 4203 --strictPort',
        url: 'http://127.0.0.1:4203/e2e/fixtures/weather-controls.html',
        reuseExistingServer: false,
        timeout: 60_000,
    },
});
