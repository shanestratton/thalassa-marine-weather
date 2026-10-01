import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { TrialRouteReview } from '../services/autoroutingReview';
import type mapboxgl from 'mapbox-gl';

type MapFixtureWindow = Window & { __trialFixture: { map: mapboxgl.Map } };

const sizes = [
    { width: 390, height: 844, pane: false },
    { width: 430, height: 932, pane: false },
    { width: 1024, height: 768, pane: true },
];
const runtimeErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
    expect(runtimeErrors.get(page) ?? [], 'No unhandled chart errors, including after Close').toEqual([]);
});
async function openFixture(
    page: Page,
    size: (typeof sizes)[number],
    mode: string,
    status = 'ready',
    /** Extra fixture query, e.g. 'engine=real' (Thalassa's router on a synthetic cell). */
    query = '',
    review = 'native',
) {
    const errors: string[] = [];
    runtimeErrors.set(page, errors);
    page.on('pageerror', (error) => errors.push(error.message));
    // Auto never asks the old server trial (2026-10-01): any request to it fails the test.
    page.on('request', (request) => {
        if (request.url().includes('/functions/v1/autorouting-trial'))
            errors.push(`request to the autorouting-trial edge function: ${request.url()}`);
    });
    page.on('console', (message) => {
        if (/AuthIdentityScope|failed to mount/.test(message.text())) console.info(message.text());
    });
    const origin = 'http://127.0.0.1:4199';
    // Surface fixture/module failures directly instead of the production
    // stale-chunk reload hiding their cause behind an empty planning screen.
    await page.addInitScript(() => sessionStorage.setItem('lazyRetry_lastReloadAt', String(Date.now())));
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (
            ['grouped', 'sparse'].includes(review) &&
            url.pathname === '/services/autoroutingReview.ts' &&
            !url.searchParams.has('fixtureOriginal')
        )
            return route.fulfill({
                contentType: 'application/javascript',
                body: `export * from '/services/autoroutingReview.ts?fixtureOriginal=1';
                    export async function reviewAutoroutingProposal(_route, _draft, signal, onProgress) {
                        const review = window.__trialFixture.review;
                        if (!review) throw new Error('Synthetic review missing');
                        if (signal.aborted) return {...review, phase:'stopped'};
                        onProgress(review);
                        return review;
                    }`,
            });
        if (url.origin === origin && url.pathname.endsWith('.pbf'))
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
                    glyphs: `${origin}/e2e/fixtures/glyphs/{fontstack}/{range}.pbf`,
                    sources: {},
                    layers: [
                        {
                            id: 'fixture-water',
                            type: 'background',
                            paint: { 'background-color': mode === 'light' ? '#b8d9e5' : '#18354b' },
                        },
                    ],
                },
            });
        return url.origin === origin &&
            ['GET', 'HEAD'].includes(route.request().method()) &&
            !url.pathname.startsWith('/api/')
            ? route.continue()
            : route.abort();
    });
    await page.routeWebSocket('**/*', (socket) => socket.close());
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(
        `/e2e/fixtures/autorouting-trial.html?mode=${mode}&pane=${size.pane}&status=${status}&review=${review}${query ? `&${query}` : ''}`,
    );
    await expect(page.getByRole('button', { name: 'Slide to Start Plotting', exact: true })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
}
async function slideToChoice(page: Page, fraction = 1) {
    const slider = page.getByRole('button', { name: 'Slide to Start Plotting', exact: true });
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    await page.mouse.move(box.x + 24, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 24 + (box.width - 56) * fraction, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
}
async function fixtureCounts(page: Page) {
    return page.evaluate(() => {
        const { statuses, calculations, manualSelections, mapsCreated, mapsRemoved } = (
            window as unknown as {
                __trialFixture: {
                    statuses: number;
                    calculations: number;
                    manualSelections: number;
                    mapsCreated: number;
                    mapsRemoved: number;
                };
            }
        ).__trialFixture;
        return { statuses, calculations, manualSelections, mapsCreated, mapsRemoved };
    });
}
async function choiceFits(page: Page, pane: boolean) {
    const dialog = page.getByRole('dialog', { name: 'Choose routing mode', exact: true });
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const frame = pane
        ? (await page.getByTestId('trial-pane').boundingBox())!
        : { x: 0, y: 0, ...page.viewportSize()! };
    const geometry = JSON.stringify({ box, frame });
    expect(Math.abs(box.x + box.width / 2 - (frame.x + frame.width / 2)), geometry).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - (frame.y + frame.height / 2)), geometry).toBeLessThanOrEqual(1);
    expect(box.x, geometry).toBeGreaterThanOrEqual(frame.x);
    expect(box.y, geometry).toBeGreaterThanOrEqual(frame.y);
    expect(box.x + box.width, geometry).toBeLessThanOrEqual(frame.x + frame.width);
    expect(box.y + box.height, geometry).toBeLessThanOrEqual(frame.y + frame.height);
    expect(
        await dialog.evaluate(
            (node) => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1,
        ),
    ).toBe(true);
    for (const name of ['Manual routing', 'Auto routing', 'Close routing choice'])
        await hitVisible(dialog.getByRole('button', { name, exact: true }));
    if (pane) await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
    else await expect(dialog).toHaveAttribute('aria-modal', 'true');
}
async function hitVisible(element: Locator) {
    await expect
        .poll(() =>
            element.evaluate((node) => {
                const box = node.getBoundingClientRect();
                const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
                return !!hit && (hit === node || node.contains(hit));
            }),
        )
        .toBe(true);
}
async function setControlsExpanded(page: Page, expanded: boolean) {
    const toggle = page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ });
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-expanded')) !== String(expanded)) await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
}
async function showReview(page: Page) {
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toBeVisible();
    await setControlsExpanded(page, true);
    const review = page.getByRole('button', { name: 'Review', exact: true });
    await review.click();
    await expect(review).toHaveAttribute('aria-pressed', 'true');
}
async function showSetup(page: Page) {
    await setControlsExpanded(page, true);
    const setup = page.getByRole('button', { name: 'Setup', exact: true });
    await setup.click();
    await expect(setup).toHaveAttribute('aria-pressed', 'true');
}
/** Open real disclosure controls from the outside in; never force-click a
 * locator hidden behind an intentionally collapsed advisory. */
