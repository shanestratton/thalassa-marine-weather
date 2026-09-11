import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

const sizes = [
    { width: 390, height: 844, pane: false },
    { width: 430, height: 932, pane: false },
    { width: 1024, height: 768, pane: true },
];
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
async function fits(page: Page, pane: boolean) {
    const dialog = page.getByRole('dialog', { name: 'Autorouting trial' });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    const frame = pane ? await page.getByTestId('trial-pane').boundingBox() : { x: 0, y: 0, ...page.viewportSize()! };
    expect(Math.abs(box!.x - frame!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.width - frame!.width)).toBeLessThanOrEqual(1);
    const chart = await page.getByRole('region', { name: /Trial chart/ }).boundingBox();
    expect(chart!.height).toBeGreaterThanOrEqual(100);
    expect(chart!.y).toBeGreaterThanOrEqual(box!.y);
    expect(chart!.y + chart!.height).toBeLessThanOrEqual(box!.y + box!.height + 1);
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
    expect(await dialog.evaluate((node) => node.scrollTop)).toBe(0);
}
async function capture(page: Page, info: TestInfo, name: string) {
    const path = info.outputPath(`${name}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await info.attach(name, { path, contentType: 'image/png' });
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

for (const size of sizes)
    for (const mode of ['light', 'dark', 'night']) {
        test(`Trial proposal stays isolated and usable at ${size.width} ${mode}${size.pane ? ' split' : ''}`, async ({
            page,
        }, info) => {
            test.setTimeout(60_000);
            const origin = 'http://127.0.0.1:4199';
            await page.route('**/*', (route) => {
                const url = new URL(route.request().url());
                if (url.pathname === '/services/supabase.ts')
                    return route.fulfill({
                        contentType: 'application/javascript',
                        body: 'export const supabase = {auth:{},functions:{}};',
                    });
                if (url.hostname === 'api.mapbox.com' && url.pathname.startsWith('/styles/'))
                    return route.fulfill({
                        json: {
                            version: 8,
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
            await page.goto(`/e2e/fixtures/autorouting-trial.html?mode=${mode}&pane=${size.pane}`);
            await page.getByRole('button', { name: 'Open trial' }).click();
            const dialog = page.getByRole('dialog', { name: 'Autorouting trial' });
            await expect(dialog).toBeVisible();
            await page.evaluate(async () => {
                await document.fonts.ready;
            });
            await expect(page.getByRole('button', { name: 'Calculate trial route' })).toBeDisabled();
            await fits(page, size.pane);
            await capture(page, info, 'trial-initial');
            const chart = page.getByRole('region', { name: /Trial chart/ });
            const chartBox = await chart.boundingBox();
            await chart.click({ position: { x: chartBox!.width * 0.4, y: chartBox!.height * 0.4 } });
            await expect(page.getByRole('button', { name: /departure position set/i })).toBeVisible();
            await chart.click({ position: { x: chartBox!.width * 0.65, y: chartBox!.height * 0.7 } });
            const calculate = page.getByRole('button', { name: 'Calculate trial route' });
            await expect(calculate).toBeEnabled();
            await calculate.click();
            const proposal = page.getByRole('region', { name: 'Trial proposal' });
            await expect(proposal).toContainText('SevenCs proposal');
            await expect(proposal).toContainText('Fixture warning 4');
            await expect
                .poll(() =>
                    page.evaluate(() => {
                        const fixture = (
                            window as unknown as {
                                __trialFixture: {
                                    mapsCreated: number;
                                    map: {
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
            await page.getByRole('button', { name: 'Open trial' }).click();
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
