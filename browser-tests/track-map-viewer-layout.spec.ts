import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    boxes,
    creditsReadable,
    isBoat,
    isImagery,
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
    type Rect,
} from '../e2e/helpers/logMapBrowser';
import { expectWideFaceDrawn } from '../e2e/helpers/wideFonts';

/**
 * The big Log track map on Relief + Sat (125-13b, Shane 2026-10-09: "replace
 * the little and the big map with our relief + sat ?? remove the old
 * satellite map"), drawn for real by Mapbox GL in Chromium and WebKit,
 * offline: every tile comes from made-up coastlines (e2e/helpers/
 * syntheticChartTiles.ts), in the app's own TrackMapViewer (e2e/fixtures/
 * track-map.tsx) with wide fonts, at 320x568 and 390x844:
 *
 *  - the Solent (England): reliefBase's Relief + Sat layers on exactly as
 *    seaBaseLayers says; relief at sea, imagery on land, the track in its
 *    forecast-wind colours, the start and end dots; the old satellite tiles
 *    never asked for; every control of the viewer whole, uncovered and apart
 *    (back, title, Wind/Track, both legends, the speed line, the scrubber,
 *    Mapbox's ⓘ and wordmark); the credits open to Mapbox, Maxar, GEBCO,
 *    Not for navigation and OpenSeaMap; a tap shows the conditions there and
 *    a second tap closes them; a drag pans; closing removes the map;
 *  - playback: the boat drawn where the scrubber puts her, the HUD and the
 *    waypoint banner clear of the controls; a waypoint note of many lines
 *    (and an iPhone SE on its side, 568x320) never puts the back button
 *    under the dock, and the button still closes the viewer;
 *  - Fiji: a passage across the antimeridian is one short line;
 *  - the Whitsundays: a planned route beside the voyage sailed (the GBR 30 m
 *    relief grid);
 *  - the Pi rule for the day it switches on (forced on in the fixture; in the
 *    app PI_TILE_PROXY_USABLE keeps it off, so today no tile goes through the
 *    Pi), and with no style at all a plain sea with the track still on it;
 *  - no WebGL (Lockdown Mode): an honest plain box, the viewer still works;
 *  - Chromium: the JS heap the map costs per open, and what closing gives back.
 */

const open = (
    page: Page,
    baseURL: string,
    screen: string,
    size: { width: number; height: number },
    network: Network = 'online',
    extra = '',
) => openFixture(page, baseURL, `/e2e/fixtures/track-map.html?screen=${screen}&fonts=wide${extra}`, size, network);

const spot = (page: Page, name: string) => page.evaluate((n) => window.__logMapFixture.spots[n], name);
const probeSpot = async (page: Page, name: string) => {
    const [lon, lat] = await spot(page, name);
    return probe(page, lon, lat);
};
const at = (page: Page, lon: number, lat: number) =>
    page.evaluate(([x, y]) => window.__logMapFixture.at(x, y), [lon, lat] as const);

/** The Solent's 22-28 kt stretch: strong, '#f97316'. */
const isStrongWind = ([r, g, b]: number[]) => r > 200 && g > 70 && g < 160 && b < 90;
/** Fiji's 15-20 kt: moderate '#84cc16' or fresh '#eab308'. */
const isModerateOrFresh = ([r, g, b]: number[]) => g > 150 && b < 90 && r > 100;
const isStartGreen = ([r, g, b]: number[]) => g > 170 && r < 140 && b > 100 && b < 210;
const isEndRed = ([r, g, b]: number[]) => r > 190 && g < 120 && b < 120;

