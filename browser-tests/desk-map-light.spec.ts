/**
 * The desk chart (127-DESKMAP): Light base, Relief seabed, OpenSeaMap
 * seamarks on top. Shane 2026-10-10: "we will need to have a fairly good map
 * to use, on the desktop as the underlying map is dark and very hard to see
 * what is water and what isnt" and "a combination of these 3 would rock".
 *
 * Two halves, both offline on made-up coastlines (e2e/helpers/
 * syntheticChartTiles.ts) at public waters outside every Australian set (the
 * Solent, Chesapeake Bay) and inside one (the Whitsundays):
 *  - the Light base drawn by Mapbox GL through the app's own pieces
 *    (e2e/fixtures/desk-map.tsx): pixels, the seamark gate, OpenSeaMap down,
 *    a fictional NOAA-shaped chart in chart mode, credits, night;
 *  - the real app's web planner (the tracer): the desk menu and its strip,
 *    clear of every control at 1440, 1024, 390 and 320 px in wide fonts, the
 *    words for an account with and without licensed charts aboard, and the
 *    picks kept on this computer.
 *
 * DESK_MAP_SHOTS_DIR also saves the screenshots there (before/after evidence).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { compositeTile, fixtureStyle, imageryTile, reliefTile, seamarkTile } from '../e2e/helpers/syntheticChartTiles';
import { ONBOARDED_STORAGE } from '../e2e/helpers/storageState';
import { applyWideFonts, expectWideFaceDrawn } from '../e2e/helpers/wideFonts';
import { contrast, deltaE } from '../tests/helpers/colourScience';

const SHOTS = process.env.DESK_MAP_SHOTS_DIR?.trim() || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

type DeskMap = {
    ready: boolean;
    writes: { count: number };
    setBase(base: string): void;
    setNight(on: boolean): void;
    setSeamarks(on: boolean): void;
    jump(lon: number, lat: number, zoom: number): Promise<void>;
    idle(): Promise<void>;
    probe(points: Array<[number, number]>): Promise<Array<number[] | null>>;
    column(x: number, y0: number, y1: number): Promise<number[][]>;
    at(lon: number, lat: number): { x: number; y: number };
    visibility(id: string): string | null;
    paint(id: string, prop: string): unknown;
};
declare global {
    interface Window {
        __deskMap: DeskMap;
        __thalassaMap?: {
            jumpTo(o: { center: [number, number]; zoom: number }): void;
            once(t: string, f: () => void): void;
            getLayoutProperty(id: string, prop: string): unknown;
        };
    }
}

// ── The offline network ──────────────────────────────────────────────────
const made = new Map<string, Buffer | null>();
const once = (key: string, make: () => Buffer | null) => {
    if (!made.has(key)) made.set(key, make());
    return made.get(key)!;
};
interface Net {
    seamarkStatus?: number;
    seamarkRequests: number;
}
async function serveDesk(page: Page, origin: string, net: Net) {
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        const xyz = (m: RegExpMatchArray, at: number) => [Number(m[at]), Number(m[at + 1]), Number(m[at + 2])] as const;
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
                // App-owned symbol layers need a glyphs URL; the fonts below are empty.
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
            net.seamarkRequests += 1;
            if (net.seamarkStatus) return route.fulfill({ status: net.seamarkStatus, body: 'busy' });
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

async function shot(page: Page, info: TestInfo, name: string) {
    const file = `${name}-${info.project.name}.png`;
    await page.screenshot({ path: info.outputPath(file), animations: 'disabled' });
    if (SHOTS) await page.screenshot({ path: join(SHOTS, file), animations: 'disabled' });
}

const hex = ([r, g, b]: number[]) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
const lum = (px: number[]) => {
    const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(px[0]) + 0.7152 * lin(px[1]) + 0.0722 * lin(px[2]);
};
const near = (px: number[], ref: string, tol: number) =>
    [1, 3, 5].every((i, k) => Math.abs(px[k] - parseInt(ref.slice(i, i + 2), 16)) <= tol);

// ── The Light base, drawn ────────────────────────────────────────────────
test.describe('the Light base, drawn (e2e/fixtures/desk-map.tsx)', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    async function openDesk(page: Page, baseURL: string | undefined, query: string, net: Net = { seamarkRequests: 0 }) {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await serveDesk(page, new URL(baseURL!).origin, net);
        await page.goto(`/e2e/fixtures/desk-map.html?${query}`);
        await page.waitForFunction(() => window.__deskMap?.ready === true, null, { timeout: 45_000 });
        await page.evaluate(() => window.__deskMap.idle());
        return { errors, net };
    }
    const jump = (page: Page, lon: number, lat: number, z: number) =>
        page.evaluate(([x, y, zoom]) => window.__deskMap.jump(x, y, zoom), [lon, lat, z] as const);
    const probe = (page: Page, points: Array<[number, number]>) =>
        page.evaluate((pts) => window.__deskMap.probe(pts), points);

    /** Darkest pixel down a column through [lon, lat0 → lat1]: the coastline. */
    async function darkestAcross(page: Page, lon: number, lat0: number, lat1: number) {
        const [a, b] = await page.evaluate(([x, y0, y1]) => [window.__deskMap.at(x, y0), window.__deskMap.at(x, y1)], [
            lon,
            lat0,
            lat1,
        ] as const);
        const run = await page.evaluate(([x, y0, y1]) => window.__deskMap.column(x, y0, y1), [
            a.x,
            Math.min(a.y, b.y),
            Math.max(a.y, b.y),
        ] as const);
        return run.reduce((dark, px) => (lum(px) < lum(dark) ? px : dark));
    }

    const PLACES = {
        solent: { land: [-1.35, 50.83], water: [-1.45, 50.745], wide: [-1.3, 50.5], coast: [-1.25, 50.79, 50.84] },
        whitsundays: {
            land: [148.7, -20.4],
            water: [148.75, -20.2],
            wide: [148.8, -20.1],
            coast: [148.75, -20.21, -20.3],
        },
    } as const;

    for (const place of ['solent', 'whitsundays'] as const) {
        test(`land buff, water pale, ΔE ≥ 15 apart, a dark coastline at z8, z11 and z13: ${place}`, async ({
            page,
            baseURL,
        }, info) => {
            test.setTimeout(120_000);
            const { errors } = await openDesk(page, baseURL, `place=${place}&z=11`);
            // Seamarks off for the colour reads: a buoy is not the sea.
            await page.evaluate(() => window.__deskMap.setSeamarks(false));
            const p = PLACES[place];
            for (const z of [8, 11, 13]) {
                const water = z === 8 ? p.wide : p.water;
                await jump(page, (p.land[0] + water[0]) / 2, (p.land[1] + water[1]) / 2, z === 13 ? 12 : z);
                if (z === 13) await jump(page, water[0], water[1], 13);
                const [landPx, waterPx] = await probe(page, [p.land as [number, number], water as [number, number]]);
                if (z !== 13) {
                    expect(landPx, `${place} z${z} land on screen`).not.toBeNull();
                    expect(near(landPx!, '#d6c590', 10), `${place} z${z} land ${hex(landPx!)} is buff`).toBe(true);
                }
                expect(waterPx, `${place} z${z} water on screen`).not.toBeNull();
                const w = waterPx!;
                expect(w[2] >= w[0] + 8, `${place} z${z} water ${hex(w)} is pale blue`).toBe(true);
                expect(lum(w), `${place} z${z} water ${hex(w)} is light`).toBeGreaterThan(0.45);
                expect(deltaE('#d6c590', hex(w)), `${place} z${z} land vs water`).toBeGreaterThanOrEqual(15);
                if (z !== 13) {
                    const coast = await darkestAcross(page, p.coast[0], p.coast[1], p.coast[2]);
                    expect(lum(coast), `${place} z${z} coastline ${hex(coast)} is dark`).toBeLessThan(0.3);
                }
                if (z === 11) await shot(page, info, `desk-light-${place}-z${z}`);
            }
            expect(errors).toEqual([]);
        });
    }

    test('flat water past z12 off the Solent (no seam, no blobs); the Whitsundays keep GA’s 30 m tint at z13', async ({
        page,
        baseURL,
    }, info) => {
        test.setTimeout(90_000);
        await openDesk(page, baseURL, 'place=solent&z=13');
        await page.evaluate(() => window.__deskMap.setSeamarks(false));
        // Open water east of the Isle of Wight; the run crosses two tile rows.
        await jump(page, -1.0, 50.65, 13);
        const run = await page.evaluate(() => window.__deskMap.column(720, 120, 780));
        for (const [i, px] of run.entries())
            expect(near(px, '#c9d0d6', 4), `row ${120 + i}: ${hex(px)} is the flat no-depth water`).toBe(true);
        for (let i = 1; i < run.length; i++)
            expect(
                Math.max(...[0, 1, 2].map((k) => Math.abs(run[i][k] - run[i - 1][k]))),
                `rows ${i}`,
            ).toBeLessThanOrEqual(2);
        await shot(page, info, 'desk-light-solent-z13');
        await jump(page, 148.82, -20.2, 13);
        const [ga] = await probe(page, [[148.82, -20.2]]);
        expect(near(ga!, '#c9d0d6', 4), `Whitsundays z13 ${hex(ga!)}: GA's tint, not flat water`).toBe(false);
        expect(ga![2]).toBeGreaterThan(ga![0] + 10);
        await shot(page, info, 'desk-light-whitsundays-z13');
    });

    test('seamarks on by default: the buoys draw and the strip says what they are; off, they are gone', async ({
        page,
        baseURL,
    }, info) => {
        test.setTimeout(90_000);
        await openDesk(page, baseURL, 'place=solent&z=12');
        await jump(page, -1.33, 50.776, 12);
        const slot1 = page.getByTestId('desk-strip-slot-1');
        await expect(slot1).toHaveText(/^Seamarks: OpenSeaMap community data, not verified/);
        await expect(slot1.getByRole('link', { name: /OpenSeaMap contributors, CC BY-SA 2\.0/ })).toHaveAttribute(
            'href',
            'https://www.openseamap.org',
        );
        expect(await page.evaluate(() => window.__deskMap.visibility('openseamap-permanent'))).toBe('visible');
        const [green] = await probe(page, [[-1.318, 50.774]]);
        expect(green![1] > green![0] + 40 && green![1] > green![2] + 20, `buoy ${hex(green!)}`).toBe(true);
        await shot(page, info, 'desk-seamarks-on-solent-z12');
        await page.getByRole('button', { name: 'Map base: Light' }).click();
        await page.getByRole('menuitemcheckbox', { name: /^Seamarks/ }).click();
        await page.evaluate(() => window.__deskMap.idle());
        expect(await page.evaluate(() => window.__deskMap.visibility('openseamap-permanent'))).toBe('none');
        const [gone] = await probe(page, [[-1.318, 50.774]]);
        expect(gone![1] > gone![0] + 40 && gone![1] > gone![2] + 20, `no buoy ${hex(gone!)}`).toBe(false);
        await expect(slot1).toHaveCount(0);
    });

    test('OpenSeaMap answering 503: after three, the label says it is not answering', async ({ page, baseURL }) => {
        test.setTimeout(60_000);
        const net: Net = { seamarkRequests: 0, seamarkStatus: 503 };
        await openDesk(page, baseURL, 'place=solent&z=12', net);
        await expect(page.getByTestId('desk-strip-slot-1')).toHaveText(/^Seamarks: OpenSeaMap not answering/, {
            timeout: 20_000,
        });
        expect(net.seamarkRequests).toBeGreaterThanOrEqual(3);
    });

    test('a NOAA-shaped cell while tracing: OpenSeaMap steps aside and the chart draws its own marks; off the cell the buoys return', async ({
        page,
        baseURL,
    }, info) => {
        test.setTimeout(90_000);
        await openDesk(page, baseURL, 'place=chesapeake&z=13&cell=1');
        await jump(page, -76.4, 38.975, 13);
        const vis = (id: string) => page.evaluate((layer) => window.__deskMap.visibility(layer), id);
        expect(await vis('openseamap-permanent')).toBe('none');
        expect(await vis('enc-vec-boylat-circle')).toBe('visible');
        expect(await vis('enc-vec-depcnt-safety')).toBe('visible');
        // Slot 0 over the chart: the box stays, the words go.
        const slot0 = page.getByTestId('desk-strip-slot-0');
        await expect(slot0).toHaveCSS('visibility', 'hidden');
        const before = (await page.getByTestId('desk-strip-slot-1').boundingBox()) ?? null;
        await shot(page, info, 'desk-chesapeake-cell-z13');
        await jump(page, -76.2, 38.975, 13);
        expect(await vis('openseamap-permanent')).toBe('visible');
        await expect(slot0).toHaveCSS('visibility', 'visible');
        await expect(slot0).toHaveText('No chart for this area');
        const after = await page.getByTestId('desk-strip-slot-1').boundingBox();
        expect(after).toEqual(before);
        const [red] = await probe(page, [[-76.2, 38.975]]);
        expect(red![0] > red![1] + 60, `buoy ${hex(red!)}`).toBe(true);
    });

    test('the cell on Light is a paper chart: opaque bands, charted white ΔE ≥ 10 from the no-chart sea, ENC land = base land; Relief + Sat and back, then quiet', async ({
        page,
        baseURL,
    }, info) => {
        test.setTimeout(120_000);
        const { errors } = await openDesk(page, baseURL, 'place=chesapeake&z=12&cell=1');
        await page.evaluate(() => window.__deskMap.setSeamarks(false));
        await jump(page, -76.4, 38.975, 12);
        const deep: [number, number] = [-76.43, 38.975];
        const outside: [number, number] = [-76.47, 38.975];
        const encLand: [number, number] = [-76.36, 38.975];
        const [d, o, l] = (await probe(page, [deep, outside, encLand])) as number[][];
        expect(deltaE(hex(d), hex(o)), `charted ${hex(d)} vs no-chart ${hex(o)}`).toBeGreaterThanOrEqual(10);
        expect(near(o, '#c9d0d6', 6), `outside the chart ${hex(o)} is the flat water`).toBe(true);
        // The chart's land (#d6c590 at its 0.85 opacity) is the base land's
        // colour: here over the made-up open water, on a real coast over the
        // same buff, so the two meet with no seam.
        expect(deltaE(hex(l), '#d6c590'), `ENC land ${hex(l)} is the base land`).toBeLessThan(5);
        expect(await page.evaluate(() => window.__deskMap.paint('enc-vec-depare-fill', 'fill-opacity'))).not.toBe(0);
        await shot(page, info, 'desk-cell-chart-mode');

        // Light → Relief + Sat → Light with no reload: chart → glaze → chart.
        const pick = async (name: string) => {
            await page.getByRole('button', { name: /^Map base: / }).click();
            await page.getByRole('menuitemradio', { name: new RegExp(`^${name.replace('+', '\\+')} `) }).click();
            await page.evaluate(() => window.__deskMap.idle());
        };
        await pick('Relief + Sat');
        expect(await page.evaluate(() => window.__deskMap.paint('enc-vec-depare-fill', 'fill-opacity'))).toBe(0);
        await pick('Light');
        expect(await page.evaluate(() => window.__deskMap.paint('enc-vec-depare-fill', 'fill-opacity'))).not.toBe(0);
        const [again] = (await probe(page, [deep])) as number[][];
        expect(deltaE(hex(again), hex(d))).toBeLessThan(3);
        // The styledata-loop rule: a settled map writes nothing for 2 s.
        await page.waitForTimeout(500);
        const settled = await page.evaluate(() => window.__deskMap.writes.count);
        await page.waitForTimeout(2_000);
        expect(await page.evaluate(() => window.__deskMap.writes.count)).toBe(settled);
        expect(errors).toEqual([]);
    });

    test('credits: Mapbox, OSM, GEBCO, GA’s title, CC BY 4.0, OpenSeaMap’s CC BY-SA 2.0 and ODbL, Not for navigation', async ({
        page,
        baseURL,
    }) => {
        test.setTimeout(60_000);
        await openDesk(page, baseURL, 'place=whitsundays&z=12');
        await page.locator('.mapboxgl-ctrl-attrib-button').click();
        const credits = page.locator('.mapboxgl-ctrl-attrib-inner');
        for (const words of [
            'Mapbox',
            'OpenStreetMap',
            'GEBCO',
            'AusBathyTopo (Great Barrier Reef) 30m 2017 - A regional-scale depth model (20170025C)',
            'CC BY 4.0',
            'OpenSeaMap',
            'CC BY-SA 2.0',
            'ODbL',
            'Not for navigation',
        ])
            await expect(credits).toContainText(words);
        const logo = page.locator('.mapboxgl-ctrl-logo');
        if ((await logo.count()) > 0) {
            const box = (await logo.boundingBox())!;
            const hit = await page.evaluate(
                ([x, y]) => document.elementFromPoint(x, y)?.closest('.mapboxgl-ctrl-logo') !== null,
                [box.x + box.width / 2, box.y + box.height / 2] as const,
            );
            expect(hit, 'the Mapbox logo is uncovered').toBe(true);
        }
    });

    test('night keeps its dim palette; leaving night restores Light', async ({ page, baseURL }) => {
        test.setTimeout(60_000);
        await openDesk(page, baseURL, 'place=solent&z=11');
        await page.evaluate(() => window.__deskMap.setSeamarks(false));
        const water: [number, number] = [-1.45, 50.745];
        await page.evaluate(() => window.__deskMap.setNight(true));
        await page.evaluate(() => window.__deskMap.idle());
        const [dark] = (await probe(page, [water])) as number[][];
        expect(lum(dark), `night water ${hex(dark)}`).toBeLessThan(0.05);
        await page.evaluate(() => window.__deskMap.setNight(false));
        await page.evaluate(() => window.__deskMap.idle());
        const [light] = (await probe(page, [water])) as number[][];
        expect(lum(light), `day water ${hex(light)}`).toBeGreaterThan(0.45);
    });

    test('1024 × 768: the menu and the strip fit under the top row', async ({ page, baseURL }, info) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width: 1024, height: 768 });
        await openDesk(page, baseURL, 'place=solent&z=11');
        await expect(page.getByRole('button', { name: 'Map base: Light' })).toBeVisible();
        await expect(page.getByTestId('desk-strip-slot-1')).toBeVisible();
        await shot(page, info, 'desk-light-solent-1024');
    });
});

