import { test, expect, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

// Exercise the packaged application with a deliberately stale location label,
// no real account, no hardware GPS and no access to any external service.
test.use({
    serviceWorkers: 'block',
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
        });
    },
});

async function openWithoutReceivers(page: Page, baseURL: string) {
    await page.setViewportSize({ width: 390, height: 844 });
    const origin = new URL(baseURL).origin;
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        const staticRead =
            url.origin === origin &&
            ['GET', 'HEAD'].includes(route.request().method()) &&
            !url.pathname.startsWith('/api/') &&
            !url.pathname.startsWith('/functions/');
        return staticRead ? route.continue() : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.addInitScript(() => {
        localStorage.setItem('thalassa_split_view', '0');
        localStorage.setItem('thalassa_weather_follow_target::anonymous', 'phone');
        localStorage.removeItem('thalassa_weather_last_boat_fix::anonymous');
        for (const key of ['thalassa_settings_mirror::anonymous', 'CapacitorStorage.thalassa_settings::anonymous']) {
            const saved = JSON.parse(localStorage.getItem(key)!);
            saved.settings.defaultLocation = 'Current Location';
            // This legacy phone/home-port point must never become vessel GPS.
            saved.settings.defaultLocationCoords = { lat: -33.8688, lon: 151.2093 };
            saved.settings.displayMode = 'dark';
            localStorage.setItem(key, JSON.stringify(saved));
        }
        const denyPosition = (_success: PositionCallback, error?: PositionErrorCallback | null) => {
            queueMicrotask(() =>
                error?.({
                    code: 1,
                    message: 'GPS disabled in source-selection regression',
                    PERMISSION_DENIED: 1,
                    POSITION_UNAVAILABLE: 2,
                    TIMEOUT: 3,
                }),
            );
        };
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                getCurrentPosition: denyPosition,
                watchPosition: (success: PositionCallback, error?: PositionErrorCallback | null) => {
                    denyPosition(success, error);
                    return 0;
                },
                clearWatch: () => undefined,
            },
        });
    });
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Navigate to The Glass', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    await expect(page.getByRole('button', { name: 'Saved locations', exact: true })).toBeVisible();
}

async function chooseReceiver(page: Page, target: 'phone' | 'boat') {
    await page.getByRole('button', { name: 'Saved locations', exact: true }).click();
    if (target === 'boat') {
        await page.getByTestId('location-star-vessel').click();
    } else {
        await page.getByRole('menuitem', { name: 'Current Location', exact: true }).click();
    }
    await expect(page.getByRole('menu', { name: 'Saved locations', exact: true })).toHaveCount(0);
}

async function expectUnavailable(page: Page, target: 'phone' | 'boat') {
    const label = `${target === 'phone' ? 'Phone' : 'Boat'} GPS unavailable`;
    const location = page.getByRole('textbox', { name: 'Current location', exact: true });
    await expect(location).toHaveValue(label);
    await expect(location).not.toHaveValue(/Sydney/);
    await expect(page.getByRole('heading', { name: "Couldn't update conditions", exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry loading weather data', exact: true })).toBeInViewport();
    await expect
        .poll(() => page.evaluate(() => localStorage.getItem('thalassa_weather_follow_target::anonymous')))
        .toBe(target);
}

test('phone and vessel selections stay unavailable instead of reusing Sydney, including Retry', async ({
    page,
    baseURL,
}) => {
    test.setTimeout(60_000);
    await openWithoutReceivers(page, baseURL!);
    await chooseReceiver(page, 'phone');
    await expectUnavailable(page, 'phone');

    await chooseReceiver(page, 'boat');
    await expectUnavailable(page, 'boat');
    await page.getByRole('button', { name: 'Retry loading weather data', exact: true }).click();
    await expectUnavailable(page, 'boat');

    await chooseReceiver(page, 'phone');
    await expectUnavailable(page, 'phone');
    await page.getByRole('button', { name: 'Retry loading weather data', exact: true }).click();
    await expectUnavailable(page, 'phone');
});

test('the latest receiver selection survives the ordinary follow tick with both receivers unavailable', async ({
    page,
    baseURL,
}) => {
    test.setTimeout(60_000);
    await openWithoutReceivers(page, baseURL!);
    await chooseReceiver(page, 'boat');
    await chooseReceiver(page, 'phone');
    await expectUnavailable(page, 'phone');
    // A stale callback or the next five-second follower must not restore the
    // previous vessel choice or the cached Sydney label after these assertions.
    await page.waitForTimeout(5_500);
    await expectUnavailable(page, 'phone');
});