/** Every control the viewer floats over its map, by name. */
function controls(page: Page): Record<string, Locator> {
    const dialog = page.getByRole('dialog', { name: 'Voyage track viewer' });
    return {
        back: dialog.getByRole('button', { name: 'Close track map viewer' }),
        title: dialog.getByRole('heading', { name: 'Voyage Track' }),
        colours: dialog.getByRole('group', { name: 'Track colour mode' }),
        windKey: dialog.getByText('Forecast wind (kt)').locator('..'),
        legend: dialog.getByLabel('Track legend'),
        speed: dialog.getByText('Speed', { exact: true }).locator('../..'),
        scrubber: dialog.getByRole('slider', { name: 'Track playback position' }).locator('..'),
        hud: dialog.getByRole('button', { name: 'Hide voyage details' }).locator('../../..'),
        credits: dialog.locator('.mapboxgl-ctrl-attrib-button'),
        logo: dialog.locator('.mapboxgl-ctrl-logo'),
    };
}

/** Nothing lies on anything; everything on the screen; the credits and buttons hit-testable. */
async function apart(page: Page, size: { width: number; height: number }, named: Record<string, Locator>) {
    const rects = await boxes(page, named);
    for (const [a, ra] of Object.entries(rects))
        for (const [b, rb] of Object.entries(rects))
            if (a < b) expect(overlaps(ra, rb), `${a} lies on ${b}`).toBe(false);
    for (const [name, rect] of Object.entries(rects)) {
        expect(rect.x, `${name} off the left`).toBeGreaterThanOrEqual(-0.5);
        expect(rect.y, `${name} off the top`).toBeGreaterThanOrEqual(-0.5);
        expect(rect.x + rect.width, `${name} off the right`).toBeLessThanOrEqual(size.width + 0.5);
        expect(rect.y + rect.height, `${name} off the bottom`).toBeLessThanOrEqual(size.height + 0.5);
    }
    return rects;
}

/** Every CSS animation done (the banner slides in) and two frames drawn since, so boxes are where they stay. */
async function layoutSettled(page: Page) {
    await page.evaluate(async () => {
        await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
}

/** Drag the map by (dx, dy) px from `from`, with the mouse. */
async function dragMap(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) await page.mouse.move(from.x + (dx * step) / 8, from.y + (dy * step) / 8);
    await page.mouse.up();
}

async function scrubTo(page: Page, index: number) {
    await page.getByRole('slider', { name: 'Track playback position' }).evaluate((input: HTMLInputElement, i) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(i));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, index);
}

