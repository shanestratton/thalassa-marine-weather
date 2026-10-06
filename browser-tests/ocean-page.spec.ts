/**
 * Thalassa Ocean (ocean.html): the real page against FICTIONAL fleet data.
 * Every sighting below is invented, in open water, credited to a fictional
 * boat; the historical layer is the committed OBIS context file.
 *
 * By default nothing leaves 127.0.0.1: the Mapbox style is a stub (no tiles,
 * no token sent anywhere), which still proves the map wrapper loads and draws
 * the context and fleet layers. With OCEAN_LIVE_MAP=1 the real Mapbox style,
 * our Relief tiles and Google Fonts load too, and the test also requires at
 * least one relief tile to answer 200 (proof of rendering, not of absence).
 *
 * Checked: desktop 1440x900 and phone 390x844, dark and light, the zero-fleet
 * day-one state, the "functions not pushed yet" state and the map-failed
 * fallback (with Try again); no sideways scroll; the honest copy; nothing
 * promises anonymity; and the map canvas always fills its box, including when
 * the stylesheets arrive late (the Safari race that left 60% of the hero map
 * blank). Run it under WebKit too: --project=mobile-safari.
 * Set OCEAN_SHOTS_DIR to save screenshots.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = process.env.OCEAN_SHOTS_DIR?.trim() || '';
const LIVE = process.env.OCEAN_LIVE_MAP === '1';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const HUMPBACK = 'Megaptera novaeangliae';

/** Fictional fleet summary in the exact shape api/ocean/[view].ts passes on. */
function fictionalSummary() {
    const cells: unknown[][] = [
        [-27.05, 153.65, 'whale', HUMPBACK, false, 2026, 7, 4, 9],
        [-26.95, 153.75, 'whale', HUMPBACK, false, 2026, 8, 6, 13],
        [-24.85, 153.45, 'whale', HUMPBACK, false, 2026, 9, 5, 12],
        [-20.05, 149.45, 'whale', HUMPBACK, false, 2026, 8, 3, 7],
        [-26.55, 153.25, 'whale', null, true, 2026, 8, 1, 1],
        [-27.35, 153.35, 'dolphin', 'Tursiops aduncus', false, 2026, 9, 2, 6],
        [-27.45, 153.35, 'dugong', 'Dugong dugon', true, 2026, 9, 1, 2],
        [-23.45, 151.95, 'turtle', 'Chelonia mydas', true, 2026, 10, 1, 1],
        [-23.15, 152.05, 'seabird', 'Sula leucogaster', false, 2026, 10, 2, 14],
    ];
    const recent = [
        {
            id: '0f6f2d0e-5d0b-4c4e-9a51-1f0c2b7a9e01',
            group: 'turtle',
            sci: 'Chelonia mydas',
            name: 'Green turtle',
            rank: 'species',
            count: 1,
            calf: false,
            time: '2026-10-03T01:00:00+00:00',
            lat: -23.45,
            lon: 151.95,
            uncertainty_m: 7850,
            generalised: true,
            credit: null,
        },
        {
            id: '6b7f0b52-3c1e-4c9e-8f7a-2d0a3e4b5c02',
            group: 'seabird',
            sci: 'Sula leucogaster',
            name: 'Brown booby',
            rank: 'species',
            count: 14,
            calf: false,
            time: '2026-10-02T22:40:00+00:00',
            lat: -23.155,
            lon: 152.045,
            uncertainty_m: 790,
            generalised: false,
            credit: 'fixture-boat',
        },
        {
            id: '9c2d4e6f-7a8b-4c0d-9e1f-3a5b7c9d1e03',
            group: 'whale',
            sci: HUMPBACK,
            name: 'Humpback whale',
            rank: 'species',
            count: 3,
            calf: true,
            time: '2026-09-21T03:10:00+00:00',
            lat: -24.855,
            lon: 153.445,
            uncertainty_m: 790,
            generalised: false,
            credit: null,
        },
    ];
    const species = [
        {
            sci: HUMPBACK,
            name: 'Humpback whale',
            group: 'whale',
            generalised: false,
            n: 18,
            animals: 41,
            first: '2026-07-04T00:00:00+00:00',
            last: '2026-09-21T03:10:00+00:00',
            months: { '7': 4, '8': 9, '9': 5 },
            hours: { '7': 2, '8': 3, '9': 4, '10': 3, '13': 2, '15': 3, '16': 1 },
            years: { '2026': 18 },
            sst: { '20': 2, '21': 5, '22': 7, '23': 3 },
        },
        {
            sci: 'Tursiops aduncus',
            name: 'Indo-Pacific bottlenose dolphin',
            group: 'dolphin',
            generalised: false,
            n: 2,
            animals: 6,
            first: '2026-09-10T00:00:00+00:00',
            last: '2026-09-12T00:00:00+00:00',
            months: { '9': 2 },
            hours: { '8': 1, '16': 1 },
            years: { '2026': 2 },
            sst: null,
        },
    ];
    return {
        v: 1,
        status: 'ok',
        generated_at: '2026-10-06T00:00:00+00:00',
        delay_hours: 3,
        grid: { fine_deg: 0.01, coarse_deg: 0.1, cell_deg: 0.1 },
        totals: {
            sightings: 25,
            animals: 65,
            species: 5,
            boats: null,
            boats_min_shown: 3,
            first_time: '2026-07-04T00:00:00+00:00',
            last_time: '2026-10-03T01:00:00+00:00',
        },
        groups: { whale: [19, 42], dolphin: [2, 6], dugong: [1, 2], turtle: [1, 1], seabird: [2, 14] },
        cells,
        species,
        recent,
    };
}