async function revealAdvisory(locator: Locator) {
    for (let depth = 0; depth < 4; depth++) {
        const closed = locator.locator('xpath=ancestor::details[not(@open)][last()]');
        if (!(await closed.count())) break;
        await closed.locator(':scope > summary').click();
    }
    await expect(locator).toBeVisible();
}
async function routeGeometry(page: Page) {
    return page.evaluate(() => {
        const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
        const source = map.getStyle().sources.trial as mapboxgl.GeoJSONSourceSpecification;
        const data = source.data as GeoJSON.FeatureCollection<GeoJSON.LineString>;
        return data.features.find((feature) => feature.geometry.type === 'LineString')!.geometry.coordinates;
    });
}
async function calculateSmallFixtureRoute(page: Page) {
    await slideToChoice(page);
    await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
    await page.getByText('Enter coordinates', { exact: true }).click();
    for (const [name, value] of [
        ['departure latitude', '-26.68'],
        ['departure longitude', '153.16'],
        ['destination latitude', '-26.67'],
        ['destination longitude', '153.18'],
    ])
        await page.getByLabel(name, { exact: true }).fill(value);
    await page.getByLabel('destination longitude', { exact: true }).blur();
    await page.getByText('Enter coordinates', { exact: true }).click();
    await page.getByRole('button', { name: 'Calculate trial route', exact: true }).click();
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toHaveAttribute(
        'aria-expanded',
        'false',
    );
    await settleGroupedMap(page);
}
async function chartRect(page: Page) {
    const chart = page.getByRole('region', { name: /Trial chart/ });
    return chart.evaluate((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        const canvas = node.querySelector('canvas')?.getBoundingClientRect();
        return {
            x,
            y,
            width,
            height,
            canvas: canvas ? { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height } : null,
        };
    });
}
async function fits(page: Page, pane: boolean) {
    const dialog = page.getByRole('dialog', { name: 'Autorouting trial' });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const frame = pane ? await page.getByTestId('trial-pane').boundingBox() : { x: 0, y: 0, ...page.viewportSize()! };
    expect(Math.abs(box!.x - frame!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.width - frame!.width)).toBeLessThanOrEqual(1);
    const chart = await page.getByRole('region', { name: /Trial chart/ }).boundingBox();
    for (const key of ['x', 'y', 'width', 'height'] as const)
        expect(Math.abs(chart![key] - box![key]), `Chart fills dialog ${key}`).toBeLessThanOrEqual(1);
    expect(
        await dialog.evaluate((node) =>
            [...node.querySelectorAll('button, input, p'), node]
                .filter((element) => element.scrollWidth > element.clientWidth + 1)
                .map((element) => element.textContent || element.getAttribute('aria-label')),
        ),
    ).toEqual([]);
    await hitVisible(page.getByRole('button', { name: 'Close autorouting trial' }));
    await hitVisible(page.getByRole('button', { name: 'Zoom trial chart in' }));
    await hitVisible(page.getByRole('button', { name: 'Zoom trial chart out' }));
    // The dock handle remains reachable while its content scrolls/collapses;
    // the chart is not resized into a second, smaller panel.
    await hitVisible(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ }));
    expect(await dialog.evaluate((node) => node.scrollTop)).toBe(0);
}
async function capture(page: Page, info: TestInfo, name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
}

async function groupedReviewState(page: Page) {
    return page.evaluate(() => {
        const fixture = (
            window as unknown as {
                __trialFixture: {
                    review: TrialRouteReview;
                    map: {
                        queryRenderedFeatures(options: { layers: string[] }): Array<{ properties: { number: number } }>;
                        getStyle(): {
                            sources: Record<
                                string,
                                {
                                    data: {
                                        geometry?: { coordinates: number[] };
                                        features?: Array<{ geometry: { type: string }; properties: { color: string } }>;
                                    };
                                }
                            >;
                        };
                    };
                };
            }
        ).__trialFixture;
        const sources = fixture.map.getStyle().sources;
        const issues = fixture.review.legs.map((leg) => leg!.verdict.issues);
        return {
            focus: sources['trial-focus'].data.geometry?.coordinates,
            legColors: sources['trial-review'].data.features
                ?.filter((feature) => feature.geometry.type === 'LineString')
                .map((feature) => feature.properties.color),
            trackIssueCount: issues.flat().filter((issue) => issue.chartTrack).length,
            labels: [
                ...new Set(
                    fixture.map
                        .queryRenderedFeatures({ layers: ['trial-waypoint-labels'] })
                        .map((feature) => feature.properties.number),
                ),
            ].sort(),
            firstTrackSpot: [issues[0][0].at!.lon, issues[0][0].at!.lat],
            worstTrackSpot: [issues[1][0].at!.lon, issues[1][0].at!.lat],
            depthSpot: [issues[1][1].at!.lon, issues[1][1].at!.lat],
            obstructionSpot: [issues[1][2].mark!.lon, issues[1][2].mark!.lat],
        };
    });
}