// ── The real web planner ─────────────────────────────────────────────────
const SIZES = [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
];

/** A fictional NOAA-shaped cell in this browser's own chart registry (EncCellMetadata's localStorage). */
const FIXTURE_CELL = {
    id: 'US5FX10M',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-01-01',
    importedAt: '2026-10-10T00:00:00Z',
    bbox: [-76.45, 38.95, -76.35, 39.0],
    geojsonPath: 'enc/US5FX10M.json',
    hazardCount: 0,
    usage: 'navigation',
};
const CELL_STORAGE = [
    { name: 'thalassa.enc.cell.index', value: JSON.stringify([FIXTURE_CELL.id]) },
    { name: `thalassa.enc.cell:${FIXTURE_CELL.id}`, value: JSON.stringify(FIXTURE_CELL) },
];

function storage(baseURL: string, extra: Record<string, unknown> = {}, cell = false) {
    return {
        ...ONBOARDED_STORAGE,
        origins: ONBOARDED_STORAGE.origins.map((origin) => ({
            ...origin,
            origin: new URL(baseURL).origin,
            localStorage: [...(cell ? CELL_STORAGE : []), ...origin.localStorage].map((entry) => {
                if (
                    entry.name !== 'thalassa_settings_mirror::anonymous' &&
                    entry.name !== 'CapacitorStorage.thalassa_settings::anonymous'
                )
                    return entry;
                const saved = JSON.parse(entry.value);
                // A saved dark Obs base on the account: the desk must ignore it.
                saved.settings.obsChartBase = 'relief';
                saved.settings.vessel = { ...saved.settings.vessel, name: 'Fixture Boat' };
                Object.assign(saved.settings, extra);
                return { ...entry, value: JSON.stringify(saved) };
            }),
        })),
    };
}

