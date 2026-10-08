import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compositeTile, fixtureStyle, imageryTile, reliefTile, seamarkTile } from '../e2e/helpers/syntheticChartTiles';
import { expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * The little Log map on Relief + Sat (125-13a, Shane 2026-10-09: "replace the
 * little and the big map with our relief + sat ?? remove the old satellite
 * map"), drawn for real by Mapbox GL in Chromium and WebKit, offline: every
 * tile comes from made-up coastlines (e2e/helpers/syntheticChartTiles.ts), in
 * the app's own cards (e2e/fixtures/log-mini-map.tsx) with wide fonts.
 *
 *  - the live card at 320x568 and 390x844 (the Solent): reliefBase's Relief +
 *    Sat layers on exactly as seaBaseLayers says; relief at sea, imagery on
 *    land, the boat's cyan dot drawn; the old satellite tiles never asked
 *    for; the credits a compact ⓘ that opens to Mapbox, Maxar, GEBCO and Not
 *    for navigation, clear of the card's own buttons; a tap on the map opens
 *    it, a tap on the credits does not; one WebGL map on the page;
 *  - its fullscreen map, credits clear of the Sighting pill and the shrink
 *    button;
 *  - an expanded planned route card in the Whitsundays (the GBR 30 m grid);
 *  - the Pi rule for the day it switches on (the fixture forces
 *    canDisplayProxiedTiles; in the app PI_TILE_PROXY_USABLE keeps it off, so
 *    today no tile goes through the Pi): relief and seamarks through the Pi,
 *    none direct; and with no style at all, a plain sea with the track still
 *    on it;
 *  - Chromium: the JS heap the little map costs, and what it gives back.
 *
 * Set LOG_MAP_SHOTS_DIR to also save the screenshots there.
 */

const SHOTS = process.env.LOG_MAP_SHOTS_DIR?.trim() || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const SIZES = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
];
const MIB = 1024 * 1024;
const OLD_SATELLITE = /satellite-streets|arcgisonline|World_Imagery/;

type Network = 'online' | 'pi' | 'nostyle';
type Fixture = {
    ready: boolean;
    maps: Array<{
        getContainer(): HTMLElement;
        getLayoutProperty(id: string, p: string): unknown;
        getLayer(id: string): unknown;
        loaded(): boolean;
        getZoom(): number;
        once(type: 'idle', listener: () => void): unknown;
        triggerRepaint(): void;
    }>;
    taps: { count: number };
    expected: Array<[string, boolean]>;
    boat: [number, number];
    mount(): void;
    unmount(): void;
    forget(): void;
    probe(lon: number, lat: number): Promise<number[] | null>;
};
declare global {
    interface Window {
        __logMapFixture: Fixture;
    }
}

interface Seen {
    all: string[];
    viaPi: string[];
    direct: string[];
    unexpected: string[];
}

const made = new Map<string, Buffer | null>();
const once = (key: string, make: () => Buffer | null) => {
    if (!made.has(key)) made.set(key, make());
    return made.get(key)!;
};

/** A tile host's answer, from the made-up coastlines; null for "no such tile" (a 404). */
function upstreamTile(url: URL): Buffer | null | undefined {
    const xyz = (m: RegExpMatchArray, at: number) => [Number(m[at]), Number(m[at + 1]), Number(m[at + 2])] as const;
    if (url.hostname === 'tiles.thalassatiles.com') {
        const m = url.pathname.match(/^\/v1\/relief-(global|au)\/(idx|dem)\/(\d+)\/(\d+)\/(\d+)\.(png|webp)$/);
        if (!m) return undefined;
        const [z, x, y] = xyz(m, 3);
        return once(`${m[2]}/${z}/${x}/${y}`, () => reliefTile(m[2] as 'idx' | 'dem', z, x, y));
    }
    if (url.hostname === 'tiles.openseamap.org') {
        const m = url.pathname.match(/^\/seamark\/(\d+)\/(\d+)\/(\d+)\.png$/);
        if (!m) return undefined;
        const [z, x, y] = xyz(m, 1);
        return once(`seamark/${z}/${x}/${y}`, () => seamarkTile(z, x, y));
    }
    if (url.hostname === 'api.mapbox.com') {
        // Mapbox rewrites its own raster URLs: @2x again for a 512 source, and .webp.
        const m = url.pathname.match(/^\/v4\/mapbox\.satellite\/(\d+)\/(\d+)\/(\d+)(?:@2x)*\.(?:jpg\d*|png|webp)$/);
        if (!m) return undefined;
        const [z, x, y] = xyz(m, 1);
        return once(`imagery/${z}/${x}/${y}`, () => imageryTile(z, x, y));
    }
    return undefined;
}

async function serveOffline(page: Page, origin: string, network: Network): Promise<Seen> {
    const seen: Seen = { all: [], viaPi: [], direct: [], unexpected: [] };
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        seen.all.push(url.href);
        if (url.origin === origin) {
            const m = url.pathname.match(/^\/__log-map-fixture\/composite\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
            if (!m) return route.continue();
            const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
            return route.fulfill({
                status: 200,
                contentType: 'application/x-protobuf',
                body: once(`mvt/${z}/${x}/${y}`, () => compositeTile(z, x, y))!,
            });
        }
        // The boat's Pi (a fictional host): it fetches upstream for us.
        if (url.hostname === 'pi.fixture.test' && url.pathname === '/api/passthrough-tile') {
            const upstream = new URL(url.searchParams.get('url') ?? '');
            seen.viaPi.push(upstream.href);
            const body = upstreamTile(upstream);
            return body
                ? route.fulfill({ status: 200, contentType: 'image/png', body })
                : route.fulfill({ status: 404 });
        }
        if (url.hostname === 'api.mapbox.com' && url.pathname === '/styles/v1/mapbox/dark-v11') {
            // As if cached: the style the app opened with ashore. 'nostyle' never had it.
            if (network === 'nostyle') return route.abort('internetdisconnected');
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(fixtureStyle(origin)),
            });
        }
        const body = upstreamTile(url);
        if (body !== undefined) {
            seen.direct.push(url.href);
            if (network !== 'online') return route.abort('internetdisconnected');
            return body
                ? route.fulfill({ status: 200, contentType: 'image/png', body })
                : route.fulfill({ status: 404 });
        }
        // Mapbox's telemetry and session pings, and anything else: no internet.
        if (!/^https:\/\/(events\.mapbox\.com|api\.mapbox\.com\/map-sessions)\//.test(url.href))
            seen.unexpected.push(url.href.replace(/access_token=[^&]+/, 'access_token=…'));
        return route.abort('internetdisconnected');
    });
    await page.routeWebSocket(/^wss?:\/\/(?!127\.0\.0\.1)/, (socket) => socket.close());
    return seen;
}

