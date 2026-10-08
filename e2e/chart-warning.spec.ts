import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

test.use({
    // Service-worker fetches bypass page routes; never let a live tide
    // response race the deterministic no-data or populated-tide fixture.
    serviceWorkers: 'block',
    // The fixture style below is background-only, with no `composite` source,
    // so only an imagery base brings credits of its own: Relief and Ocean draw
    // the style's own sea, which the real dark-v11 always credits. Pin Hybrid
    // rather than ride the build's default (Relief + Sat, once its tiles are
    // served; Hybrid before).
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({
                ...origin,
                origin: new URL(baseURL!).origin,
                localStorage: origin.localStorage.map((entry) => {
                    if (
                        entry.name !== 'thalassa_settings_mirror::anonymous' &&
                        entry.name !== 'CapacitorStorage.thalassa_settings::anonymous'
                    )
                        return entry;
                    const saved = JSON.parse(entry.value);
                    saved.settings.obsChartBase = 'hybrid';
                    return { ...entry, value: JSON.stringify(saved) };
                }),
            })),
        });
    },
});

const EMPTY_ENC_NOTICE = 'No verified ENC charts installed. Library imports are reference-only.';
type TideFixture = 'none' | 'available';
/** A real long credit (Relief's, components/map/reliefBase.ts, as plain text):
 *  with the Anchorages credit it wraps the opened card to five lines in a
 *  1024x520 split pane and nine on a 320px phone. The fixture's own style
 *  carries it, so it shows whatever base the test picks. */
const LONG_CREDIT =
    'Seafloor relief derived from GEBCO Compilation Group (2026) GEBCO 2026 Grid; based on Great Barrier Reef ' +
    'Bathymetry 2020 30 m by Geoscience Australia, © Commonwealth of Australia, CC BY 4.0 (subject to its section 5 ' +
    'disclaimer of warranties); coastline © OpenStreetMap contributors. Not for navigation.';
/** A short credit the fixture style carries on its own, whatever the base (a
 *  made-up survey): it stands in for the credit the real dark-v11 always
 *  shows, so a base with no imagery still has a credit line of its own, and
 *  a stale line from the base before it can be told apart. */
const SEA_CREDIT = '© Fixture Sea Survey';

