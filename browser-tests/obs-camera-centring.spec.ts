import { expect, test, type Page } from '@playwright/test';

/**
 * Obs camera centring on the real Mapbox engine (build 124, package OC;
 * e2e/fixtures/obs-camera-centring.ts).
 *
 * Shane 2026-10-08, with screenshots: "it sometimes starts up like the 2nd
 * image [the whole east coast at z3.9] ... when i click the locate fab, it
 * goes to the first image which is not centred". Plan and Obs share one
 * map. Plan's route fit padded the camera {left 300, right 40, top 90,
 * bottom 130} to clear its route card and Mapbox GL 3 kept that padding, so
 * the locate flight after it put the fix at the padded centre, (W + 260) / 2,
 * 130 px right of the canvas centre whatever the phone, and getBounds()
 * shrank to the strip right of the card.
 *
 * Each test runs Plan's real fit, then the locate button's real path (only
 * the phone's receiver is faked, in the page), on the phone sizes in Shane's
 * screenshots (440 × 956, and 430 × 932), animated and with Reduce Motion (a
 * flight is then a jump), for his route and for a northern-hemisphere one. Without a Mapbox token the canvas is not painted,
 * so the pixel checks are skipped and the camera's own numbers stand.
 */

type Fix = { lat: number; lon: number };
type Padding = { top: number; right: number; bottom: number; left: number };
type Measure = {
    width: number;
    height: number;
    zoom: number;
    padding: Padding;
    fixPx: { x: number; y: number } | null;
    boundsPx: { west: number; east: number; north: number; south: number };
};
type Fixture = {
    ready: boolean;
    painted: boolean;
    errors: string[];
    planFit(points: Fix[]): Promise<Measure & { endsPx: Array<{ x: number }> }>;
    locate(fix: Fix): Promise<Measure & { outcome: { centred: boolean; announcement: string } | null }>;
    locateBoat(fix: Fix): Promise<Measure & { outcome: { centred: boolean; announcement: string } | null }>;
    tracerFly(fix: Fix, zoom: number): Promise<Measure>;
    leave(padding: Padding): Promise<Measure>;
    showObs(): Promise<Measure & { cleared: boolean }>;
    symmetricFit(points: Fix[]): Promise<Measure>;
    probe(x: number, y: number): number[];
};
type FixtureWindow = { __obsCamera: Fixture };

/** Plan's route card, as fitTraceBounds clears it. */
const PLAN_CARD: Padding = { top: 90, bottom: 130, left: 300, right: 40 };
const ZERO: Padding = { top: 0, right: 0, bottom: 0, left: 0 };
const FIX_RGB = [255, 0, 200];

const ROUTES = [
    {
        name: 'Newport to Airlie Beach (the screenshots)',
        // A trip leg home reversed: Newport, Moreton Bay, to Coral Sea Marina.
        points: [
            { lat: -27.205, lon: 153.095 },
            { lat: -20.266, lon: 148.718 },
        ],
        fix: { lat: -20.266, lon: 148.718 },
        // The whole-coast view in screenshot 2.
        fitZoom: [3.7, 4.1] as const,
    },
    {
        name: 'Falmouth to A Coruña',
        points: [
            { lat: 50.152, lon: -5.066 },
            { lat: 43.369, lon: -8.398 },
        ],
        fix: { lat: 43.369, lon: -8.398 },
        fitZoom: null,
    },
];
const VIEWPORTS = [
    { width: 440, height: 956 },
    { width: 430, height: 932 },
];

const call = <K extends keyof Fixture>(page: Page, name: K, ...args: unknown[]) =>
    page.evaluate(
        ([fn, rest]) =>
            (
                (window as unknown as FixtureWindow).__obsCamera[fn as keyof Fixture] as unknown as (
                    ...a: unknown[]
                ) => unknown
            )(...(rest as unknown[])),
        [name, args] as const,
    ) as Promise<Awaited<ReturnType<Extract<Fixture[K], (...a: never[]) => unknown>>>>;

/** Requests that left the machine. The fixture makes none of its own; Mapbox's own (its token, its telemetry) are allowed. */
let offsite: string[] = [];
test.beforeEach(() => {
    offsite = [];
});
test.afterEach(() => {
    expect(offsite.filter((url) => !new URL(url).hostname.endsWith('mapbox.com'))).toEqual([]);
});