async function open(
    page: Page,
    baseURL: string,
    screen: string,
    size: { width: number; height: number },
    network: Network = 'online',
) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize(size);
    const seen = await serveOffline(page, new URL(baseURL).origin, network);
    await page.goto(`/e2e/fixtures/log-mini-map.html?screen=${screen}&fonts=wide${network === 'pi' ? '&pi=1' : ''}`);
    await page.waitForFunction(() => window.__logMapFixture?.ready === true);
    await page.evaluate(() => document.fonts.ready);
    return { errors, seen };
}

/** The newest map has its style (or the fallback) and every tile it asked for. */
async function settled(page: Page, style: 'relief-sat' | 'fallback') {
    await page.waitForFunction(
        (want) => {
            const map = window.__logMapFixture.maps.at(-1);
            return !!map && map.getContainer().dataset.logMapStyle === want && map.loaded();
        },
        style,
        { timeout: 45_000 },
    );
    // loaded() is true as the last tile arrives, but a raster tile then fades
    // in over 300 ms (the land imagery keeps Mapbox's default fade), and a
    // pixel read mid-fade sees the imagery half-drawn. Mapbox fires 'idle'
    // only once every fade and transition is done; the repaint makes sure
    // one comes even if the map went idle before we asked.
    await page.evaluate(
        () =>
            new Promise<void>((resolve) => {
                const map = window.__logMapFixture.maps.at(-1)!;
                map.once('idle', () => resolve());
                map.triggerRepaint();
            }),
    );
}

