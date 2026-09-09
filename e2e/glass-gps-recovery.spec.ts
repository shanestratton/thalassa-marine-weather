import { expect, test } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

// Exercise the packaged app's real location/forecast state machines. Only the
// browser receiver and cache are controlled; no app store/context is patched.
test.use({
    serviceWorkers: 'block',
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
        });
    },
});

interface ControlledGps {
    phase: 'live' | 'timeout';
    successes: number;
    timeouts: number;
}

test('Glass keeps same-location weather and layout through GPS timeout, then recovers automatically', async ({
    page,
    baseURL,
}) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const origin = new URL(baseURL!).origin;
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
        for (const key of [
            'thalassa_glass_tutorial_seen',
            'thalassa_tutorial_completed',
            'thalassa_onboarding_complete',
        ]) {
            localStorage.setItem(`${key}::anonymous`, 'true');
        }
        for (const key of ['thalassa_settings_mirror::anonymous', 'CapacitorStorage.thalassa_settings::anonymous']) {
            const saved = JSON.parse(localStorage.getItem(key)!);
            saved.settings.defaultLocation = 'Current Location';
            delete saved.settings.defaultLocationCoords;
            saved.settings.displayMode = 'dark';
            localStorage.setItem(key, JSON.stringify(saved));
        }
        // Keep the cache fresh at execution time, not when the runner imported
        // the shared fixture. Coordinates exactly match our genuine phone fix.
        const key = 'thalassa_weather_cache_v9::anonymous';
        const weather = JSON.parse(localStorage.getItem(key)!);
        weather.generatedAt = new Date().toISOString();
        localStorage.setItem(key, JSON.stringify(weather));

        const gps: ControlledGps = { phase: 'live', successes: 0, timeouts: 0 };
        (window as unknown as { __glassGps: ControlledGps }).__glassGps = gps;
        Object.defineProperty(navigator, 'permissions', {
            configurable: true,
            value: {
                query: async () => ({
                    state: 'granted',
                    onchange: null,
                    addEventListener() {},
                    removeEventListener() {},
                    dispatchEvent: () => true,
                }),
            },
        });
        const readPosition = (success: PositionCallback, failure?: PositionErrorCallback | null) => {
            queueMicrotask(() => {
                if (gps.phase === 'timeout') {
                    gps.timeouts++;
                    failure?.({
                        code: 3,
                        message: 'Controlled transient GPS timeout',
                        PERMISSION_DENIED: 1,
                        POSITION_UNAVAILABLE: 2,
                        TIMEOUT: 3,
                    });
                    return;
                }
                gps.successes++;
                success({
                    coords: {
                        latitude: -33.8688,
                        longitude: 151.2093,
                        accuracy: 5,
                        altitude: null,
                        altitudeAccuracy: null,
                        heading: null,
                        speed: 0,
                        toJSON: () => ({}),
                    },
                    timestamp: Date.now(),
                    toJSON: () => ({}),
                });
            });
        };
        let watchId = 0;
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                getCurrentPosition: readPosition,
                watchPosition: (success: PositionCallback, failure?: PositionErrorCallback | null) => {
                    readPosition(success, failure);
                    return ++watchId;
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
    const location = page.getByRole('textbox', { name: 'Current location', exact: true });
    const metrics = page.getByRole('region', { name: 'Weather metrics dashboard', exact: true });
    const retry = page.getByTestId('weather-position-retry');
    const fullScreenFailure = page.getByRole('heading', { name: "Couldn't update conditions", exact: true });
    await expect(location).toBeVisible();
    await expect(metrics).toBeVisible();

    // Verify the cache is not the only thing on screen: the real weather
    // context has accepted this phone as its selected, working receiver.
    await page.getByRole('button', { name: /^System status:/ }).click();
    await expect(page.getByTestId('gps-source-row')).toContainText('this phone’s GPS');
    await expect(page.getByTestId('gps-source-row')).not.toContainText('unavailable');
    await page.getByRole('button', { name: 'Close system status', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'System Status', exact: true })).toHaveCount(0);
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { __glassGps: ControlledGps }).__glassGps.successes))
        .toBeGreaterThan(0);
    await expect(location).not.toHaveValue(/^Last location/);
    await expect(retry).toHaveCount(0);
    const locationBefore = await location.inputValue();
    const metricsBefore = await metrics.textContent();
    const heightBefore = (await location.boundingBox())!.height;

    await page.evaluate(() => {
        (window as unknown as { __glassGps: ControlledGps }).__glassGps.phase = 'timeout';
    });
    await expect(location).toHaveValue(`Last location · ${locationBefore}`);
    await expect(retry).toBeVisible();
    await expect(retry).toHaveAccessibleName(
        /Phone GPS unavailable.*Showing forecast for last location.*Retrying automatically/,
    );
    await expect(metrics).toBeVisible();
    await expect(metrics).toHaveText(metricsBefore!);
    await expect(fullScreenFailure).toHaveCount(0);
    expect(Math.abs((await location.boundingBox())!.height - heightBefore)).toBeLessThanOrEqual(1);
    const retryBox = (await retry.boundingBox())!;
    const locationBox = (await location.boundingBox())!;
    expect(retryBox.y).toBeGreaterThanOrEqual(locationBox.y - 1);
    expect(retryBox.y + retryBox.height).toBeLessThanOrEqual(locationBox.y + locationBox.height + 1);

    // A still-failing manual retry stays compact and keeps the existing cards.
    const failuresBefore = await page.evaluate(
        () => (window as unknown as { __glassGps: ControlledGps }).__glassGps.timeouts,
    );
    await retry.click();
    await expect
        .poll(() => page.evaluate(() => (window as unknown as { __glassGps: ControlledGps }).__glassGps.timeouts))
        .toBeGreaterThan(failuresBefore);
    await expect(location).toHaveValue(`Last location · ${locationBefore}`);
    await expect(metrics).toHaveText(metricsBefore!);
    await expect(fullScreenFailure).toHaveCount(0);

    await page.evaluate(() => {
        (window as unknown as { __glassGps: ControlledGps }).__glassGps.phase = 'live';
    });
    await expect(retry).toHaveCount(0);
    await expect(location).toHaveValue(locationBefore);
    await expect(metrics).toBeVisible();
    await expect(metrics).toHaveText(metricsBefore!);
    await expect(fullScreenFailure).toHaveCount(0);
    expect(Math.abs((await location.boundingBox())!.height - heightBefore)).toBeLessThanOrEqual(1);
});
