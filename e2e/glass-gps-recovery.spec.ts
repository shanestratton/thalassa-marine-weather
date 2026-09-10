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

interface StartupGps {
    requests: number;
    successes: number;
    timeouts: number;
    finish: (outcome: 'live' | 'timeout') => void;
}

for (const outcome of ['live', 'timeout'] as const) {
    test(`Glass keeps cold-start phone acquisition neutral until the receiver returns ${outcome}`, async ({
        page,
        baseURL,
    }, testInfo) => {
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
            for (const key of [
                'thalassa_settings_mirror::anonymous',
                'CapacitorStorage.thalassa_settings::anonymous',
            ]) {
                const saved = JSON.parse(localStorage.getItem(key)!);
                saved.settings.defaultLocation = 'Current Location';
                // Neither a saved coordinate nor a forecast cache proves that
                // this newly started receiver has acquired its first fix.
                saved.settings.defaultLocationCoords = { lat: -33.8688, lon: 151.2093 };
                saved.settings.displayMode = 'dark';
                localStorage.setItem(key, JSON.stringify(saved));
            }
            const key = 'thalassa_weather_cache_v9::anonymous';
            const weather = JSON.parse(localStorage.getItem(key)!);
            weather.generatedAt = new Date().toISOString();
            localStorage.setItem(key, JSON.stringify(weather));

            let phase: 'pending' | 'live' | 'timeout' = 'pending';
            const pending: (() => void)[] = [];
            const gps: StartupGps = {
                requests: 0,
                successes: 0,
                timeouts: 0,
                finish(outcome) {
                    phase = outcome;
                    for (const deliver of pending.splice(0)) queueMicrotask(deliver);
                },
            };
            (window as unknown as { __startupGps: StartupGps }).__startupGps = gps;
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
                gps.requests++;
                const deliver = () => {
                    if (phase === 'timeout') {
                        gps.timeouts++;
                        failure?.({
                            code: 3,
                            message: 'Controlled first-fix timeout',
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
                };
                if (phase === 'pending') pending.push(deliver);
                else queueMicrotask(deliver);
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
        await expect
            .poll(() => page.evaluate(() => (window as unknown as { __startupGps: StartupGps }).__startupGps.requests))
            .toBeGreaterThan(0);

        const location = page.getByRole('textbox', { name: 'Current location', exact: true });
        const pending = page.getByTestId('weather-position-resolving');
        const metrics = page.getByRole('region', { name: 'Weather metrics dashboard', exact: true });
        const fullScreenFailure = page.getByRole('heading', { name: "Couldn't update conditions", exact: true });
        await expect(location).toHaveValue('Finding phone location…');
        await expect(pending).toBeVisible();
        await expect(pending).toHaveText('Finding phone location…');
        await expect(fullScreenFailure).toHaveCount(0);
        await expect(page.getByTestId('weather-position-retry')).toHaveCount(0);
        await expect(metrics).toHaveCount(0);

        await page.getByRole('button', { name: /^System status:/ }).click();
        const source = page.getByTestId('gps-source-row');
        await expect(source).toContainText('finding this phone’s GPS location');
        await expect(source).toHaveAttribute('data-glyph', 'phone');
        await expect(source).toHaveAttribute('data-tone', 'none');
        await expect(source).not.toContainText(/unavailable|live|boat/);
        await page.getByRole('button', { name: 'Close system status', exact: true }).click();
        await expect(pending).toBeVisible();
        expect(
            await page.evaluate(() => {
                const gps = (window as unknown as { __startupGps: StartupGps }).__startupGps;
                return { successes: gps.successes, timeouts: gps.timeouts };
            }),
        ).toEqual({ successes: 0, timeouts: 0 });
        if (outcome === 'live' && testInfo.project.name === 'mobile-safari') {
            await page.screenshot({ path: testInfo.outputPath('cold-start-pending.png'), fullPage: true });
        }

        // The first receiver callback is released only after the pending UI
        // has been checked. No store/context or weather position is injected.
        await page.evaluate((result) => {
            (window as unknown as { __startupGps: StartupGps }).__startupGps.finish(result);
        }, outcome);
        await expect(pending).toHaveCount(0);
        if (outcome === 'live') {
            await expect(metrics).toBeVisible();
            // External geocoding is blocked, so the acquired point is named
            // by its coordinates while the matching forecast remains usable.
            await expect(location).toHaveValue('33.8688°S, 151.2093°E');
            await expect(fullScreenFailure).toHaveCount(0);
            await expect(page.getByTestId('weather-position-retry')).toHaveCount(0);
            if (testInfo.project.name === 'mobile-safari') {
                await page.screenshot({ path: testInfo.outputPath('cold-start-recovered.png'), fullPage: true });
            }
        } else {
            await expect(location).toHaveValue('Phone GPS unavailable');
            await expect(fullScreenFailure).toBeVisible();
            await expect(page.getByRole('button', { name: 'Retry loading weather data', exact: true })).toBeVisible();
            await expect(metrics).toHaveCount(0);
        }
        await page.getByRole('button', { name: /^System status:/ }).click();
        await expect(source).toHaveAttribute('data-glyph', 'phone');
        await expect(source).toHaveAttribute('data-tone', outcome === 'live' ? 'phone' : 'none');
        await expect(source).toContainText(outcome === 'live' ? 'this phone’s GPS' : 'this phone’s GPS unavailable');
        await expect(source).not.toContainText(/finding|boat/);
    });
}

test('Glass keeps same-location weather and layout through GPS timeout, then recovers automatically', async ({
    page,
    baseURL,
}, testInfo) => {
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
    await page.screenshot({ path: testInfo.outputPath('retained-weather.png'), fullPage: true });

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
