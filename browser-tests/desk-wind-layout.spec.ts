/**
 * Wind on the desk (127-DESKMAP-b). Shane 2026-10-10: "can we include the
 * wind layer on the desktop.?? as an option??". The weather rules: "Name
 * whichever models you actually used" and "Where models disagree, say so."
 *
 * The real app's web planner (the tracer), offline: tiles from made-up
 * coastlines (e2e/helpers/syntheticChartTiles.ts) and a stubbed
 * proxy-openmeteo answering fictional JSON. 12 kt from the south-east south of
 * the map's middle, 26 kt north of it, 48 hourly frames; and a fictional
 * seven-model comparison. No live proxy, no key: the stub is the edge function.
 *
 *  - the Wind row: offered at 1440, 1024 and 768 px, OFF; one click turns it
 *    on without moving the camera or blinking the seamarks; a reload turns it
 *    off; at 390 px there is no row;
 *  - the panel stands bottom right, clear of every control on the planner;
 *  - strip slot 2 names the model and its licence, UKMO as CC BY-SA;
 *  - Light: the streaks are dark ink, drawn normally (128-LIGHT), reaching 3:1
 *    on the sea beside them (land masked out): slate at 12 kt, red at 26 kt,
 *    to the streaks' soft edges; Relief + Sat,
 *    switched to with the wind running: white, as on Obs, reaching 3:1 on a
 *    genuinely dark sea (the fixture's deep west of Lisbon, seen darker than
 *    Relief's plain water), land masked out;
 *  - the models' agreement: split off the Solent, agree off Noumea, not known
 *    when the comparison answers 503.
 *
 * The desk is a desktop browser: Desktop Chrome, and in WebKit Desktop Safari
 * (DPR 2, no touch), not the WebKit project's iPhone 13. The two streak-pixel
 * tests are tagged @pixel: the keyboard shards leave them out
 * (--grep-invert @pixel) and one serial step runs them, as
 * `npx playwright test --config playwright.keyboard.config.ts --grep @pixel --workers=1 --retries=1`.
 *
 * DESK_WIND_SHOTS_DIR also saves the screenshots there (before/after evidence).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { devices, expect, test, type Browser, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
    compositeTile,
    depthAt,
    fixtureStyle,
    imageryTile,
    isLand,
    reliefTile,
    seamarkTile,
} from '../e2e/helpers/syntheticChartTiles';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';
import { tapPlanTab } from './helpers/planTab';
import { captureWindPair, cropPixelPair, measurePixelPair, saveCapturedPair } from './helpers/windPixelCapture';

const SHOTS = process.env.DESK_WIND_SHOTS_DIR?.trim() || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** The app's chart, as MapHub exposes it to the browser tests. */
type ThalassaMap = {
    jumpTo(o: { center: [number, number]; zoom: number }): void;
    once(t: string, f: () => void): void;
    getCenter(): { lng: number; lat: number };
    getZoom(): number;
    getLayoutProperty(id: string, prop: string): unknown;
    getLayer(id: string): unknown;
    unproject(point: [number, number]): { lng: number; lat: number };
    getBearing(): number;
    getPitch(): number;
    getContainer(): HTMLElement;
    /** mapbox-gl's own flag, set on 'load': read only to say why a layer is missing. */
    _loaded?: boolean;
};
/** Inlined in each page.evaluate: the browser never sees a Node-side helper. */
type ChartWindow = { __thalassaMap?: ThalassaMap };

// ── The offline network and the fictional weather ──────────────────────
const made = new Map<string, Buffer | null>();
const once = (key: string, make: () => Buffer | null) => {
    if (!made.has(key)) made.set(key, make());
    return made.get(key)!;
};
const KMH_PER_KT = 1.852;
interface Net {
    /** Where the 26 kt band starts (the map's middle latitude when opened). */
    bandLat: number;
    /** The seven-model comparison: 'split' (one model 28 kt), 'agree' (within 2 kt) or an HTTP status. */
    spread: 'split' | 'agree' | number;
    spreadAsks: number;
    /** The wind grid's rows (latitudes) the chart asked for, when a test wants to know where they fell. */
    rows?: Set<number>;
}

