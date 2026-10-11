/**
 * The phone keeps working while it routes (127-ROUTE-W2): the long-task spec.
 *
 * Shane, 2026-10-10: "yes for a short while it looked as though the app had
 * frozen". Since 127-ROUTE-W the router runs in a worker. This drives Auto on
 * the dev fixture with Thalassa's real router over the synthetic archipelago
 * (invented, 161.0E 20.3S; e2e/fixtures/autorouting-trial.tsx
 * `engine=real&scene=archipelago`), the 20 NM route, and measures the page's
 * main thread while the status reads "Routing round the land":
 *   - a 4 ms heartbeat's longest gap stays under 150 ms, requestAnimationFrame
 *     keeps firing, and in Chromium no long task of 150 ms or more starts;
 *   - a click on the fixture's probe button waits under 150 ms;
 *   (on CI, 250 ms: see PAUSE_MS)
 *   - the seconds counter ticks.
 * The negative control (`worker=off`: the route worker cannot start, as on an
 * old webview) sees the freeze, one gap of a second or more, so the harness
 * can see one; and the
 * route it draws is bit-identical to the worker's in the same browser (never
 * WebKit against V8: they differ in the last bits of a few lengths).
 * Stop ends a route at once and keeps the pins; the next route comes from a
 * fresh worker and is the same line. The tracer's grids (Auto's chart
 * checks) run in their own instance of the same worker script.
 *
 * The scene's own OSM water is served as the boat Pi's overlay (its marina
 * and harbour water, as in the route job's parity tests). Every outside
 * request is aborted, so tides, notices, satellite water and the land check
 * fail fast, as on the real-engine tests in autorouting-trial.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import type mapboxgl from 'mapbox-gl';
import { syntheticArchipelago } from '../tests/fixtures/syntheticArchipelago';

const ROUTE = syntheticArchipelago().routes['20nm'];
const LIVE_LINE = 'The chart stays live while it works. Stop ends it.';
const STOPPED = 'Stopped. Nothing changed.';
/**
 * The pause limits. On the M1 (Chromium and WebKit) the longest pause while it
 * routes was 16-18 ms and the probe waited 3-9 ms. CI's runners (4 vCPUs, a
 * second Playwright worker beside this one, software WebGL) have not been
 * measured, so they get more room; the no-Worker control's freeze (one pause of
 * 1,000 ms or more) stays well clear of either limit.
 */
const PAUSE_MS = process.env.CI ? 250 : 150;
const STOP_MS = process.env.CI ? 500 : 300;
/** The chart is settled after a full second with no pause over this. */
const SETTLE_GAP_MS = process.env.CI ? 100 : 50;

interface Beat {
    /** [time, the status read "Routing round the land"] every 4 ms. */
    ticks: [number, boolean][];
    /** [time, status text] whenever it changed. */
    texts: [number, string][];
    frames: number[];
    longTasks: [number, number][];
    clicks: [number, string][];
}
type FixtureWindow = Window & {
    __beat: Beat;
    __trialFixture: {
        map: mapboxgl.Map;
        lastRoute: { coordinates: [number, number][]; engine?: Record<string, unknown> } | null;
        workers: { url: string; sent: string[] }[];
        probeClicks: number[];
    };
};