async function open(page: Page, motion: 'reduce' | 'no-preference', size = VIEWPORTS[0]) {
    // Watched, not intercepted: an intercepting route stops WebKit loading
    // Mapbox's blob: worker ("Web Inspector blocked blob:… from loading"), and
    // then the map never finishes loading its style.
    page.on('request', (request) => {
        const { protocol, hostname } = new URL(request.url());
        if (protocol !== 'blob:' && protocol !== 'data:' && hostname !== '127.0.0.1') offsite.push(request.url());
    });
    await page.setViewportSize(size);
    await page.emulateMedia({ reducedMotion: motion });
    await page.goto('/e2e/fixtures/obs-camera-centring.html');
    await page.waitForFunction(() => (window as unknown as Partial<FixtureWindow>).__obsCamera?.ready === true, null, {
        timeout: 30_000,
    });
    return page.evaluate(() => (window as unknown as FixtureWindow).__obsCamera.painted);
}

/** The fix on the canvas centre, within 2 px, and getBounds() the whole canvas, within 1 px (soft: every number reports). */
function expectCentredOnWholeCanvas(m: Measure, label: string) {
    expect.soft(m.zoom, `${label}: zoom`).toBeCloseTo(14, 5);
    expect.soft(m.padding, `${label}: no padding left on the map`).toEqual(ZERO);
    expect
        .soft(Math.abs(m.fixPx!.x - m.width / 2), `${label}: fix x ${m.fixPx!.x} vs centre ${m.width / 2}`)
        .toBeLessThanOrEqual(2);
    expect
        .soft(Math.abs(m.fixPx!.y - m.height / 2), `${label}: fix y ${m.fixPx!.y} vs centre ${m.height / 2}`)
        .toBeLessThanOrEqual(2);
    expect.soft(Math.abs(m.boundsPx.west), `${label}: bounds west`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(m.boundsPx.east - m.width), `${label}: bounds east`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(m.boundsPx.north), `${label}: bounds north`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(m.boundsPx.south - m.height), `${label}: bounds south`).toBeLessThanOrEqual(1);
}

async function expectDrawnAtCentre(page: Page, painted: boolean, m: Measure, label: string) {
    test.info().annotations.push({
        type: 'pixels',
        description: painted ? 'rendered' : 'canvas not painted (no token)',
    });
    if (!painted) return;
    const centre = await call(page, 'probe', m.width / 2, m.height / 2);
    // Where the padded centre put her before build 124.
    const padded = await call(page, 'probe', m.width / 2 + 130, m.height / 2 - 20);
    expect(centre, `${label}: the fix is drawn at the canvas centre`).toEqual([...FIX_RGB, 255]);
    expect(padded.slice(0, 3), `${label}: and not at the padded centre`).not.toEqual(FIX_RGB);
}

for (const size of VIEWPORTS) {
    for (const route of ROUTES) {
        for (const motion of ['no-preference', 'reduce'] as const) {
            test(`${route.name}, ${size.width} × ${size.height}, motion ${motion}: after Plan's route fit, Locate centres the fix on the whole canvas`, async ({
                page,
            }) => {
                const painted = await open(page, motion, size);

                // Plan's route fit: still clear of its card, and nothing left behind.
                const fit = await call(page, 'planFit', route.points);
                test.info().annotations.push({ type: 'fit', description: JSON.stringify(fit) });
                for (const end of fit.endsPx) {
                    expect(end.x, 'route end clear of the card').toBeGreaterThanOrEqual(PLAN_CARD.left - 1);
                    expect(end.x, 'route end clear of the right edge').toBeLessThanOrEqual(
                        size.width - PLAN_CARD.right + 1,
                    );
                }
                if (route.fitZoom) {
                    expect(fit.zoom).toBeGreaterThanOrEqual(route.fitZoom[0]);
                    expect(fit.zoom).toBeLessThanOrEqual(route.fitZoom[1]);
                }
                expect.soft(fit.padding, "Plan's fit leaves no padding on the shared map").toEqual(ZERO);

                // Obs: the locate button.
                const located = await call(page, 'locate', route.fix);
                test.info().annotations.push({ type: 'locate', description: JSON.stringify(located) });
                expect(located.outcome).toEqual({ centred: true, announcement: 'Chart centred on your position.' });
                expectCentredOnWholeCanvas(located, 'locate after the fit');
                await expectDrawnAtCentre(page, painted, located, 'locate after the fit');
                expect(await page.evaluate(() => (window as unknown as FixtureWindow).__obsCamera.errors)).toEqual([]);
            });
        }
    }
}