async function settleGroupedMap(page: Page) {
    await page.evaluate(async () => {
        const map = (
            window as unknown as {
                __trialFixture: { map: { isMoving(): boolean; once(event: string, listener: () => void): void } };
            }
        ).__trialFixture.map;
        if (map.isMoving()) await new Promise<void>((resolve) => map.once('moveend', resolve));
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
}

for (const size of [
    { width: 390, height: 844, pane: false },
    { width: 568, height: 320, pane: false },
]) {
    test(`Tracer waypoint move preserves the route and rechecks at ${size.width}`, async ({
        page,
        browserName,
    }, info) => {
        test.setTimeout(60_000);
        await openFixture(page, size, size.width === 390 ? 'light' : 'dark', 'ready', '', 'grouped');
        await slideToChoice(page);
        await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
        await page.getByText('Enter coordinates', { exact: true }).click();
        for (const [name, value] of [
            ['departure latitude', '-26.68'],
            ['departure longitude', '153.16'],
            ['destination latitude', '-26.67'],
            ['destination longitude', '153.18'],
        ])
            await page.getByLabel(name, { exact: true }).fill(value);
        await page.getByLabel('destination longitude', { exact: true }).blur();
        await page.getByText('Enter coordinates', { exact: true }).click();
        await page.getByRole('button', { name: 'Calculate trial route', exact: true }).click();
        await showReview(page);
        await page.getByRole('button', { name: 'Select waypoint 2', exact: true }).click();
        const editor = page.getByRole('region', { name: 'Waypoint 2', exact: true });
        await expect(editor).toBeVisible();
        const geometry = () =>
            page.evaluate(() => {
                const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
                const source = map.getStyle().sources.trial as mapboxgl.GeoJSONSourceSpecification;
                const data = source.data as GeoJSON.FeatureCollection<GeoJSON.LineString>;
                return data.features.find((feature) => feature.geometry.type === 'LineString')!.geometry.coordinates;
            });
        const original = await geometry();
        const place = async () => {
            await editor.getByRole('button', { name: 'Move', exact: true }).click();
            await settleGroupedMap(page);
            await hitVisible(editor.getByRole('button', { name: 'Confirm move', exact: true }));
            await hitVisible(editor.getByRole('button', { name: 'Cancel', exact: true }));
            const target = await page.evaluate(() => {
                const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
                const canvas = map.getCanvas(),
                    rect = canvas.getBoundingClientRect();
                for (const x of [0.82, 0.6, 0.45, 0.95])
                    for (const y of [0.46, 0.58, 0.7]) {
                        const point = { x: rect.x + rect.width * x, y: rect.y + rect.height * y };
                        if (document.elementFromPoint(point.x, point.y) === canvas) return point;
                    }
                throw new Error('No exposed chart remains for waypoint movement');
            });
            await page.mouse.click(target.x, target.y);
            await expect(editor.getByText('New position', { exact: true })).toBeVisible();
            await expect(editor.getByRole('button', { name: 'Confirm move', exact: true })).toBeEnabled();
        };
        await place();
        expect(await geometry()).toEqual(original);
        await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(await geometry()).toEqual(original);
        await place();
        await capture(page, info, `tracer-moving-${size.width}`);
        await editor.getByRole('button', { name: 'Confirm move', exact: true }).click();
        await expect(page.getByText('Edited · router checks no longer apply', { exact: true })).toBeVisible();
        const edited = await geometry();
        expect(edited).toHaveLength(original.length);
        expect(edited[0]).toEqual(original[0]);
        expect(edited[2]).toEqual(original[2]);
        expect(edited[1]).not.toEqual(original[1]);
        await editor.getByRole('button', { name: 'Close waypoint editor' }).click();
        await showReview(page);
        await expect(
            page.getByText('From the original route, before waypoint edits · historical, not checks of this line.'),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Save as planned route', exact: true })).toBeDisabled();
        const undo = page.getByRole('button', { name: /Undo last move$/ });
        // At very short landscape heights the entire expanded area, including
        // its footer, deliberately scrolls instead of squeezing the controls.
        // Playwright mobile WebKit cannot synthesize a mouse wheel; verify
        // physical scrolling in Chromium and reachable controls in both.
        if (size.height < 500 && browserName === 'chromium') {
            const expanded = page.locator('.trial-tracer-expanded');
            await expanded.hover();
            await page.mouse.wheel(0, await expanded.evaluate((node) => node.scrollHeight));
            await expect.poll(() => expanded.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
        }
        await undo.scrollIntoViewIfNeeded();
        await hitVisible(undo);
        await undo.click();
        await expect.poll(() => geometry()).toEqual(original);
        await expect(page.getByText('Edited · router checks no longer apply', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Undo last move$/ })).toHaveCount(0);
        await expect(page.getByRole('region', { name: 'Route chart checks' }).getByRole('status')).toContainText(
            '2/2 checked segments',
        );
        expect(await fixtureCounts(page)).toMatchObject({ calculations: 1, mapsCreated: 1 });
        expect(runtimeErrors.get(page)).toEqual([]);
    });
}

for (const size of [sizes[0], sizes[2]]) {
    test(`Setup and Review preserve the proposal and Show whole route clears the close-up at ${size.width}`, async ({
        page,
    }, info) => {
        await openFixture(page, size, 'dark', 'ready', '', 'grouped');
        await calculateSmallFixtureRoute(page);
        const original = await routeGeometry(page);
        await setControlsExpanded(page, true);
        await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByRole('button', { name: 'Calculate trial route', exact: true })).toBeHidden();
        await showSetup(page);
        await expect(page.getByRole('button', { name: 'Calculate trial route', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Clear', exact: true })).toBeVisible();
        expect(await routeGeometry(page)).toEqual(original);
        await showReview(page);
        expect(await routeGeometry(page)).toEqual(original);
        await page.getByRole('button', { name: 'Select waypoint 2', exact: true }).click();
        const editor = page.getByRole('region', { name: 'Waypoint 2', exact: true });
        await expect(editor).toBeVisible();
        await settleGroupedMap(page);
        await editor.getByRole('button', { name: 'Show on chart', exact: true }).click();
        await settleGroupedMap(page);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
                    const source = map.getStyle().sources['trial-review'] as mapboxgl.GeoJSONSourceSpecification;
                    const data = source.data as GeoJSON.FeatureCollection<GeoJSON.Point>;
                    const pin = data.features.find(
                        (feature) => feature.geometry.type === 'Point' && feature.properties?.number === 2,
                    )!;
                    const pixel = map.project(pin.geometry.coordinates as [number, number]);
                    const canvas = map.getCanvas(),
                        frame = canvas.getBoundingClientRect();
                    return document.elementFromPoint(frame.x + pixel.x, frame.y + pixel.y) === canvas;
                }),
            )
            .toBe(true);
        const closeZoom = await page.evaluate(() =>
            (window as unknown as MapFixtureWindow).__trialFixture.map.getZoom(),
        );
        await editor.getByRole('button', { name: 'Close waypoint editor', exact: true }).click();
        await showReview(page);
        const fit = page.getByRole('button', { name: 'Show whole route', exact: true }).last();
        await hitVisible(fit);
        await fit.click();
        await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        await settleGroupedMap(page);
        await expect
            .poll(async () => page.evaluate(() => (window as unknown as MapFixtureWindow).__trialFixture.map.getZoom()))
            .toBeLessThan(closeZoom);
        await proposalFitsChart(page);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
                    const source = map.getStyle().sources.trial as mapboxgl.GeoJSONSourceSpecification;
                    const data = source.data as GeoJSON.FeatureCollection<GeoJSON.LineString>;
                    const coordinates = data.features.find((feature) => feature.geometry.type === 'LineString')!
                        .geometry.coordinates;
                    const canvas = map.getCanvas(),
                        frame = canvas.getBoundingClientRect();
                    return [coordinates[0], coordinates.at(-1)!].every((coordinate) => {
                        const pixel = map.project(coordinate as [number, number]);
                        return document.elementFromPoint(frame.x + pixel.x, frame.y + pixel.y) === canvas;
                    });
                }),
            )
            .toBe(true);
        expect(await routeGeometry(page)).toEqual(original);
        expect(await fixtureCounts(page)).toMatchObject({ calculations: 1, mapsCreated: 1 });
        await capture(page, info, `whole-route-after-inspection-${size.width}`);
    });
}

test('Waypoint tap target accepts a near-edge touch without changing route geometry', async ({ page }) => {
    await openFixture(page, sizes[0], 'light', 'ready', '', 'grouped');
    await calculateSmallFixtureRoute(page);
    const original = await routeGeometry(page);
    const cameraBeforeSelection = await page.evaluate(() => {
        const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
        return { zoom: map.getZoom(), centre: map.getCenter().toArray() };
    });
    const target = await page.evaluate(() => {
        const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
        const source = map.getStyle().sources['trial-review'] as mapboxgl.GeoJSONSourceSpecification;
        const data = source.data as GeoJSON.FeatureCollection<GeoJSON.Point>;
        const pin = data.features.find(
            (feature) => feature.geometry.type === 'Point' && feature.properties?.number === 2,
        )!;
        const centre = map.project(pin.geometry.coordinates as [number, number]);
        const canvas = map.getCanvas(),
            frame = canvas.getBoundingClientRect();
        for (const [dx, dy] of [
            [18, 0],
            [-18, 0],
            [0, 18],
            [0, -18],
        ]) {
            const pixel: [number, number] = [centre.x + dx, centre.y + dy];
            const target = { x: frame.x + pixel[0], y: frame.y + pixel[1] };
            // Outside the visible 12px marker/stroke: old exact-point hit
            // testing misses it, but the 44px touch target must select pin2.
            if (
                document.elementFromPoint(target.x, target.y) === canvas &&
                map.queryRenderedFeatures(pixel, { layers: ['trial-waypoints'] }).length === 0
            )
                return target;
        }
        throw new Error('No exposed near-edge waypoint tap target');
    });
    await page.mouse.click(target.x, target.y);
    await expect(page.getByRole('region', { name: 'Waypoint 2', exact: true })).toBeVisible();
    await settleGroupedMap(page);
    const cameraAfterSelection = await page.evaluate(() => {
        const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
        return { zoom: map.getZoom(), centre: map.getCenter().toArray() };
    });
    expect(cameraAfterSelection.zoom).toBeCloseTo(cameraBeforeSelection.zoom, 5);
    expect(cameraAfterSelection.centre[0]).toBeCloseTo(cameraBeforeSelection.centre[0], 5);
    expect(cameraAfterSelection.centre[1]).toBeCloseTo(cameraBeforeSelection.centre[1], 5);
    expect(await routeGeometry(page)).toEqual(original);
    expect(await fixtureCounts(page)).toMatchObject({ calculations: 1, mapsCreated: 1 });
});

