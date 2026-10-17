import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    for (const large of [false, true])
        for (const offshore of [false, true])
            test(`marine source credits fit at ${width}px ${large ? '130%' : 'normal'} ${offshore ? 'offshore' : 'inshore'}`, async ({
                page,
            }, info) => {
                await page.setViewportSize({ width, height: 667 });
                const errors: string[] = [];
                page.on('pageerror', (error) => errors.push(error.message));
                await page.route('**/*', (route) =>
                    ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
                        ? route.continue()
                        : route.abort(),
                );
                await page.routeWebSocket('**/*', (socket) => socket.close());
                await page.goto(
                    `/e2e/fixtures/marine-picker141.html?large=${large ? 1 : 0}&offshore=${offshore ? 1 : 0}`,
                );
                await page.getByRole('button', { name: 'Choose forecast model', exact: true }).click();
                const dialog = page.getByRole('dialog', {
                    name: offshore ? 'Offshore forecast model' : 'Forecast model',
                    exact: true,
                });
                await expect(dialog).toBeVisible();
                await dialog.evaluate(async (element) => {
                    await Promise.all(
                        element
                            .getAnimations({ subtree: true })
                            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
                            .map((animation) => animation.finished),
                    );
                });
                await expect(dialog).not.toHaveText(/StormGlass/i);
                if (offshore)
                    await expect(dialog.getByTestId('forecast-credit')).toContainText(
                        'Forecast: ECMWF IFS · CC BY 4.0',
                    );
                const summary = dialog.getByText('Data sources', { exact: true });
                await summary.scrollIntoViewIfNeeded();
                await summary.click();
                const credit = dialog.getByRole('link', { name: /^Marine: Météo-France/ });
                await credit.scrollIntoViewIfNeeded();
                await expect(credit).toBeVisible();
                await expect(credit).toHaveAttribute('href', 'https://open-meteo.com/en/docs/marine-weather-api');
                await expect(credit).toContainText('© Mercator Ocean');
                for (const control of [summary, credit, dialog.getByRole('button', { name: 'Close', exact: true })]) {
                    await control.scrollIntoViewIfNeeded();
                    const rect = await control.boundingBox();
                    expect(rect).not.toBeNull();
                    expect(rect!.width).toBeGreaterThanOrEqual(44);
                    expect(rect!.height).toBeGreaterThanOrEqual(44);
                    expect(rect!.x).toBeGreaterThanOrEqual(0);
                    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
                    expect(rect!.y).toBeGreaterThanOrEqual(0);
                    expect(rect!.y + rect!.height).toBeLessThanOrEqual(667);
                    const reachable = await control.evaluate((element) => {
                        const r = element.getBoundingClientRect();
                        let left = r.left,
                            right = r.right,
                            top = r.top,
                            bottom = r.bottom;
                        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                            const css = getComputedStyle(parent),
                                box = parent.getBoundingClientRect();
                            if (/(hidden|clip|auto|scroll)/.test(css.overflowX)) {
                                left = Math.max(left, box.left);
                                right = Math.min(right, box.right);
                            }
                            if (/(hidden|clip|auto|scroll)/.test(css.overflowY)) {
                                top = Math.max(top, box.top);
                                bottom = Math.min(bottom, box.bottom);
                            }
                        }
                        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
                        return {
                            width: right - left,
                            height: bottom - top,
                            hit: !!hit && (element === hit || element.contains(hit)),
                        };
                    });
                    expect(reachable.width).toBeGreaterThanOrEqual(44);
                    expect(reachable.height).toBeGreaterThanOrEqual(44);
                    expect(reachable.hit).toBe(true);
                }
                await expect(
                    page.getByText(
                        'Ocean models do not resolve berths or enclosed water. Missing values stay unknown.',
                        { exact: true },
                    ),
                ).toBeVisible();
                expect(
                    await page.evaluate(() => ({
                        width: document.documentElement.scrollWidth,
                        height: document.documentElement.scrollHeight,
                    })),
                ).toEqual({ width, height: 667 });
                await credit.scrollIntoViewIfNeeded();
                await page.screenshot({ path: info.outputPath('expanded-marine-credit.png'), animations: 'disabled' });
                await dialog.getByRole('button', { name: 'Close', exact: true }).click();
                await expect(dialog).toHaveCount(0);
                await page.getByRole('button', { name: 'Choose forecast model', exact: true }).click();
                await page.getByRole('button', { name: 'Use the GFS forecast model', exact: true }).click();
                await expect(page.getByRole('status', { name: 'Selected model' })).toHaveText(
                    offshore ? 'gfs' : 'gfs_seamless',
                );
                expect(errors).toEqual([]);
            });