type Fleet = 'fixture' | 'empty' | 'not-ready' | 'down';

async function open(page: Page, fleet: Fleet, opts: { failMap?: boolean; lateCss?: number } = {}) {
    const reliefTiles: number[] = [];
    const contextRequests: string[] = [];
    page.on('response', (response) => {
        if (new URL(response.url()).hostname === 'tiles.thalassatiles.com') reliefTiles.push(response.status());
    });
    page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/ocean-data/context/')) contextRequests.push(request.url());
    });
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        // WebKit routes the page's own blob: URLs too (Mapbox starts its
        // worker from one); aborting it there left the map waiting forever.
        if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
        if (url.pathname === '/api/ocean/summary') {
            if (fleet === 'down')
                return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"x"}' });
            const body =
                fleet === 'fixture'
                    ? fictionalSummary()
                    : fleet === 'not-ready'
                      ? { v: 1, status: 'not-ready' }
                      : {
                            ...fictionalSummary(),
                            totals: { sightings: 0, animals: 0, species: 0, boats: null, boats_min_shown: 3 },
                            groups: {},
                            cells: [],
                            species: [],
                            recent: [],
                        };
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        }
        if (url.pathname === '/api/ocean/rows') {
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: '{"v":1,"status":"ok","rows":[],"next":null}',
            });
        }
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
            if (opts.lateCss && url.pathname.endsWith('.css')) await new Promise((r) => setTimeout(r, opts.lateCss));
            return route.continue();
        }
        if (url.hostname.endsWith('mapbox.com') && url.pathname.includes('/styles/v1/')) {
            if (opts.failMap) return route.abort();
            if (!LIVE) {
                return route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        version: 8,
                        sources: {},
                        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b2133' } }],
                    }),
                });
            }
        }
        const liveHosts = ['api.mapbox.com', 'tiles.thalassatiles.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
        if (LIVE && liveHosts.includes(url.hostname)) return route.continue();
        return route.abort();
    });
    await page.goto('/ocean');
    await expect(page.getByRole('heading', { level: 1, name: 'Every boat is a research vessel.' })).toBeVisible();
    return { reliefTiles, contextRequests };
}

/** The canvas is the size of its box (Safari once left it 250 px tall in a 589 px box). */
async function canvasFills(page: Page) {
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const box = document.querySelector('.oc-map-wrap') as HTMLElement | null;
                    const canvas = document.querySelector('.oc-map canvas') as HTMLCanvasElement | null;
                    if (!box || !canvas) return 'no map';
                    return Math.abs(box.clientHeight - canvas.clientHeight) <= 2 &&
                        Math.abs(box.clientWidth - canvas.clientWidth) <= 2
                        ? 'fills'
                        : `canvas ${canvas.clientWidth}x${canvas.clientHeight} in ${box.clientWidth}x${box.clientHeight}`;
                }),
            { timeout: 15_000 },
        )
        .toBe('fills');
}