async function serve(page: Page, origin: string, net: Net) {
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        // The fixture's synthetic Mapbox service is reachable, including on
        // a native-style phone; no actual WAN request leaves this test.
        if (url.hostname === 'www.gstatic.com' && url.pathname === '/generate_204')
            return route.fulfill({ status: 204 });
        const xyz = (m: RegExpMatchArray, at: number) => [Number(m[at]), Number(m[at + 1]), Number(m[at + 2])] as const;
        if (url.pathname.endsWith('/functions/v1/proxy-openmeteo'))
            return proxy(route.request().postData(), net, route);
        if (url.origin === origin) {
            const m = url.pathname.match(/^\/__log-map-fixture\/composite\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
            if (m) {
                const [z, x, y] = xyz(m, 1);
                return route.fulfill({
                    status: 200,
                    contentType: 'application/x-protobuf',
                    body: once(`mvt/${z}/${x}/${y}`, () => compositeTile(z, x, y))!,
                });
            }
            if (url.pathname.startsWith('/api/')) return route.abort();
            return route.continue();
        }
        if (url.hostname === 'api.mapbox.com' && /^\/styles\/v1\/mapbox\/dark-v11\/?$/.test(url.pathname))
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ...fixtureStyle(origin),
                    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
                }),
            });
        if (url.hostname === 'api.mapbox.com' && /^\/fonts\/v1\/mapbox\/[^/]+\/[^/]+\.pbf$/.test(url.pathname))
            return route.fulfill({ contentType: 'application/x-protobuf', body: Buffer.from([0x0a, 0x00]) });
        if (url.hostname === 'tiles.thalassatiles.com') {
            const m = url.pathname.match(/^\/v1\/relief-(global|au)\/(idx|dem)\/(\d+)\/(\d+)\/(\d+)\.(png|webp)$/);
            if (!m) return route.fulfill({ status: 404 });
            const [z, x, y] = xyz(m, 3);
            const body = once(`${m[1]}-${m[2]}/${z}/${x}/${y}`, () => reliefTile(m[2] as 'idx' | 'dem', z, x, y));
            return body
                ? route.fulfill({ status: 200, contentType: 'image/png', body })
                : route.fulfill({ status: 404 });
        }
        if (url.hostname === 'tiles.openseamap.org') {
            const m = url.pathname.match(/^\/seamark\/(\d+)\/(\d+)\/(\d+)\.png$/);
            if (!m) return route.fulfill({ status: 404 });
            const [z, x, y] = xyz(m, 1);
            return route.fulfill({
                status: 200,
                contentType: 'image/png',
                body: once(`seamark/${z}/${x}/${y}`, () => seamarkTile(z, x, y))!,
            });
        }
        if (url.hostname === 'api.mapbox.com') {
            const m = url.pathname.match(/^\/v4\/mapbox\.satellite\/(\d+)\/(\d+)\/(\d+)(?:@2x)*\.(?:jpg\d*|png|webp)$/);
            if (m) {
                const [z, x, y] = xyz(m, 1);
                return route.fulfill({
                    status: 200,
                    contentType: 'image/png',
                    body: once(`imagery/${z}/${x}/${y}`, () => imageryTile(z, x, y)),
                });
            }
        }
        return route.abort('internetdisconnected');
    });
    await page.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1)/, (socket) => socket.close());
}

/** proxy-openmeteo, as the edge answers it: the wind grid's points, or the seven-model comparison. */
function proxy(body: string | null, net: Net, route: Parameters<Parameters<Page['route']>[1]>[0]) {
    const { operation, params } = JSON.parse(body ?? '{}') as { operation: string; params: Record<string, string> };
    const json = (data: unknown) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    const hourMs = 3_600_000;
    const start = Math.floor(Date.now() / hourMs) * hourMs;
    const models = String(params.models ?? '').split(',');
    if (models.length > 1) {
        net.spreadAsks += 1;
        if (typeof net.spread === 'number') return route.fulfill({ status: net.spread, body: 'busy' });
        const times = Array.from(
            { length: Number(params.forecast_hours) || 240 },
            (_, i) => (start + i * hourMs) / 1000,
        );
        if (operation === 'marine') return json({ hourly: { time: times } });
        const hourly: Record<string, unknown> = { time: times };
        models.forEach((id, k) => {
            const peak = net.spread === 'split' ? (k === models.length - 1 ? 28 : 12) : 14 + (k % 3);
            hourly[`wind_speed_10m_${id}`] = times.map(() => peak);
            hourly[`wind_direction_10m_${id}`] = times.map(() => 135);
        });
        return json({ hourly });
    }
    // The chart's wind grid: one answer per point, km/h as the fetcher reads it.
    const lats = String(params.latitude).split(',').map(Number);
    for (const lat of lats) net.rows?.add(lat);
    const hours = Number(params.forecast_hours) || 48;
    const time = Array.from({ length: hours }, (_, i) => new Date(start + i * hourMs).toISOString().slice(0, 16));
    return json(
        lats.map((lat) => {
            const kmh = (lat >= net.bandLat ? 26 : 12) * KMH_PER_KT;
            return {
                hourly: {
                    time,
                    wind_speed_10m: time.map(() => kmh),
                    wind_direction_10m: time.map(() => 135),
                    wind_gusts_10m: time.map(() => kmh * 1.3),
                },
            };
        }),
    );
}

function storage(baseURL: string) {
    return {
        ...ONBOARDED_STORAGE,
        origins: ONBOARDED_STORAGE.origins.map((origin) => ({
            ...origin,
            origin: new URL(baseURL).origin,
            localStorage: origin.localStorage.map((entry) => {
                if (
                    entry.name !== 'thalassa_settings_mirror::anonymous' &&
                    entry.name !== 'CapacitorStorage.thalassa_settings::anonymous'
                )
                    return entry;
                const saved = JSON.parse(entry.value);
                // A saved dark Obs base on the account, as Shane's: the desk ignores it.
                saved.settings.obsChartBase = 'relief';
                return { ...entry, value: JSON.stringify(saved) };
            }),
        })),
    };
}

/**
 * A desk browser (2026-10-12). The WebKit project is an iPhone 13, and a
 * manual newContext() inherits it: a "1440 × 900 desk" drawn at DPR 3 with
 * touch and an iPhone user agent, which also thins leaflet-velocity's
 * particles. Nobody plans at a desk that way, so in WebKit the desk is Desktop
 * Safari; Chromium's project is already Desktop Chrome. The phone's Obs credit
 * below keeps the iPhone.
 */
const DESKTOP_SAFARI = (({ userAgent, screen, deviceScaleFactor, isMobile, hasTouch }) => ({
    userAgent,
    // Its 1792 × 1120 screen, not the iPhone's 390 × 844 (Playwright's
    // device list carries it; its DeviceDescriptor type leaves it out).
    screen,
    deviceScaleFactor,
    isMobile,
    hasTouch,
}))(devices['Desktop Safari'] as (typeof devices)[string] & { screen: { width: number; height: number } });
const deskContext = (browser: Browser, browserName: string, baseURL: string) =>
    browser.newContext({
        storageState: storage(baseURL),
        serviceWorkers: 'block',
        ...(browserName === 'webkit' ? DESKTOP_SAFARI : {}),
    });

