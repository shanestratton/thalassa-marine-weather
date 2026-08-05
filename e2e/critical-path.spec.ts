import { test, expect, type Page } from '@playwright/test';
import { DISCLAIMER_STORAGE, ONBOARDED_STORAGE } from './helpers/storageState';

async function openMobDirectlyFromChart(page: Page) {
    await page.goto('/');

    const chartsTab = page.getByRole('tab', { name: 'Navigate to Charts' });
    await expect(chartsTab).toBeEnabled();
    await chartsTab.click();
    await expect(chartsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('map-hub')).toBeVisible({ timeout: 30_000 });

    // MOB is a direct chart action: the skipper must not first discover or
    // open the layer menu in an emergency.
    await expect(page.getByRole('menu', { name: 'Map overlay categories' })).toHaveCount(0);
    const chartMob = page.getByRole('button', { name: 'Open Man Overboard emergency' });
    await expect(chartMob).toBeVisible();
    await chartMob.click();
    await expect(page.getByRole('heading', { name: 'Man Overboard' })).toBeVisible();
}

test.describe('Critical Path', () => {
    test.use({ storageState: DISCLAIMER_STORAGE });

    test('anonymous first run reaches the useful empty state', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Use my location' })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Choose a port on the map' })).toBeEnabled();
    });

    test('anonymous browsing exposes the primary navigation', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('tablist', { name: 'Main navigation' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Navigate to Charts' })).toBeEnabled();
    });

    test('anonymous user can move from the Glass to Charts', async ({ page }) => {
        await page.goto('/');
        const chartsTab = page.getByRole('tab', { name: 'Navigate to Charts' });
        await chartsTab.click();
        await expect(chartsTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#main-content')).toBeVisible();
    });
});

test.describe('Chart MOB emergency journey', () => {
    // The chart mounts a live-location subscriber. Keep the GPS journey behind
    // the discoverability journey within each browser project so two contexts
    // cannot race the browser process's single emulated location provider.
    test.describe.configure({ mode: 'serial' });
    test.use({ storageState: ONBOARDED_STORAGE });

    test('keeps the one-tap chart MOB entry discoverable', async ({ page }) => {
        test.setTimeout(60_000);
        await openMobDirectlyFromChart(page);

        await expect(page.getByRole('button', { name: 'Activate Man Overboard' })).toBeVisible();
    });

    test.describe('browser GPS integration', () => {
        test.use({
            permissions: ['geolocation'],
            // Start with a deliberately poor but usable fix. This exercises
            // the real web GPS boundary while keeping the production-like run
            // independent of the host machine's location hardware.
            geolocation: { latitude: -27.4698, longitude: 153.0251, accuracy: 250 },
        });

        test('marks and refines an approximate MOB fix', async ({ page, context, browserName }) => {
            test.setTimeout(60_000);
            // Playwright WebKit does not treat its local HTTP preview as a
            // secure context, so the application correctly refuses web
            // geolocation there. A hosted HTTPS WebKit run is eligible; native
            // iOS GPS is covered by the MobService integration suite.
            test.skip(
                browserName === 'webkit' && !process.env.PREVIEW_URL,
                'Local Playwright WebKit has no secure geolocation context.',
            );
            await openMobDirectlyFromChart(page);

            // Refresh and observe the emulated provider immediately before
            // the emergency tap. This also proves the browser boundary itself.
            const appOrigin = new URL(process.env.PREVIEW_URL ?? 'http://127.0.0.1:4173').origin;
            await context.grantPermissions(['geolocation'], { origin: appOrigin });
            await context.setGeolocation({ latitude: -27.4698, longitude: 153.0251, accuracy: 250 });
            const browserFix = await page.evaluate(
                () =>
                    new Promise<{ accuracy: number }>((resolve, reject) => {
                        navigator.geolocation.getCurrentPosition(
                            (position) => resolve({ accuracy: position.coords.accuracy }),
                            (error) =>
                                reject(new Error(`Browser geolocation failed (${error.code}): ${error.message}`)),
                            { enableHighAccuracy: true, timeout: 10_000, maximumAge: 15_000 },
                        );
                    }),
            );
            expect(browserFix.accuracy).toBe(250);
            await page.getByRole('button', { name: 'Activate Man Overboard' }).click();

            await expect(page.getByRole('heading', { name: 'MOB ACTIVE' })).toBeVisible();
            await expect(page.getByText('Approximate search area')).toBeVisible();
            await expect(page.getByRole('alert').filter({ hasText: 'APPROXIMATE MOB MARK' })).toContainText(
                '±250 m uncertainty',
            );

            // The service listens for a better fix for 30 seconds after the
            // mark. This update drives that real watcher and proves the
            // emergency changes from an honest uncertainty warning to a
            // precise datum without requiring native GPS hardware.
            await context.setGeolocation({ latitude: -27.4697, longitude: 153.0252, accuracy: 20 });

            await expect(page.getByText('Return to fix')).toBeVisible();
            await expect(page.getByRole('alert').filter({ hasText: 'APPROXIMATE MOB MARK' })).toHaveCount(0);
            await expect(page.getByText('MOB Fix').locator('..')).toContainText('±20m');
            await expect(page.getByRole('button', { name: 'Hold to clear MOB' })).toBeVisible();
        });
    });
});
