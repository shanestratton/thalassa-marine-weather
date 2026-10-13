import { test, expect, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

/**
 * Tablets and wide windows start with The Glass beside Obs (Shane 2026-10-13,
 * build 128): "from the moment they start the app, if it is in the correct size
 * and if it is in landscape". Portrait or narrower opens as today; rotating
 * afterwards keeps the split's own rules; Settings → Preferences can switch the
 * start off. The chart is ONE kept-alive Mapbox map through all of it, moved
 * over the right pane and never mounted twice (fab4590c).
 */
test.use({
    serviceWorkers: 'block',
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
        });
    },
});

/** 'unset' is a skipper who never touched the switch: the default. */
type StartSwitch = 'unset' | 'on' | 'off';

async function coldStart(page: Page, baseURL: string, width: number, height: number, start: StartSwitch = 'unset') {
    await page.setViewportSize({ width, height });
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
    await page.addInitScript((start) => {
        // The hold's own saved choice: closed last time.
        localStorage.setItem('thalassa_split_view', '0');
        for (const key of ['thalassa_settings_mirror::anonymous', 'CapacitorStorage.thalassa_settings::anonymous']) {
            const saved = JSON.parse(localStorage.getItem(key)!);
            saved.settings.displayMode = 'dark';
            if (start === 'unset') delete saved.settings.glassBesideChartAtStart;
            else saved.settings.glassBesideChartAtStart = start === 'on';
            localStorage.setItem(key, JSON.stringify(saved));
        }
        const deny = (_ok: PositionCallback, error?: PositionErrorCallback | null) =>
            queueMicrotask(() =>
                error?.({
                    code: 1,
                    message: 'GPS off in this test',
                    PERMISSION_DENIED: 1,
                    POSITION_UNAVAILABLE: 2,
                    TIMEOUT: 3,
                }),
            );
        Object.defineProperty(navigator, 'geolocation', {
            configurable: true,
            value: {
                getCurrentPosition: deny,
                watchPosition: (ok: PositionCallback, error?: PositionErrorCallback | null) => {
                    deny(ok, error);
                    return 0;
                },
                clearWatch: () => undefined,
            },
        });
    }, start);
    await page.goto('/');
    await expect(nav(page)).toBeVisible();
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main', exact: true });
const tab = (page: Page, name: string) => nav(page).getByRole('button', { name, exact: true });
const canvases = (page: Page) => page.locator('canvas.mapboxgl-canvas');

async function expectGlassBesideObs(page: Page, width: number) {
    await expect(page.locator('[data-split-pane="glass"]')).toBeVisible();
    await expect(page.locator('[data-split-pane="chart"]')).toBeVisible();
    await expect(tab(page, 'The Glass')).toHaveAttribute('aria-current', 'page');
    await expect(tab(page, 'Obs')).toHaveAttribute('aria-current', 'page');
    await expect(canvases(page)).toHaveCount(1, { timeout: 30_000 });
    // The Glass on the left half, the chart over the right.
    const glass = (await page.locator('[data-split-pane="glass"]').boundingBox())!;
    const chart = (await page.locator('[data-split-pane="chart"]').boundingBox())!;
    expect(glass.x).toBeLessThan(width / 2);
    expect(chart.x).toBeGreaterThanOrEqual(glass.x + glass.width - 1);
    expect(chart.x + chart.width).toBeLessThanOrEqual(width + 1);
    expect(chart.width).toBeGreaterThan(width * 0.35);
}

async function expectTodaysStart(page: Page) {
    await expect(tab(page, 'The Glass')).toHaveAttribute('aria-current', 'page');
    await expect(tab(page, 'Obs')).not.toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-split-pane]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Saved locations', exact: true })).toBeVisible();
    // The chart is not even started: today's cold open paints The Glass alone.
    await expect(canvases(page)).toHaveCount(0);
}

for (const size of [
    { name: 'an iPad (iPad12,1) in landscape', width: 1080, height: 810 },
    { name: 'a 12.9-inch iPad in landscape', width: 1366, height: 1024 },
]) {
    test(`a cold start on ${size.name}, ${size.width} x ${size.height}, opens The Glass beside Obs`, async ({
        page,
        baseURL,
    }) => {
        test.setTimeout(90_000);
        await coldStart(page, baseURL!, size.width, size.height);
        await expectGlassBesideObs(page, size.width);
        // The start pins the split for this run; the hold's saved choice is untouched.
        expect(await page.evaluate(() => localStorage.getItem('thalassa_split_view'))).toBe('0');
    });
}

