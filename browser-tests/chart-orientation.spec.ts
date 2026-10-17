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
import { openOrientation as open, windProbes, type Pt } from './helpers/chartOrientationPage';

test.describe('the wind field turns with the chart', () => {
    for (const bearing of [0, 37, 90, 200]) {
        test(`at ${bearing}°, the field's canvas points land on the chart within 2 px`, async ({ page }) => {
            const errors = await open(page, { scene: 'wind', bearing: String(bearing) });
            const read = await windProbes(page);
            for (const { mapbox, css } of read.probes) {
                expect(Math.abs(css.x - mapbox.x), `x at ${JSON.stringify(mapbox)}`).toBeLessThan(2);
                expect(Math.abs(css.y - mapbox.y), `y at ${JSON.stringify(mapbox)}`).toBeLessThan(2);
            }
            if (bearing === 0) {
                // North up: today's div exactly.
                expect(read.div.inset).toBe('0px');
                expect(read.div.width).toBe(`${read.view.width}px`);
                expect(read.div.transform).not.toContain('rotate');
            } else {
                const side = Math.ceil(Math.hypot(read.view.width, read.view.height));
                expect(read.div.width).toBe(`${side}px`);
                // The field is projected by the actual Mapbox camera at each settle;
                // CSS carries only the delta during a moving camera.
                expect(read.div.transform).toBe('');
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

    // 820 x 1180 has a file and a browser of its own (chart-orientation-sideways.spec.ts):
    // in CI's software GL the next test in its browser could not get a context in 30 s.
    for (const [w, h] of [[390, 844]] as const) {
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

// ── 127-11b: the modes ──────────────────────────────────────────────────
type Orient = {
    bearing: () => number;
    needle: () => number;
    run: () => Promise<{ eases: number; upright: boolean; worstProbe: number; bearing: number }>;
};
const orient = (page: Page) => page.evaluate(() => (window as unknown as { __orient: Orient }).__orient.bearing());
const kept = (deg: number) => ((deg % 360) + 360) % 360;

test.describe('the north arrow (Heading up from her compass)', () => {
    for (const heading of [0, 37, 90, 200]) {
        test(`her compass on ${heading}°: the chart turns to it and the needle points at north on screen within 1°`, async ({
            page,
        }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            const errors = await open(page, { scene: 'arrow', heading: String(heading) });
            await expect
                .poll(async () => angleOff(kept(await orient(page)), heading), { timeout: 10_000 })
                .toBeLessThan(0.5);
            // Polled: the needle repaints on the frame after the bearing settles.
            await expect
                .poll(async () => {
                    const needle = await page.evaluate(() =>
                        (window as unknown as { __orient: Orient }).__orient.needle(),
                    );
                    return angleOff(needle, kept(-(await orient(page))));
                })
                .toBeLessThan(1);
            expect(errors).toEqual([]);
        });
    }

    test('one tap at 90° puts the chart North up, at once, with no menu', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await open(page, { scene: 'arrow', heading: '90' });
        await expect.poll(async () => angleOff(kept(await orient(page)), 90), { timeout: 10_000 }).toBeLessThan(0.5);
        const arrow = page.getByRole('button', { name: /^Chart orientation:/ });
        await expect(arrow).toHaveAccessibleName(
            'Chart orientation: Heading up, turned to 090 degrees. Tap for North up',
        );
        await arrow.click();
        await expect.poll(async () => angleOff(kept(await orient(page)), 0)).toBeLessThan(0.5);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(arrow).toHaveAccessibleName('Chart orientation: North up. Tap to choose');
        // The needle repaints on the next animation frame; Linux WebKit in CI can
        // be a few frames behind the bearing (release run 38366466523, both attempts).
        await expect
            .poll(async () =>
                angleOff(await page.evaluate(() => (window as unknown as { __orient: Orient }).__orient.needle()), 0),
            )
            .toBeLessThan(1);
    });
});

test('a simulated Track-up run: three turns, her words upright, the wind field true after each settle', async ({
    page,
}) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = await open(page, { scene: 'run' });
    const result = await page.evaluate(() => (window as unknown as { __orient: Orient }).__orient.run());
    expect(result.upright, 'her badge stays level, beside her').toBe(true);
    expect(result.eases, 'at most 12 eases for three turns').toBeLessThanOrEqual(12);
    expect(result.eases).toBeGreaterThanOrEqual(4);
    expect(result.worstProbe, 'the wind field lands within 2 px after every settle').toBeLessThan(2);
    // She ends on her last leg, 290°, within the deadband.
    expect(angleOff(kept(result.bearing), 290)).toBeLessThanOrEqual(6);
    expect(errors).toEqual([]);
});

// ── 127-11b review: a camera move while a turn is still easing (real motion) ──
type Read = { centre: [number, number]; zoom: number; her: Pt; bearing: number };
const interrupted = (page: Page) =>
    page.evaluate(() =>
        (
            window as unknown as {
                __orient: { interrupted: () => Promise<{ midTurn: number; after: Read; later: Read }> };
            }
        ).__orient.interrupted(),
    );

test.describe('a camera move that lands mid-turn sticks', () => {
    test('the startup camera’s jump to her (a Brittany-like headland) 10° into a turn to 120°', async ({ page }) => {
        const errors = await open(page, { scene: 'interrupt', kind: 'jump' });
        const { midTurn, after, later } = await interrupted(page);
        // It really was mid-turn.
        expect(kept(midTurn)).toBeGreaterThanOrEqual(10);
        expect(kept(midTurn)).toBeLessThan(110);
        // Right after the jump she is in the middle, at zoom 14; 2 s later she still is.
        expect(Math.abs(after.her.x - 195) + Math.abs(after.her.y - 422)).toBeLessThan(2);
        expect(Math.abs(later.her.x - 195), `she stays where the jump put her: ${JSON.stringify(later)}`).toBeLessThan(
            2,
        );
        expect(Math.abs(later.her.y - 422)).toBeLessThan(2);
        expect(later.zoom).toBeCloseTo(14, 3);
        // And the turn went on from there.
        expect(angleOff(kept(later.bearing), 120)).toBeLessThan(0.5);
        expect(errors).toEqual([]);
    });

    test('a duration-0 whole-route fit (a Tromsø-like fjord) 10° into a turn to 120°', async ({ page }) => {
        const errors = await open(page, { scene: 'interrupt', kind: 'fit' });
        const { after, later } = await interrupted(page);
        expect(angleOff(kept(after.bearing), 120)).toBeLessThan(0.5);
        expect(Math.abs(later.centre[0] - after.centre[0]), `the fit stays: ${JSON.stringify(later)}`).toBeLessThan(
            1e-4,
        );
        expect(Math.abs(later.centre[1] - after.centre[1])).toBeLessThan(1e-4);
        expect(later.zoom).toBeCloseTo(after.zoom, 3);
        expect(errors).toEqual([]);
    });
});

// Mapbox snaps a chart within bearingSnap (7° by default) of north to north at the end
// of a pan. The chart's map is built with bearingSnap 0 (tests/chartTurnsMapInit.test.tsx);
// here, real Mapbox shows what each value does to a chart turned to 5°.
for (const [snap, stays] of [
    ['7', false],
    ['0', true],
] as const) {
    test(`a pan on a chart turned to 5°, bearingSnap ${snap}: ${stays ? 'it stays at 5°' : 'Mapbox snaps it north'}`, async ({
        page,
        browserName,
    }) => {
        // A mouse pan: the desk chart's. Mobile WebKit pans by touch, which Playwright cannot drag.
        test.skip(browserName === 'webkit', 'a mouse pan is the desk chart’s');
        await open(page, { scene: 'snap', snap });
        expect(angleOff(kept(await orient(page)), 5)).toBeLessThan(0.1);
        const centre = () =>
            page.evaluate(() => (window as unknown as { __orient: { centre: () => number[] } }).__orient.centre());
        const before = await centre();
        await page.mouse.move(195, 422);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) await page.mouse.move(195 + 6 * i, 422 - 12 * i);
        await page.mouse.up();
        await page.waitForTimeout(1500);
        // It really panned.
        expect(Math.abs((await centre())[1] - before[1])).toBeGreaterThan(1e-4);
        expect(angleOff(kept(await orient(page)), stays ? 5 : 0)).toBeLessThan(0.1);
    });
}