async function openEmptyChart(
    page: Page,
    baseURL: string,
    testInfo: TestInfo,
    tideFixture?: TideFixture,
    { longCredits = false, seaCredit = false }: { longCredits?: boolean; seaCredit?: boolean } = {},
) {
    const origin = new URL(baseURL).origin;
    let tideResponses = 0;
    const tideAnchorSeconds = Math.floor(Date.now() / 1000);
    const errors: string[] = [];
    const styleRequests: string[] = [];
    const glyphDiagnostics = { requests: [] as string[], errors: [] as string[] };
    const recordError = (message: string) => {
        if (message.includes('requires a style "glyphs" property')) glyphDiagnostics.errors.push(message);
        if (errors.length < 40)
            errors.push(message.replace(/([?&](?:access_token|token|key)=)[^&\s]+/g, '$1[redacted]'));
    };
    page.on('pageerror', (error) => recordError(error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') recordError(message.text());
    });
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/functions/v1/proxy-tides') {
            // Exercise the real WorldTides → TideHeightService →
            // TideOffsetService chain, including LAT and interpolation guards.
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    status: 200,
                    requestDatum: 'LAT',
                    responseDatum: 'LAT',
                    station: 'Sydney Harbour',
                    extremes:
                        tideFixture === 'available'
                            ? Array.from({ length: 9 }, (_, index) => ({
                                  dt: tideAnchorSeconds + (index * 6 - 12) * 3600,
                                  height: index % 2 === 0 ? 0.4 : 1.8,
                                  type: index % 2 === 0 ? 'Low' : 'High',
                              }))
                            : [],
                }),
            });
            tideResponses += 1;
        } else if (url.origin === origin) {
            await route.continue();
        } else if (url.hostname.endsWith('.mapbox.com') && /^\/styles\/v1\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
            styleRequests.push(url.pathname);
            // Keep the real Mapbox canvas, load event and native controls.
            // The empty style avoids live imagery/account requests; a fresh
            // anonymous browser has no licensed or reference ENC inventory.
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    version: 8,
                    // App-owned symbol layers require glyph metadata even
                    // when this background-only fixture has no label features.
                    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
                    // An empty source credits the map as soon as a visible
                    // layer uses it, like any real one.
                    sources: {
                        ...(longCredits
                            ? {
                                  'long-credit': {
                                      type: 'geojson',
                                      data: { type: 'FeatureCollection', features: [] },
                                      attribution: LONG_CREDIT,
                                  },
                              }
                            : {}),
                        ...(seaCredit
                            ? {
                                  'sea-credit': {
                                      type: 'geojson',
                                      data: { type: 'FeatureCollection', features: [] },
                                      attribution: SEA_CREDIT,
                                  },
                              }
                            : {}),
                    },
                    layers: [
                        { id: 'background', type: 'background', paint: { 'background-color': '#0f2433' } },
                        ...(longCredits
                            ? [{ id: 'long-credit', type: 'fill', source: 'long-credit', paint: { 'fill-opacity': 0 } }]
                            : []),
                        ...(seaCredit
                            ? [{ id: 'sea-credit', type: 'fill', source: 'sea-credit', paint: { 'fill-opacity': 0 } }]
                            : []),
                    ],
                }),
            });
        } else if (
            url.hostname.endsWith('.mapbox.com') &&
            /^\/fonts\/v1\/mapbox\/[^/]+\/[^/]+\.pbf$/.test(url.pathname)
        ) {
            glyphDiagnostics.requests.push(url.pathname);
            await route.fulfill({
                status: 200,
                contentType: 'application/x-protobuf',
                // Valid empty fontstack message: field 1, zero-length body.
                // Mapbox parses this as { glyphs: [] }; no live font request
                // is needed for the fixture's empty symbol sources.
                body: Buffer.from([0x0a, 0x00]),
            });
        } else {
            await route.abort();
        }
    });
    await page.goto('/');
    const showNavigation = page.getByRole('button', { name: /show navigation$/i });
    const viewport = page.viewportSize()!;
    const shortLandscape = viewport.width > viewport.height && viewport.height < 500;
    if (shortLandscape) {
        // Orientation is detected after App mounts. A one-shot isVisible()
        // can miss the toggle during boot and wait forever for a hidden tab.
        await expect(showNavigation).toBeVisible();
        await showNavigation.click();
    }
    const charts = page
        .getByRole('navigation', { name: 'Main', exact: true })
        .getByRole('button', { name: 'Obs', exact: true });
    await charts.click();
    await expect(page.getByTestId('map-hub')).toBeVisible();
    // Keep landscape navigation open: verify the warning against the actual
    // fixed nav, not an empty bottom edge.
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await expect(charts).toHaveAttribute('aria-current', 'page');
    // Browse charts start off on every fresh OBS (Release 119) and the
    // no-charts notice only shows while they are on: switch them on the way a
    // skipper does, from the map-base menu.
    await page.getByRole('button', { name: /^Map base:/ }).click();
    const encSwitch = page.getByRole('menuitemcheckbox', { name: /^ENC charts, / });
    await expect(encSwitch).toHaveAttribute('aria-checked', 'false');
    // The chart is its own stacking context, so the open menu paints UNDER the
    // tab bar: it must end above the bar and scroll inside, and its ENC row
    // must come fully into view there, whole and pressable. (On a 320px-tall
    // landscape phone the row starts below the menu's fold; whether it should
    // sit higher in the menu is a design call, not asserted here.)
    const menuBox = await visibleBox(page.getByRole('menu', { name: 'Map base' }), page);
    const menuNavBox = await visibleBox(page.getByRole('navigation', { name: 'Main', exact: true }), page);
    expect(menuBox.y + menuBox.height, 'the open map-base menu must end above the tab bar').toBeLessThanOrEqual(
        menuNavBox.y,
    );
    await encSwitch.scrollIntoViewIfNeeded();
    await expect(encSwitch).toBeInViewport({ ratio: 1 });
    await expectFullHitTarget(encSwitch, 'ENC charts switch in the map-base menu');
    await encSwitch.click();
    await expect(page.getByRole('menu', { name: 'Map base' })).toHaveCount(0);
    try {
        await expect(page.getByText(EMPTY_ENC_NOTICE, { exact: true })).toBeVisible();
    } catch (error) {
        const mapState = await page.evaluate(() => {
            const map = (
                window as unknown as {
                    __thalassaMap?: {
                        _loaded?: boolean;
                        loaded: () => boolean;
                        isStyleLoaded: () => boolean;
                        painter?: { context?: { gl?: { isContextLost: () => boolean } } };
                    };
                }
            ).__thalassaMap;
            if (!map) return { mapAvailable: false };
            return {
                mapAvailable: true,
                internalLoaded: map._loaded,
                loaded: map.loaded(),
                styleLoaded: map.isStyleLoaded(),
                contextLost: map.painter?.context?.gl?.isContextLost(),
            };
        });
        await testInfo.attach('map-load-diagnostics', {
            contentType: 'application/json',
            body: JSON.stringify({ errors, styleRequests, mapState }),
        });
        throw error;
    }
    if (tideFixture) {
        await expect.poll(() => tideResponses, 'the real tide service must consume the fixture API').toBeGreaterThan(0);
        const tideBadge = page.getByRole('button', {
            name: 'Live tide depth is on — tap to return to chart datum',
            exact: true,
        });
        const scrubber = page.getByRole('slider', { name: 'Scrub the tide through the next 24 hours' });
        if (tideFixture === 'available') {
            await expect(tideBadge).toContainText('Sydney Harbour');
            await expect(tideBadge).toContainText('approx');
            await expect(scrubber).toBeVisible();
        } else {
            await expect(tideBadge).toHaveText('LIVE DEPTH — no tide data, showing chart datum');
            await expect(scrubber).toHaveCount(0);
        }
    }
    await page.evaluate(() => document.fonts.ready);
    return glyphDiagnostics;
}

async function visibleBox(locator: Locator, page: Page) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;
    const geometry = JSON.stringify({ box, viewport });
    expect(box!.x, geometry).toBeGreaterThanOrEqual(-1);
    expect(box!.y, geometry).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width, geometry).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height, geometry).toBeLessThanOrEqual(viewport.height + 1);
    return box!;
}

async function expectHitTarget(locator: Locator) {
    await expect
        .poll(() =>
            locator.evaluate((element) => {
                const box = element.getBoundingClientRect();
                const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return hit === element || (hit !== null && element.contains(hit));
            }),
        )
        .toBe(true);
}

type Box = { x: number; y: number; width: number; height: number };

function boxesOverlap(first: Box, second: Box) {
    const overlapWidth = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
    const overlapHeight = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
    return overlapWidth > 0 && overlapHeight > 0;
}

function expectSeparate(first: Box, second: Box, label: string) {
    expect(
        boxesOverlap(first, second),
        `${label} overlaps the ENC warning: ${JSON.stringify({ warning: first, control: second })}`,
    ).toBe(false);
}

/** Full-box separation. A centre-point hit test alone passed a layer-key pill
 *  lying 2px over the top of the Mapbox wordmark at 320x568. */
function expectApart(first: Box, second: Box, label: string) {
    expect(boxesOverlap(first, second), `${label}: ${JSON.stringify({ first, second })}`).toBe(false);
}

/** A whole-control hit test: a 3x3 grid at 15/50/85% of the element's box
 *  (inside any rounded corner), clipped to what its scrolling ancestors show,
 *  must reach the element everywhere. A centre point alone passed a Hide
 *  button whose top-right quarter lay under the Mapbox scale bar. */