async function openPlanner(page: Page, baseURL: string, size: { width: number; height: number }) {
    await page.setViewportSize(size);
    await applyWideFonts(page);
    await serveDesk(page, new URL(baseURL).origin, { seamarkRequests: 0 });
    await page.goto('/');
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
    // The chart's chunk and Mapbox load lazily; a cold dev server is slow.
    await expect(page.getByTestId('map-hub')).toBeVisible({ timeout: 45_000 });
    await page.waitForFunction(() => !!window.__thalassaMap, null, { timeout: 45_000 });
    await expect(page.getByRole('button', { name: /^Map base: / })).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
}
const plannerJump = (page: Page, lon: number, lat: number, zoom: number) =>
    page.evaluate(
        ([x, y, z]) =>
            new Promise<void>((resolve) => {
                const map = window.__thalassaMap!;
                map.once('moveend', () => setTimeout(resolve, 400));
                map.jumpTo({ center: [x, y], zoom: z });
            }),
        [lon, lat, zoom] as const,
    );
/**
 * The first chart merge in a fresh dev server can pull a dependency Vite has
 * not pre-bundled yet (delaunator, for derived contours), and Vite then reloads
 * the page ("optimized dependencies changed. reloading"). Jump, give that a
 * moment, and if the page reloaded, open the planner again and jump once more.
 */