async function openFixture(page: Page, query = '') {
    const ORIGIN = new URL(test.info().project.use.baseURL!).origin;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => sessionStorage.setItem('lazyRetry_lastReloadAt', String(Date.now())));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        // The OSM water the boat Pi would hand back for the scene (its harbour
        // and marina water), as the route job's parity tests serve it.
        if (url.pathname === '/services/OsmRouteOverlayService.ts' && !url.searchParams.has('fixtureOriginal'))
            return route.fulfill({
                contentType: 'application/javascript',
                body: `export * from '/services/OsmRouteOverlayService.ts?fixtureOriginal=1';
                    export async function getOsmRouteOverlay() { return structuredClone(window.__trialFixture.osm); }`,
            });
        if (url.origin === ORIGIN && url.pathname.endsWith('.pbf'))
            return route.fulfill({ contentType: 'application/x-protobuf', body: Buffer.alloc(0) });
        if (url.pathname === '/services/enc/autoSyncFromPi.ts')
            return route.fulfill({
                contentType: 'application/javascript',
                body: 'export const startAutoSyncPolling = () => {};',
            });
        if (url.pathname === '/services/supabase.ts')
            return route.fulfill({
                contentType: 'application/javascript',
                body: 'export const supabase = {auth:{onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},functions:{}}; export const getCurrentUserId = async () => "trial-layout-fixture"; export const isSupabaseConfigured = () => false; export const supabaseAnonKey = "fixture-only"; export const supabaseUrl = "https://fixture.invalid";',
            });
        if (url.hostname === 'api.mapbox.com' && url.pathname.startsWith('/styles/'))
            return route.fulfill({
                json: {
                    version: 8,
                    glyphs: `${ORIGIN}/e2e/fixtures/glyphs/{fontstack}/{range}.pbf`,
                    sources: {},
                    layers: [{ id: 'fixture-water', type: 'background', paint: { 'background-color': '#18354b' } }],
                },
            });
        return url.origin === ORIGIN &&
            ['GET', 'HEAD'].includes(route.request().method()) &&
            !url.pathname.startsWith('/api/')
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
        `/e2e/fixtures/autorouting-trial.html?mode=dark&pane=false&status=ready&review=native&fonts=wide&engine=real&scene=archipelago${query}`,
    );
    const slider = page.getByRole('button', { name: 'Slide to Start Plotting', exact: true });
    await expect(slider).toBeVisible();
    const box = (await slider.boundingBox())!;
    await page.mouse.move(box.x + 24, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 32, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Autorouting trial', exact: true })).toBeVisible();
    // Her pins: the archipelago's 20 NM route.
    const summary = page.getByText('Enter coordinates', { exact: true });
    await expect(async () => {
        if (!(await summary.evaluate((node) => (node.closest('details') as HTMLDetailsElement).open)))
            await summary.click({ timeout: 8_000 });
        await expect(page.getByLabel('departure latitude', { exact: true })).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    for (const [name, value] of [
        ['departure latitude', ROUTE.from[1]],
        ['departure longitude', ROUTE.from[0]],
        ['destination latitude', ROUTE.to[1]],
        ['destination longitude', ROUTE.to[0]],
    ] as const)
        await page.getByLabel(name, { exact: true }).fill(String(value));
    await page.getByLabel('destination longitude', { exact: true }).blur();
    return errors;
}

const statusLine = (page: Page) => page.locator('.trial-tracer-status');
const calculate = (page: Page) => page.getByRole('button', { name: 'Calculate trial route', exact: true });

/** The heartbeat, the frame counter, Chromium's long tasks, and every click's event time. */
async function startBeat(page: Page) {
    await page.evaluate(() => {
        const beat: Beat = { ticks: [], texts: [], frames: [], longTasks: [], clicks: [] };
        let last = '';
        setInterval(() => {
            const text = document.querySelector('.trial-tracer-status')?.textContent ?? '';
            const now = performance.now();
            beat.ticks.push([now, text.includes('Routing round the land')]);
            if (text !== last) beat.texts.push([now, (last = text)]);
        }, 4);
        const frame = (t: number) => {
            beat.frames.push(t);
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        try {
            new PerformanceObserver((list) => {
                for (const e of list.getEntries()) beat.longTasks.push([e.startTime, e.duration]);
            }).observe({ type: 'longtask' });
        } catch {
            /* WebKit has no long-task API: the heartbeat stands alone there */
        }
        document.addEventListener(
            'click',
            (e) => beat.clicks.push([e.timeStamp, (e.target as HTMLElement).textContent ?? '']),
            true,
        );
        (window as unknown as FixtureWindow).__beat = beat;
    });
}

/**
 * Let the chart settle before measuring: entering the pins moves the chart and
 * draws the archipelago's charts, which is main-thread work of its own (in
 * Chromium's software WebGL, a run of 50-95 ms tasks for a second or two).
 * Waits for a full second with no pause over 50 ms (CI: 100), then starts afresh.
 */
async function settleThenBeat(page: Page) {
    await startBeat(page);
    await page.waitForFunction(
        (gap) => {
            const ticks = (window as unknown as FixtureWindow).__beat.ticks;
            const now = performance.now();
            const recent = ticks.filter(([t]) => t >= now - 1_000);
            if (recent.length < 50 || ticks[0][0] > now - 1_000) return false;
            for (let i = 1; i < recent.length; i++) if (recent[i][0] - recent[i - 1][0] > gap) return false;
            return true;
        },
        SETTLE_GAP_MS,
        { timeout: 30_000, polling: 100 },
    );
    await page.evaluate(() => {
        const beat = (window as unknown as FixtureWindow).__beat;
        for (const list of [beat.ticks, beat.texts, beat.frames, beat.longTasks, beat.clicks]) list.length = 0;
    });
}

/** While the status read "Routing round the land": the window, its longest gap, frames and long tasks. */
async function routingWindow(page: Page) {
    return page.evaluate((limit) => {
        const beat = (window as unknown as FixtureWindow).__beat;
        let first: number | null = null;
        let last = 0;
        let maxGap = 0;
        let maxGapAt = 0;
        for (let i = 1; i < beat.ticks.length; i++) {
            const [t0, r0] = beat.ticks[i - 1];
            const [t1, r1] = beat.ticks[i];
            if (!r0 && !r1) continue;
            first ??= t0;
            last = t1;
            if (t1 - t0 > maxGap) [maxGap, maxGapAt] = [t1 - t0, t0];
        }
        const from = first ?? 0;
        return {
            ms: last - from,
            maxGap,
            /** When the longest pause began, from the start of the window (ms). */
            maxGapAt: maxGapAt - from,
            frames: beat.frames.filter((t) => t >= from && t <= last).length,
            longTasks: beat.longTasks.filter(([s, d]) => s + d >= from && s <= last && d >= limit).map(([, d]) => d),
            texts: beat.texts.map(([, text]) => text),
        };
    }, PAUSE_MS);
}

const route = (page: Page) =>
    page.evaluate(() => {
        const r = (window as unknown as FixtureWindow).__trialFixture.lastRoute;
        if (!r) return null;
        const { elapsedMs: _elapsed, ...engine } = r.engine ?? {};
        return JSON.stringify({ coordinates: r.coordinates, engine });
    });
const workers = (page: Page) =>
    page.evaluate(() => (window as unknown as FixtureWindow).__trialFixture.workers.map((w) => [...new Set(w.sent)]));
const routeLines = (page: Page) =>
    page.evaluate(() => {
        const map = (window as unknown as FixtureWindow).__trialFixture.map;
        const source = map.getStyle().sources['thalassa-route'] as mapboxgl.GeoJSONSourceSpecification | undefined;
        return ((source?.data as GeoJSON.FeatureCollection | undefined)?.features ?? []).length;
    });
/** The route arrived: the panel folds onto the chart, as Review opens. */
async function routed(page: Page) {
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toHaveAttribute(
        'aria-expanded',
        'false',
        { timeout: 120_000 },
    );
    await expect.poll(() => route(page)).not.toBeNull();
}

test.describe.configure({ mode: 'serial' });

test('the router works in the worker: the chart stays live, a click answers, the seconds tick', async ({
    page,
}, info) => {
    test.setTimeout(240_000);
    const errors = await openFixture(page);
    await settleThenBeat(page);
    await calculate(page).click();
    await expect(statusLine(page)).toContainText('Routing round the land ·', { timeout: 60_000 });
    await expect(statusLine(page)).not.toContainText('the screen may pause');
    await expect(page.getByText(LIVE_LINE, { exact: true })).toBeVisible();
    // The probe: from just before the click is sent to its handler, on the page's own clock.
    const probeBox = (await page.getByRole('button', { name: 'Fixture probe', exact: true }).boundingBox())!;
    const clickSent = await page.evaluate(() => performance.now());
    await page.mouse.click(probeBox.x + probeBox.width / 2, probeBox.y + probeBox.height / 2);
    await routed(page);
    const w = await routingWindow(page);
    const measured = JSON.stringify({ ...w, texts: undefined });
    info.annotations.push({ type: 'routing window', description: measured });
    console.info(`[route-worker] ${info.project.name} worker: ${measured}`);
    expect(w.ms, 'the router ran long enough to measure').toBeGreaterThan(300);
    expect(w.maxGap, 'the longest pause while it routed (ms)').toBeLessThan(PAUSE_MS);
    expect(w.frames, 'frames drawn while it routed').toBeGreaterThanOrEqual(Math.floor(w.ms / 200));
    expect(w.longTasks, `long tasks of ${PAUSE_MS} ms or more (Chromium)`).toEqual([]);
    const probe = (await page.evaluate(() => (window as unknown as FixtureWindow).__trialFixture.probeClicks)).map(
        (handled) => handled - clickSent,
    );
    expect(probe).toHaveLength(1);
    expect(probe[0], 'the probe click waited (ms)').toBeLessThan(PAUSE_MS);
    // The count ticked: every second of the route is a new number.
    const seconds = new Set(w.texts.flatMap((t) => [...t.matchAll(/· (\d+) s/g)].map((m) => m[1])));
    const busy = await page.evaluate(() => {
        const t = (window as unknown as FixtureWindow).__beat.texts.filter(([, text]) => /· \d+ s/.test(text));
        return t.length ? t[t.length - 1][0] - t[0][0] : 0;
    });
    info.annotations.push({ type: 'counted', description: `${[...seconds]} over ${Math.round(busy)} ms` });
    console.info(
        `[route-worker] ${info.project.name} counted ${[...seconds]} over ${Math.round(busy)} ms; probe ${probe[0]} ms`,
    );
    expect(seconds.size).toBeGreaterThanOrEqual(busy >= 2_000 ? 3 : busy >= 1_000 ? 2 : 1);
    // One route worker; a tracer grid (if Auto's chart checks build one) never shares it.
    const sent = await workers(page);
    expect(sent.filter((s) => s.includes('job'))).toHaveLength(1);
    expect(sent.filter((s) => s.includes('job') && s.includes('grid'))).toEqual([]);
    expect(errors).toEqual([]);
});

test('when the route worker can’t start the same harness sees the freeze, and the route is bit-identical to the worker’s', async ({
    page,
}, info) => {
    test.setTimeout(300_000);
    // The worker's route, in this browser.
    await openFixture(page);
    await calculate(page).click();
    await routed(page);
    const inWorker = await route(page);
    // The old way: the route worker can't start, so the router runs on the main thread.
    const errors = await openFixture(page, '&worker=off');
    await settleThenBeat(page);
    await calculate(page).click();
    await expect(statusLine(page)).toContainText('Routing round the land (the screen may pause) ·', {
        timeout: 60_000,
    });
    await expect(page.getByText(LIVE_LINE, { exact: true })).toHaveCount(0);
    await routed(page);
    const w = await routingWindow(page);
    const measured = JSON.stringify({ ...w, texts: undefined });
    info.annotations.push({ type: 'main-thread window', description: measured });
    console.info(`[route-worker] ${info.project.name} worker=off: ${measured}`);
    expect(w.maxGap, 'the freeze the worker removes (ms)').toBeGreaterThanOrEqual(1_000);
    expect(await route(page)).toBe(inWorker);
    expect(errors).toEqual([]);
});

test('Stop ends the route at once and keeps her pins; the next route comes from a fresh worker, the same line', async ({
    page,
}) => {
    test.setTimeout(300_000);
    const errors = await openFixture(page);
    await calculate(page).click();
    await routed(page);
    const reference = await route(page);
    // Again, and stop it while the router works.
    await page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ }).click();
    await page.getByRole('button', { name: 'Setup', exact: true }).click();
    await settleThenBeat(page);
    await calculate(page).click();
    await expect(statusLine(page)).toContainText('Routing round the land ·', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(statusLine(page)).toContainText(STOPPED);
    // The heartbeat reads the status every 4 ms: wait for its tick, not just the DOM's.
    await page.waitForFunction(
        (stopped) => (window as unknown as FixtureWindow).__beat.texts.some(([, text]) => text.includes(stopped)),
        STOPPED,
    );
    const stop = await page.evaluate((stopped) => {
        const beat = (window as unknown as FixtureWindow).__beat;
        const clicked = beat.clicks.find(([, text]) => text === 'Stop')![0];
        const shown = beat.texts.find(([, text]) => text.includes(stopped))![0];
        return { ms: shown - clicked };
    }, STOPPED);
    expect(stop.ms, 'Stop to "Stopped. Nothing changed." (ms)').toBeLessThan(STOP_MS);
    expect((await routingWindow(page)).maxGap).toBeLessThan(PAUSE_MS);
    // Nothing changed: no line, even after the stopped route would have finished; the pins stay.
    await page.waitForTimeout(3_000);
    expect(await routeLines(page)).toBe(0);
    await expect(statusLine(page)).toContainText(STOPPED);
    await expect(page.getByLabel('destination longitude', { exact: true })).toHaveValue(String(ROUTE.to[0]));
    // Calculate again: a fresh route worker, the same line.
    await calculate(page).click();
    await routed(page);
    expect(await route(page)).toBe(reference);
    expect((await workers(page)).filter((s) => s.includes('job'))).toHaveLength(2);
    expect(errors).toEqual([]);
});