async function openPlanner(page: Page) {
    const { phone, touch, dpr } = await page.evaluate(() => ({
        phone: /iPhone|iPad|Mobile/.test(navigator.userAgent),
        touch: navigator.maxTouchPoints,
        dpr: window.devicePixelRatio,
    }));
    expect({ phone, touch }, 'a desk browser, not a phone').toEqual({ phone: false, touch: 0 });
    expect(dpr, 'a desk screen: 1x or Retina, not a phone’s 3x').toBeLessThanOrEqual(2);
    // One tap; a second only if a cold dev server reloaded the page under it.
    await tapPlanTab(page);
    const start = page.getByRole('button', { name: 'Start plotting', exact: true });
    await start.scrollIntoViewIfNeeded();
    await start.click();
    await page
        .getByRole('dialog', { name: 'Choose routing mode', exact: true })
        .getByRole('button', { name: 'Manual routing', exact: true })
        .click();
    await expect(page.getByTestId('map-hub')).toBeVisible({ timeout: 45_000 });
    await page.waitForFunction(() => !!(window as unknown as ChartWindow).__thalassaMap, null, { timeout: 45_000 });
    await expect(page.getByRole('button', { name: /^Map base: / })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
}

const jump = (page: Page, lon: number, lat: number, zoom: number) =>
    page.evaluate(
        ([x, y, z]) =>
            new Promise<void>((resolve) => {
                const map = (window as unknown as ChartWindow).__thalassaMap!;
                map.once('moveend', () => setTimeout(resolve, 400));
                map.jumpTo({ center: [x, y], zoom: z });
            }),
        [lon, lat, zoom] as const,
    );
const camera = (page: Page) =>
    page.evaluate(() => {
        const map = (window as unknown as ChartWindow).__thalassaMap!;
        const { lng, lat } = map.getCenter();
        return { lng, lat, zoom: map.getZoom() };
    });
/** The seamark raster's visibility, or why there is none yet: useMapInit adds it on Mapbox's 'load'. */
const seamarks = (page: Page) =>
    page.evaluate(() => {
        const map = (window as unknown as ChartWindow).__thalassaMap!;
        return map.getLayer('openseamap-permanent')
            ? String(map.getLayoutProperty('openseamap-permanent', 'visibility'))
            : `no layer (map loaded: ${map._loaded === true})`;
    });

async function setDeskWind(page: Page, on: boolean) {
    await page.getByRole('button', { name: /^Map base: / }).click();
    const row = page.getByRole('menuitemcheckbox', { name: /^Wind/ });
    await expect(row).toHaveAttribute('aria-checked', on ? 'false' : 'true');
    await row.click();
}
/**
 * The panel hides itself after six idle seconds (useWeatherControlsAutoHide,
 * Shane's design), and that unmounts it. So one panel action is one bounded
 * unit: reopen the panel if it has hidden, then act, every step on a short
 * timeout, retried whole for up to 30 s. A click can no longer wait out the
 * test's whole budget on a button that has gone (CI 2026-10-12: "element was
 * detached from the DOM, retrying" until "Test ended").
 */
async function inPanel<T>(page: Page, act: (region: Locator) => Promise<T>): Promise<T> {
    let result: { value: T } | undefined;
    await expect(async () => {
        const region = page.getByRole('region', { name: 'Weather controls' });
        if (!(await region.isVisible()))
            await page.getByRole('button', { name: 'Show weather controls' }).click({ timeout: 4_000 });
        await expect(region).toBeVisible({ timeout: 4_000 });
        result = { value: await act(region) };
    }, 'the weather controls, reopened whenever they hide themselves').toPass({ timeout: 30_000 });
    return result!.value;
}
/** A box that is there, or a retry: a box read as the panel hides is null. */
const boxOf = async (locator: Locator) => {
    const box = await locator.boundingBox({ timeout: 4_000 });
    if (!box) throw new Error('it went while it was measured');
    return box;
};

/** The agreement line's words, reopening the panel whenever it has hidden itself; a probe that fails is a retry. */
const agreement = (page: Page) =>
    expect.poll(
        async () => {
            try {
                const region = page.getByRole('region', { name: 'Weather controls' });
                if (!(await region.isVisible())) {
                    await page.getByRole('button', { name: 'Show weather controls' }).click({ timeout: 3_000 });
                    return null;
                }
                return await region.getByTestId('desk-wind-agreement').textContent({ timeout: 3_000 });
            } catch {
                return null;
            }
        },
        { message: 'the models’ agreement line', timeout: 30_000 },
    );

/** The panel out of the way of the sampled water: hidden by its own button, or by itself. */
async function hidePanel(page: Page) {
    const hide = page.getByRole('button', { name: 'Hide weather controls' });
    if (await hide.isVisible()) await hide.click({ timeout: 4_000 }).catch(() => undefined);
    await expect(page.getByRole('region', { name: 'Weather controls' })).toHaveCount(0, { timeout: 10_000 });
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** Evidence. A capture is bounded by the test's budget, never the describe's 15 s click cap (timeout: 0). */
async function shot(page: Page, info: TestInfo, name: string) {
    const file = `${name}-${info.project.name}.png`;
    await page.screenshot({ path: info.outputPath(file), animations: 'disabled', timeout: 0 });
    if (SHOTS) await page.screenshot({ path: join(SHOTS, file), animations: 'disabled', timeout: 0 });
}

/**
 * A menu click with the wind running. On CI's software GL the field starves
 * the renderer: two such clicks, a 2.5 s wait and Mapbox idle took 60 s
 * (run 38190842354). Bounded, but not by the 15 s cap meant for the panel.
 */
const UNDER_WIND = { timeout: 60_000 };

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** Relief's plain water fill (reliefBase DAY.water), what Relief + Sat draws where no depth tint does. */
const RELIEF_PLAIN_WATER = '#1f5a85';

const SOLENT = { lon: -1.4, lat: 50.76 };
/** The fixture's deep, west of Lisbon: open water, 2,000 m (syntheticChartTiles depthAt). */
const DEEP_SEA = { lon: -11, lat: 38.7 };

/**
 * Lon/lat of each CSS column and row of a clip (viewport pixels) on the live
 * chart. North up and flat (the planner never turns or tilts), Web Mercator: a
 * column has one longitude, a row one latitude.
 */
async function clipLonLat(page: Page, clip: Box) {
    return page.evaluate(({ x, y, width, height }) => {
        const map = (window as unknown as ChartWindow).__thalassaMap!;
        if (map.getBearing() !== 0 || map.getPitch() !== 0) throw new Error('the planner is north up and flat');
        const { left, top } = map.getContainer().getBoundingClientRect();
        return {
            lons: Array.from({ length: width }, (_, i) => map.unproject([x - left + i + 0.5, y - top]).lng),
            lats: Array.from({ length: height }, (_, j) => map.unproject([x - left, y - top + j + 0.5]).lat),
        };
    }, clip);
}

test.describe('wind on the desk planner', () => {
    test.use({ serviceWorkers: 'block' });
    // No click waits out a 150 s budget: a panel that hides itself under one
    // fails it in 15 s. Playwright also applies this to an un-timed
    // screenshot, so every capture here passes its own (timeout: 0).
    test.use({ actionTimeout: 15_000 });

    for (const size of [
        { width: 1440, height: 900 },
        { width: 1024, height: 768 },
        { width: 768, height: 1024 },
    ]) {
        test(`${size.width} × ${size.height}: a Wind row, OFF; on, it never moves the map, stands bottom right clear of every control and names its model`, async ({
            browser,
            baseURL,
            browserName,
        }, info) => {
            test.setTimeout(150_000);
            const context = await deskContext(browser, browserName, baseURL!);
            const page = await context.newPage();
            const net: Net = { bandLat: SOLENT.lat, spread: 'split', spreadAsks: 0 };
            await page.setViewportSize(size);
            await applyWideFonts(page);
            await serve(page, new URL(baseURL!).origin, net);
            await page.goto('/');
            await openPlanner(page);
            await jump(page, SOLENT.lon, SOLENT.lat, 9);

            // OFF by default, "Model forecast · ECMWF", after Seamarks.
            await page.getByRole('button', { name: /^Map base: / }).click();
            const rows = page.getByRole('menuitemcheckbox');
            await expect(rows).toHaveCount(2);
            await expect(rows.nth(0)).toContainText('Seamarks');
            await expect(rows.nth(1)).toContainText('Wind');
            await expect(rows.nth(1)).toContainText('Model forecast · ECMWF');
            await expect(rows.nth(1)).toHaveAttribute('aria-checked', 'false');
            await page.keyboard.press('Escape');

            const before = await camera(page);
            // The raster comes with Mapbox's 'load' and two React commits: wait for it once.
            await expect
                .poll(() => seamarks(page), { message: 'the Solent at z9 draws the buoys', timeout: 30_000 })
                .toBe('visible');
            await setDeskWind(page, true);
            await inPanel(page, async (region) => {
                await expect(region).toHaveClass(/thalassa-chart-controls-panel--desk/, { timeout: 4_000 });
                await expect(region.getByRole('slider', { name: 'Wind timeline' })).toBeVisible({ timeout: 4_000 });
            });
            const after = await camera(page);
            expect(after.zoom, 'the zoom stays').toBeCloseTo(before.zoom, 6);
            expect(after.lng, 'the centre stays').toBeCloseTo(before.lng, 6);
            expect(after.lat).toBeCloseTo(before.lat, 6);
            // Read once, not polled: drawn before the wind went on, still drawn after it.
            expect(await seamarks(page), 'the seamarks never blink').toBe('visible');

            // The credit, strip slot 2.
            const slot2 = page.getByTestId('desk-strip-slot-2');
            await expect(slot2).toHaveText('Wind: ECMWF (CC BY 4.0) via Open-Meteo');

            // The models' agreement at the map's middle, nothing pinned.
            await agreement(page).toMatch(/^Models split here \w+day: strongest wind 12-28 kt across 7 of 7 models$/);

            // Clear of every control on the planner, and of the desk's own menu and strip.
            const box = await inPanel(page, boxOf);
            expect(box.x + box.width).toBeLessThanOrEqual(size.width);
            expect(box.y).toBeGreaterThanOrEqual(0);
            const others = {
                rose: page.getByRole('button', { name: /^Compass rose/ }),
                tracer: page.locator('.map-tracer-panel'),
                zoom: page.getByRole('button', { name: /^Zoom / }),
                mic: page.getByTitle('Talk to Calypso'),
                status: page.getByRole('button', { name: /^System status/ }),
                chartKey: page.getByRole('button', { name: 'What the chart colours and numbers mean' }),
                scrubber: page.getByLabel('Chart detail — full at left, minimal at right'),
                locator: page.getByRole('button', { name: /^(Locate yacht|Finding yacht…)$/ }),
                scale: page.locator('.mapboxgl-ctrl-scale'),
                credits: page.locator('.mapboxgl-ctrl-attrib'),
                logo: page.locator('.mapboxgl-ctrl-logo'),
                menu: page.getByRole('button', { name: /^Map base: / }),
                strip: page.locator('[data-testid^="desk-strip-"]'),
            };
            for (const [name, locator] of Object.entries(others)) {
                for (let i = 0; i < (await locator.count()); i++) {
                    const item = locator.nth(i);
                    if (!(await item.isVisible())) continue;
                    expect(overlaps(box, (await item.boundingBox())!), `the panel lies on the ${name}`).toBe(false);
                }
            }
            await shot(page, info, `desk-wind-${size.width}x${size.height}`);

            // UKMO is share-alike.
            await inPanel(page, (region) =>
                region.getByRole('button', { name: 'Wind model UKMO' }).click({ timeout: 4_000 }),
            );
            await expect(slot2).toHaveText('Wind: UK Met Office (CC BY-SA 4.0) via Open-Meteo');
            await page.getByRole('button', { name: /^Map base: / }).click(UNDER_WIND);
            await expect(page.getByRole('menuitemcheckbox', { name: /^Wind/ })).toContainText('Model forecast · UKMO');
            await page.keyboard.press('Escape');
            await context.close();
        });
    }

    // Review 2026-10-10: a 1366x768 laptop's browser leaves ~170-200 px above
    // the credits, and the panel's timeline had to be scrolled to inside it
    // (with the six-second auto-hide cutting in). The timeline comes first.
    test('1366 × 657 (a 1366x768 laptop’s browser): the timeline is in view inside the panel, unscrolled', async ({
        browser,
        baseURL,
        browserName,
    }, info) => {
        test.setTimeout(150_000);
        const context = await deskContext(browser, browserName, baseURL!);
        const page = await context.newPage();
        await page.setViewportSize({ width: 1366, height: 657 });
        await applyWideFonts(page);
        await serve(page, new URL(baseURL!).origin, { bandLat: SOLENT.lat, spread: 'split', spreadAsks: 0 });
        await page.goto('/');
        await openPlanner(page);
        await jump(page, SOLENT.lon, SOLENT.lat, 9);
        await setDeskWind(page, true);
        await inPanel(page, (region) =>
            expect(region.getByRole('slider', { name: 'Wind timeline' })).toBeVisible({ timeout: 4_000 }),
        );
        await agreement(page).toMatch(/^Models split here/);
        // One panel, measured whole: its box, the timeline and Play, and its scroll.
        const { box, controls, scrollTop } = await inPanel(page, async (region) => ({
            box: await boxOf(region),
            controls: [
                await boxOf(region.getByRole('slider', { name: 'Wind timeline' })),
                await boxOf(region.getByRole('button', { name: /^(Play|Pause)$/ })),
            ],
            scrollTop: await region
                .locator('.thalassa-chart-controls-panel-body')
                .evaluate((el) => el.scrollTop, undefined, { timeout: 4_000 }),
        }));
        for (const at of controls) {
            expect(at.y, 'below the panel’s top').toBeGreaterThanOrEqual(box.y);
            expect(at.y + at.height, 'above the panel’s fold').toBeLessThanOrEqual(box.y + box.height);
        }
        expect(scrollTop, 'nothing scrolled to reach it').toBe(0);
        await shot(page, info, 'desk-wind-1366x657');
        await context.close();
    });

    // Two tests, not one (2026-10-12): together they took 142-148 s of one
    // 150 s budget on CI's software GL, so each half has its own.
    test(
        'Light: dark streaks that read on the pale sea, red in the 26 kt half',
        { tag: '@pixel' },
        async ({ browser, baseURL, browserName }, info) => {
            test.setTimeout(150_000);
            const size = { width: 1440, height: 900 };
            const context = await deskContext(browser, browserName, baseURL!);
            const page = await context.newPage();
            await page.setViewportSize(size);
            const net: Net = { bandLat: SOLENT.lat, spread: 'split', spreadAsks: 0, rows: new Set() };
            await serve(page, new URL(baseURL!).origin, net);
            await page.goto('/');
            await openPlanner(page);
            await jump(page, SOLENT.lon, SOLENT.lat, 9);
            await setDeskWind(page, true);
            await expect(page.getByTestId('desk-strip-slot-2')).toBeVisible({ timeout: 30_000 });
            // Out of the way of the sampled water.
            await hidePanel(page);
            await page.waitForTimeout(2_500);
            const x = 340;
            const width = size.width - 16 - 400 - x;
            const south = { x, y: Math.round(size.height * 0.62), width, height: Math.round(size.height * 0.13) };
            // The 26 kt half, on the sea alone (128-LIGHT; Shane 2026-10-13 "yes
            // to all of your questions for 128"): until 128 this band ran from
            // x 340 across the fixture's Hampshire, four fifths of it buff
            // land, so "red" was mostly a claim about streaks on fields. It is
            // now the water east of Hampshire's coast (lon 0.95° W and east at
            // z9), from the coast's shallows out, clear of the hidden panel's
            // pill and the top-right controls, and north of the grid's first
            // 26 kt row: between that row and the last 12 kt one the field
            // blends 12 into 26 kt and draws the 20-25 kt band's own ink.
            const north = {
                x: 1056,
                y: Math.round(size.height * 0.215),
                width: size.width - 16 - 1056,
                height: Math.round(size.height * 0.13),
            };

            // The 12 kt claim is about the pale sea, and a third of this band is
            // the Isle of Wight: slate ink over its warm fields comes out olive
            // (b < r), which failed "slate" at 0.78 in WebKit (2026-10-12) with
            // every land core still dark. So both bands read the sea alone, by
            // the fixture's own isLand.
            const seaOf = async (band: Box) => {
                const { lons, lats } = await clipLonLat(page, band);
                const sea = (cx: number, cy: number) => !isLand(lons[cx], lats[cy]);
                let pixels = 0;
                for (let cy = 0; cy < band.height; cy++)
                    for (let cx = 0; cx < band.width; cx++) if (sea(cx, cy)) pixels++;
                return { sea, pixels, share: pixels / (band.width * band.height), lats };
            };
            const calmSea = await seaOf(south);
            const reefSea = await seaOf(north);
            expect(calmSea.share, 'the 12 kt band is mostly sea').toBeGreaterThan(0.5);
            expect(reefSea.share, 'the 26 kt band is sea').toBeGreaterThan(0.95);
            // The premise, from the fixture's own grid: the 26 kt band lies wholly
            // north of the first row that answered 26 kt, and the 12 kt band where
            // the blend from the last 12 kt row stays under 20 kt (slate).
            const rows = [...net.rows!].sort((a, b) => a - b);
            const reefRow = rows.find((lat) => lat >= net.bandLat)!;
            const calmRow = rows.filter((lat) => lat < net.bandLat).at(-1)!;
            const blendAt = (lat: number) => 12 + (14 * (lat - calmRow)) / (reefRow - calmRow);
            expect(
                Math.min(...reefSea.lats),
                `the 26 kt band is north of the grid's 26 kt row (${reefRow}°)`,
            ).toBeGreaterThan(reefRow);
            expect(blendAt(Math.max(...calmSea.lats)), 'the 12 kt band draws under 20 kt').toBeLessThan(19.5);

            const lightPair = await captureWindPair(page);
            saveCapturedPair(lightPair, info, 'desk-wind-light-streaks', SHOTS);
            const calm = measurePixelPair(cropPixelPair(lightPair.pair, south), calmSea.sea);
            const reef = measurePixelPair(cropPixelPair(lightPair.pair, north), reefSea.sea);
            const isRed = (p: { ink: string }) => {
                const [r, g, b] = rgb(p.ink);
                return r > g + 40 && r > b + 40;
            };
            const red = reef.cores.filter(isRed);
            // The streaks' body, out to their soft edges: the most contrasting
            // fifth of what the 26 kt wind changed, where a Retina screen's
            // upscale of the CSS-pixel canvas leaves about half the ink.
            const body = [...reef.all]
                .sort((a, b) => b.contrast - a.contrast)
                .slice(0, Math.max(1, Math.floor(reef.all.length / 5)));
            const redBody = body.filter(isRed);
            const slate = calm.cores.filter((p) => {
                const [r, g, b] = rgb(p.ink);
                return b >= r && Math.max(r, g, b) < 140;
            });
            info.annotations.push({
                type: 'streak contrast (cores, the most contrasting 5%: their weakest)',
                description: `12 kt ${calm.edge.toFixed(2)}:1 over ${calm.all.length} px on ${calmSea.pixels} sea CSS px of ${south.width * south.height}, slate ${(slate.length / Math.max(1, calm.cores.length)).toFixed(3)}; 26 kt ${reef.edge.toFixed(2)}:1 over ${reef.all.length} px on ${reefSea.pixels} sea CSS px of ${north.width * north.height}, red ${(red.length / Math.max(1, reef.cores.length)).toFixed(3)}, red to the soft edges ${(redBody.length / Math.max(1, body.length)).toFixed(3)} (the fifth's weakest ${body.at(-1)!.contrast.toFixed(2)}:1); DPR ${lightPair.pair.scale}`,
            });
            expect(calm.all.length, 'the 12 kt streaks draw').toBeGreaterThan(300);
            expect(calm.edge, '12 kt cores on the sea beside them').toBeGreaterThanOrEqual(3);
            expect(reef.all.length, 'the 26 kt streaks draw on the sea').toBeGreaterThan(300);
            expect(reef.edge, '26 kt cores on the sea beside them').toBeGreaterThanOrEqual(3);
            // Red with margin, on the sea alone: nine in ten of the cores (127
            // asked four in five, over the whole chart, land and all), and nine
            // in ten of the streaks' body too. 127's maroon, added up under
            // leaflet-velocity's 'lighter', went mauve there: 0.22-0.23 of the
            // body red in WebKit, 0.82 in Chromium (2026-10-13); the pure red
            // drawn normally, 0.99-1.00.
            expect(red.length / reef.cores.length, 'the 26 kt cores read red on the sea').toBeGreaterThan(0.9);
            expect(redBody.length / body.length, 'the 26 kt streaks read red to their soft edges').toBeGreaterThan(0.9);
            expect(slate.length / calm.cores.length, 'the 12 kt streaks are slate ink, not white').toBeGreaterThan(0.8);
            await context.close();
        },
    );

    // Relief + Sat: white below 20 kt, brighter than the dark sea under it. The
    // Solent band this read until 2026-10-12 was neither: a third of it Isle of
    // Wight fields, the rest 8-20 m water that Relief draws mid-blue, where the
    // product's black rim (MVO's PARTICLE_HALO) changes pixels as much as the
    // white cores. So: the fixture's 2,000 m deep west of Lisbon, near-black on
    // Relief, and only the pixels the fixture's own isLand calls sea. The wind
    // goes on over Light and the base changes under it, as a skipper switches:
    // the running field must take the white palette. On that near-black sea
    // almost any ink is "lighter", Light's slate too (1.56-1.61:1 in Chromium,
    // 2026-10-12), so the cores must also reach the spec's 3:1.
    test(
        'Relief + Sat: white streaks, as on Obs, on the dark deep sea',
        { tag: '@pixel' },
        async ({ browser, baseURL, browserName }, info) => {
            test.setTimeout(150_000);
            const size = { width: 1440, height: 900 };
            const context = await deskContext(browser, browserName, baseURL!);
            const page = await context.newPage();
            await page.setViewportSize(size);
            // 12 kt everywhere: white, the Obs streak below 20 kt.
            await serve(page, new URL(baseURL!).origin, { bandLat: 90, spread: 'agree', spreadAsks: 0 });
            await page.goto('/');
            await openPlanner(page);
            await jump(page, DEEP_SEA.lon, DEEP_SEA.lat, 9);
            // On over Light first, drawing, then Relief + Sat under the running field.
            await setDeskWind(page, true);
            await expect(page.getByTestId('desk-strip-slot-2')).toBeVisible({ timeout: 30_000 });
            await expect(page.locator('[data-wind-field="true"]').first(), 'the field draws over Light').toBeAttached({
                timeout: 30_000,
            });
            await page.getByRole('button', { name: 'Map base: Light' }).click(UNDER_WIND);
            await page.getByRole('menuitemradio', { name: /^Relief \+ Sat/ }).click(UNDER_WIND);
            await expect(page.getByRole('button', { name: /^Map base: Relief \+ Sat/ })).toBeVisible({
                timeout: 30_000,
            });
            await hidePanel(page);
            await page.waitForTimeout(2_500);
            const x = 340;
            const band = {
                x,
                y: Math.round(size.height * 0.62),
                width: size.width - 16 - 400 - x,
                height: Math.round(size.height * 0.13),
            };
            const { lons, lats } = await clipLonLat(page, band);
            const sea = (cx: number, cy: number) => !isLand(lons[cx], lats[cy]);
            let seaPixels = 0;
            let shallowest = Infinity;
            for (let cy = 0; cy < band.height; cy++) {
                for (let cx = 0; cx < band.width; cx++) {
                    if (!sea(cx, cy)) continue;
                    seaPixels += 1;
                    shallowest = Math.min(shallowest, depthAt(lons[cx], lats[cy]));
                }
            }
            expect(seaPixels, 'the band is all open sea: no land in it').toBe(band.width * band.height);
            expect(shallowest, 'all of that sea is the fixture’s deep').toBeGreaterThan(1_000);

            const darkPair = await captureWindPair(page);
            saveCapturedPair(darkPair, info, 'desk-wind-relief-sat-streaks', SHOTS);
            const crop = cropPixelPair(darkPair.pair, band);
            // The premise on screen too: Relief drew the deep's tint there, not
            // its plain water (a relief tile that 404s draws only that).
            const sum = [0, 0, 0];
            const { data, channels } = crop.off;
            for (let i = 0; i < data.length; i += channels) for (let c = 0; c < 3; c++) sum[c] += data[i + c];
            const ground = sum.map((v) => Math.round(v / (data.length / channels)));
            const white = measurePixelPair(crop, sea);
            const lighter = white.cores.filter(
                (p) => rgb(p.ink).reduce((a, c) => a + c, 0) > rgb(p.ground).reduce((a, c) => a + c, 0),
            );
            info.annotations.push({
                type: 'white streaks on the dark base (cores lighter than the sea under them)',
                description: `${lighter.length} of ${white.cores.length} cores (${(lighter.length / Math.max(1, white.cores.length)).toFixed(3)}), ${white.all.length} changed px over ${seaPixels} sea CSS px of ${band.width * band.height}; weakest core ${white.edge.toFixed(2)}:1; sea under them mean rgb ${ground.join(',')}; DPR ${darkPair.pair.scale}`,
            });
            const plain = rgb(RELIEF_PLAIN_WATER);
            expect(
                ground.map((c, k) => c < plain[k]),
                `the sea under the band (mean rgb ${ground.join(',')}) is darker than Relief’s plain water ${RELIEF_PLAIN_WATER} in every channel`,
            ).toEqual([true, true, true]);
            expect(white.all.length, 'the streaks draw on the deep').toBeGreaterThan(300);
            expect(lighter.length / white.cores.length, 'white streaks on the dark base').toBeGreaterThan(0.8);
            expect(white.edge, 'white cores on the dark sea, not Light’s slate').toBeGreaterThanOrEqual(3);
            await context.close();
        },
    );

    test('where the models disagree it says so: split off the Solent, agree off Noumea, not known when the comparison is refused', async ({
        browser,
        baseURL,
        browserName,
    }) => {
        test.setTimeout(150_000);
        const context = await deskContext(browser, browserName, baseURL!);
        const page = await context.newPage();
        await page.setViewportSize({ width: 1440, height: 900 });
        const net: Net = { bandLat: 90, spread: 'split', spreadAsks: 0 };
        await serve(page, new URL(baseURL!).origin, net);
        await page.goto('/');
        await openPlanner(page);
        await jump(page, SOLENT.lon, SOLENT.lat, 9);
        await setDeskWind(page, true);
        await agreement(page).toMatch(/^Models split here \w+day: strongest wind 12-28 kt across 7 of 7 models$/);
        // Every model compared is credited under its own licence, ECCC in its own words.
        await inPanel(page, async (region) => {
            const compared = region.getByTestId('desk-wind-compared');
            await expect(compared).toContainText('Compared via Open-Meteo: ', { timeout: 4_000 });
            await expect(compared).toContainText('UK Met Office (CC BY-SA 4.0)', { timeout: 4_000 });
            await expect(compared).toContainText('Data Source: Environment and Climate Change Canada', {
                timeout: 4_000,
            });
        });

        net.spread = 'agree';
        await jump(page, 166.45, -22.28, 9); // Noumea, fictional winds
        await agreement(page).toMatch(/^Models agree here \w+day: strongest wind 14-16 kt across 7 of 7 models$/);

        net.spread = 503;
        await jump(page, -9.14, 38.69, 9); // off Lisbon
        await agreement(page).toBe('Model agreement not known here');
        await context.close();
    });

    test('a reload turns the desk’s wind off; a 390 px window has no Wind row', async ({
        browser,
        baseURL,
        browserName,
    }) => {
        test.setTimeout(150_000);
        const context = await deskContext(browser, browserName, baseURL!);
        const page = await context.newPage();
        await page.setViewportSize({ width: 1024, height: 768 });
        await serve(page, new URL(baseURL!).origin, { bandLat: 90, spread: 'agree', spreadAsks: 0 });
        await page.goto('/');
        await openPlanner(page);
        await setDeskWind(page, true);
        await expect(page.getByTestId('desk-strip-slot-2')).toBeVisible({ timeout: 30_000 });
        await page.reload();
        await openPlanner(page);
        await page.getByRole('button', { name: /^Map base: / }).click();
        await expect(page.getByRole('menuitemcheckbox', { name: /^Wind/ })).toHaveAttribute('aria-checked', 'false');
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('desk-strip-slot-2')).toHaveCount(0);
        await expect(page.getByRole('region', { name: 'Weather controls' })).toHaveCount(0);

        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: /^Map base: / }).click();
        await expect(page.getByRole('menuitemcheckbox', { name: /^Seamarks/ })).toBeVisible();
        await expect(page.getByRole('menuitemcheckbox', { name: /^Wind/ })).toHaveCount(0);
        await context.close();
    });
});