async function shot(page: Page, info: TestInfo, name: string) {
    const file = `${name}-${info.project.name}.png`;
    await page.screenshot({ path: info.outputPath(file), animations: 'disabled' });
    if (SHOTS) await page.screenshot({ path: join(SHOTS, file), animations: 'disabled' });
}

const probe = (page: Page, lon: number, lat: number) =>
    page.evaluate(([x, y]) => window.__logMapFixture.probe(x, y), [lon, lat] as const);

/** The water fill alone (#1f5a85): the relief tint must have drawn over it. */
const PLAIN_WATER = [31, 90, 133];
const isRelief = ([r, g, b]: number[]) =>
    b > r + 40 && b >= g && Math.max(...[r, g, b].map((c, i) => Math.abs(c - PLAIN_WATER[i]))) > 12;
const isImagery = ([r, g, b]: number[]) => g > b + 8 && r > 40;
const isPlainLand = ([r, g, b]: number[]) => b >= g && Math.abs(r - 51) < 20 && Math.abs(b - 69) < 20;
const isBoat = ([r, g, b]: number[]) => r < 110 && g > 180 && b > 200;
const isRouteViolet = ([r, g, b]: number[]) => b > 200 && r > 140 && g < b;

async function layerMismatches(page: Page) {
    return page.evaluate(() => {
        const f = window.__logMapFixture;
        const map = f.maps.at(-1)!;
        return f.expected
            .filter(([id, on]) => {
                if (!map.getLayer(id)) return true;
                const shown = (map.getLayoutProperty(id, 'visibility') ?? 'visible') === 'visible';
                return shown !== on;
            })
            .map(([id]) => id);
    });
}

/** Rectangles that must not lie on one another, by name. */
async function boxes(page: Page, named: Record<string, Locator>) {
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const [name, locator] of Object.entries(named)) {
        if ((await locator.count()) === 0 || !(await locator.first().isVisible())) continue;
        out[name] = (await locator.first().boundingBox())!;
    }
    return out;
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
    return (
        a.x < b.x + b.width - 0.5 &&
        b.x < a.x + a.width - 0.5 &&
        a.y < b.y + b.height - 0.5 &&
        b.y < a.y + a.height - 0.5
    );
}

/**
 * The opened credits, read whole: inside the map's box, nothing on any part
 * of what shows, and scrolling when they run longer than the map.
 */
