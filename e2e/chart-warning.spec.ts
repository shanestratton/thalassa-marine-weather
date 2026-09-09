import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

test.use({
    // Service-worker fetches bypass page routes; never let a live tide
    // response race the deterministic no-data or populated-tide fixture.
    serviceWorkers: 'block',
    storageState: async ({ baseURL }, provide) => {
        await provide({
            ...ONBOARDED_STORAGE,
            origins: ONBOARDED_STORAGE.origins.map((origin) => ({ ...origin, origin: new URL(baseURL!).origin })),
        });
    },
});

const EMPTY_ENC_NOTICE = 'No verified ENC charts installed. Library imports are reference-only.';
type TideFixture = 'none' | 'available';

async function openEmptyChart(page: Page, baseURL: string, testInfo: TestInfo, tideFixture?: TideFixture) {
    const origin = new URL(baseURL).origin;
    let tideResponses = 0;
    const tideAnchorSeconds = Math.floor(Date.now() / 1000);
    const errors: string[] = [];
    const styleRequests: string[] = [];
    const recordError = (message: string) => {
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
                    sources: {},
                    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0f2433' } }],
                }),
            });
        } else {
            await route.abort();
        }
    });
    await page.goto('/');
    const showNavigation = page.getByRole('button', { name: 'Show navigation', exact: true });
    const viewport = page.viewportSize()!;
    const shortLandscape = viewport.width > viewport.height && viewport.height < 500;
    if (shortLandscape) {
        // Orientation is detected after App mounts. A one-shot isVisible()
        // can miss the toggle during boot and wait forever for a hidden tab.
        await expect(showNavigation).toBeVisible();
        await showNavigation.click();
    }
    const charts = page.getByRole('tab', { name: /^Navigate to Charts/ });
    await charts.click();
    await expect(page.getByTestId('map-hub')).toBeVisible();
    // Keep landscape navigation open: verify the warning against the actual
    // fixed nav, not an empty bottom edge.
    await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
    await expect(charts).toHaveAttribute('aria-selected', 'true');
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

function expectSeparate(
    first: { x: number; y: number; width: number; height: number },
    second: { x: number; y: number; width: number; height: number },
    label: string,
) {
    const overlapWidth = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
    const overlapHeight = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
    expect(
        overlapWidth <= 0 || overlapHeight <= 0,
        `${label} overlaps the ENC warning: ${JSON.stringify({ warning: first, control: second })}`,
    ).toBe(true);
}

const cases: { width: number; height: number; mode: string; split?: boolean; tide?: TideFixture }[] = [
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
];

for (const size of cases) {
    test(`ENC warning clears controls at ${size.width}x${size.height} ${size.mode}${size.split ? ' split' : ''}${size.tide ? ` tide depth ${size.tide}` : ''}`, async ({
        page,
        baseURL,
    }, testInfo) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width: size.width, height: size.height });
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
        await openEmptyChart(page, baseURL!, testInfo, size.tide);

        const library = page.getByRole('button', { name: 'Open on-device ENC Library', exact: true });
        // Existing text/CTA identify the production warning too, so the old
        // compiled app fails on its collision rather than a newly added role.
        const warning = library.locator('..');
        async function expectControlsClear(stage: string) {
            await testInfo.attach(`enc-controls-geometry-${stage}`, {
                contentType: 'application/json',
                body: JSON.stringify(
                    await page.evaluate(() => {
                        const selectors = {
                            warning: '[aria-label="ENC coverage"]',
                            chart: '[data-testid="map-hub"]',
                            nav: 'nav[aria-label="Main"]',
                            back: 'button[aria-label="Back"]',
                            locate: 'button[aria-label="Locate me"]',
                            mob: 'button[aria-label="Open Man Overboard emergency"]',
                            layers: 'button[aria-label="Open layer menu"]',
                            tide: 'button[aria-label="Live tide depth is on — tap to return to chart datum"]',
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
            const nav = page.getByRole('navigation', { name: 'Main', exact: true });
            const navBox = await visibleBox(nav, page);
            expect(
                warningBox.y + warningBox.height,
                'the complete warning must clear the fixed navigation',
            ).toBeLessThanOrEqual(navBox.y);
            const chartBox = await visibleBox(page.getByTestId('map-hub'), page);
            expect(warningBox.x).toBeGreaterThanOrEqual(chartBox.x);
            expect(warningBox.y).toBeGreaterThanOrEqual(chartBox.y);
            expect(warningBox.x + warningBox.width).toBeLessThanOrEqual(chartBox.x + chartBox.width);
            expect(warningBox.y + warningBox.height).toBeLessThanOrEqual(chartBox.y + chartBox.height);
            if (size.split) await expect(page.locator('[data-split-pane="glass"]')).toBeVisible();

            const locate = page.getByRole('button', { name: 'Locate me', exact: true });
            const back = page.getByRole('button', { name: 'Back', exact: true });
            const mob = page.getByRole('button', { name: 'Open Man Overboard emergency', exact: true });
            const layers = page.getByRole('button', { name: 'Open layer menu', exact: true });
            const attribution = page.locator('.thalassa-chart-map .mapboxgl-ctrl-attrib');
            const scale = page.locator('.thalassa-chart-map .mapboxgl-ctrl-scale');
            const logo = page.locator('.thalassa-chart-map .mapboxgl-ctrl-logo');
            for (const [label, control] of [
                ['Locate', locate],
                ['Back', back],
                ['MOB', mob],
                ['Layers', layers],
                ['Mapbox attribution', attribution],
                ['map scale', scale],
                ['Mapbox logo', logo],
            ] as const) {
                expectSeparate(warningBox, await visibleBox(control, page), label);
            }
            if (size.tide) {
                const tideBadge = page.getByRole('button', {
                    name: 'Live tide depth is on — tap to return to chart datum',
                    exact: true,
                });
                expectSeparate(warningBox, await visibleBox(tideBadge, page), 'Live tide depth badge');
                await expectHitTarget(tideBadge);
                const tideScrubber = page.getByRole('slider', { name: 'Scrub the tide through the next 24 hours' });
                if (size.tide === 'available') {
                    // The labels/padding share the higher-z panel with the
                    // slider: its full box, not just the input, can block Library.
                    const tidePanel = tideScrubber.locator('..');
                    expectSeparate(warningBox, await visibleBox(tidePanel, page), 'Full tide scrubber panel');
                    await expectHitTarget(tideScrubber);
                } else {
                    await expect(tideScrubber).toHaveCount(0);
                }
            }
            for (const control of [library, locate, back, mob, layers, attribution, logo])
                await expectHitTarget(control);
            for (const tab of await nav.getByRole('tab').all()) {
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
        await page.getByRole('button', { name: /^Map base:/ }).click();
        await page.getByRole('menuitemradio', { name: /^Ocean / }).click();
        await expect(page.getByRole('button', { name: 'Map base: Ocean', exact: true })).toBeVisible();
        await expect(warning).toBeVisible();
        await expectControlsClear('after-ocean-selection');

        await library.click();
        await expect(page.getByRole('heading', { name: 'ENC Library', exact: true })).toBeVisible();
        await expect(page.getByText('No reference ENC cells are installed', { exact: true })).toBeVisible();
    });
}