async function mapDrawn(page: Page, reliefTiles: number[], expectFleet: boolean) {
    const map = page.locator('.oc-map');
    await expect(map).toHaveAttribute('data-map-state', 'ready', { timeout: 45_000 });
    await canvasFills(page);
    await expect
        .poll(async () => Number(await map.getAttribute('data-ctx-rendered')), { timeout: 45_000 })
        .toBeGreaterThan(0);
    if (expectFleet) {
        await expect
            .poll(async () => Number(await map.getAttribute('data-fleet-rendered')), { timeout: 30_000 })
            .toBeGreaterThan(0);
    }
    if (LIVE)
        await expect.poll(() => reliefTiles.filter((s) => s === 200).length, { timeout: 45_000 }).toBeGreaterThan(0);
    // The Mapbox wordmark and the attribution stay on screen and uncovered.
    // (The stub style has no sources, so its attribution is empty and Mapbox
    // hides the empty control; the live style credits Mapbox, OSM and, via
    // the relief sources, GEBCO and Geoscience Australia.)
    await expect(page.locator('.mapboxgl-ctrl-logo')).toBeVisible();
    if (LIVE) {
        const attribution = page.locator('.mapboxgl-ctrl-attrib');
        await expect(attribution).toBeVisible();
        await expect(attribution).toContainText(/GEBCO/);
    }
}

async function noSidewaysScroll(page: Page) {
    const { scroll, width } = await page.evaluate(() => ({
        scroll: document.scrollingElement?.scrollWidth ?? 0,
        width: window.innerWidth,
    }));
    expect(scroll).toBeLessThanOrEqual(width);
}

async function honestCopy(page: Page) {
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    expect(text).not.toMatch(/sample data|concept/i);
    expect(text).not.toMatch(/25 km/);
    expect(text).toContain('on a 1 km grid');
    expect(text).toContain('10 km square');
    // Threatened species are counts, never points, until 3 boats share an area.
    expect(text).toContain('shown only as area counts until at least 3 boats have logged them in an area');
    // Only ever "Not anonymous while the fleet is small", never a promise.
    expect(text.replace(/Not anonymous while the fleet is small/g, '')).not.toMatch(/anonym/i);
    await expect(page.getByRole('button', { name: /^Fish/ })).toHaveCount(0);
}

async function shot(page: Page, name: string, fullPage = false) {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `shot_${name}.png`), fullPage });
}

for (const scheme of ['dark', 'light'] as const) {
    test(`desktop 1440x900 with fictional fleet data (${scheme})`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.setViewportSize({ width: 1440, height: 900 });
        const { reliefTiles } = await open(page, 'fixture');
        await expect(page.locator('.oc-pill')).toHaveText('Live · 3 h behind');
        const panel = page.getByRole('complementary', { name: 'Map controls' });
        await expect(panel.locator('.oc-stat').first()).toContainText('sightings');
        await expect(panel).toContainText('fewer than 3');
        await expect(page.getByRole('link', { name: 'Logged aboard fixture-boat' })).toHaveAttribute(
            'href',
            'https://fixture-boat.thalassawx.app',
        );
        await expect(page.locator('.oc-latest')).toContainText('A Thalassa sailor');
        await expect(page.getByRole('heading', { level: 2, name: 'Humpback whale' })).toBeVisible();
        await mapDrawn(page, reliefTiles, true);
        await honestCopy(page);
        await noSidewaysScroll(page);
        await shot(page, `desktop_${scheme}`);
        await shot(page, `desktop_${scheme}_full`, true);
    });
}

test('desktop: the waiting layers explain themselves, and Play the year moves the month', async ({ page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'fixture');
    const effort = page.getByRole('button', { name: /^Where we looked/ });
    await expect(effort).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled, not disabled: it stays focusable so it can say why it waits.
    await effort.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.oc-note')).toContainText('at least 3 boats');
    await expect(page.locator('.oc-note')).toContainText('Fewer than 3 boats are logging so far.');
    await page.getByRole('button', { name: 'August' }).click();
    await expect(page.locator('.oc-mon')).toHaveText('August');
    await expect(page.locator('.oc-cap').first()).toContainText('Whitsundays');
    await page.getByRole('button', { name: 'Play the year' }).click();
    await expect(page.locator('.oc-mon')).toHaveText('September');
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.getByRole('combobox', { name: 'Choose an animal' }).selectOption('Tursiops aduncus');
    await expect(page).toHaveURL(/\/ocean\/species\/tursiops-aduncus$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Indo-Pacific bottlenose dolphin' })).toBeVisible();
});

for (const scheme of ['dark', 'light'] as const) {
    test(`phone 390x844 with fictional fleet data (${scheme})`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
        await page.setViewportSize({ width: 390, height: 844 });
        const { reliefTiles } = await open(page, 'fixture');
        await mapDrawn(page, reliefTiles, true);
        // The month readout sits below the region chips, never over them.
        const chips = await page.locator('.oc-regions').boundingBox();
        const readout = await page.locator('.oc-readout').boundingBox();
        expect(readout!.y).toBeGreaterThanOrEqual(chips!.y + chips!.height - 1);
        await noSidewaysScroll(page);
        await honestCopy(page);
        await shot(page, `phone_${scheme}`);
        await shot(page, `phone_${scheme}_full`, true);
    });
}

