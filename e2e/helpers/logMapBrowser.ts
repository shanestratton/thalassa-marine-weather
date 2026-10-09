import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { compositeTile, fixtureStyle, imageryTile, reliefTile, seamarkTile } from './syntheticChartTiles';

/**
 * What the Log maps' browser specs share (the little map, browser-tests/
 * log-mini-map-layout.spec.ts, 125-13a; the big track map, browser-tests/
 * track-map-viewer-layout.spec.ts, 125-13b): the offline network that answers
 * every tile from made-up coastlines (./syntheticChartTiles.ts), the wait for
 * a map that has really drawn, a pixel probe and its colour tests, and the
 * layout checks (nothing on anything, nothing sideways, credits readable).
 *
 * Both fixtures publish window.__logMapFixture: every Mapbox map the page
 * built, the layers seaBaseLayers('reliefSat') says are on, and a probe.
 *
 * Set LOG_MAP_SHOTS_DIR to also save the screenshots there.
 */

export const SHOTS = process.env.LOG_MAP_SHOTS_DIR?.trim() || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
export const SIZES = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
];
export const MIB = 1024 * 1024;
export const OLD_SATELLITE = /satellite-streets|arcgisonline|World_Imagery/;

export type Network = 'online' | 'pi' | 'nostyle';
export type FixtureMap = {
    getContainer(): HTMLElement;
    getLayoutProperty(id: string, p: string): unknown;
    getLayer(id: string): unknown;
    loaded(): boolean;
    getZoom(): number;
    getCenter(): { lng: number; lat: number };
    getBounds(): { getWest(): number; getEast(): number; getSouth(): number; getNorth(): number };
    once(type: 'idle', listener: () => void): unknown;
    triggerRepaint(): void;
};
export type LogMapFixture = {
    ready: boolean;
    maps: FixtureMap[];
    taps: { count: number };
    expected: Array<[string, boolean]>;
    boat: [number, number];
    /** The track map's fixture: named places on its tracks, [lon, lat]. */
    spots: Record<string, [number, number]>;
    /** The track map's fixture: the slider index the spec scrubs the boat to. */
    boatIndex: number;
    /** The track map's fixture: where [lon, lat] is on the screen (client pixels). */
    at(lon: number, lat: number): { x: number; y: number };
    mount(): void;
    unmount(): void;
    forget(): void;
    probe(lon: number, lat: number): Promise<number[] | null>;
};
declare global {
    interface Window {
        __logMapFixture: LogMapFixture;
    }
}

export interface Seen {
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

/**
 * No internet: the page's own origin, the fixture's vector tiles, a cached
 * dark-v11 stand-in (unless 'nostyle'), the made-up tiles online, and the
 * boat's Pi (a fictional host) for 'pi'. Anything else is refused and noted.
 */
export async function serveOffline(page: Page, origin: string, network: Network): Promise<Seen> {
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

/** Open a fixture page (its path and query) offline, at `size`, once it says it is ready. */
export async function openFixture(
    page: Page,
    baseURL: string,
    path: string,
    size: { width: number; height: number },
    network: Network = 'online',
) {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize(size);
    const seen = await serveOffline(page, new URL(baseURL).origin, network);
    await page.goto(`${path}${network === 'pi' ? '&pi=1' : ''}`);
    await page.waitForFunction(() => window.__logMapFixture?.ready === true);
    await page.evaluate(() => document.fonts.ready);
    return { errors, seen };
}

/** The newest map has its style (or the fallback) and every tile it asked for. */
export async function settled(page: Page, style: 'relief-sat' | 'fallback') {
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

export async function shot(page: Page, info: TestInfo, name: string) {
    const file = `${name}-${info.project.name}.png`;
    await page.screenshot({ path: info.outputPath(file), animations: 'disabled' });
    if (SHOTS) await page.screenshot({ path: join(SHOTS, file), animations: 'disabled' });
}

export const probe = (page: Page, lon: number, lat: number) =>
    page.evaluate(([x, y]) => window.__logMapFixture.probe(x, y), [lon, lat] as const);

/** The water fill alone (#1f5a85): the relief tint must have drawn over it. */
const PLAIN_WATER = [31, 90, 133];
export const isRelief = ([r, g, b]: number[]) =>
    b > r + 40 && b >= g && Math.max(...[r, g, b].map((c, i) => Math.abs(c - PLAIN_WATER[i]))) > 12;
export const isImagery = ([r, g, b]: number[]) => g > b + 8 && r > 40;
export const isPlainLand = ([r, g, b]: number[]) => b >= g && Math.abs(r - 51) < 20 && Math.abs(b - 69) < 20;
export const isBoat = ([r, g, b]: number[]) => r < 110 && g > 180 && b > 200;
export const isRouteViolet = ([r, g, b]: number[]) => b > 200 && r > 140 && g < b;

export async function layerMismatches(page: Page) {
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

export type Rect = { x: number; y: number; width: number; height: number };

/** Rectangles that must not lie on one another, by name. */
export async function boxes(page: Page, named: Record<string, Locator>) {
    const out: Record<string, Rect> = {};
    for (const [name, locator] of Object.entries(named)) {
        if ((await locator.count()) === 0 || !(await locator.first().isVisible())) continue;
        out[name] = (await locator.first().boundingBox())!;
    }
    return out;
}

export function overlaps(a: Rect, b: Rect) {
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
export async function creditsReadable(page: Page, corner: Locator, mapBox: Rect) {
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
export async function uncovered(page: Page, locator: Locator) {
    return locator.first().evaluate((element) => {
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && (hit === element || element.contains(hit));
    });
}

export async function noSideways(page: Page) {
    return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}