async function expectFullHitTarget(locator: Locator, label: string) {
    await expect
        .poll(
            () =>
                locator.evaluate((element) => {
                    let rect = element.getBoundingClientRect();
                    let left = rect.left;
                    let top = rect.top;
                    let right = rect.right;
                    let bottom = rect.bottom;
                    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                        const style = getComputedStyle(parent);
                        if (!/(auto|scroll|hidden|clip)/.test(style.overflowX + style.overflowY)) continue;
                        rect = parent.getBoundingClientRect();
                        left = Math.max(left, rect.left);
                        top = Math.max(top, rect.top);
                        right = Math.min(right, rect.right);
                        bottom = Math.min(bottom, rect.bottom);
                    }
                    if (right - left < 1 || bottom - top < 1) return ['clipped out of view'];
                    const misses: string[] = [];
                    for (const fx of [0.15, 0.5, 0.85])
                        for (const fy of [0.15, 0.5, 0.85]) {
                            const x = left + (right - left) * fx;
                            const y = top + (bottom - top) * fy;
                            const hit = document.elementFromPoint(x, y);
                            if (hit === element || (hit !== null && element.contains(hit))) continue;
                            const owner = hit?.closest('[aria-label]')?.getAttribute('aria-label');
                            misses.push(
                                `(${Math.round(x)},${Math.round(y)}) → ${owner ?? hit?.className?.toString() ?? 'nothing'}`,
                            );
                        }
                    return misses;
                }),
            { message: `${label} must be pressable across its whole box` },
        )
        .toEqual([]);
}

/** Where a passive map element shares pixels with an open surface, the open
 *  surface must be the one on top there (the element never paints over it). */
async function expectPaintsUnder(under: Locator, over: Locator, label: string) {
    await expect
        .poll(
            async () =>
                under.evaluate(
                    (element, overElement) => {
                        if (!overElement) return ['the open surface is gone'];
                        const a = element.getBoundingClientRect();
                        const b = overElement.getBoundingClientRect();
                        const left = Math.max(a.left, b.left);
                        const top = Math.max(a.top, b.top);
                        const right = Math.min(a.right, b.right);
                        const bottom = Math.min(a.bottom, b.bottom);
                        if (right - left < 1 || bottom - top < 1) return [];
                        const misses: string[] = [];
                        for (const fx of [0.1, 0.5, 0.9])
                            for (const fy of [0.1, 0.5, 0.9]) {
                                const hit = document.elementFromPoint(
                                    left + (right - left) * fx,
                                    top + (bottom - top) * fy,
                                );
                                if (!hit || !overElement.contains(hit))
                                    misses.push(hit?.closest('[aria-label]')?.getAttribute('aria-label') ?? 'other');
                            }
                        return misses;
                    },
                    await over.elementHandle(),
                ),
            { message: label },
        )
        .toEqual([]);
}

const cases: {
    width: number;
    height: number;
    mode: string;
    split?: boolean;
    tide?: TideFixture;
    wideFont?: boolean;
    /** A landscape phone with its tab bar folded away: the credits band drops to 60px. */
    navClosed?: boolean;
    /** The Anchorages layer on too: its 'Next 12 hours' chip joins the layer pill. */
    anchorages?: boolean;
    /** Zoom buttons pressed from where Obs opens (+in, -out): the scale bar's
     *  length and the credits change with the zoom, the furniture must not. */
    zoomSteps?: number;
    /** A long real credit on the chart (LONG_CREDIT): the opened card wraps
     *  to many lines and climbs. */
    longCredits?: boolean;
    /** Open Obs at this window size first, then resize to the case's: the
     *  chart re-lays its credits across the compact line, and Mapbox puts the
     *  new attribution BEFORE the scale bar in its DOM (on load it comes
     *  after), as a desktop resize, an iPad split, rotation or Stage Manager
     *  resize all do. */
    flipFrom?: { width: number; height: number };
}[] = [
    { width: 320, height: 568, mode: 'dark' },
    { width: 390, height: 844, mode: 'dark' },
    { width: 430, height: 932, mode: 'dark' },
    { width: 568, height: 320, mode: 'dark' },
    { width: 667, height: 375, mode: 'dark' },
    { width: 768, height: 768, mode: 'dark' },
    { width: 390, height: 844, mode: 'light' },
    { width: 390, height: 844, mode: 'night' },
    { width: 1024, height: 768, mode: 'dark', split: true },
    { width: 1024, height: 520, mode: 'dark', split: true },
    { width: 568, height: 320, mode: 'dark', tide: 'none' },
    { width: 667, height: 375, mode: 'dark', tide: 'none' },
    { width: 568, height: 320, mode: 'dark', tide: 'available' },
    { width: 667, height: 375, mode: 'dark', tide: 'available' },
    { width: 320, height: 568, mode: 'dark', tide: 'available' },
    // Fallback fonts differ between macOS, Linux and devices without cached
    // web fonts. Also exercise a wider installed fallback, including reflow
    // after mount; no text-size reduction or collision tolerance is allowed.
    { width: 320, height: 568, mode: 'dark', wideFont: true },
    { width: 667, height: 375, mode: 'dark', wideFont: true },
    { width: 568, height: 320, mode: 'dark', tide: 'available', wideFont: true },
    { width: 320, height: 568, mode: 'dark', tide: 'available', wideFont: true },
    // The landscape tab bar folded away: the credits (and the scale bar above
    // the ⓘ) come down to 60px, the layer pill and the notices with them.
    { width: 568, height: 320, mode: 'dark', navClosed: true },
    { width: 667, height: 375, mode: 'dark', navClosed: true },
    { width: 568, height: 320, mode: 'dark', tide: 'available', navClosed: true },
    { width: 667, height: 375, mode: 'dark', tide: 'available', navClosed: true },
    // The Anchorages layer brings the 'Next 12 hours' chip AND the layer pill.
    { width: 320, height: 568, mode: 'dark', anchorages: true },
    { width: 390, height: 844, mode: 'dark', anchorages: true },
    { width: 568, height: 320, mode: 'dark', tide: 'available', anchorages: true },
    { width: 667, height: 375, mode: 'dark', tide: 'available', navClosed: true, anchorages: true },
    { width: 1024, height: 520, mode: 'dark', split: true, anchorages: true },
    // A tablet prints Mapbox's full credit strip, always shown, running left
    // under the layer controls' corner: they must stand above its row.
    { width: 834, height: 1194, mode: 'dark', anchorages: true },
    // Obs opens on the location box at z10 (build 121), where the Anchorages
    // credit wraps the opened card to two lines; the furniture must hold at
    // other zooms (a shorter or longer scale bar, more or fewer credits) and
    // under credits many lines long.
    { width: 320, height: 568, mode: 'dark', anchorages: true, zoomSteps: 1 },
    { width: 1024, height: 520, mode: 'dark', split: true, anchorages: true, zoomSteps: -2 },
    { width: 320, height: 568, mode: 'dark', anchorages: true, longCredits: true },
    { width: 1024, height: 520, mode: 'dark', split: true, anchorages: true, longCredits: true },
    { width: 667, height: 375, mode: 'dark', tide: 'available', navClosed: true, anchorages: true, longCredits: true },
    // A landscape phone sets MOB beside the layers button: the opened card
    // must stop left of both, tab bar open or folded.
    { width: 568, height: 320, mode: 'dark', tide: 'available', anchorages: true, longCredits: true },
    { width: 568, height: 320, mode: 'dark', navClosed: true, anchorages: true, longCredits: true },
    // Re-laid at runtime (the strip of a roomy window to the compact ⓘ):
    // the scale bar must not paint over the opened card or its ⓘ.
    {
        width: 600,
        height: 800,
        mode: 'dark',
        anchorages: true,
        longCredits: true,
        flipFrom: { width: 1280, height: 800 },
    },
];