test('Setup and Review preserve an unsaved planned-route name', async ({ page }) => {
    await openFixture(page, sizes[0], 'dark');
    await calculateSmallFixtureRoute(page);
    const original = await routeGeometry(page);
    await showReview(page);
    const save = page.getByRole('button', { name: 'Save as planned route', exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    const name = page.getByRole('textbox', { name: 'Planned route name', exact: true });
    await name.fill('Newport trial — still reviewing');
    await name.blur();
    await showSetup(page);
    await expect(name).toBeHidden();
    await showReview(page);
    await expect(name).toHaveValue('Newport trial — still reviewing');
    expect(await routeGeometry(page)).toEqual(original);
    expect(await fixtureCounts(page)).toMatchObject({ calculations: 1, mapsCreated: 1 });
    // Do not submit: the regression concerns local form state, not saving.
});

test('ENC passage overview still draws after zooming below the detail floor', async ({ page }, info) => {
    await openFixture(page, sizes[0], 'dark', 'ready', '', 'overview');
    await slideToChoice(page);
    await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
    await setControlsExpanded(page, false);
    await page.evaluate(() =>
        (window as unknown as MapFixtureWindow).__trialFixture.map.jumpTo({
            center: [153.16, -26.68],
            zoom: 5.8,
            padding: 0,
        }),
    );
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
                return map
                    .queryRenderedFeatures()
                    .some((feature) => feature.layer?.id.startsWith('enc-') && feature.layer?.type === 'fill');
            }),
        )
        .toBe(true);
    await capture(page, info, 'tracer-enc-passage-overview');
    expect(runtimeErrors.get(page)).toEqual([]);
});

test('Fine-only chart imports do not pretend to provide a passage overview', async ({ page }) => {
    await openFixture(page, sizes[0], 'dark');
    await slideToChoice(page);
    await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
    await setControlsExpanded(page, false);
    await page.evaluate(() =>
        (window as unknown as MapFixtureWindow).__trialFixture.map.jumpTo({
            center: [153.16, -26.68],
            zoom: 5.8,
            padding: 0,
        }),
    );
    await expect(page.getByRole('button', { name: /Reference: chart unavailable at this view/ })).toBeVisible();
    expect(runtimeErrors.get(page)).toEqual([]);
});

