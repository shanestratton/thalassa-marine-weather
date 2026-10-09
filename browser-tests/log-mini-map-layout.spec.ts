import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    boxes,
    creditsReadable,
    isBoat,
    isImagery,
    isPlainLand,
    isRelief,
    isRouteViolet,
    layerMismatches,
    MIB,
    noSideways,
    OLD_SATELLITE,
    openFixture,
    overlaps,
    probe,
    settled,
    shot,
    SHOTS,
    SIZES,
    uncovered,
    type Network,
} from '../e2e/helpers/logMapBrowser';
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
 * Set LOG_MAP_SHOTS_DIR to also save the screenshots there. The offline
 * network, the probe and the layout checks are shared with the big track
 * map's spec (e2e/helpers/logMapBrowser.ts).
 */

/** The live, fullscreen, planned or heap screen of e2e/fixtures/log-mini-map.tsx, offline. */
const open = (
    page: Page,
    baseURL: string,
    screen: string,
    size: { width: number; height: number },
    network: Network = 'online',
) => openFixture(page, baseURL, `/e2e/fixtures/log-mini-map.html?screen=${screen}&fonts=wide`, size, network);

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
        // The card's placeholder box can be swapped for the map's own box (the
        // lazy chunk landing) mid-scroll: scroll whichever box is there now.
        await expect(async () => {
            await page.locator('.live-mini-map').scrollIntoViewIfNeeded({ timeout: 2_000 });
        }).toPass({ timeout: 15_000 });
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