// ── The credit the chart owes on Obs too ───────────────────────────────
test.describe('the wind credit on the phone’s Obs chart', () => {
    test.use({ serviceWorkers: 'block' });

    for (const size of [
        { width: 320, height: 568 },
        { width: 390, height: 844 },
    ]) {
        test(`${size.width} × ${size.height}, wide fonts: one line in the strip under the base picker, clear of the zoom pill and the top-right controls`, async ({
            browser,
            baseURL,
        }, info) => {
            test.setTimeout(150_000);
            const context = await browser.newContext({ storageState: storage(baseURL!), serviceWorkers: 'block' });
            const page = await context.newPage();
            await page.setViewportSize(size);
            await applyWideFonts(page);
            await serve(page, new URL(baseURL!).origin, { bandLat: 90, spread: 'agree', spreadAsks: 0 });
            await page.goto('/');
            const nav = page.getByRole('navigation', { name: 'Main', exact: true });
            const show = page.getByRole('button', { name: /show navigation$/i });
            if (await show.isVisible().catch(() => false)) await show.click();
            await nav.getByRole('button', { name: 'Obs', exact: true }).click();
            await page.waitForFunction(() => !!(window as unknown as ChartWindow).__thalassaMap, null, {
                timeout: 45_000,
            });
            await page.getByRole('button', { name: 'Open layer menu' }).click();
            await page.getByRole('menuitem', { name: 'Sky layers' }).click();
            await page.getByRole('menuitemcheckbox', { name: 'Wind, off' }).click();
            await page.getByRole('button', { name: 'Close layer menu' }).click();
            const credit = page.getByTestId('obs-credits-rollup');
            const openCredits = page.getByRole('button', { name: /^Credits(?:; layer status needs review)?$/ });
            const dialog = page.getByRole('dialog', { name: 'Map credits & source status' });
            await expect(credit).toBeVisible({ timeout: 30_000 });
            await openCredits.click();
            await expect(dialog).toContainText('Wind: ECMWF (CC BY 4.0) via Open-Meteo');
            await dialog.getByRole('button', { name: 'Close', exact: true }).click();
            // The longest provider licence stays available in the scrollable
            // rollup; replacing the field must replace its source text too.
            await inPanel(page, (region) =>
                region.getByRole('button', { name: 'Wind model UKMO' }).click({ timeout: 4_000 }),
            );
            await expect(credit).toBeVisible({ timeout: 30_000 });
            await openCredits.click();
            const source = dialog.getByText('Wind: UK Met Office (CC BY-SA 4.0) via Open-Meteo', { exact: true });
            await expect(source).toBeVisible({ timeout: 30_000 });
            await expectWideFaceDrawn(source);
            const sourceBox = await boxOf(source);
            expect(sourceBox.x).toBeGreaterThanOrEqual(0);
            expect(sourceBox.x + sourceBox.width).toBeLessThanOrEqual(size.width);
            await dialog.getByRole('button', { name: 'Close', exact: true }).click();
            // Licence length no longer adds rows over the chart. Keep the
            // original map-control overlap checks on the closed credit row.
            await expect(async () => {
                await expect(credit).toBeVisible();
                const box = await boxOf(credit);
                expect(box.height, 'one touch-height row at the configured text size').toBeLessThanOrEqual(64);
                expect(box.x).toBeGreaterThanOrEqual(0);
                expect(box.x + box.width).toBeLessThanOrEqual(size.width);
                const picker = await boxOf(page.getByRole('button', { name: /^Map base: / }));
                expect(box.y, 'under the base picker').toBeGreaterThanOrEqual(picker.y + picker.height);
                for (const [name, locator] of Object.entries({
                    zoom: page.getByRole('button', { name: /^Zoom / }),
                    mic: page.getByTitle('Talk to Calypso'),
                    status: page.getByRole('button', { name: /^System status/ }),
                    layers: page.getByRole('button', { name: /layer menu$/ }),
                })) {
                    for (let i = 0; i < (await locator.count()); i++) {
                        const item = locator.nth(i);
                        if (!(await item.isVisible())) continue;
                        expect(overlaps(box, await boxOf(item)), `the credit lies on the ${name}`).toBe(false);
                    }
                }
            }, 'closed source rollup fits after the replacement field loads').toPass({ timeout: 30_000 });
            await shot(page, info, `obs-wind-credit-${size.width}x${size.height}`);
            await context.close();
        });
    }
});
