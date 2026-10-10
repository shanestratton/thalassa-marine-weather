import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sourceLayoutConfig from './playwright.keyboard.config';

/** Source-only fixture; no build, live account, provider or boat connection. */
export default defineConfig({
    ...sourceLayoutConfig,
    // Screen 1 and All places; the stop page's routing cases (127-PYD-2, 3, 11) in their own spec.
    testMatch: ['day-planner-layout.spec.ts', 'day-planner-route.spec.ts'],
    outputDir: process.env.CI ? 'test-results/day-planner' : join(tmpdir(), 'thalassa-day-planner-e2e'),
    workers: 1,
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 4199 --strictPort',
        url: 'http://127.0.0.1:4199/e2e/fixtures/day-planner.html',
        reuseExistingServer: false,
        env: {
            VITE_SUPABASE_URL: 'https://day-planner-fixture.invalid',
            VITE_SUPABASE_ANON_KEY: 'synthetic-fixture-key-not-a-credential',
        },
        timeout: 60_000,
    },
});