for (const size of [sizes[0], { width: 1440, height: 900, pane: false }]) {
    test(`Grouped chart-track warnings retain hazard locations at ${size.width}`, async ({ page }, info) => {
        test.setTimeout(60_000);
        await openFixture(page, size, 'dark', 'ready', '', 'grouped');
        await slideToChoice(page);
        await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
        await page.getByText('Enter coordinates', { exact: true }).click();
        for (const [name, value] of [
            ['departure latitude', '-26.68'],
            ['departure longitude', '153.16'],
            ['destination latitude', '-26.67'],
            ['destination longitude', '153.18'],
        ])
            await page.getByLabel(name, { exact: true }).fill(value);
        await page.getByLabel('destination longitude', { exact: true }).blur();
        await page.getByText('Enter coordinates', { exact: true }).click();
        await page.getByRole('button', { name: 'Calculate trial route', exact: true }).click();
        await showReview(page);

        const checks = page.getByRole('region', { name: 'Route chart checks', exact: true });
        const grouped = page.getByRole('region', { name: 'Chart track advisories', exact: true });
        await expect(grouped.getByRole('listitem')).toHaveCount(1);
        await expect(grouped).toContainText('Track 1 · Fixture entrance track');
        await expect(grouped).toContainText('Up to 90 m from charted track');
        await expect(grouped).toContainText('Detailed route segments 1–2');
        await expect(checks.getByRole('status')).toHaveText(
            '1 danger · 1 caution · 0 incomplete · 2/2 checked segments',
        );
        await expect(checks.getByText('50 m from charted track — review alignment', { exact: true })).toHaveCount(0);
        await expect(checks.getByText('90 m from charted track — review alignment', { exact: true })).toHaveCount(0);
        await expect(checks.getByText('Leg 2→3: danger · 1.0 m least', { exact: true })).toHaveCount(1);
        await expect(checks.getByText('Needs tide — no tidal clearance or departure window established.')).toHaveCount(
            1,
        );
        await expect.poll(async () => (await groupedReviewState(page)).legColors).toEqual(['#fbbf24', '#f87171']);
        await expect.poll(async () => (await groupedReviewState(page)).labels).toEqual([1, 2, 3]);
        const state = await groupedReviewState(page);
        expect(state.trackIssueCount).toBe(2);

        const summary = grouped.getByRole('button', { name: 'Locate track 1: Fixture entrance track', exact: true });
        await summary.scrollIntoViewIfNeeded();
        await hitVisible(summary);
        await fits(page, false);
        await settleGroupedMap(page);
        await capture(page, info, 'grouped-track-summary');
        await summary.click();
        await expect.poll(async () => (await groupedReviewState(page)).focus).toEqual(state.worstTrackSpot);
        await showReview(page);
        const waypoints = checks.getByRole('list', { name: 'Proposal waypoints' }).getByRole('listitem');
        await expect(waypoints.nth(2)).toHaveClass(/border-sky-400/);

        const local = checks.getByRole('button', {
            name: 'Locate track 1 near segment 1',
            exact: true,
            includeHidden: true,
        });
        await revealAdvisory(local);
        await local.scrollIntoViewIfNeeded();
        await hitVisible(local);
        await local.click();
        await expect.poll(async () => (await groupedReviewState(page)).focus).toEqual(state.firstTrackSpot);

        for (const [name, spot] of [
            ['Fixture shallow depth — 1.0 m charted ↗', state.depthSpot],
            ['Fixture obstruction near route ↗', state.obstructionSpot],
        ] as const) {
            await showReview(page);
            const hazard = checks.getByRole('button', { name, exact: true, includeHidden: true });
            await revealAdvisory(hazard);
            await hazard.scrollIntoViewIfNeeded();
            await hitVisible(hazard);
            await hazard.click();
            await expect.poll(async () => (await groupedReviewState(page)).focus).toEqual(spot);
        }
        await fits(page, false);
        await settleGroupedMap(page);
        await capture(page, info, 'grouped-track-hazards');
        expect((await groupedReviewState(page)).legColors).toEqual(['#fbbf24', '#f87171']);
        expect(await fixtureCounts(page)).toMatchObject({ calculations: 1, manualSelections: 0, mapsCreated: 1 });
        await page.getByRole('button', { name: 'Close autorouting trial', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Autorouting trial', exact: true })).toHaveCount(0);
        expect((await fixtureCounts(page)).mapsRemoved).toBe(1);
    });
}

for (const size of [sizes[0], sizes[2]]) {
    test(`Sparse 240 NM review keeps the exact 1000-point route and hidden hazard at ${size.width}${size.pane ? ' split' : ''}`, async ({
        page,
    }, info) => {
        test.setTimeout(60_000);
        await openFixture(page, size, 'dark', 'ready', '', 'sparse');
        await slideToChoice(page);
        await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
        await page.getByText('Enter coordinates', { exact: true }).click();
        const endLongitude = 153 + ((240 * 1852) / (6371000 * Math.cos((27 * Math.PI) / 180))) * (180 / Math.PI);
        for (const [name, value] of [
            ['departure latitude', '-27'],
            ['departure longitude', '153'],
            ['destination latitude', '-27'],
            ['destination longitude', String(endLongitude)],
        ])
            await page.getByLabel(name, { exact: true }).fill(value);
        await page.getByLabel('destination longitude', { exact: true }).blur();
        await page.getByText('Enter coordinates', { exact: true }).click();
        await page.getByRole('button', { name: 'Calculate trial route', exact: true }).click();
        await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        await settleGroupedMap(page);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const fixture = (
                        window as unknown as {
                            __trialFixture: {
                                routeCoordinates: [number, number][];
                                review: TrialRouteReview;
                                map: {
                                    getStyle(): { sources: Record<string, { data: GeoJSON.FeatureCollection }> };
                                    queryRenderedFeatures(options: {
                                        layers: string[];
                                    }): Array<{ properties: { number: number } }>;
                                };
                            };
                        }
                    ).__trialFixture;
                    const sources = fixture.map.getStyle().sources;
                    const route = sources.trial.data.features.find((feature) => feature.geometry.type === 'LineString')
                        ?.geometry as GeoJSON.LineString | undefined;
                    const reviewed = sources['trial-review'].data.features;
                    return {
                        rawCoordinates: route?.coordinates.length,
                        exactPath: JSON.stringify(route?.coordinates) === JSON.stringify(fixture.routeCoordinates),
                        displayPoints: reviewed.filter((feature) => feature.geometry.type === 'Point').length,
                        checkedSegments: reviewed.filter((feature) => feature.geometry.type === 'LineString').length,
                        originalChecks: fixture.review.legs.length,
                        dangerousSegments: reviewed.filter(
                            (feature) =>
                                feature.geometry.type === 'LineString' && feature.properties?.color === '#f87171',
                        ).length,
                        renderedLabels: [
                            ...new Set(
                                fixture.map
                                    .queryRenderedFeatures({ layers: ['trial-waypoint-labels'] })
                                    .map((feature) => feature.properties.number),
                            ),
                        ].sort((a, b) => a - b),
                    };
                }),
            )
            .toEqual({
                rawCoordinates: 1000,
                exactPath: true,
                displayPoints: 6,
                checkedSegments: 999,
                originalChecks: 999,
                dangerousSegments: 1,
                renderedLabels: [1, 2, 3, 4, 5, 6],
            });
        await fits(page, size.pane);
        await capture(page, info, 'sparse-240nm-full-route');
        await showReview(page);
        const checks = page.getByRole('region', { name: 'Route chart checks', exact: true });
        await expect(checks).toContainText('6 waypoints · 1000 detailed route points');
        await expect(checks.getByRole('status')).toHaveText(
            '1 danger · 0 caution · 0 incomplete · 999/999 checked segments',
        );
        const rows = checks.getByRole('list', { name: 'Proposal waypoints' }).getByRole('listitem');
        await expect(rows).toHaveCount(6);
        await expect(rows.nth(3)).toContainText('Leg 3→4: danger · 1.2 m least');
        await expect(rows.nth(3).getByText('● 4', { exact: true })).toHaveCSS('color', 'rgb(248, 113, 113)');
        await expect(rows.nth(3)).toContainText('Segment 556');
        const hazard = checks.getByRole('button', {
            name: 'Sparse fixture obstruction in original segment 556 ↗',
            exact: true,
        });
        await hazard.scrollIntoViewIfNeeded();
        await hitVisible(hazard);
        await capture(page, info, 'sparse-240nm-hidden-segment-warning');
        await hazard.click();
        await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        await settleGroupedMap(page);
        await expect
            .poll(() =>
                page.evaluate(() => {
                    const fixture = (
                        window as unknown as {
                            __trialFixture: {
                                review: TrialRouteReview;
                                map: {
                                    getStyle(): { sources: Record<string, { data: GeoJSON.Feature<GeoJSON.Point> }> };
                                };
                            };
                        }
                    ).__trialFixture;
                    const exact = fixture.review.legs[555]!.verdict.issues[0].mark!;
                    return {
                        focus: fixture.map.getStyle().sources['trial-focus'].data.geometry.coordinates,
                        expected: [exact.lon, exact.lat],
                    };
                }),
            )
            .toEqual({
                focus: [153 + ((endLongitude - 153) * 556) / 999, -26.9998],
                expected: [153 + ((endLongitude - 153) * 556) / 999, -26.9998],
            });
        await capture(page, info, 'sparse-240nm-exact-hazard-locator');
        await showReview(page);
        await expect(rows.nth(3)).toHaveClass(/border-sky-400/);
        expect(await fixtureCounts(page)).toMatchObject({ calculations: 1, manualSelections: 0, mapsCreated: 1 });
        await page.getByRole('button', { name: 'Close autorouting trial', exact: true }).click();
        expect((await fixtureCounts(page)).mapsRemoved).toBe(1);
    });
}

async function proposalFitsChart(page: Page) {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = (
                    window as unknown as {
                        __trialFixture: {
                            map: {
                                getStyle: () => {
                                    sources: {
                                        trial: {
                                            data: {
                                                features: Array<{
                                                    geometry: { type: string; coordinates: [number, number][] };
                                                }>;
                                            };
                                        };
                                    };
                                };
                                project: (coordinate: [number, number]) => { x: number; y: number };
                                getContainer: () => HTMLElement;
                            };
                        };
                    }
                ).__trialFixture.map;
                const route = map
                    .getStyle()
                    .sources.trial.data.features.find((feature) => feature.geometry.type === 'LineString');
                const container = map.getContainer();
                return (
                    !!route &&
                    route.geometry.coordinates.every((coordinate) => {
                        const pixel = map.project(coordinate);
                        return (
                            pixel.x >= 8 &&
                            pixel.x <= container.clientWidth - 8 &&
                            pixel.y >= 8 &&
                            pixel.y <= container.clientHeight - 8
                        );
                    })
                );
            }),
        )
        .toBe(true);
}