for (const size of cases) {
    test(`ENC warning clears controls at ${size.width}x${size.height} ${size.mode}${size.split ? ' split' : ''}${size.tide ? ` tide depth ${size.tide}` : ''}${size.wideFont ? ' wide fallback font' : ''}${size.navClosed ? ' nav closed' : ''}${size.anchorages ? ' anchorages' : ''}${size.zoomSteps ? ` zoom ${size.zoomSteps > 0 ? '+' : ''}${size.zoomSteps}` : ''}${size.longCredits ? ' long credits' : ''}${size.flipFrom ? ` from ${size.flipFrom.width}x${size.flipFrom.height}` : ''}`, async ({
        page,
        baseURL,
    }, testInfo) => {
        test.setTimeout(90_000);
        await page.setViewportSize(size.flipFrom ?? { width: size.width, height: size.height });
        await page.addInitScript(
            ({ mode, split, tideDepth }) => {
                for (const key of [
                    'thalassa_settings_mirror::anonymous',
                    'CapacitorStorage.thalassa_settings::anonymous',
                ]) {
                    const value = localStorage.getItem(key);
                    if (!value) continue;
                    const saved = JSON.parse(value);
                    saved.settings.displayMode = mode;
                    localStorage.setItem(key, JSON.stringify(saved));
                }
                if (split) localStorage.setItem('thalassa_split_view', '1');
                if (tideDepth) localStorage.setItem('thalassa_tide_depth_mode', 'true');
            },
            { mode: size.mode, split: size.split === true, tideDepth: size.tide !== undefined },
        );
        const glyphDiagnostics = await openEmptyChart(page, baseURL!, testInfo, size.tide, {
            longCredits: size.longCredits,
        });
        if (size.flipFrom) {
            const chartMap = page.locator('.thalassa-chart-map');
            await expect(chartMap).toHaveAttribute('data-attribution-layout', 'strip');
            await page.setViewportSize({ width: size.width, height: size.height });
            await expect(chartMap).toHaveAttribute('data-attribution-layout', 'compact');
            // The case is only worth its run if the order really flipped.
            const order = await chartMap
                .locator('.mapboxgl-ctrl-bottom-right')
                .evaluate((corner) =>
                    [...corner.children].flatMap((child) =>
                        child.classList.contains('mapboxgl-ctrl-attrib')
                            ? ['attribution']
                            : child.classList.contains('mapboxgl-ctrl-scale')
                              ? ['scale']
                              : [],
                    ),
                );
            expect(order, 'Mapbox re-adds the attribution first in its corner').toEqual(['attribution', 'scale']);
        }
        if (size.zoomSteps) {
            // As a skipper does: the zoom buttons, one step at a time.
            const readout = page.getByRole('img', { name: /^Zoom \d+\.\d$/ });
            let zoom = Number((await readout.getAttribute('aria-label'))!.replace('Zoom ', ''));
            const button = page.getByRole('button', { name: size.zoomSteps > 0 ? 'Zoom in' : 'Zoom out', exact: true });
            for (let step = 0; step < Math.abs(size.zoomSteps); step++) {
                await button.click();
                zoom += Math.sign(size.zoomSteps);
                await expect(page.getByRole('img', { name: `Zoom ${zoom.toFixed(1)}`, exact: true })).toBeVisible();
            }
        }
        if (size.wideFont) {
            await page.addStyleTag({ content: ':root { --font-sans: Verdana, sans-serif; }' });
            await page.evaluate(() => document.fonts.ready);
        }
        const anchorageChip = page.getByRole('button', {
            name: 'Compare anchorages for the next 12 hours',
            exact: true,
        });
        if (size.anchorages) {
            // As a skipper does: layer menu → Sea → Anchorages.
            await page.getByRole('button', { name: 'Open layer menu', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Sea layers' }).click();
            await page.getByRole('menuitemcheckbox', { name: 'Anchorages, off' }).click();
            await expect(page.getByRole('menuitemcheckbox', { name: 'Anchorages, on' })).toBeVisible();
            const closeLayerMenu = page.getByRole('button', { name: 'Close layer menu', exact: true });
            await expect(async () => {
                if (await closeLayerMenu.count()) await page.keyboard.press('Escape');
                await expect(closeLayerMenu).toHaveCount(0, { timeout: 1_000 });
            }).toPass();
            await expect(anchorageChip).toBeVisible();
        } else {
            await expect(anchorageChip).toHaveCount(0);
        }
        if (size.navClosed) {
            await page.getByRole('button', { name: 'Hide navigation', exact: true }).click();
            await expect(page.getByRole('button', { name: /show navigation$/i })).toBeVisible();
            await expect(page.getByRole('navigation', { name: 'Navigation toggle', exact: true })).toHaveCount(0);
        }
        await testInfo.attach('enc-warning-text-metrics', {
            contentType: 'application/json',
            body: JSON.stringify(
                await page.evaluate(() =>
                    Object.fromEntries(
                        [
                            '[aria-label="ENC coverage"]',
                            '[aria-label="ENC coverage"] > span',
                            '[aria-label="Open on-device ENC Library"]',
                        ].map((selector) => {
                            const element = document.querySelector(selector);
                            if (!element) return [selector, null];
                            const style = getComputedStyle(element);
                            return [
                                selector,
                                {
                                    box: element.getBoundingClientRect().toJSON(),
                                    fontFamily: style.fontFamily,
                                    fontSize: style.fontSize,
                                    lineHeight: style.lineHeight,
                                    letterSpacing: style.letterSpacing,
                                },
                            ];
                        }),
                    ),
                ),
            ),
        });

        const library = page.getByRole('button', { name: 'Open on-device ENC Library', exact: true });
        // Existing text/CTA identify the production warning too, so the old
        // compiled app fails on its collision rather than a newly added role.
        const warning = library.locator('..');
        const nav = page.getByRole('navigation', { name: 'Main', exact: true });
        // Folded away, the landscape tab bar is just its bottom-left toggle
        // (its own <nav>, still named 'Main').
        const navToggle = page.getByRole('button', { name: /show navigation$/i });
        const locate = page.getByRole('button', { name: 'Locate me', exact: true });
        // The chart's Back chevron went in Release 118; the one-handed zoom
        // buttons now share the lower rail with Locate (UX scorecard run 7).
        const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true });
        const zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
        const mob = page.getByRole('button', { name: 'MOB, open Man Overboard emergency', exact: true });
        const layers = page.getByRole('button', { name: 'Open layer menu', exact: true });
        // Any chart layer (ENC alone here) brings the collapsed layer-key pill
        // to the bottom-left, the Mapbox wordmark's corner.
        const layerKey = page.getByRole('button', { name: 'Show layer controls', exact: true });
        const attribution = page.locator('.thalassa-chart-map .mapboxgl-ctrl-attrib');
        const creditsToggle = attribution.getByRole('button', { name: 'Toggle attribution', exact: true });
        const scale = page.locator('.thalassa-chart-map .mapboxgl-ctrl-scale');
        const logo = page.locator('.thalassa-chart-map .mapboxgl-ctrl-logo');
        const compactCredits = async () => /\bmapboxgl-compact\b/.test((await attribution.getAttribute('class')) ?? '');
        async function expectControlsClear(stage: string) {
            await testInfo.attach(`enc-controls-geometry-${stage}`, {
                contentType: 'application/json',
                body: JSON.stringify(
                    await page.evaluate(() => {
                        const selectors = {
                            warning: '[aria-label="ENC coverage"]',
                            chart: '[data-testid="map-hub"]',
                            nav: 'nav[aria-label="Main"]',
                            zoomIn: 'button[aria-label="Zoom in"]',
                            zoomOut: 'button[aria-label="Zoom out"]',
                            locate: 'button[aria-label="Locate me"]',
                            mob: 'button[aria-label="MOB, open Man Overboard emergency"]',
                            layers: 'button[aria-label="Open layer menu"]',
                            tide: 'button[aria-label="Live tide depth is on — tap to return to chart datum"]',
                            layerKey: 'button[aria-label="Show layer controls"]',
                            anchorageChip: 'button[aria-label="Compare anchorages for the next 12 hours"]',
                            logo: '.thalassa-chart-map .mapboxgl-ctrl-logo',
                            attribution: '.thalassa-chart-map .mapboxgl-ctrl-attrib',
                            scale: '.thalassa-chart-map .mapboxgl-ctrl-scale',
                        };
                        return Object.fromEntries(
                            Object.entries(selectors).map(([name, selector]) => [
                                name,
                                document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null,
                            ]),
                        );
                    }),
                ),
            });
            const warningBox = await visibleBox(warning, page);
            if (size.navClosed) {
                expectSeparate(warningBox, await visibleBox(navToggle, page), 'Navigation toggle');
            } else {
                const navBox = await visibleBox(nav, page);
                expect(
                    warningBox.y + warningBox.height,
                    'the complete warning must clear the fixed navigation',
                ).toBeLessThanOrEqual(navBox.y);
            }
            const chartBox = await visibleBox(page.getByTestId('map-hub'), page);
            expect(warningBox.x).toBeGreaterThanOrEqual(chartBox.x);
            expect(warningBox.y).toBeGreaterThanOrEqual(chartBox.y);
            expect(warningBox.x + warningBox.width).toBeLessThanOrEqual(chartBox.x + chartBox.width);
            expect(warningBox.y + warningBox.height).toBeLessThanOrEqual(chartBox.y + chartBox.height);
            if (size.split) await expect(page.locator('[data-split-pane="glass"]')).toBeVisible();

            const boxes: Record<string, Box> = {};
            for (const [label, control] of [
                ['Locate', locate],
                ['Zoom in', zoomIn],
                ['Zoom out', zoomOut],
                ['MOB', mob],
                ['Layers', layers],
                ['Mapbox attribution', attribution],
                ['map scale', scale],
                ['Mapbox logo', logo],
                ['Layer key pill', layerKey],
                ...(size.anchorages ? ([['Anchorage chip', anchorageChip]] as const) : []),
                ...(size.navClosed ? ([['Navigation toggle', navToggle]] as const) : []),
            ] as const) {
                boxes[label] = await visibleBox(control, page);
                if (label !== 'Navigation toggle') expectSeparate(warningBox, boxes[label], label);
            }
            // The pill and the chip are controls in their own right: whole
            // boxes, not centres, against the licence credits and every other
            // chart control, and each other.
            const neighbours = [
                'Locate',
                'Zoom in',
                'Zoom out',
                'MOB',
                'Layers',
                'Mapbox attribution',
                'map scale',
                'Mapbox logo',
                ...(size.navClosed ? ['Navigation toggle'] : []),
            ];
            for (const label of neighbours)
                expectApart(boxes['Layer key pill'], boxes[label], `Layer key pill overlaps ${label}`);
            expect(boxes['Layer key pill'].width).toBeGreaterThanOrEqual(44);
            expect(boxes['Layer key pill'].height).toBeGreaterThanOrEqual(44);
            if (size.anchorages) {
                for (const label of [...neighbours, 'Layer key pill'])
                    expectApart(boxes['Anchorage chip'], boxes[label], `Anchorage chip overlaps ${label}`);
                expect(boxes['Anchorage chip'].width).toBeGreaterThanOrEqual(44);
                expect(boxes['Anchorage chip'].height).toBeGreaterThanOrEqual(44);
            }
            // Mapbox's full strip (a roomy map) is always shown and runs left as
            // far as its text: the chart's own controls stand above its row.
            if (!(await compactCredits())) {
                for (const label of ['Layer key pill', ...(size.anchorages ? ['Anchorage chip'] : [])])
                    expect(
                        boxes[label].y + boxes[label].height,
                        `${label} must stand above Mapbox's credit strip`,
                    ).toBeLessThanOrEqual(boxes['Mapbox attribution'].y);
            }
            // Folded on a landscape phone the pill sits beside Mapbox's ⓘ on the
            // credits row: it carries the app's layers glyph, never an ⓘ, and
            // says what it opens.
            await expect(layerKey.locator('svg[data-glyph="layers"]')).toBeVisible();
            await expect(layerKey).not.toContainText('ⓘ');
            await expect(layerKey).toHaveAccessibleDescription(/layer/i);
            if (size.tide) {
                const tideBadge = page.getByRole('button', {
                    name: 'Live tide depth is on — tap to return to chart datum',
                    exact: true,
                });
                const tideBadgeBox = await visibleBox(tideBadge, page);
                expectSeparate(warningBox, tideBadgeBox, 'Live tide depth badge');
                expectApart(boxes['Layer key pill'], tideBadgeBox, 'Layer key pill overlaps the live tide badge');
                if (size.anchorages)
                    expectApart(boxes['Anchorage chip'], tideBadgeBox, 'Anchorage chip overlaps the live tide badge');
                await expectHitTarget(tideBadge);
                const tideScrubber = page.getByRole('slider', { name: 'Scrub the tide through the next 24 hours' });
                if (size.tide === 'available') {
                    // The labels/padding share the higher-z panel with the
                    // slider: its full box, not just the input, can block Library.
                    const tidePanel = tideScrubber.locator('..');
                    const tidePanelBox = await visibleBox(tidePanel, page);
                    expectSeparate(warningBox, tidePanelBox, 'Full tide scrubber panel');
                    expectApart(boxes['Layer key pill'], tidePanelBox, 'Layer key pill overlaps the tide scrubber');
                    if (size.anchorages)
                        expectApart(boxes['Anchorage chip'], tidePanelBox, 'Anchorage chip overlaps the tide scrubber');
                    await expectHitTarget(tideScrubber);
                } else {
                    await expect(tideScrubber).toHaveCount(0);
                }
            }
            for (const control of [locate, zoomIn, zoomOut, mob, layers, attribution]) await expectHitTarget(control);
            await expectFullHitTarget(library, 'ENC Library button');
            await expectFullHitTarget(logo, 'Mapbox logo');
            await expectFullHitTarget(layerKey, 'Layer key pill');
            if (size.anchorages) await expectFullHitTarget(anchorageChip, 'Anchorage chip');
            for (const tab of await nav.getByRole('button').all()) {
                await visibleBox(tab, page);
                await expectHitTarget(tab);
            }
            // Mapbox's scale is not interactive. Geometry guards it without
            // incorrectly requiring it to intercept pointer events.
            await expect(library).toBeEnabled();
            await library.click({ trial: true });
            await expect(warning).toHaveAttribute('role', 'status');
            await expect(warning).toHaveAttribute('aria-label', 'ENC coverage');
            await testInfo.attach(`enc-warning-layout-${stage}`, {
                body: await page.screenshot(),
                contentType: 'image/png',
            });
        }
        await expectControlsClear('initial');

        // Opening a picker intentionally overlays map information; the
        // coverage warning must not intercept its options as it loads.
        // Hybrid: on the fixture's empty style only imagery carries credits, and
        // Hybrid is the one imagery base since the old Satellite went (125-13a).
        await page.getByRole('button', { name: /^Map base:/ }).click();
        await page.getByRole('menuitemradio', { name: /^Hybrid / }).click();
        await expect(page.getByRole('button', { name: 'Map base: Hybrid', exact: true })).toBeVisible();
        await expect(warning).toBeVisible();
        await expectControlsClear('after-base-selection');

        // Opened, the credits run left along the chart, over whatever passive
        // furniture shares their row: nothing may lie on any part of them.
        if (await compactCredits()) {
            await creditsToggle.click();
            await expect(creditsToggle).toHaveAttribute('aria-expanded', 'true');
            if (size.longCredits) await expect(attribution).toContainText(LONG_CREDIT);
            await expectFullHitTarget(attribution, 'Opened Mapbox credits');
            // However many lines the card wraps to, its ⓘ (at the card's top
            // right) stays pressable to close it, and the card stays off the
            // right-hand rail: never under the helm, never over MOB or Locate.
            await expectFullHitTarget(creditsToggle, 'Mapbox credits toggle with the credits open');
            const openedCredits = await visibleBox(attribution, page);
            for (const [label, control] of [
                ['MOB', mob],
                ['Layers', layers],
                ['Locate', locate],
            ] as const)
                expectApart(openedCredits, await visibleBox(control, page), `Opened Mapbox credits overlap ${label}`);
            // The ruler never draws across the card, whichever comes first in
            // Mapbox's DOM, and is never left part-covered beside it (a
            // shortened bar under a full-length label).
            await expectPaintsUnder(scale, attribution, 'the Mapbox scale bar paints over the opened credits');
            if (await scale.isVisible())
                expectApart(
                    openedCredits,
                    (await scale.boundingBox())!,
                    'the opened credits cover part of the scale bar',
                );
            await expectFullHitTarget(logo, 'Mapbox logo beside the opened credits');
            await testInfo.attach('enc-warning-layout-credits-open', {
                body: await page.screenshot(),
                contentType: 'image/png',
            });
            await creditsToggle.click();
            await expect(creditsToggle).toHaveAttribute('aria-expanded', 'false');
        } else {
            await expectFullHitTarget(attribution, "Mapbox's credit strip");
        }

        // Opened, the layer panel may cover passive chart information (the
        // warning, the tide readouts, the ruler), but never a licence credit,
        // MOB, Locate or the zoom and layer controls, and never the tab bar;
        // and nothing may lie on any part of the panel's own controls.
        await layerKey.click();
        const layerPanel = page.getByRole('region', { name: 'Chart layer controls', exact: true });
        await expect(layerPanel).toBeVisible();
        const hideLayerPanel = page.getByRole('button', { name: 'Hide layer controls', exact: true });
        // Keyboard focus inside holds the panel's idle auto-hide for the checks.
        await hideLayerPanel.focus();
        const panelBox = await visibleBox(layerPanel, page);
        if (size.navClosed) {
            expectApart(panelBox, await visibleBox(navToggle, page), 'Open layer panel overlaps the navigation toggle');
        } else {
            const panelNav = await visibleBox(nav, page);
            expect(panelBox.y + panelBox.height, 'the open panel must clear the tab bar').toBeLessThanOrEqual(
                panelNav.y,
            );
        }
        const panelChart = await visibleBox(page.getByTestId('map-hub'), page);
        expect(panelBox.x).toBeGreaterThanOrEqual(panelChart.x);
        expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(panelChart.x + panelChart.width);
        for (const [label, control] of [
            ['Locate', locate],
            ['Zoom in', zoomIn],
            ['Zoom out', zoomOut],
            ['MOB', mob],
            ['Layers', layers],
            ['Mapbox attribution', attribution],
            ['Mapbox logo', logo],
        ] as const) {
            const box = await visibleBox(control, page);
            expectApart(panelBox, box, `Open layer panel overlaps ${label}`);
            if (label === 'Mapbox attribution' && !(await compactCredits()))
                expect(
                    panelBox.y + panelBox.height,
                    "the open panel must stand above Mapbox's credit strip",
                ).toBeLessThanOrEqual(box.y);
            await expectHitTarget(control);
        }
        await expectFullHitTarget(logo, 'Mapbox logo beside the open panel');
        const panelControls = layerPanel.locator('button, input, select, a[href], [role="slider"]');
        async function expectPanelControlsWhole(when: string) {
            await expectFullHitTarget(hideLayerPanel, `Hide layer controls${when}`);
            for (const control of await panelControls.all()) {
                if (!(await control.isVisible())) continue;
                const name =
                    (await control.getAttribute('aria-label')) ?? (await control.innerText()).trim().slice(0, 40);
                await expectFullHitTarget(control, `Open layer panel control '${name}'${when}`);
            }
            // The ruler (and, opened, the credits) never paint over the panel.
            await expectPaintsUnder(scale, layerPanel, `the Mapbox scale bar paints over the open layer panel${when}`);
            await expectPaintsUnder(attribution, layerPanel, `Mapbox's credits paint over the open layer panel${when}`);
        }
        await expectPanelControlsWhole('');
        if (await compactCredits()) {
            // Credits opened while the panel is up stay under the panel.
            await creditsToggle.click();
            await expect(creditsToggle).toHaveAttribute('aria-expanded', 'true');
            // A key press inside holds the panel again after that tap outside.
            await hideLayerPanel.press('Shift');
            await expectPanelControlsWhole(' with the credits open');
            await testInfo.attach('enc-warning-layout-layer-panel-and-credits-open', {
                body: await page.screenshot(),
                contentType: 'image/png',
            });
            await creditsToggle.click();
            await expect(creditsToggle).toHaveAttribute('aria-expanded', 'false');
            await hideLayerPanel.press('Shift');
        }
        await expect(hideLayerPanel).toBeFocused();
        await testInfo.attach('enc-warning-layout-layer-panel-open', {
            body: await page.screenshot(),
            contentType: 'image/png',
        });
        await hideLayerPanel.click();
        await expect(layerPanel).toHaveCount(0);
        await expectFullHitTarget(layerKey, 'Layer key pill after the panel closes');
        await expectFullHitTarget(library, 'ENC Library button after the panel closes');

        if (size.anchorages) {
            // The chip's sheet is modal: its backdrop, not a Mapbox credit,
            // takes a tap anywhere outside the card — even with the credits
            // opened before it (the chip is then reached by keyboard).
            const sheet = page.getByRole('dialog', { name: /Where to stop/ });
            const expectSheetOverCredits = async (when: string) => {
                await expect(sheet).toBeVisible();
                await expectPaintsUnder(logo, sheet, `the Mapbox logo shows through the anchorage sheet${when}`);
                await expectPaintsUnder(attribution, sheet, `Mapbox's credits show through the anchorage sheet${when}`);
                await sheet.getByRole('button', { name: 'Close', exact: true }).click();
                await expect(sheet).toHaveCount(0);
            };
            await anchorageChip.click();
            await expectSheetOverCredits('');
            if (await compactCredits()) {
                await creditsToggle.click();
                await expect(creditsToggle).toHaveAttribute('aria-expanded', 'true');
                await anchorageChip.focus();
                await page.keyboard.press('Enter');
                await expectSheetOverCredits(' with the credits open');
                await creditsToggle.click();
                await expect(creditsToggle).toHaveAttribute('aria-expanded', 'false');
            }
        }

        await library.click();
        await expect(page.getByRole('heading', { name: 'ENC Library', exact: true })).toBeVisible();
        await expect(page.getByText('No reference ENC cells are installed', { exact: true })).toBeVisible();
        await testInfo.attach('glyph-fixture-diagnostics', {
            contentType: 'application/json',
            body: JSON.stringify(glyphDiagnostics),
        });
        expect(glyphDiagnostics.errors, 'the fixture must support app-owned text symbol layers').toEqual([]);
    });
}