for (const size of SIZES) {
    test(`the Solent on Relief + Sat, every control clear, ${size.width}x${size.height}, wide fonts`, async ({
        page,
        baseURL,
        browserName,
    }, info) => {
        const { errors, seen } = await open(page, baseURL!, 'solent', size);
        await expectWideFaceDrawn(page.getByRole('button', { name: 'Wind', exact: true }));
        await settled(page, 'relief-sat');
        expect(await layerMismatches(page), 'layers not as seaBaseLayers(reliefSat)').toEqual([]);
        await expect(page.locator('canvas.mapboxgl-canvas'), 'one WebGL map').toHaveCount(1);

        // Relief at sea, imagery on land, the track in its wind colours, both ends.
        const sea = (await probeSpot(page, 'sea'))!;
        expect(isRelief(sea), `relief at sea: ${sea}`).toBe(true);
        let land: number[] | null = null;
        for (const [lon, lat] of [
            [-1.35, 50.815],
            [-1.25, 50.84],
            [-1.4, 50.69],
            [-1.2, 50.65],
        ]) {
            land = await probe(page, lon, lat);
            if (land) break;
        }
        expect(land, 'a land point in view').not.toBeNull();
        expect(isImagery(land!), `imagery on land: ${land}`).toBe(true);
        const track = (await probeSpot(page, 'track'))!;
        expect(isStrongWind(track), `the 22-28 kt stretch in orange: ${track}`).toBe(true);
        const start = (await probeSpot(page, 'start'))!;
        expect(isStartGreen(start), `the start dot: ${start}`).toBe(true);
        const end = (await probeSpot(page, 'end'))!;
        expect(isEndRed(end), `the end dot: ${end}`).toBe(true);

        // The tiles it asked for: relief (both kinds), mapbox.satellite and the
        // seamarks, never the old satellite.
        expect(seen.all.some((u) => u.includes('/relief-global/idx/'))).toBe(true);
        expect(seen.all.some((u) => u.includes('/relief-global/dem/'))).toBe(true);
        expect(seen.all.some((u) => u.includes('/v4/mapbox.satellite/'))).toBe(true);
        expect(seen.all.some((u) => u.includes('tiles.openseamap.org/seamark/'))).toBe(true);
        expect(seen.all.filter((u) => OLD_SATELLITE.test(u))).toEqual([]);
        expect(seen.unexpected).toEqual([]);

        // Layout: the dialog covers the tab bar; nothing sideways; every
        // control whole, apart and uncovered; touch targets at least 44 px.
        expect(await noSideways(page)).toBeLessThanOrEqual(0);
        expect(await uncovered(page, page.getByTestId('app-bottom-nav')), 'the tab bar is under the viewer').toBe(
            false,
        );
        const named = controls(page);
        const rects = await apart(page, size, named);
        expect(Object.keys(rects)).toEqual(
            expect.arrayContaining(['back', 'title', 'colours', 'windKey', 'legend', 'speed', 'scrubber', 'credits']),
        );
        for (const name of ['back', 'credits', 'colours'] as const)
            expect(await uncovered(page, named[name]), `${name} covered`).toBe(true);
        for (const target of [
            named.back,
            page.getByRole('button', { name: 'Play track' }),
            page.getByRole('button', { name: 'Wind', exact: true }),
            page.getByRole('button', { name: 'Track', exact: true }),
        ]) {
            const box = (await target.boundingBox())!;
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(await uncovered(page, target)).toBe(true);
        }
        await shot(page, info, `solent-${size.width}`);

        // A tap on the track shows the conditions logged there; a second tap closes them.
        const [tlon, tlat] = await spot(page, 'track');
        const point = await at(page, tlon, tlat);
        await page.mouse.click(point.x, point.y);
        const popup = page.locator('.track-cond-popup');
        await expect(popup).toBeVisible();
        await expect(popup).toContainText(/2[2-8] kt SW/);
        await expect(popup).toContainText('kt SOG');
        await shot(page, info, `solent-conditions-${size.width}`);
        // A second tap, a moment later (two quick taps are a double-tap zoom,
        // as they were on the Leaflet map).
        await page.waitForTimeout(700);
        await page.mouse.click(point.x, point.y);
        await expect(popup).toHaveCount(0);
        await settled(page, 'relief-sat');

        // Pan and pinch, north-up, as the real map in this browser has them on.
        const gestures = await page.evaluate(() => {
            const map = window.__logMapFixture.maps.at(-1)! as unknown as {
                dragPan: { isEnabled(): boolean };
                scrollZoom: { isEnabled(): boolean };
                touchZoomRotate: { isEnabled(): boolean };
                doubleClickZoom: { isEnabled(): boolean };
                getBearing(): number;
                getMaxPitch(): number;
            };
            return {
                dragPan: map.dragPan.isEnabled(),
                scrollZoom: map.scrollZoom.isEnabled(),
                touchZoom: map.touchZoomRotate.isEnabled(),
                doubleTapZoom: map.doubleClickZoom.isEnabled(),
                northUp: map.getBearing() === 0 && map.getMaxPitch() === 0,
            };
        });
        expect(gestures).toEqual({
            dragPan: true,
            scrollZoom: true,
            touchZoom: true,
            doubleTapZoom: true,
            northUp: true,
        });
        // A drag pans the map (and opens nothing). With the mouse, so Chromium
        // only: Playwright's WebKit can make no touch events, and its iPhone
        // emulation drops mouse drags after a tap (seen in 4 runs out of 6).
        if (browserName === 'chromium') {
            const before = await page.evaluate(() => window.__logMapFixture.maps.at(-1)!.getCenter());
            const area = (await page.locator('.track-map-gl').boundingBox())!;
            await dragMap(page, { x: area.x + area.width / 2, y: area.y + area.height * 0.4 }, -96, 48);
            const after = await page.evaluate(() => window.__logMapFixture.maps.at(-1)!.getCenter());
            expect(after.lng - before.lng, 'dragged left, the map moves east').toBeGreaterThan(0);
            await expect(popup).toHaveCount(0);
        }

        // The credits: a compact ⓘ that opens to every licence line, readable whole.
        const mapBox = (await page.locator('.track-map-gl').boundingBox())! as Rect;
        await named.credits.click();
        await expect(named.credits).toHaveAttribute('aria-expanded', 'true');
        await creditsReadable(page, page.locator('.track-map-gl .mapboxgl-ctrl-bottom-right'), mapBox);
        const text = await page.locator('.track-map-gl .mapboxgl-ctrl-attrib-inner').innerText();
        for (const credit of ['Mapbox', 'Maxar', 'GEBCO', 'Geoscience Australia', 'Not for navigation', 'OpenSeaMap'])
            expect(text, credit).toContain(credit);
        await expect(popup, 'the credits tap opened no conditions').toHaveCount(0);
        await shot(page, info, `solent-credits-${size.width}`);
        await named.credits.click();

        // Closing removes the map.
        await named.back.click();
        await expect(page.getByRole('dialog', { name: 'Voyage track viewer' })).toHaveCount(0);
        await expect(page.locator('canvas.mapboxgl-canvas')).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test(`playback: the boat where the scrubber puts her, the HUD clear, ${size.width}x${size.height}`, async ({
        page,
        baseURL,
    }, info) => {
        const { errors } = await open(page, baseURL!, 'solent', size);
        await settled(page, 'relief-sat');
        await page.getByRole('button', { name: 'Play track' }).click();
        await expect(page.getByRole('button', { name: 'Hide voyage details' })).toBeVisible();
        await page.getByRole('button', { name: 'Pause playback' }).click();
        const index = await page.evaluate(() => window.__logMapFixture.boatIndex);
        await scrubTo(page, index);
        await settled(page, 'relief-sat');
        await layoutSettled(page);
        const boat = await page.evaluate(() => window.__logMapFixture.boat);
        const pixel = (await probe(page, boat[0], boat[1]))!;
        expect(isBoat(pixel), `the playback boat in cyan: ${pixel}`).toBe(true);
        const named = controls(page);
        const rects = await apart(page, size, named);
        expect(Object.keys(rects)).toEqual(expect.arrayContaining(['back', 'hud', 'legend', 'scrubber', 'credits']));
        await shot(page, info, `playback-${size.width}`);

        // The waypoint banner ("Lunch stop") under the HUD, clear of the controls too.
        await scrubTo(page, 11);
        await expect(page.getByText('Lunch stop')).toBeVisible();
        await layoutSettled(page);
        const banner = page.getByRole('button', { name: 'Dismiss active waypoint' }).locator('../..');
        await apart(page, size, { ...controls(page), banner });
        await shot(page, info, `playback-waypoint-${size.width}`);
        expect(errors).toEqual([]);
    });

    test(`Fiji: a passage across the antimeridian is one short line, ${size.width}x${size.height}`, async ({
        page,
        baseURL,
    }, info) => {
        const { errors } = await open(page, baseURL!, 'fiji', size);
        await settled(page, 'relief-sat');
        expect(await layerMismatches(page)).toEqual([]);
        const view = await page.evaluate(() => {
            const map = window.__logMapFixture.maps.at(-1)!;
            const b = map.getBounds();
            return { zoom: map.getZoom(), west: b.getWest(), east: b.getEast() };
        });
        expect(view.east - view.west, `the view spans ${view.west}..${view.east}`).toBeLessThan(4);
        expect(view.zoom).toBeGreaterThan(6);
        const crossing = (await probeSpot(page, 'crossing'))!;
        expect(crossing, 'the crossing is in view').not.toBeNull();
        expect(isModerateOrFresh(crossing), `the line across 180°: ${crossing}`).toBe(true);
        expect(isRelief((await probeSpot(page, 'sea'))!)).toBe(true);
        await apart(page, size, controls(page));
        await shot(page, info, `fiji-${size.width}`);
        expect(errors).toEqual([]);
    });

    test(`the Whitsundays: a planned route beside the voyage sailed (GBR 30 m), ${size.width}x${size.height}`, async ({
        page,
        baseURL,
    }, info) => {
        const { errors, seen } = await open(page, baseURL!, 'whitsundays', size);
        await settled(page, 'relief-sat');
        expect(await layerMismatches(page)).toEqual([]);
        expect(isRelief((await probeSpot(page, 'sea'))!)).toBe(true);
        expect(
            seen.all.some((u) => u.includes('/relief-au/idx/')),
            'the GBR 30 m grid is asked for here',
        ).toBe(true);
        expect(seen.all.filter((u) => OLD_SATELLITE.test(u))).toEqual([]);
        const plan = (await probeSpot(page, 'plan'))!;
        expect(isRouteViolet(plan), `the planned route's violet core: ${plan}`).toBe(true);
        await apart(page, size, controls(page));
        await shot(page, info, `whitsundays-${size.width}`);
        expect(errors).toEqual([]);
    });
}

/** An iPhone SE on its side (the viewer never locks orientation): the dock takes half the height. */
const LANDSCAPE_SE = { width: 568, height: 320 };

for (const size of [...SIZES, LANDSCAPE_SE]) {
    test(`playback: a waypoint note of many lines never puts the back button under the dock, ${size.width}x${size.height}`, async ({
        page,
        baseURL,
    }, info) => {
        const { errors } = await open(page, baseURL!, 'solent', size, 'online', '&note=long');
        await settled(page, 'relief-sat');
        await page.getByRole('button', { name: 'Play track' }).click();
        await page.getByRole('button', { name: 'Pause playback' }).click();
        await scrubTo(page, 11);
        const banner = page.getByRole('button', { name: 'Dismiss active waypoint' }).locator('../..');
        const longNote = banner.getByText(/^Anchored off Newtown for lunch\. The tide/);
        await expect(longNote).toBeVisible();
        await layoutSettled(page);
        const { back, speed, scrubber, legend } = controls(page);
        const rects = await apart(page, size, { back, speed, scrubber, legend });
        expect(Object.keys(rects)).toEqual(expect.arrayContaining(['back', 'speed', 'scrubber']));
        const dockTop = Math.min(rects.speed.y, rects.scrubber.y);
        expect(rects.back.y + rects.back.height, 'the back button clear above the dock').toBeLessThanOrEqual(
            dockTop - 4,
        );
        // On top of anything it meets (the HUD or the banner), so a tap reaches it.
        expect(await uncovered(page, back), 'back button hit-testable').toBe(true);
        if (size.height > size.width) {
            // Upright, three lines of note at most keep the banner clear of the dock.
            const shown = (await banner.boundingBox())!;
            expect(shown.y + shown.height, 'the banner clear above the dock').toBeLessThanOrEqual(dockTop);
        }
        await shot(page, info, `playback-longnote-${size.width}x${size.height}`);
        // An iPhone has no Escape key: the button itself closes the viewer.
        await expect(longNote).toBeVisible();
        await back.click();
        await expect(page.getByRole('dialog', { name: 'Voyage track viewer' })).toHaveCount(0);
        expect(errors).toEqual([]);
    });
}

test('Pi rule, forced on as PI_TILE_PROXY_USABLE will one day be: relief and seamarks via the Pi, none direct', async ({
    page,
    baseURL,
}, info) => {
    const { errors, seen } = await open(page, baseURL!, 'solent', { width: 390, height: 844 }, 'pi');
    await settled(page, 'relief-sat');
    expect(seen.viaPi.some((u) => u.includes('tiles.thalassatiles.com/v1/relief-global/idx/'))).toBe(true);
    expect(seen.viaPi.some((u) => u.includes('tiles.openseamap.org/seamark/'))).toBe(true);
    // Mapbox's own imagery never goes through the Pi (useMapInit's rule).
    expect(seen.viaPi.filter((u) => u.includes('api.mapbox.com'))).toEqual([]);
    expect(seen.direct.filter((u) => /thalassatiles|openseamap/.test(u))).toEqual([]);
    expect(isRelief((await probeSpot(page, 'sea'))!)).toBe(true);
    expect(isStrongWind((await probeSpot(page, 'track'))!)).toBe(true);
    await shot(page, info, 'offline-pi-390');
    expect(errors).toEqual([]);
});

test('no internet and no style at all: a plain sea, the track and its ends still drawn', async ({
    page,
    baseURL,
}, info) => {
    const { errors } = await open(page, baseURL!, 'solent', { width: 390, height: 844 }, 'nostyle');
    await settled(page, 'fallback');
    const track = (await probeSpot(page, 'track'))!;
    expect(isStrongWind(track), `the track on a plain sea: ${track}`).toBe(true);
    expect(isStartGreen((await probeSpot(page, 'start'))!)).toBe(true);
    await shot(page, info, 'offline-nostyle-390');
    expect(errors).toEqual([]);
});

test('no WebGL (Lockdown Mode): an honest plain box, and playback still works', async ({ page, baseURL }, info) => {
    const size = { width: 320, height: 568 };
    const { errors } = await open(page, baseURL!, 'solent', size, 'online', '&webgl=0');
    await expect(page.getByText(/can.t draw the map/i)).toBeVisible();
    await expect(page.locator('canvas.mapboxgl-canvas')).toHaveCount(0);
    await page.getByRole('button', { name: 'Play track' }).click();
    await expect(page.getByRole('button', { name: 'Hide voyage details' })).toBeVisible();
    await page.getByRole('button', { name: 'Pause playback' }).click();
    await apart(page, size, {
        ...controls(page),
        notice: page.getByRole('status').filter({ hasText: /can.t draw the map/i }),
    });
    await shot(page, info, 'no-webgl-320');
    await page.getByRole('button', { name: 'Close track map viewer' }).click();
    await expect(page.getByRole('dialog', { name: 'Voyage track viewer' })).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('Chromium: the JS heap the track map costs per open, and what closing gives back', async ({
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
    // Three opens (TRACK_MAP_HEAP_VISITS for more). The first also pays
    // Mapbox's one-time warm-up (its code compiled on first use, which Obs has
    // already paid in the app); the last is what an open costs. What a closed
    // map leaves behind must level off, never grow by a map's worth per open.
    await page.waitForTimeout(800);
    const readings: number[] = [await heap()];
    let canvas = { width: 0, height: 0 };
    const visits = Math.max(3, Number(process.env.TRACK_MAP_HEAP_VISITS) || 3);
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
        perOpenDeltaMiB: readings.slice(1).flatMap((on, i) => (i % 2 === 0 ? [mib(on - readings[i])] : [])),
        perCloseLeftMiB: readings.slice(2).flatMap((off, i) => (i % 2 === 0 ? [mib(off - readings[i])] : [])),
        firstVisitDeltaMiB: mib(firstOn - base),
        firstVisitLeftAfterRemoveMiB: mib(firstOff - base),
        lastVisitDeltaMiB: mib(lastOn - previousOff),
        lastVisitLeftAfterRemoveMiB: mib(lastOff - previousOff),
        canvas,
        canvasBackingMiB: mib(canvas.width * canvas.height * 4),
        note: 'main-thread JS heap after a forced GC; Mapbox workers and GPU textures are outside it',
    };
    info.annotations.push({ type: 'track map heap', description: JSON.stringify(report) });
    writeFileSync(info.outputPath('track-map-heap.json'), JSON.stringify(report, null, 2));
    if (SHOTS) writeFileSync(join(SHOTS, 'track-map-heap.json'), JSON.stringify(report, null, 2));
    console.info('track map heap:', JSON.stringify(report));
    expect(firstOn - base).toBeLessThan(48 * MIB);
    expect(lastOn - previousOff).toBeLessThan(24 * MIB);
    expect(lastOff - previousOff, 'a closed map leaves nothing that grows per open').toBeLessThan(1.5 * MIB);
});