for (const size of [
    { name: 'an iPad in portrait', width: 810, height: 1080 },
    { name: 'a phone', width: 390, height: 844 },
]) {
    test(`a cold start on ${size.name}, ${size.width} x ${size.height}, opens as today`, async ({ page, baseURL }) => {
        test.setTimeout(90_000);
        await coldStart(page, baseURL!, size.width, size.height);
        await expectTodaysStart(page);
    });
}

test('with the switch off, a landscape iPad opens as today', async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await coldStart(page, baseURL!, 1080, 810, 'off');
    await expectTodaysStart(page);
});

test('straight after the app died in the foreground, a landscape iPad opens The Glass alone (no crash loop into the chart)', async ({
    page,
    baseURL,
}) => {
    test.setTimeout(90_000);
    // The last session's flag, still up: it was killed on the Log a minute ago.
    await page.addInitScript(() => {
        const before = Date.now() - 60_000;
        localStorage.setItem('thalassa.lastView', JSON.stringify({ view: 'details', at: before }));
        localStorage.setItem('thalassa.sessionOpen', JSON.stringify({ at: before, view: 'details', build: null }));
    });
    await coldStart(page, baseURL!, 1080, 810);
    await expectTodaysStart(page);
    // The session watch booked the death to the Log, where it happened.
    await expect
        .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('thalassa.abnormalExits') || 'null')?.view))
        .toBe('details');
});

test('started in portrait, turning to landscape keeps the split closed (today’s rules)', async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    await coldStart(page, baseURL!, 810, 1080);
    await expectTodaysStart(page);
    await page.setViewportSize({ width: 1080, height: 810 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await expect(page.locator('[data-split-pane]')).toHaveCount(0);
    await expect(tab(page, 'The Glass')).toHaveAttribute('aria-current', 'page');
});

test('one map from the split start through portrait, back to landscape, and a hold that closes the split', async ({
    page,
    baseURL,
}) => {
    test.setTimeout(120_000);
    await coldStart(page, baseURL!, 1080, 810, 'on');
    await expectGlassBesideObs(page, 1080);
    // Tag the one canvas: if it is ever remounted, the tag is gone.
    await canvases(page).evaluate((canvas) => canvas.setAttribute('data-tidy128', 'first'));

    // Turn to portrait: the split collapses and Obs fills the screen.
    await page.setViewportSize({ width: 810, height: 1080 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await expect(page.locator('[data-split-pane="glass"]')).toHaveCount(0);
    await expect(tab(page, 'Obs')).toHaveAttribute('aria-current', 'page');
    await expect(tab(page, 'The Glass')).not.toHaveAttribute('aria-current', 'page');
    await expect(canvases(page)).toHaveCount(1);
    await expect(page.locator('canvas.mapboxgl-canvas[data-tidy128="first"]')).toBeVisible();

    // Back to landscape: the split comes back, the same map on the right.
    await page.setViewportSize({ width: 1080, height: 810 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await expectGlassBesideObs(page, 1080);
    await expect(page.locator('canvas.mapboxgl-canvas[data-tidy128="first"]')).toHaveCount(1);

    // A hold on The Glass closes the split, as it always has, and saves that.
    const glass = tab(page, 'The Glass');
    const box = (await glass.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    await expect(page.locator('[data-split-pane="glass"]')).toHaveCount(0);
    await expect(tab(page, 'Obs')).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => localStorage.getItem('thalassa_split_view'))).toBe('0');
    await expect(canvases(page)).toHaveCount(1);
    await expect(page.locator('canvas.mapboxgl-canvas[data-tidy128="first"]')).toHaveCount(1);

    // And a second hold opens it again (to the Log, today's rule from the chart).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(650);
    await page.mouse.up();
    await expect(page.locator('[data-split-pane="glass"]')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('thalassa_split_view'))).toBe('1');
    await expect(canvases(page)).toHaveCount(1);
    await expect(page.locator('canvas.mapboxgl-canvas[data-tidy128="first"]')).toHaveCount(1);
});