async function openTallProposal(page: Page) {
    await openFixture(page, sizes[0], 'dark');
    await slideToChoice(page);
    await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
    await page.getByText('Enter coordinates', { exact: true }).click();
    for (const [name, value] of [
        ['departure latitude', '-26.7'],
        ['departure longitude', '153.16'],
        ['destination latitude', '-26.65'],
        ['destination longitude', '153.16'],
    ])
        await page.getByLabel(name, { exact: true }).fill(value);
    await page.getByLabel('destination longitude', { exact: true }).blur();
    await page.getByText('Enter coordinates', { exact: true }).click();
    await page.getByRole('button', { name: 'Calculate trial route', exact: true }).click();
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toHaveAttribute(
        'aria-expanded',
        'false',
    );
    await settleGroupedMap(page);
}

// Both ends of the proposal are hit-testable map, not covered by a card.
async function expectProposalEndpointsClear(page: Page) {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const map = (
                    window as unknown as {
                        __trialFixture: {
                            map: {
                                getStyle(): { sources: { trial: { data: GeoJSON.FeatureCollection } } };
                                project(point: [number, number]): { x: number; y: number };
                                getCanvas(): HTMLCanvasElement;
                            };
                        };
                    }
                ).__trialFixture.map;
                const canvas = map.getCanvas();
                const frame = canvas.getBoundingClientRect();
                const route = map
                    .getStyle()
                    .sources.trial.data.features.find((feature) => feature.geometry.type === 'LineString')?.geometry as
                    | GeoJSON.LineString
                    | undefined;
                return (
                    !!route &&
                    [route.coordinates[0], route.coordinates.at(-1)!].every((coordinate) => {
                        const point = map.project(coordinate as [number, number]);
                        return document.elementFromPoint(frame.x + point.x, frame.y + point.y) === canvas;
                    })
                );
            }),
        )
        .toBe(true);
}

test('Tall proposal endpoints remain visible below the floating controls', async ({ page }, info) => {
    await openTallProposal(page);
    await capture(page, info, 'tall-proposal-collapsed');
    await expectProposalEndpointsClear(page);
});

test('Tall proposal endpoints stay clear when the folded card grows after the fit', async ({ page }, info) => {
    await openTallProposal(page);
    await expectProposalEndpointsClear(page);
    // Taller lines after the fold model a late wrap: the card gains height after
    // the map was framed. On CI, Linux fonts wrapped 'Chart checks complete ·
    // review required' onto a third line, which covered the route's top
    // endpoint until the workspace re-fitted on the card's own resize. Line
    // height, not a font face, so the card grows on every platform's fonts.
    const before = await page.locator('.trial-tracer-shell[data-expanded="false"]').boundingBox();
    await page.addStyleTag({ content: '.trial-tracer-shell * { line-height: 2 !important; }' });
    await expect
        .poll(async () => (await page.locator('.trial-tracer-shell[data-expanded="false"]').boundingBox())!.height)
        .toBeGreaterThan(before!.height + 4);
    await settleGroupedMap(page);
    await capture(page, info, 'tall-proposal-late-wrap');
    await expectProposalEndpointsClear(page);
});

