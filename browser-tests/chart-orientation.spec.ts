/**
 * The chart can turn (127-11a): everything drawn on it stays right at a fixed
 * bearing, proven in the browser before any mode turns it (127-11b).
 *
 * Shane 2026-10-10: "oh, um add in the course up and north up etc. that is
 * cool to see as well". e2e/fixtures/chart-orientation.tsx: real Mapbox
 * projection, the real MapboxVelocityOverlay on a synthetic southerly, the
 * production own-ship marker and the production AIS layers, at fictional
 * places worldwide (a Tromsø-like fjord, a Chesapeake-like bay, a beacon on
 * the antimeridian). Offline: Mapbox projects, places markers and places
 * symbols without its session; it paints only with one, so the ⊗'s pixels are
 * read only when it paints (as distress-beacon-layout.spec.ts does).
 */
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, query: Record<string, string>) {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        const local = url.protocol === 'blob:' || ['127.0.0.1', 'localhost'].includes(url.hostname);
        return local ? route.continue() : route.abort();
    });
    await page.goto(`/e2e/fixtures/chart-orientation.html?${new URLSearchParams(query)}`);
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
    return errors;
}

type Pt = { x: number; y: number };
interface WindRead {
    probes: Array<{ mapbox: Pt; css: Pt }>;
    div: { inset: string; width: string; height: string; transform: string };
    view: { width: number; height: number };
}
const windProbes = (page: Page) =>
    page.evaluate(() =>
        (window as unknown as { __orient: { windProbes: () => Promise<WindRead> } }).__orient.windProbes(),
    );

test.describe('the wind field turns with the chart', () => {
    for (const bearing of [0, 37, 90, 200]) {
        test(`at ${bearing}°, the field’s north-up Leaflet points land on the chart within 2 px`, async ({ page }) => {
            const errors = await open(page, { scene: 'wind', bearing: String(bearing) });
            const read = await windProbes(page);
            for (const { mapbox, css } of read.probes) {
                expect(Math.abs(css.x - mapbox.x), `x at ${JSON.stringify(mapbox)}`).toBeLessThan(2);
                expect(Math.abs(css.y - mapbox.y), `y at ${JSON.stringify(mapbox)}`).toBeLessThan(2);
            }
            if (bearing === 0) {
                // North up: today's div exactly.
                expect(read.div.inset).toBe('0px');
                expect(read.div.width).toBe('');
                expect(read.div.transform).not.toContain('rotate');
            } else {
                const side = Math.ceil(Math.hypot(read.view.width, read.view.height));
                expect(read.div.width).toBe(`${side}px`);
                // Mapbox keeps a bearing in (-180, 180]: 200° is -160°.
                const kept = ((bearing + 180) % 360) - 180;
                expect(read.div.transform).toContain(`rotate(${-kept}deg)`);
            }
            expect(errors).toEqual([]);
        });
    }

    test('a southerly runs up the screen north up, and down it turned to 180°', async ({ page }) => {
        // The streaks fly in Leaflet's north-up frame: north in that frame is where they go.
        for (const [bearing, upward] of [
            [0, true],
            [180, false],
        ] as const) {
            await open(page, { scene: 'wind', bearing: String(bearing), mode: 'turning' });
            const { probes } = await windProbes(page);
            // Probe 0 is the centre; probe 1 lies north (and east) of it.
            const north = probes[1].css.y - probes[0].css.y;
            expect(north < 0).toBe(upward);
        }
    });

    for (const [w, h] of [
        [390, 844],
        [820, 1180],
    ] as const) {
        test(`turned to 37° at ${w} x ${h}, then the device turned on its side: still within 2 px`, async ({
            page,
        }) => {
            const errors = await open(page, { scene: 'wind', bearing: '37', mode: 'turning' });
            await page.setViewportSize({ width: w, height: h });
            await windProbes(page);
            // Width and height swap: the square's side is the same, its centre is not.
            await page.setViewportSize({ width: h, height: w });
            const read = await windProbes(page);
            expect(read.view).toEqual({ width: h, height: w });
            for (const { mapbox, css } of read.probes) {
                expect(Math.abs(css.x - mapbox.x), `x at ${JSON.stringify(mapbox)}`).toBeLessThan(2);
                expect(Math.abs(css.y - mapbox.y), `y at ${JSON.stringify(mapbox)}`).toBeLessThan(2);
            }
            expect(errors).toEqual([]);
        });
    }

    test('a turn while open: the field follows it, still within 2 px after the settle', async ({ page }) => {
        await open(page, { scene: 'wind', bearing: '0', mode: 'turning' });
        await page.evaluate(() =>
            (window as unknown as { __orient: { turn: (b: number) => Promise<void> } }).__orient.turn(115),
        );
        const read = await windProbes(page);
        for (const { mapbox, css } of read.probes) {
            expect(Math.abs(css.x - mapbox.x)).toBeLessThan(2);
            expect(Math.abs(css.y - mapbox.y)).toBeLessThan(2);
        }
    });
});