async function jumpSettled(page: Page, lon: number, lat: number, zoom: number) {
    await page.evaluate(() => ((window as unknown as { __deskWarm?: boolean }).__deskWarm = true));
    await plannerJump(page, lon, lat, zoom).catch(() => undefined);
    await page.waitForTimeout(3_000);
    const same = await page
        .evaluate(() => (window as unknown as { __deskWarm?: boolean }).__deskWarm === true)
        .catch(() => false);
    if (same) return;
    await page.waitForLoadState('load');
    await openPlannerAfterReload(page);
    await page.waitForFunction(() => !!window.__thalassaMap, null, { timeout: 45_000 });
    await plannerJump(page, lon, lat, zoom);
}
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

test.describe('the real web planner', () => {
    test.use({ serviceWorkers: 'block' });

    for (const size of SIZES) {
        // Narrower than 744 px the tracer's compass rose holds the top centre:
        // the menu is an icon pill under the mic and only the strip's seamark
        // line stays, one line between the rose and the tracer card (index.css
        // .thalassa-desk-tracing): wherever the buoys draw, so do those words.
        const narrow = size.width < 744;
        test(`${size.width} × ${size.height}: Light, the menu${narrow ? ' under the mic' : ' top centre and its strip'} clear of every control`, async ({
            browser,
            baseURL,
        }, info) => {
            test.setTimeout(120_000);
            const context = await browser.newContext({ storageState: storage(baseURL!), serviceWorkers: 'block' });
            const page = await context.newPage();
            await openPlanner(page, baseURL!, size);
            const trigger = page.getByRole('button', { name: /^Map base: / });
            await expect(trigger).toHaveAccessibleName('Map base: Light');
            await plannerJump(page, -1.4, 50.76, 12);
            const slot0 = page.getByTestId('desk-strip-slot-0');
            const slot1 = page.getByTestId('desk-strip-slot-1');
            await expect(page.locator('body')).not.toContainText(/Licensed|Fixture Boat/);

            const menuBox = (await trigger.boundingBox())!;
            const mine: Array<[string, Box]> = [['menu', menuBox]];
            if (narrow) {
                await expect(slot0).toBeHidden();
                await expect(page.getByTestId('desk-strip-seabed')).toBeHidden();
                const rasterOn = await page.evaluate(
                    () => window.__thalassaMap!.getLayoutProperty('openseamap-permanent', 'visibility') === 'visible',
                );
                expect(rasterOn, 'the Solent at z12 draws the buoys').toBe(true);
                await expect(slot1).toBeVisible();
                // innerText: what is drawn, without the name a narrow window hides.
                await expect(slot1).toHaveText(/^Seamarks: community data, not verified/, { useInnerText: true });
                await expectWideFaceDrawn(slot1);
                const label = (await slot1.boundingBox())!;
                expect(label.height, 'one line').toBeLessThan(30);
                expect(label.x).toBeGreaterThanOrEqual(0);
                expect(label.x + label.width).toBeLessThanOrEqual(size.width);
                expect(label.y).toBeGreaterThanOrEqual(menuBox.y + menuBox.height);
                mine.push(['slot 1', label]);
                // The top-right control (the system status pair; the mic when Calypso is on).
                const corner = (await page
                    .getByRole('button', { name: /^System status/ })
                    .first()
                    .boundingBox())!;
                expect(menuBox.y, 'the menu sits under the top-right control').toBeGreaterThanOrEqual(
                    corner.y + corner.height,
                );
                expect(
                    Math.abs(menuBox.x + menuBox.width - (corner.x + corner.width)),
                    'right-aligned with it',
                ).toBeLessThan(2);
                // The seamark words are one tap away, in the menu itself.
                await trigger.click();
                const row = page.getByRole('menuitemcheckbox', { name: /^Seamarks/ });
                await expect(row).toContainText('OpenSeaMap community data, not verified');
                await expectWideFaceDrawn(row);
                const menu = (await page.getByRole('menu', { name: 'Map base' }).boundingBox())!;
                expect(menu.x).toBeGreaterThanOrEqual(0);
                expect(menu.x + menu.width).toBeLessThanOrEqual(size.width);
                await shot(page, info, `desk-planner-${size.width}x${size.height}-menu`);
                await page.keyboard.press('Escape');
            } else {
                await expectWideFaceDrawn(slot0);
                await expect(slot0).toHaveText('No chart for this area');
                await expect(slot1).toHaveText(/^Seamarks: OpenSeaMap community data, not verified/);
                expect(Math.abs(menuBox.x + menuBox.width / 2 - size.width / 2), 'the menu is centred').toBeLessThan(2);
                const strip = [(await slot0.boundingBox())!, (await slot1.boundingBox())!];
                expect(overlaps(strip[0], strip[1]), 'the strip slots never overlap').toBe(false);
                expect(strip[0].y).toBeGreaterThanOrEqual(menuBox.y + menuBox.height);
                mine.push(['slot 0', strip[0]], ['slot 1', strip[1]]);
            }
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
            };
            for (const [name, locator] of Object.entries(others)) {
                for (let i = 0; i < (await locator.count()); i++) {
                    const item = locator.nth(i);
                    if (!(await item.isVisible())) continue;
                    const box = (await item.boundingBox())!;
                    for (const [what, b] of mine) expect(overlaps(b, box), `${what} lies on the ${name}`).toBe(false);
                }
            }
            await shot(page, info, `desk-planner-${size.width}x${size.height}`);
            await context.close();
        });
    }

    test('a licensed account sees where its charts are; everyone else never sees "Licensed" or a boat name', async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(120_000);
        const licensed = await browser.newContext({
            storageState: storage(baseURL!, { boatCharts: { licensed: true } }),
            serviceWorkers: 'block',
        });
        const page = await licensed.newPage();
        await openPlanner(page, baseURL!, SIZES[0]);
        for (const [lon, lat] of [
            [-1.4, 50.76],
            [148.86, -20.24],
        ] as const) {
            await plannerJump(page, lon, lat, 12);
            await expect(page.getByTestId('desk-strip-slot-0')).toHaveText('Licensed charts stay on Fixture Boat');
        }
        await licensed.close();

        // A fictional NOAA-shaped cell registered on this browser, off a made-up Chesapeake shore.
        const open = await browser.newContext({ storageState: storage(baseURL!, {}, true), serviceWorkers: 'block' });
        const other = await open.newPage();
        await openPlanner(other, baseURL!, SIZES[0]);
        const slot0 = other.getByTestId('desk-strip-slot-0');
        for (const [lon, lat] of [
            [-1.4, 50.76],
            [148.86, -20.24],
        ] as const) {
            await plannerJump(other, lon, lat, 12);
            await expect(slot0).toHaveText('No chart for this area');
            await expect(slot0).toHaveCSS('visibility', 'visible');
        }
        await jumpSettled(other, -76.4, 38.975, 13);
        await expect(slot0).toHaveCSS('visibility', 'hidden');
        const over = await other.getByTestId('desk-strip-slot-1').boundingBox();
        await plannerJump(other, -76.2, 38.975, 13);
        await expect(slot0).toHaveCSS('visibility', 'visible');
        expect(await other.getByTestId('desk-strip-slot-1').boundingBox(), 'slot 1 never moves').toEqual(over);
        await expect(other.locator('body')).not.toContainText(/Licensed|Fixture Boat/);
        await open.close();
    });

    test('Hybrid and Seamarks off are kept on this computer; a fresh browser opens on Light with seamarks on', async ({
        browser,
        baseURL,
    }) => {
        test.setTimeout(150_000);
        const context = await browser.newContext({ storageState: storage(baseURL!), serviceWorkers: 'block' });
        const page = await context.newPage();
        await openPlanner(page, baseURL!, SIZES[1]);
        await page.getByRole('button', { name: 'Map base: Light' }).click();
        await page.getByRole('menuitemradio', { name: /^Hybrid / }).click();
        await page.getByRole('button', { name: 'Map base: Hybrid' }).click();
        await page.getByRole('menuitemcheckbox', { name: /^Seamarks/ }).click();
        await expect(page.getByTestId('desk-strip-slot-1')).toHaveCount(0);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('thalassa_desk_map_v1') ?? 'null'))).toEqual({
            base: 'hybrid',
            seamarks: false,
        });
        // The account's own Obs base is untouched.
        const obs = await page.evaluate(
            () =>
                JSON.parse(localStorage.getItem('thalassa_settings_mirror::anonymous') ?? '{}').settings?.obsChartBase,
        );
        expect(obs).toBe('relief');
        await page.reload();
        await openPlannerAfterReload(page);
        await expect(page.getByRole('button', { name: /^Map base: / })).toHaveAccessibleName('Map base: Hybrid');
        await expect(page.getByTestId('desk-strip-slot-1')).toHaveCount(0);
        await context.close();

        const fresh = await browser.newContext({ storageState: storage(baseURL!), serviceWorkers: 'block' });
        const first = await fresh.newPage();
        await openPlanner(first, baseURL!, SIZES[1]);
        await expect(first.getByRole('button', { name: /^Map base: / })).toHaveAccessibleName('Map base: Light');
        await expect(first.getByTestId('desk-strip-slot-1')).toBeVisible();
        await fresh.close();
    });
});

async function openPlannerAfterReload(page: Page) {
    const nav = page.getByRole('navigation', { name: 'Main', exact: true });
    await nav.getByRole('button', { name: 'Plan', exact: true }).click();
    const start = page.getByRole('button', { name: 'Start plotting', exact: true });
    await expect(start).toBeVisible({ timeout: 25_000 });
    await start.click();
    await page
        .getByRole('dialog', { name: 'Choose routing mode', exact: true })
        .getByRole('button', { name: 'Manual routing', exact: true })
        .click();
    await expect(page.getByRole('button', { name: /^Map base: / })).toBeVisible({ timeout: 30_000 });
}

// The contrast the cased lines and the slate hints reach on Light (the unit
// table, tests/TraceSketchLegs.test.tsx), restated where the eye checks it.
test('the dark edge and the slate hint stay readable on Light’s palest water', () => {
    expect(contrast('#1c1917', '#d4e6f2')).toBeGreaterThan(10);
    expect(contrast('#475569', '#d4e6f2')).toBeGreaterThan(5);
});