for (const size of VIEWPORTS) {
    test(`${size.width} × ${size.height}: a padding any surface leaves goes when Obs shows, and Locate still centres`, async ({
        page,
    }) => {
        const route = ROUTES[0];
        const painted = await open(page, 'no-preference', size);
        await call(page, 'planFit', route.points);
        // Something leaves Plan's card padding on the map (the guard's case).
        const left = await call(page, 'leave', PLAN_CARD);
        expect(left.padding).toEqual(PLAN_CARD);
        expect(left.boundsPx.west, 'a left padding shrinks getBounds()').toBeGreaterThan(PLAN_CARD.left - 1);
        // Obs shows: the whole canvas is the chart's again.
        const shown = await call(page, 'showObs');
        expect(shown.cleared).toBe(true);
        expect(shown.padding).toEqual(ZERO);
        expect(Math.abs(shown.boundsPx.west)).toBeLessThanOrEqual(1);
        expect(Math.abs(shown.boundsPx.east - size.width)).toBeLessThanOrEqual(1);
        // A padding left during Obs itself: the flight clears it first.
        await call(page, 'leave', PLAN_CARD);
        const located = await call(page, 'locate', route.fix);
        expectCentredOnWholeCanvas(located, 'locate with a padding left on the map');
        await expectDrawnAtCentre(page, painted, located, 'locate with a padding left on the map');
    });

    test(`${size.width} × ${size.height}: control, a fit padded the same on every side was always centred`, async ({
        page,
    }) => {
        const route = ROUTES[1];
        await open(page, 'no-preference', size);
        const fit = await call(page, 'symmetricFit', route.points);
        expect(fit.padding).toEqual({ top: 60, right: 60, bottom: 60, left: 60 });
        const located = await call(page, 'locate', route.fix);
        expect(Math.abs(located.fixPx!.x - size.width / 2)).toBeLessThanOrEqual(2);
        expect(Math.abs(located.fixPx!.y - size.height / 2)).toBeLessThanOrEqual(2);
    });
}

// Review 2026-10-08: Shane's screenshot came from find-boat, which reads the
// boat's own position chain (locateVessel), not the phone. And with the fit's
// padding no longer left behind, a tracer flight must still land clear of
// the open route card (tracerFlyTo).
for (const size of VIEWPORTS) {
    test(`${size.width} × ${size.height}: after Plan's route fit, find-boat (her own chain) centres her on the whole canvas`, async ({
        page,
    }) => {
        const route = ROUTES[1]; // a boat in Galicia
        const painted = await open(page, 'no-preference', size);
        await call(page, 'planFit', route.points);
        const found = await call(page, 'locateBoat', route.fix);
        test.info().annotations.push({ type: 'find-boat', description: JSON.stringify(found) });
        expect(found.outcome).toEqual({ centred: true, announcement: 'Chart centred on Sea Wren.' });
        expectCentredOnWholeCanvas(found, 'find-boat after the fit');
        await expectDrawnAtCentre(page, painted, found, 'find-boat after the fit');
    });

    test(`${size.width} × ${size.height}: a tracer flight after the fit lands beside the route card and leaves the canvas whole`, async ({
        page,
    }) => {
        const route = ROUTES[0];
        const painted = await open(page, 'no-preference', size);
        await call(page, 'planFit', route.points);
        const flown = await call(page, 'tracerFly', route.fix, 15);
        test.info().annotations.push({ type: 'tracer', description: JSON.stringify(flown) });
        // The centre of the water clear of the card, as the route fit frames it.
        const beside = {
            x: (PLAN_CARD.left + size.width - PLAN_CARD.right) / 2,
            y: (PLAN_CARD.top + size.height - PLAN_CARD.bottom) / 2,
        };
        expect.soft(flown.zoom).toBeCloseTo(15, 5);
        expect.soft(flown.padding, 'nothing left on the map').toEqual(ZERO);
        expect.soft(Math.abs(flown.fixPx!.x - beside.x), `x ${flown.fixPx!.x} vs ${beside.x}`).toBeLessThanOrEqual(2);
        expect.soft(Math.abs(flown.fixPx!.y - beside.y), `y ${flown.fixPx!.y} vs ${beside.y}`).toBeLessThanOrEqual(2);
        expect(flown.fixPx!.x, 'clear of the open route card (x 12 to 300)').toBeGreaterThan(PLAN_CARD.left);
        expect.soft(Math.abs(flown.boundsPx.west), 'bounds west').toBeLessThanOrEqual(1);
        expect.soft(Math.abs(flown.boundsPx.east - size.width), 'bounds east').toBeLessThanOrEqual(1);
        if (painted) {
            expect(await call(page, 'probe', beside.x, beside.y), 'drawn beside the card').toEqual([...FIX_RGB, 255]);
        }
        // And Obs's locate after it is still dead centre.
        const located = await call(page, 'locate', route.fix);
        expectCentredOnWholeCanvas(located, 'locate after a tracer flight');
        await expectDrawnAtCentre(page, painted, located, 'locate after a tracer flight');
    });
}