interface BoatRead {
    fix: Pt;
    badge: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    chip: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    text: string;
    hullDeg: number;
    screenCourse: number;
    windDeg: number;
    screenWind: number;
}
const measureBoat = (page: Page) =>
    page.evaluate(() => (window as unknown as { __orient: { measureBoat: () => BoatRead } }).__orient.measureBoat());
const angleOff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

test.describe('her marker on a turned chart', () => {
    for (const bearing of [60, 180]) {
        test(`at ${bearing}°: her words upright beside her, her bow and her wind arrow true`, async ({ page }) => {
            const errors = await open(page, { scene: 'marker', bearing: String(bearing), state: 'underway' });
            const m = await measureBoat(page);
            expect(m.text).toBe('6.2 kts');
            // Upright: a level badge, beside her on the right, centred on her fix.
            expect(m.badge.width).toBeGreaterThan(m.badge.height * 2);
            expect(m.badge.left).toBeGreaterThan(m.fix.x + 10);
            expect(Math.abs(m.badge.top + m.badge.height / 2 - m.fix.y)).toBeLessThan(1);
            // Her wind chip under her, upright and centred.
            expect(m.chip.top).toBeGreaterThan(m.fix.y);
            expect(m.chip.width).toBeGreaterThan(m.chip.height);
            expect(Math.abs(m.chip.left + m.chip.width / 2 - m.fix.x)).toBeLessThan(1);
            // The hull points where her course runs on this screen; the wind arrow where her wind goes.
            expect(angleOff(m.hullDeg, m.screenCourse)).toBeLessThan(1);
            expect(angleOff(m.hullDeg, 135 - bearing)).toBeLessThan(0.5);
            expect(angleOff(m.windDeg, m.screenWind)).toBeLessThan(1);
            expect(errors).toEqual([]);
        });
    }

    test('a turn after she is drawn: her bow follows the chart, her words do not move', async ({ page }) => {
        await open(page, { scene: 'marker', bearing: '0', state: 'underway' });
        const before = await measureBoat(page);
        await page.evaluate(() =>
            (window as unknown as { __orient: { turn: (b: number) => Promise<void> } }).__orient.turn(90),
        );
        const after = await measureBoat(page);
        expect(angleOff(after.hullDeg, after.screenCourse)).toBeLessThan(1);
        expect(angleOff(after.hullDeg, 45)).toBeLessThan(0.5);
        expect(after.badge.left - after.fix.x).toBeCloseTo(before.badge.left - before.fix.x, 0);
        expect(after.badge.width).toBeCloseTo(before.badge.width, 0);
    });
});

test('a distress beacon on a chart turned to 45°: on its own upright layer, still a ⊗', async ({ page }) => {
    const errors = await open(page, { scene: 'sart', bearing: '45' });
    const result = await page.evaluate(() =>
        (
            window as unknown as {
                __orient: {
                    readAis: () => Promise<{
                        boats: { mmsi: number; iconKind: string }[];
                        beacons: { mmsi: number; iconKind: string }[];
                        painted: boolean;
                        armNe: number[];
                        straightUp: number[];
                    }>;
                };
            }
        ).__orient.readAis(),
    );
    // Placed by the real engine: the beacon on the upright layer, the boat on the turning one.
    expect(result.beacons).toEqual([{ mmsi: 970_000_701, iconKind: 'sart' }]);
    expect(result.boats.map((b) => b.mmsi)).toEqual([228_000_702]);
    if (result.painted) {
        // Where the engine paints: the arms still run corner to corner on screen.
        const red = ([r, g, b, a]: number[]) => a > 200 && r > 200 && g < 90 && b < 90;
        expect(red(result.armNe), `arm ${result.armNe}`).toBe(true);
        expect(red(result.straightUp), `between the arms ${result.straightUp}`).toBe(false);
    }
    expect(errors).toEqual([]);
});