async function creditsReadable(
    page: Page,
    corner: Locator,
    mapBox: { x: number; y: number; width: number; height: number },
) {
    const box = (await corner.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(mapBox.x - 0.5);
    expect(box.y).toBeGreaterThanOrEqual(mapBox.y - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(mapBox.x + mapBox.width + 0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(mapBox.y + mapBox.height + 0.5);
    const report = await corner.evaluate((element) => {
        const panel = element.querySelector('.mapboxgl-compact-show')!.getBoundingClientRect();
        const r = element.getBoundingClientRect();
        const top = Math.max(panel.top, r.top) + 4;
        const bottom = Math.min(panel.bottom, r.bottom) - 4;
        const covered: string[] = [];
        for (const y of [top, (top + bottom) / 2, bottom])
            for (const x of [panel.left + 6, (panel.left + panel.right) / 2, panel.right - 6]) {
                const hit = document.elementFromPoint(x, y);
                if (!hit || !element.contains(hit))
                    covered.push(`${Math.round(x)},${Math.round(y)}: ${hit?.className}`);
            }
        return {
            covered,
            scrolls: element.scrollHeight > element.clientHeight + 1,
            overflowY: getComputedStyle(element).overflowY,
        };
    });
    expect(report.covered, 'something lies on the opened credits').toEqual([]);
    if (report.scrolls) expect(report.overflowY).toBe('auto');
}

/** Hit-testable at its centre: nothing lies on it. */
async function uncovered(page: Page, locator: Locator) {
    return locator.first().evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && (hit === element || element.contains(hit));
    });
}

async function noSideways(page: Page) {
    return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

for (const size of SIZES) {
    test(`the live card draws Relief + Sat, credits clear, ${size.width}x${size.height}, wide fonts`, async ({
        page,
        baseURL,
    }, info) => {
        const { errors, seen } = await open(page, baseURL!, 'live', size);
        await expectWideFaceDrawn(page.getByRole('button', { name: 'Motor' }));
        await settled(page, 'relief-sat');
        expect(await layerMismatches(page), 'layers not as seaBaseLayers(reliefSat)').toEqual([]);
        await expect(page.locator('canvas.mapboxgl-canvas'), 'one Log WebGL map').toHaveCount(1);

        // Relief at sea, imagery on land, the boat where she is.
        const sea = (await probe(page, -1.4, 50.748))!;
        expect(sea, `sea pixel ${sea}`).not.toBeNull();
        expect(isRelief(sea), `relief tint at sea: ${sea}`).toBe(true);
        let land: number[] | null = null;
        for (const [lon, lat] of [
            [-1.4, 50.81],
            [-1.4, 50.7],
            [-1.25, 50.7],
            [-1.2, 50.83],
        ]) {
            land = await probe(page, lon, lat);
            if (land) break;
        }
        expect(land, 'a land point in view').not.toBeNull();
        expect(isImagery(land!), `imagery on land: ${land}`).toBe(true);
        const boat = await page.evaluate(() => window.__logMapFixture.boat);
        const boatPixel = (await probe(page, boat[0], boat[1]))!;
        expect(isBoat(boatPixel), `the boat's cyan dot: ${boatPixel}`).toBe(true);

        // The tiles it asked for: relief (both kinds) and mapbox.satellite, never the old satellite.
        expect(seen.all.some((u) => u.includes('/relief-global/idx/'))).toBe(true);
        expect(seen.all.some((u) => u.includes('/relief-global/dem/'))).toBe(true);
        expect(seen.all.some((u) => u.includes('/v4/mapbox.satellite/'))).toBe(true);
        expect(seen.all.filter((u) => OLD_SATELLITE.test(u))).toEqual([]);
        expect(seen.unexpected).toEqual([]);

        // Layout: nothing sideways; the card's buttons and the map's credits all
        // whole, uncovered and apart; the card ends above the tab bar.
        expect(await noSideways(page)).toBeLessThanOrEqual(0);
        const mapBox = (await page.locator('.live-mini-map').boundingBox())!;
        const nav = (await page.getByTestId('app-bottom-nav').boundingBox())!;
        expect(mapBox.y + mapBox.height).toBeLessThanOrEqual(nav.y + 0.5);
        expect(mapBox.height).toBeGreaterThanOrEqual(100);
        const credits = page.locator('.mapboxgl-ctrl-attrib-button');
        const named = {
            credits,
            logo: page.locator('.mapboxgl-ctrl-logo'),
            expand: page.getByRole('button', { name: 'Expand live map' }),
            sighting: page.getByRole('button', { name: 'Log a sighting' }),
        };
        const rects = await boxes(page, named);
        expect(Object.keys(rects)).toEqual(expect.arrayContaining(['credits', 'expand', 'sighting']));
        for (const [a, ra] of Object.entries(rects))
            for (const [b, rb] of Object.entries(rects))
                if (a < b) expect(overlaps(ra, rb), `${a} lies on ${b}`).toBe(false);
        for (const [name, rect] of Object.entries(rects)) {
            expect(rect.x, name).toBeGreaterThanOrEqual(mapBox.x - 0.5);
            expect(rect.x + rect.width, name).toBeLessThanOrEqual(mapBox.x + mapBox.width + 0.5);
            expect(await uncovered(page, named[name as keyof typeof named]), `${name} covered`).toBe(true);
        }
        for (const name of ['expand', 'sighting'] as const) {
            expect(rects[name].width, name).toBeGreaterThanOrEqual(44);
            expect(rects[name].height, name).toBeGreaterThanOrEqual(44);
        }
        await shot(page, info, `live-${size.width}`);

        // A tap on the map opens it; a tap on the credits opens the credits only.
        await page.locator('.live-mini-map canvas').click({ position: { x: mapBox.width / 2, y: mapBox.height / 2 } });
        await expect.poll(() => page.evaluate(() => window.__logMapFixture.taps.count)).toBe(1);
        await credits.click();
        await expect(credits).toHaveAttribute('aria-expanded', 'true');
        await creditsReadable(page, page.locator('.live-mini-map .mapboxgl-ctrl-top-right'), mapBox);
        const text = await page.locator('.mapboxgl-ctrl-attrib-inner').innerText();
        for (const credit of [
            'Mapbox',
            'Maxar',
            'GEBCO',
            'Geoscience Australia',
            'Not for navigation',
            'OpenStreetMap',
        ])
            expect(text, credit).toContain(credit);
        expect(await page.evaluate(() => window.__logMapFixture.taps.count)).toBe(1);
        await shot(page, info, `live-credits-${size.width}`);
        expect(errors).toEqual([]);
    });

    test(`the fullscreen live map: credits clear of the pill and the shrink button, ${size.width}x${size.height}`, async ({
        page,
        baseURL,
    }, info) => {
        const { errors } = await open(page, baseURL!, 'fullscreen', size);
        await settled(page, 'relief-sat');
        expect(await layerMismatches(page)).toEqual([]);
        await expect(page.locator('canvas.mapboxgl-canvas'), 'the card map is down while fullscreen').toHaveCount(1);
        const dialog = page.getByRole('dialog', { name: /Live Recording/ });
        const map = (await dialog.locator('.live-mini-map').boundingBox())!;
        expect(map.width).toBeGreaterThanOrEqual(size.width - 1);
        expect(map.height).toBeGreaterThanOrEqual(size.height - 1);
        const named = {
            credits: dialog.locator('.mapboxgl-ctrl-attrib-button'),
            logo: dialog.locator('.mapboxgl-ctrl-logo'),
            shrink: dialog.getByRole('button', { name: 'Shrink map' }),
            sighting: dialog.getByRole('button', { name: 'Log a sighting' }),
        };
        const rects = await boxes(page, named);
        expect(Object.keys(rects)).toEqual(expect.arrayContaining(['credits', 'shrink', 'sighting']));
        for (const [a, ra] of Object.entries(rects))
            for (const [b, rb] of Object.entries(rects))
                if (a < b) expect(overlaps(ra, rb), `${a} lies on ${b}`).toBe(false);
        for (const [name, rect] of Object.entries(rects)) {
            expect(rect.y + rect.height, name).toBeLessThanOrEqual(size.height + 0.5);
            expect(await uncovered(page, named[name as keyof typeof named]), `${name} covered`).toBe(true);
        }
        const boat = await page.evaluate(() => window.__logMapFixture.boat);
        expect(isBoat((await probe(page, boat[0], boat[1]))!)).toBe(true);
        await shot(page, info, `fullscreen-${size.width}`);
        await page.mouse.click(size.width / 2, size.height / 2);
        await expect.poll(() => page.evaluate(() => window.__logMapFixture.taps.count)).toBe(1);
        // Opened over the Sighting pill's row, the credits are on top and whole.
        await named.credits.click();
        await expect(named.credits).toHaveAttribute('aria-expanded', 'true');
        await creditsReadable(page, dialog.locator('.mapboxgl-ctrl-bottom-right'), map);
        expect(await page.evaluate(() => window.__logMapFixture.taps.count)).toBe(1);
        await shot(page, info, `fullscreen-credits-${size.width}`);
        expect(errors).toEqual([]);
    });

    test(`an expanded planned route in the Whitsundays (the GBR 30 m grid), ${size.width}x${size.height}`, async ({
        page,
        baseURL,
    }, info) => {
        const { errors, seen } = await open(page, baseURL!, 'planned', size);
        await page.locator('.live-mini-map').scrollIntoViewIfNeeded();
        await settled(page, 'relief-sat');
        expect(await layerMismatches(page)).toEqual([]);
        const sea = (await probe(page, 148.88, -20.2))!;
        expect(isRelief(sea), `relief at sea: ${sea}`).toBe(true);
        expect(
            seen.all.some((u) => u.includes('/relief-au/idx/')),
            'the GBR 30 m grid is asked for here',
        ).toBe(true);
        expect(seen.all.filter((u) => OLD_SATELLITE.test(u))).toEqual([]);
        expect(await noSideways(page)).toBeLessThanOrEqual(0);
        const mapBox = (await page.locator('.live-mini-map').boundingBox())!;
        expect(mapBox.height).toBe(140);
        const article = (await page.locator('.live-mini-map').evaluate((el) => {
            const card = el.closest('.rounded-2xl.snap-start') ?? el.parentElement!;
            const r = card.getBoundingClientRect();
            return { x: r.x, width: r.width };
        }))!;
        expect(mapBox.x).toBeGreaterThanOrEqual(article.x - 0.5);
        expect(mapBox.x + mapBox.width).toBeLessThanOrEqual(article.x + article.width + 0.5);
        expect(await uncovered(page, page.locator('.mapboxgl-ctrl-attrib-button'))).toBe(true);
        await shot(page, info, `planned-${size.width}`);
        await page.locator('.live-mini-map canvas').click();
        await expect.poll(() => page.evaluate(() => window.__logMapFixture.taps.count)).toBe(1);
        expect(errors).toEqual([]);
    });
}

test('Pi rule, forced on as PI_TILE_PROXY_USABLE will one day be: relief and seamarks via the Pi, none direct', async ({
    page,
    baseURL,
}, info) => {
    const { errors, seen } = await open(page, baseURL!, 'live', { width: 390, height: 844 }, 'pi');
    await settled(page, 'relief-sat');
    expect(seen.viaPi.some((u) => u.includes('tiles.thalassatiles.com/v1/relief-global/idx/'))).toBe(true);
    expect(seen.viaPi.some((u) => u.includes('tiles.openseamap.org/seamark/'))).toBe(true);
    // Mapbox's own imagery never goes through the Pi (useMapInit's rule): offline, land is plain.
    expect(seen.viaPi.filter((u) => u.includes('api.mapbox.com'))).toEqual([]);
    expect(seen.direct.filter((u) => /thalassatiles|openseamap/.test(u))).toEqual([]);
    const sea = (await probe(page, -1.4, 50.748))!;
    expect(isRelief(sea), `relief at sea through the Pi: ${sea}`).toBe(true);
    const land = (await probe(page, -1.4, 50.81)) ?? (await probe(page, -1.4, 50.7));
    expect(land && isPlainLand(land), `plain land without the imagery: ${land}`).toBe(true);
    const boat = await page.evaluate(() => window.__logMapFixture.boat);
    expect(isBoat((await probe(page, boat[0], boat[1]))!)).toBe(true);
    await shot(page, info, 'offline-pi-390');
    expect(errors).toEqual([]);
});

test('no internet and no style at all: a plain sea, the track and the boat still drawn', async ({
    page,
    baseURL,
}, info) => {
    const { errors } = await open(page, baseURL!, 'live', { width: 390, height: 844 }, 'nostyle');
    await settled(page, 'fallback');
    const boat = await page.evaluate(() => window.__logMapFixture.boat);
    expect(isBoat((await probe(page, boat[0], boat[1]))!)).toBe(true);
    // The followed route's violet core, out at Hurst where nothing else is drawn.
    const route = (await probe(page, -1.49, 50.739))!;
    expect(route, 'the route in view').not.toBeNull();
    expect(isRouteViolet(route), `the route's violet core: ${route}`).toBe(true);
    await shot(page, info, 'offline-nostyle-390');
    expect(errors).toEqual([]);
});

test('Chromium: the JS heap the little map costs, and what it gives back', async ({
    page,
    baseURL,
    browserName,
}, info) => {
    test.skip(browserName !== 'chromium', 'heap readings come from the Chrome DevTools Protocol');
    await open(page, baseURL!, 'heap', { width: 390, height: 844 });
    const cdp = await page.context().newCDPSession(page);
    const heap = async () => {
        await cdp.send('HeapProfiler.collectGarbage');
        await cdp.send('HeapProfiler.collectGarbage');
        return (await cdp.send('Runtime.getHeapUsage')).usedSize;
    };
    // Three visits (LOG_MAP_HEAP_VISITS for more). The first also pays Mapbox's
    // one-time warm-up (its code compiled on first use, which Obs has already
    // paid in the app); the last is what a visit costs. What a removed map
    // leaves behind must level off, never grow by a map's worth per visit.
    await page.waitForTimeout(800);
    const readings: number[] = [await heap()];
    let canvas = { width: 0, height: 0 };
    const visits = Math.max(3, Number(process.env.LOG_MAP_HEAP_VISITS) || 3);
    for (let visit = 0; visit < visits; visit += 1) {
        await page.evaluate(() => window.__logMapFixture.mount());
        await settled(page, 'relief-sat');
        await page.waitForTimeout(800);
        readings.push(await heap());
        canvas = await page
            .locator('canvas.mapboxgl-canvas')
            .evaluate((c: HTMLCanvasElement) => ({ width: c.width, height: c.height }));
        await page.evaluate(() => window.__logMapFixture.unmount());
        await expect(page.locator('canvas.mapboxgl-canvas')).toHaveCount(0);
        await page.evaluate(() => window.__logMapFixture.forget());
        await page.waitForTimeout(800);
        readings.push(await heap());
    }
    const [base, firstOn, firstOff] = readings;
    const [previousOff, lastOn, lastOff] = readings.slice(-3);
    const mib = (bytes: number) => +(bytes / MIB).toFixed(2);
    const report = {
        visits,
        jsHeapMiB: readings.map(mib),
        firstVisitDeltaMiB: mib(firstOn - base),
        firstVisitLeftAfterRemoveMiB: mib(firstOff - base),
        lastVisitDeltaMiB: mib(lastOn - previousOff),
        lastVisitLeftAfterRemoveMiB: mib(lastOff - previousOff),
        canvas,
        canvasBackingMiB: mib(canvas.width * canvas.height * 4),
        note: 'main-thread JS heap after a forced GC; Mapbox workers and GPU textures are outside it',
    };
    info.annotations.push({ type: 'log map heap', description: JSON.stringify(report) });
    writeFileSync(info.outputPath('log-map-heap.json'), JSON.stringify(report, null, 2));
    if (SHOTS) writeFileSync(join(SHOTS, 'log-map-heap.json'), JSON.stringify(report, null, 2));
    console.info('log map heap:', JSON.stringify(report));
    expect(firstOn - base).toBeLessThan(48 * MIB);
    expect(lastOn - previousOff).toBeLessThan(24 * MIB);
    expect(lastOff - previousOff, 'a removed map leaves nothing that grows per visit').toBeLessThan(1.5 * MIB);
});
