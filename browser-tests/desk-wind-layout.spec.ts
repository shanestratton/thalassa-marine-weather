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
 *  - Light: the streaks are dark ink reaching 3:1 on the sea beside them, red
 *    in the 26 kt half; Relief + Sat: white, as on Obs;
 *  - the models' agreement: split off the Solent, agree off Noumea, not known
 *    when the comparison answers 503.
 *
 * DESK_WIND_SHOTS_DIR also saves the screenshots there (before/after evidence).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from 'fast-png';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { compositeTile, fixtureStyle, imageryTile, reliefTile, seamarkTile } from '../e2e/helpers/syntheticChartTiles';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';
import { contrast } from '../tests/helpers/colourScience';

const SHOTS = process.env.DESK_WIND_SHOTS_DIR?.trim() || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** The app's chart, as MapHub exposes it to the browser tests. */
type ThalassaMap = {
    jumpTo(o: { center: [number, number]; zoom: number }): void;
    once(t: string, f: () => void): void;
    getCenter(): { lng: number; lat: number };
    getZoom(): number;
    getLayoutProperty(id: string, prop: string): unknown;
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
}

async function serve(page: Page, origin: string, net: Net) {
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
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

async function openPlanner(page: Page) {
    const nav = page.getByRole('navigation', { name: 'Main', exact: true });
    const show = page.getByRole('button', { name: /show navigation$/i });
    if (await show.isVisible().catch(() => false)) await show.click();
    await nav.getByRole('button', { name: 'Plan', exact: true }).click();
    const start = page.getByRole('button', { name: 'Start plotting', exact: true });
    await expect(start).toBeVisible({ timeout: 25_000 });
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
const seamarks = (page: Page) =>
    page.evaluate(() =>
        (window as unknown as ChartWindow).__thalassaMap!.getLayoutProperty('openseamap-permanent', 'visibility'),
    );

async function setDeskWind(page: Page, on: boolean) {
    await page.getByRole('button', { name: /^Map base: / }).click();
    const row = page.getByRole('menuitemcheckbox', { name: /^Wind/ });
    await expect(row).toHaveAttribute('aria-checked', on ? 'false' : 'true');
    await row.click();
}
/** The panel hides itself after six idle seconds: bring it back when it has. */
async function panel(page: Page) {
    const region = page.getByRole('region', { name: 'Weather controls' });
    if (!(await region.isVisible().catch(() => false)))
        await page.getByRole('button', { name: 'Show weather controls' }).click();
    await expect(region).toBeVisible();
    return region;
}

/** The agreement line's words, reopening the panel whenever it has hidden itself. */
const agreement = (page: Page) =>
    expect.poll(async () => (await panel(page)).getByTestId('desk-wind-agreement').textContent(), { timeout: 20_000 });

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

async function shot(page: Page, info: TestInfo, name: string) {
    const file = `${name}-${info.project.name}.png`;
    await page.screenshot({ path: info.outputPath(file), animations: 'disabled' });
    if (SHOTS) await page.screenshot({ path: join(SHOTS, file), animations: 'disabled' });
}

/**
 * The streaks as drawn: one screenshot with the field, one without it, over the
 * same still chart. Pixels the field changed, with the chart pixel under each.
 */
async function streakPixels(page: Page, clip: Box) {
    const grab = async () => {
        const png = decode(await page.screenshot({ clip, animations: 'allow' }));
        return { data: png.data, channels: png.channels, width: png.width };
    };
    const on = await grab();
    await page.evaluate(() =>
        document.querySelectorAll<HTMLElement>('.leaflet-container').forEach((el) => (el.style.visibility = 'hidden')),
    );
    const off = await grab();
    await page.evaluate(() =>
        document.querySelectorAll<HTMLElement>('.leaflet-container').forEach((el) => (el.style.visibility = '')),
    );
    const out: Array<{ ink: string; ground: string; change: number; contrast: number }> = [];
    const hex = (d: Uint8Array | Uint16Array | Uint8ClampedArray, i: number) =>
        `#${[d[i], d[i + 1], d[i + 2]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`;
    for (let i = 0; i < on.data.length; i += on.channels) {
        const change =
            Math.abs(on.data[i] - off.data[i]) +
            Math.abs(on.data[i + 1] - off.data[i + 1]) +
            Math.abs(on.data[i + 2] - off.data[i + 2]);
        if (change > 60) {
            const ink = hex(on.data, i);
            const ground = hex(off.data, i);
            out.push({ ink, ground, change, contrast: contrast(ink, ground) });
        }
    }
    // A 1 px streak is antialiased across two pixel rows, so most of its pixels
    // are part-covered. Its CORES, the most contrasting twentieth, are the ink
    // as drawn: those are what must reach 3:1.
    const cores = [...out].sort((a, b) => b.contrast - a.contrast).slice(0, Math.max(1, Math.floor(out.length / 20)));
    return { all: out, cores, edge: cores[cores.length - 1]?.contrast ?? 0 };
}
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const SOLENT = { lon: -1.4, lat: 50.76 };

test.describe('wind on the desk planner', () => {
    test.use({ serviceWorkers: 'block' });

    for (const size of [
        { width: 1440, height: 900 },
        { width: 1024, height: 768 },
        { width: 768, height: 1024 },
    ]) {
        test(`${size.width} × ${size.height}: a Wind row, OFF; on, it never moves the map, stands bottom right clear of every control and names its model`, async ({
            browser,
            baseURL,
        }, info) => {
            test.setTimeout(150_000);
            const context = await browser.newContext({ storageState: storage(baseURL!), serviceWorkers: 'block' });
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
            expect(await seamarks(page)).toBe('visible');
            await setDeskWind(page, true);
            const region = await panel(page);
            await expect(region).toHaveClass(/thalassa-chart-controls-panel--desk/);
            await expect(region.getByRole('slider', { name: 'Wind timeline' })).toBeVisible({ timeout: 30_000 });
            const after = await camera(page);
            expect(after.zoom, 'the zoom stays').toBeCloseTo(before.zoom, 6);
            expect(after.lng, 'the centre stays').toBeCloseTo(before.lng, 6);
            expect(after.lat).toBeCloseTo(before.lat, 6);
            expect(await seamarks(page), 'the seamarks never blink').toBe('visible');

            // The credit, strip slot 2.
            const slot2 = page.getByTestId('desk-strip-slot-2');
            await expect(slot2).toHaveText('Wind: ECMWF (CC BY 4.0) via Open-Meteo');

            // The models' agreement at the map's middle, nothing pinned.
            await agreement(page).toMatch(/^Models split here \w+day: strongest wind 12-28 kt across 7 of 7 models$/);

            // Clear of every control on the planner, and of the desk's own menu and strip.
            const box = (await (await panel(page)).boundingBox())!;
            expect(box.x + box.width).toBeLessThanOrEqual(size.width);
            expect(box.y).toBeGreaterThanOrEqual(0);
            const others = {
                rose: page.getByRole('img', { name: /^Compass rose/ }),
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
            await (await panel(page)).getByRole('button', { name: 'Wind model UKMO' }).click();
            await expect(slot2).toHaveText('Wind: UK Met Office (CC BY-SA 4.0) via Open-Meteo');
            await page.getByRole('button', { name: /^Map base: / }).click();
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
    }, info) => {
        test.setTimeout(150_000);
        const context = await browser.newContext({ storageState: storage(baseURL!), serviceWorkers: 'block' });
        const page = await context.newPage();
        await page.setViewportSize({ width: 1366, height: 657 });
        await applyWideFonts(page);
        await serve(page, new URL(baseURL!).origin, { bandLat: SOLENT.lat, spread: 'split', spreadAsks: 0 });
        await page.goto('/');
        await openPlanner(page);
        await jump(page, SOLENT.lon, SOLENT.lat, 9);
        await setDeskWind(page, true);
        const region = await panel(page);
        const slider = region.getByRole('slider', { name: 'Wind timeline' });
        await expect(slider).toBeVisible({ timeout: 30_000 });
        await agreement(page).toMatch(/^Models split here/);
        const box = (await (await panel(page)).boundingBox())!;
        const play = region.getByRole('button', { name: /^(Play|Pause)$/ });
        for (const control of [slider, play]) {
            const at = (await control.boundingBox())!;
            expect(at.y, 'below the panel’s top').toBeGreaterThanOrEqual(box.y);
            expect(at.y + at.height, 'above the panel’s fold').toBeLessThanOrEqual(box.y + box.height);
        }
        expect(
            await region.locator('.thalassa-chart-controls-panel-body').evaluate((el) => el.scrollTop),
            'nothing scrolled to reach it',
        ).toBe(0);
        await shot(page, info, 'desk-wind-1366x657');
        await context.close();
    });

    test('Light: dark streaks that read on the pale sea, red in the 26 kt half; Relief + Sat: white, as on Obs', async ({
        browser,
        baseURL,
    }, info) => {
        test.setTimeout(150_000);
        const size = { width: 1440, height: 900 };
        const context = await browser.newContext({ storageState: storage(baseURL!), serviceWorkers: 'block' });
        const page = await context.newPage();
        await page.setViewportSize(size);
        await serve(page, new URL(baseURL!).origin, { bandLat: SOLENT.lat, spread: 'split', spreadAsks: 0 });
        await page.goto('/');
        await openPlanner(page);
        await jump(page, SOLENT.lon, SOLENT.lat, 9);
        await setDeskWind(page, true);
        await expect(page.getByTestId('desk-strip-slot-2')).toBeVisible({ timeout: 30_000 });
        // Out of the way of the sampled water.
        const hide = page.getByRole('button', { name: 'Hide weather controls' });
        if (await hide.isVisible().catch(() => false)) await hide.click();
        await page.waitForTimeout(2_500);
        const x = 340;
        const width = size.width - 16 - 400 - x;
        const north = { x, y: Math.round(size.height * 0.25), width, height: Math.round(size.height * 0.13) };
        const south = { x, y: Math.round(size.height * 0.62), width, height: Math.round(size.height * 0.13) };

        const calm = await streakPixels(page, south);
        const reef = await streakPixels(page, north);
        info.annotations.push({
            type: 'streak contrast (cores, the most contrasting 5%: their weakest)',
            description: `12 kt ${calm.edge.toFixed(2)}:1 over ${calm.all.length} px; 26 kt ${reef.edge.toFixed(2)}:1 over ${reef.all.length} px`,
        });
        expect(calm.all.length, 'the 12 kt streaks draw').toBeGreaterThan(300);
        expect(calm.edge, '12 kt cores on the chart beside them').toBeGreaterThanOrEqual(3);
        expect(reef.all.length, 'the 26 kt streaks draw').toBeGreaterThan(300);
        expect(reef.edge, '26 kt cores on the chart beside them').toBeGreaterThanOrEqual(3);
        const red = reef.cores.filter((p) => {
            const [r, g, b] = rgb(p.ink);
            return r > g + 40 && r > b + 40;
        });
        expect(red.length / reef.cores.length, 'the 26 kt band is in the red family').toBeGreaterThan(0.8);
        const slate = calm.cores.filter((p) => {
            const [r, g, b] = rgb(p.ink);
            return b >= r && Math.max(r, g, b) < 140;
        });
        expect(slate.length / calm.cores.length, 'the 12 kt streaks are slate ink, not white').toBeGreaterThan(0.8);
        await shot(page, info, 'desk-wind-light-streaks');

        // Relief + Sat: white below 20 kt, brighter than the dark sea under it.
        await page.getByRole('button', { name: 'Map base: Light' }).click();
        await page.getByRole('menuitemradio', { name: /^Relief \+ Sat/ }).click();
        await page.waitForTimeout(2_500);
        const white = await streakPixels(page, south);
        expect(white.all.length).toBeGreaterThan(300);
        const lighter = white.cores.filter(
            (p) => rgb(p.ink).reduce((a, c) => a + c, 0) > rgb(p.ground).reduce((a, c) => a + c, 0),
        );
        expect(lighter.length / white.cores.length, 'white streaks on the dark base').toBeGreaterThan(0.8);
        await shot(page, info, 'desk-wind-relief-sat-streaks');
        await context.close();
    });

    test('where the models disagree it says so: split off the Solent, agree off Noumea, not known when the comparison is refused', async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(150_000);
        const context = await browser.newContext({ storageState: storage(baseURL!), serviceWorkers: 'block' });
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
        const compared = (await panel(page)).getByTestId('desk-wind-compared');
        await expect(compared).toContainText('Compared via Open-Meteo: ');
        await expect(compared).toContainText('UK Met Office (CC BY-SA 4.0)');
        await expect(compared).toContainText('Data Source: Environment and Climate Change Canada');

        net.spread = 'agree';
        await jump(page, 166.45, -22.28, 9); // Noumea, fictional winds
        await agreement(page).toMatch(/^Models agree here \w+day: strongest wind 14-16 kt across 7 of 7 models$/);

        net.spread = 503;
        await jump(page, -9.14, 38.69, 9); // off Lisbon
        await agreement(page).toBe('Model agreement not known here');
        await context.close();
    });

    test('a reload turns the desk’s wind off; a 390 px window has no Wind row', async ({ browser, baseURL }) => {
        test.setTimeout(150_000);
        const context = await browser.newContext({ storageState: storage(baseURL!), serviceWorkers: 'block' });
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
            const credit = page.getByTestId('wind-credit');
            await expect(credit).toHaveText('Wind: ECMWF (CC BY 4.0) via Open-Meteo', { timeout: 30_000 });
            // The longest credit, UK Met Office's share-alike.
            await (await panel(page)).getByRole('button', { name: 'Wind model UKMO' }).click();
            await expect(credit).toHaveText('Wind: UK Met Office (CC BY-SA 4.0) via Open-Meteo', { timeout: 30_000 });
            await expectWideFaceDrawn(credit);
            const box = (await credit.boundingBox())!;
            expect(box.height, 'one line').toBeLessThan(26);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(size.width);
            const picker = (await page.getByRole('button', { name: /^Map base: / }).boundingBox())!;
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
                    expect(overlaps(box, (await item.boundingBox())!), `the credit lies on the ${name}`).toBe(false);
                }
            }
            await shot(page, info, `obs-wind-credit-${size.width}x${size.height}`);
            await context.close();
        });
    }
});