for (const size of sizes)
    for (const mode of ['light', 'dark', 'night']) {
        test(`Trial proposal stays isolated and usable at ${size.width} ${mode}${size.pane ? ' split' : ''}`, async ({
            page,
        }, info) => {
            test.setTimeout(60_000);
            await openFixture(page, size, mode);
            const choice = page.getByRole('dialog', { name: 'Choose routing mode', exact: true });
            expect(await fixtureCounts(page)).toEqual({
                statuses: 0,
                calculations: 0,
                manualSelections: 0,
                mapsCreated: 0,
                mapsRemoved: 0,
            });
            await slideToChoice(page, 0.4);
            await expect(choice).toHaveCount(0);
            expect((await fixtureCounts(page)).statuses).toBe(0);
            await slideToChoice(page);
            await expect(page.getByRole('button', { name: 'Auto routing', exact: true })).toBeEnabled();
            await choiceFits(page, size.pane);
            await capture(page, info, 'routing-choice');
            await page.getByRole('button', { name: 'Close routing choice', exact: true }).click();
            await expect(choice).toHaveCount(0);
            await slideToChoice(page);
            await expect(choice).toBeVisible();
            await page.keyboard.press('Escape');
            await expect(choice).toHaveCount(0);
            await slideToChoice(page);
            await page.getByRole('button', { name: 'Manual routing', exact: true }).click();
            await expect(page.getByRole('heading', { name: 'Manual routing selected', exact: true })).toBeVisible();
            await expect(choice).toHaveCount(0);
            const afterManual = await fixtureCounts(page);
            expect(afterManual.statuses).toBeGreaterThan(0);
            expect(afterManual).toMatchObject({ calculations: 0, manualSelections: 1, mapsCreated: 0, mapsRemoved: 0 });
            await page.getByRole('button', { name: 'Return to planning', exact: true }).click();
            await slideToChoice(page);
            await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
            await expect(choice).toHaveCount(0);
            const dialog = page.getByRole('dialog', { name: 'Autorouting trial' });
            await expect(dialog).toBeVisible();
            await page.evaluate(async () => {
                await document.fonts.ready;
            });
            await expect(page.getByRole('button', { name: 'Calculate trial route' })).toBeDisabled();
            await expect(dialog).not.toContainText(
                'Trial departure: leaving now. The scheduled departure on Planning home is not used.',
            );
            await expect(page.getByLabel('Trial vessel draft in metres', { exact: true })).toHaveCount(0);
            await expect(page.getByLabel('Trial cruising speed in knots', { exact: true })).toHaveCount(0);
            // Real ENC importer, viewport hook and renderer over one tiny
            // synthetic reference cell — not a photograph masquerading as ENC.
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const map = (
                            window as unknown as {
                                __trialFixture: { map: { getStyle: () => { layers: { id: string }[] } } };
                            }
                        ).__trialFixture.map;
                        const layers = map.getStyle().layers;
                        const enc = layers.findIndex((layer) => layer.id === 'enc-vec-depare-fill');
                        const route = layers.findIndex((layer) => layer.id === 'trial-route');
                        return enc >= 0 && route > enc;
                    }),
                )
                .toBe(true);
            await fits(page, size.pane);
            await capture(page, info, 'trial-initial');
            // Two pins and Calculate (2026-10-01): no departure type, no canal exit.
            for (const name of ['Canal / marina', 'Open water'])
                await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
            await expect(page.getByLabel('canal exit latitude', { exact: true })).toHaveCount(0);
            const chart = page.getByRole('region', { name: /Trial chart/ });
            const chartBox = await chart.boundingBox();
            const expandedChart = await chartRect(page);
            await setControlsExpanded(page, false);
            expect(await chartRect(page)).toEqual(expandedChart);
            await chart.click({ position: { x: chartBox!.width * 0.4, y: chartBox!.height * 0.4 } });
            await setControlsExpanded(page, true);
            await expect(page.getByRole('button', { name: /^departure/i })).toContainText(/\d+°\d{2}\.\d{3}′[NS]/);
            await expect(page.getByRole('button', { name: /^departure/i })).toContainText(/\d{3}°\d{2}\.\d{3}′[EW]/);
            await setControlsExpanded(page, false);
            await chart.click({ position: { x: chartBox!.width * 0.65, y: chartBox!.height * 0.7 } });
            await setControlsExpanded(page, true);
            await expect(page.getByRole('button', { name: /^destination/i })).toContainText(/\d+°\d{2}\.\d{3}′[NS]/);
            await expect(page.getByRole('button', { name: /^destination/i })).toContainText(/\d{3}°\d{2}\.\d{3}′[EW]/);
            await fits(page, size.pane);
            await capture(page, info, 'trial-endpoints');
            const calculate = page.getByRole('button', { name: 'Calculate trial route' });
            await expect(calculate).toBeEnabled();
            await calculate.click();
            await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toHaveAttribute(
                'aria-expanded',
                'false',
            );
            expect(await chartRect(page)).toEqual(expandedChart);
            await showReview(page);
            const proposal = page.getByRole('region', { name: 'Trial proposal' });
            await expect(proposal).toContainText('Thalassa proposal');
            await expect(page.getByRole('region', { name: 'What this route must say' })).toContainText(
                'Fixture warning 4',
            );
            const checks = page.getByRole('region', { name: 'Route chart checks' });
            await expect(checks).toBeVisible();
            await expect(checks.getByRole('list', { name: 'Proposal waypoints' }).locator('li')).toHaveCount(3);
            // The only cell in this fixture is reference-only. It must not
            // turn any of the real local grader's route segments green.
            await expect(checks.getByRole('status')).toContainText('incomplete');
            expect(
                await page.evaluate(
                    () => (window as unknown as { __trialFixture: { mapErrors: string[] } }).__trialFixture.mapErrors,
                ),
            ).toEqual([]);
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const map = (
                            window as unknown as {
                                __trialFixture: {
                                    map: {
                                        queryRenderedFeatures(options: {
                                            layers: string[];
                                        }): { properties: { number: number } }[];
                                    };
                                };
                            }
                        ).__trialFixture.map;
                        return [
                            ...new Set(
                                map
                                    .queryRenderedFeatures({ layers: ['trial-waypoint-labels'] })
                                    .map((f) => f.properties.number),
                            ),
                        ].sort();
                    }),
                )
                .toEqual([1, 2, 3]);
            expect(
                await page.evaluate(() => {
                    const map = (
                        window as unknown as {
                            __trialFixture: {
                                map: {
                                    getStyle(): {
                                        sources: Record<
                                            string,
                                            { data?: { features: { properties: { color: string } }[] } }
                                        >;
                                    };
                                };
                            };
                        }
                    ).__trialFixture.map;
                    return map.getStyle().sources['trial-review'].data!.features.map((f) => f.properties.color);
                }),
            ).not.toContain('#10b981');
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const fixture = (
                            window as unknown as {
                                __trialFixture: {
                                    mapsCreated: number;
                                    map: {
                                        isStyleLoaded: () => boolean;
                                        getStyle: () => {
                                            sources: {
                                                trial?: {
                                                    data?: {
                                                        features: Array<{
                                                            geometry: { type: string; coordinates: unknown[] };
                                                        }>;
                                                    };
                                                };
                                            };
                                        };
                                    };
                                };
                            }
                        ).__trialFixture;
                        // Dark and night themes reload the style; getStyle()
                        // throws "Style is not done loading" mid-reload, which
                        // failed the poll instead of letting it retry (CI
                        // 36511842433, WebKit 390 dark and 430 night).
                        if (!fixture.map.isStyleLoaded()) return null;
                        const features = fixture.map.getStyle().sources.trial?.data?.features || [];
                        return {
                            maps: fixture.mapsCreated,
                            points: features.filter((feature) => feature.geometry.type === 'Point').length,
                            routeVertices: features.find((feature) => feature.geometry.type === 'LineString')?.geometry
                                .coordinates.length,
                        };
                    }),
                )
                .toEqual({ maps: 1, points: 2, routeVertices: 3 });
            await fits(page, size.pane);
            await proposalFitsChart(page);
            await capture(page, info, 'trial-proposal');
            await showSetup(page);
            await calculate.scrollIntoViewIfNeeded();
            await hitVisible(calculate);
            if (size.pane) {
                await page.getByRole('button', { name: 'Companion action 0' }).click();
                await expect(page.getByRole('button', { name: 'Companion action 1' })).toBeVisible();
                await expect(dialog).toBeVisible();
            }
            await page.getByText('Enter coordinates', { exact: true }).click();
            const longitude = page.getByLabel('destination longitude', { exact: true });
            await longitude.focus();
            const keyboardHeight = size.pane ? 250 : 300;
            await page.evaluate(
                (height) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: height })),
                keyboardHeight,
            );
            await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', 'true');
            await longitude.scrollIntoViewIfNeeded();
            await hitVisible(longitude);
            const inputBox = await longitude.boundingBox();
            expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(size.height - keyboardHeight + 1);
            await fits(page, size.pane);
            await proposalFitsChart(page);
            await capture(page, info, 'trial-keyboard');
            await longitude.fill('153.25');
            await expect(proposal).toHaveCount(0);
            await longitude.blur();
            await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: 0 })));
            await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', 'false');
            await page.getByRole('button', { name: 'Clear', exact: true }).click();
            await expect(page.getByLabel('departure latitude', { exact: true })).toHaveValue('');
            await expect(calculate).toBeDisabled();
            await page.getByRole('button', { name: 'Close autorouting trial' }).click();
            await expect(dialog).toHaveCount(0);
            await slideToChoice(page);
            await choiceFits(page, size.pane);
            await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
            await expect(dialog).toBeVisible();
            await expect(proposal).toHaveCount(0);
            await expect(calculate).toBeDisabled();
            expect(
                await page.evaluate(() =>
                    (({ calculations, mapsCreated, mapsRemoved }) => ({ calculations, mapsCreated, mapsRemoved }))(
                        (
                            window as unknown as {
                                __trialFixture: { calculations: number; mapsCreated: number; mapsRemoved: number };
                            }
                        ).__trialFixture,
                    ),
                ),
            ).toEqual({ calculations: 1, mapsCreated: 2, mapsRemoved: 1 });
        });
    }

