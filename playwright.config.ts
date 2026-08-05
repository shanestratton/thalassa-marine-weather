import { defineConfig, devices } from '@playwright/test';

const hostedPreviewUrl = process.env.PREVIEW_URL?.trim();
const localReleaseUrl = 'http://127.0.0.1:4173';
const requireHostedPreview = process.env.REQUIRE_HOSTED_PREVIEW === 'true';

if (requireHostedPreview && !hostedPreviewUrl) {
    throw new Error('REQUIRE_HOSTED_PREVIEW is true but PREVIEW_URL is empty. Refusing to test localhost.');
}
if (hostedPreviewUrl && !hostedPreviewUrl.startsWith('https://')) {
    throw new Error('PREVIEW_URL must use HTTPS.');
}

export default defineConfig({
    testDir: './e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [['list'], ['html', { open: 'never' }]],
    timeout: 30_000,
    // Vite transforms the chart and community chunks lazily. Under the full
    // four-worker desktop/mobile matrix, a cold WebKit load can legitimately
    // cross Playwright's 5s assertion default even though the UI is healthy.
    // Keep individual tests bounded while giving visible-state assertions a
    // deterministic budget that matches the app's lazy-loading architecture.
    expect: {
        timeout: 15_000,
    },

    use: {
        baseURL: hostedPreviewUrl || localReleaseUrl,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },

    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                // The app's chart is a real WebGL surface. Playwright's bundled
                // Chromium has WebGL disabled by default in this environment,
                // so use its software ANGLE backend for deterministic coverage.
                // Keep this Chromium-only: WebKit does not understand ANGLE's
                // command-line switches.
                launchOptions: {
                    args: ['--use-angle=swiftshader'],
                },
            },
        },
        {
            name: 'mobile-safari',
            use: { ...devices['iPhone 13'] },
        },
    ],

    // Normal release E2E serves the already-built immutable `dist` artifact.
    // Hosted-preview smoke tests use their absolute deployment URL and must not
    // boot or accidentally validate a second localhost development server.
    webServer: hostedPreviewUrl
        ? undefined
        : {
              command: 'npm run preview -- --host 127.0.0.1 --strictPort',
              url: localReleaseUrl,
              reuseExistingServer: false,
              timeout: 120_000,
          },
});