for (const size of [
    { width: 390, height: 844, split: false },
    // The important regression: a half-pane wider than Mapbox's own 640px
    // breakpoint must still use the native compact control, not a grey strip.
    { width: 1500, height: 1000, split: true },
]) {
    test(`native map attribution stays compact and reopenable at ${size.width}x${size.height}${size.split ? ' split' : ''}`, async ({
        page,
        baseURL,
    }, testInfo) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.addInitScript((split) => {
            localStorage.setItem('thalassa_split_view', split ? '1' : '0');
            for (const key of [
                'thalassa_settings_mirror::anonymous',
                'CapacitorStorage.thalassa_settings::anonymous',
            ]) {
                const value = localStorage.getItem(key);
                if (!value) continue;
                const saved = JSON.parse(value);
                saved.settings.displayMode = 'dark';
                localStorage.setItem(key, JSON.stringify(saved));
            }
        }, size.split);
        await openEmptyChart(page, baseURL!, testInfo, undefined, { seaCredit: true });
        const chart = page.locator('.thalassa-chart-map');
        const attribution = chart.locator('.mapboxgl-ctrl-attrib');
        const toggle = attribution.getByRole('button', { name: 'Toggle attribution', exact: true });
        const credits = attribution.locator('.mapboxgl-ctrl-attrib-inner');
        const logo = chart.locator('.mapboxgl-ctrl-logo');
        const chartBox = (await chart.boundingBox())!;
        if (size.split) {
            await expect(page.locator('[data-split-pane="glass"]')).toBeVisible();
            await expect(page.locator('[data-split-pane="chart"]')).toBeVisible();
            expect(chartBox.width).toBeGreaterThan(640);
            expect(chartBox.width).toBeLessThan(960);
        }
        await expect(attribution).toHaveCount(1);
        await expect(attribution).toHaveClass(/mapboxgl-compact/);
        await expect(attribution).not.toHaveClass(/mapboxgl-compact-show/);
        await expect(credits).not.toBeVisible();
        const toggleBox = await visibleBox(toggle, page);
        await expectFullHitTarget(toggle, 'Mapbox attribution toggle');
        const logoBox = await visibleBox(logo, page);
        await expectFullHitTarget(logo, 'Mapbox logo');
        // The chart's own bottom-left layer key shares the wordmark's corner.
        const layerKey = page.getByRole('button', { name: 'Show layer controls', exact: true });
        const layerKeyBox = await visibleBox(layerKey, page);
        expectApart(layerKeyBox, logoBox, 'Layer key pill overlaps the Mapbox logo');
        expectApart(layerKeyBox, toggleBox, 'Layer key pill overlaps the attribution toggle');
        await expectFullHitTarget(layerKey, 'Layer key pill');
        await page.screenshot({ path: testInfo.outputPath('native-attribution-collapsed.png') });

        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(credits).toBeVisible();
        await expect(credits).toContainText('Mapbox');
        await expect(credits.getByRole('link', { name: 'Mapbox', exact: true }).first()).toBeVisible();
        const expandedBox = await visibleBox(attribution, page);
        expect(expandedBox.x).toBeGreaterThanOrEqual(chartBox.x - 1);
        expect(expandedBox.x + expandedBox.width).toBeLessThanOrEqual(chartBox.x + chartBox.width + 1);
        // Opened, the credits run left along the chart; the pill stays below
        // them, and nothing lies on any part of them.
        expectApart(expandedBox, await visibleBox(layerKey, page), 'Opened Mapbox credits overlap the layer key pill');
        await expectFullHitTarget(attribution, 'Opened Mapbox credits');
        await expectFullHitTarget(layerKey, 'Layer key pill beside the opened credits');
        await page.screenshot({ path: testInfo.outputPath('native-attribution-expanded.png') });

        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(credits).not.toBeVisible();
        // Native source-change handling must survive the custom compact mode:
        // from the pinned Hybrid to Ocean is a real source change (the old
        // Satellite base this used to switch to went in 125-13a), and
        // Hybrid's imagery and OpenStreetMap credits must go with it. Ocean
        // draws only the style's own sea here, whose credit (SEA_CREDIT, as
        // dark-v11's own would) stays; then back to Hybrid, whose credits
        // must return.
        await expect(credits).toContainText(SEA_CREDIT);
        await expect(credits).toContainText('Maxar');
        await expect(credits).toContainText('OpenStreetMap');
        await page.getByRole('button', { name: /^Map base:/ }).click();
        await page.getByRole('menuitemradio', { name: /^Ocean / }).click();
        await expect(page.getByRole('button', { name: 'Map base: Ocean', exact: true })).toBeVisible();
        await expect(attribution).toHaveCount(1);
        await expect(attribution).toHaveClass(/mapboxgl-compact/);
        await toggle.click();
        await expect(credits).toBeVisible();
        await expect(credits).toContainText(SEA_CREDIT);
        await expect(credits).not.toContainText('Maxar');
        await expect(credits).not.toContainText('OpenStreetMap');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await page.getByRole('button', { name: /^Map base:/ }).click();
        await page.getByRole('menuitemradio', { name: /^Hybrid / }).click();
        await expect(page.getByRole('button', { name: 'Map base: Hybrid', exact: true })).toBeVisible();
        await expect(attribution).toHaveCount(1);
        await expect(attribution).toHaveClass(/mapboxgl-compact/);
        await toggle.click();
        await expect(credits).toBeVisible();
        await expect(credits).toContainText('Maxar');
        await expect(credits).toContainText('OpenStreetMap');
        await expectFullHitTarget(toggle, 'Mapbox attribution toggle');
        await expectFullHitTarget(attribution, 'Opened Mapbox credits');
        await expectFullHitTarget(logo, 'Mapbox logo');
    });
}