for (const status of ['disabled', 'failed']) {
    test(`Manual routing remains available when Auto status is ${status}`, async ({ page }) => {
        await openFixture(page, sizes[0], 'dark', status);
        await slideToChoice(page);
        const choice = page.getByRole('dialog', { name: 'Choose routing mode', exact: true });
        await expect(choice.getByRole('status')).not.toContainText('Checking');
        await expect(choice.getByRole('button', { name: 'Auto routing', exact: true })).toBeDisabled();
        await expect(choice.getByRole('button', { name: 'Manual routing', exact: true })).toBeEnabled();
        await choiceFits(page, false);
        await choice.getByRole('button', { name: 'Manual routing', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Manual routing selected', exact: true })).toBeVisible();
        expect(await fixtureCounts(page)).toEqual({
            statuses: 1,
            calculations: 0,
            manualSelections: 1,
            mapsCreated: 0,
            mapsRemoved: 0,
        });
    });
}

test('signed in with no charts, Auto opens its chart without calculating', async ({ page }) => {
    await openFixture(page, sizes[0], 'dark', 'unready');
    await slideToChoice(page);
    await expect(page.getByRole('dialog', { name: 'Choose routing mode', exact: true })).toContainText(
        'Install charts for your area to use Auto. Manual is ready.',
    );
    await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Autorouting trial', exact: true });
    await expect(dialog).toContainText('Install charts for your area to use Auto. Manual is ready.');
    await fits(page, false);
    const chart = page.getByRole('region', { name: /Trial chart/ });
    await setControlsExpanded(page, false);
    await chart.click({ position: { x: 100, y: 350 } });
    await chart.click({ position: { x: 150, y: 450 } });
    await setControlsExpanded(page, true);
    await expect(page.getByRole('button', { name: 'Calculate trial route', exact: true })).toBeDisabled();
    expect(await fixtureCounts(page)).toEqual({
        statuses: 2,
        calculations: 0,
        manualSelections: 0,
        mapsCreated: 1,
        mapsRemoved: 0,
    });
    await page.getByRole('button', { name: 'Close autorouting trial', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Slide to Start Plotting', exact: true })).toBeVisible();
});

/** Requests that must never leave this page, and the old server trial. */
function watchRequests(page: Page) {
    const trial: string[] = [];
    page.on('request', (request) => {
        if (request.url().includes('/functions/v1/autorouting-trial')) trial.push(request.url());
    });
    return trial;
}

async function enterPins(page: Page, from: [number, number], to: [number, number]) {
    await page.getByText('Enter coordinates', { exact: true }).click();
    for (const [name, value] of [
        ['departure latitude', String(from[1])],
        ['departure longitude', String(from[0])],
        ['destination latitude', String(to[1])],
        ['destination longitude', String(to[0])],
    ])
        await page.getByLabel(name, { exact: true }).fill(value);
    await page.getByLabel('destination longitude', { exact: true }).blur();
    await page.getByText('Enter coordinates', { exact: true }).click();
}

async function thalassaRouteFeatures(page: Page) {
    return page.evaluate(() => {
        const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
        const source = map.getStyle().sources['thalassa-route'] as mapboxgl.GeoJSONSourceSpecification | undefined;
        const data = source?.data as GeoJSON.FeatureCollection<GeoJSON.LineString> | undefined;
        return (data?.features ?? []).map((feature) => ({
            safety: feature.properties?.safety as string,
            points: feature.geometry.coordinates.length,
        }));
    });
}

// Thalassa's own router in the browser (2026-10-01), on a synthetic navigation
// cell near 161.0E, 31.0S (e2e/fixtures/autorouting-trial.tsx): a 10 m sea,
// an island and a bank charted 0–1 m. Every outside request is aborted by
// openFixture's route handler, so the OSM overlay, tides, markers, Mapbox
// water and the satellite land check fail fast; the route says so.
test('Real engine: two pins and Calculate draw a Thalassa route round the island', async ({ page }, info) => {
    test.setTimeout(150_000);
    const trial = watchRequests(page);
    await openFixture(page, sizes[0], 'dark', 'ready', 'engine=real');
    await slideToChoice(page);
    await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Autorouting trial', exact: true })).toBeVisible();
    await expect(page.getByText('Not for navigation. Unsaved proposal only.', { exact: true })).toBeVisible();
    await enterPins(page, [160.95, -31.0], [161.05, -31.0]);
    const calculate = page.getByRole('button', { name: 'Calculate trial route', exact: true });
    await expect(calculate).toBeEnabled();
    await calculate.click();
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toHaveAttribute(
        'aria-expanded',
        'false',
        { timeout: 120_000 },
    );
    await expect.poll(() => thalassaRouteFeatures(page)).not.toEqual([]);
    for (const { safety } of await thalassaRouteFeatures(page))
        expect(['danger', 'tide', 'survey', 'channel', 'offshore', 'green']).toContain(safety);
    // Round the island, never across it: the line is wholly outside it.
    const across = await page.evaluate(() => {
        const map = (window as unknown as MapFixtureWindow).__trialFixture.map;
        const source = map.getStyle().sources.trial as mapboxgl.GeoJSONSourceSpecification;
        const data = source.data as GeoJSON.FeatureCollection;
        const line = data.features.find((feature) => feature.geometry.type === 'LineString')!
            .geometry as GeoJSON.LineString;
        let inside = 0;
        const c = line.coordinates;
        for (let i = 0; i + 1 < c.length; i++)
            for (let k = 0; k < 50; k++) {
                const lon = c[i][0] + ((c[i + 1][0] - c[i][0]) * k) / 50;
                const lat = c[i][1] + ((c[i + 1][1] - c[i][1]) * k) / 50;
                if (lon > 160.9905 && lon < 161.0095 && lat > -31.0095 && lat < -30.9905) inside += 1;
            }
        return inside;
    });
    expect(across).toBe(0);
    await showReview(page);
    await expect(page.getByRole('region', { name: 'Trial proposal' })).toContainText('Thalassa proposal');
    await expect(page.getByRole('region', { name: 'What this route must say' })).toContainText(
        'Routed on this phone by Thalassa from your installed charts',
    );
    await expect(page.getByText('Chart checks complete · review required')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('region', { name: 'Save planned proposal' })).toBeVisible();
    await capture(page, info, 'real-engine-route');
    expect(trial).toEqual([]);
    expect(await fixtureCounts(page)).toMatchObject({ calculations: 1, mapsCreated: 1 });
});

test('Real engine: a pin on the island stops the route at the water, and says so', async ({ page }) => {
    test.setTimeout(150_000);
    const trial = watchRequests(page);
    await openFixture(page, sizes[0], 'dark', 'ready', 'engine=real');
    await slideToChoice(page);
    await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
    await enterPins(page, [160.95, -31.0], [161.0, -31.0]);
    await page.getByRole('button', { name: 'Calculate trial route', exact: true }).click();
    // Owner decision 7: a pin on land — the route stops at the water's edge
    // and the route's notes say so; it never runs onto the island.
    await expect(page.getByRole('button', { name: /^(Expand|Collapse) tracer panel$/ })).toHaveAttribute(
        'aria-expanded',
        'false',
        { timeout: 120_000 },
    );
    await showReview(page);
    await expect(page.getByRole('region', { name: 'What this route must say' })).toContainText(/charted land/);
    expect(trial).toEqual([]);
});

test('Real engine with no charts installed: Auto opens and Calculate stays disabled', async ({ page }) => {
    const trial = watchRequests(page);
    await openFixture(page, sizes[0], 'dark', 'ready', 'engine=real&charts=none');
    await slideToChoice(page);
    await expect(page.getByRole('dialog', { name: 'Choose routing mode', exact: true })).toContainText(
        'Install charts for your area to use Auto. Manual is ready.',
    );
    await page.getByRole('button', { name: 'Auto routing', exact: true }).click();
    await enterPins(page, [160.95, -31.0], [161.05, -31.0]);
    await expect(page.getByRole('button', { name: 'Calculate trial route', exact: true })).toBeDisabled();
    expect(trial).toEqual([]);
    expect((await fixtureCounts(page)).calculations).toBe(0);
});