test('region fly-tos draw the chart from the whole globe down to a bay', async ({ page }) => {
    test.setTimeout(150_000);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const { reliefTiles } = await open(page, 'fixture');
    await mapDrawn(page, reliefTiles, true);
    const map = page.locator('.oc-map');
    for (const [chip, name] of [
        ['World', 'world'],
        ['Moreton Bay', 'moreton'],
    ] as const) {
        await page.getByRole('button', { name: chip, exact: false }).first().click();
        await expect(page.getByRole('button', { name: chip, exact: false }).first()).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        // Both views keep the historical layer drawn (heatmap on the globe,
        // soft cells close in) and the fleet on top.
        await expect
            .poll(async () => Number(await map.getAttribute('data-ctx-rendered')), { timeout: 45_000 })
            .toBeGreaterThan(0);
        await page.waitForTimeout(LIVE ? 4000 : 500);
        await page.locator('.oc-map-wrap').scrollIntoViewIfNeeded();
        if (SHOTS) await page.locator('.oc-map-wrap').screenshot({ path: join(SHOTS, `shot_map_${name}.png`) });
    }
});

test('day one: zero fleet sightings is said plainly, with no numbers', async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const { reliefTiles } = await open(page, 'empty');
    await expect(page.locator('.oc-pill')).toHaveText('Waiting for the first sightings');
    const panel = page.getByRole('complementary', { name: 'Map controls' });
    await expect(panel).toContainText('The first sightings arrive as boats log them.');
    await expect(page.locator('.oc-latest')).toHaveCount(0);
    // The historical layer still fills the map, labelled as what it is.
    await expect(panel).toContainText('record-days');
    await expect(page.locator('.oc-readout')).toContainText('Showing historical public records');
    await mapDrawn(page, reliefTiles, false);
    await honestCopy(page);
    await shot(page, 'empty_desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await noSidewaysScroll(page);
    await shot(page, 'empty_phone');
});

test('before the migration is pushed, the page waits honestly', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'not-ready');
    await expect(page.locator('.oc-pill')).toHaveText('Waiting for the first sightings');
    await expect(page.getByRole('complementary', { name: 'Map controls' })).toContainText(
        'The first sightings arrive as boats log them.',
    );
});

test('fleet data down, and no map: everything else still works, and the map can be tried again', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, 'down', { failMap: true });
    await expect(page.locator('.oc-pill')).toHaveText('Fleet data offline');
    await expect(page.locator('.oc-map-fallback')).toContainText('The map can’t load here.', { timeout: 30_000 });
    // With no map, it does not claim the historical records are on it.
    await expect(page.getByRole('complementary', { name: 'Map controls' })).toContainText(
        'Fleet data is not reachable right now.',
    );
    await expect(page.getByRole('complementary', { name: 'Map controls' })).not.toContainText(
        'historical records are still shown',
    );
    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(page.locator('.oc-map-fallback')).toContainText('The map can’t load here.', { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 2, name: 'Humpback whale' })).toBeVisible();
    await noSidewaysScroll(page);
    await shot(page, 'fallback_phone');
});

test('the historical records file is downloaded once (Safari fetched a preloaded copy twice)', async ({ page }) => {
    const { contextRequests } = await open(page, 'not-ready');
    await expect(page.getByRole('complementary', { name: 'Map controls' })).toContainText('record-days');
    await page.waitForTimeout(3_000);
    expect(contextRequests).toHaveLength(1);
});

test('late stylesheets: the map still fills its box at phone size (the Safari race)', async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    const { reliefTiles } = await open(page, 'not-ready', { lateCss: 1500 });
    await mapDrawn(page, reliefTiles, false);
    // A later size change (the iOS address bar collapsing) is followed too.
    await page.setViewportSize({ width: 390, height: 700 });
    await canvasFills(page);
    await shot(page, 'late_css_phone');
});
