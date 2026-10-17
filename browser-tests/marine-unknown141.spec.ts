import { expect, test } from '@playwright/test';

for (const width of [300, 375])
    for (const scale of [1, 1.3])
        for (const known of [false, true])
            test(`unknown marine never sets rode at${width}px ${scale * 100}% text, sea${known ? 'known' : 'unknown'}`, async ({
                page,
            }, info) => {
                await page.setViewportSize({ width, height: 667 });
                const errors: string[] = [];
                page.on('pageerror', (error) => errors.push(error.message));
                await page.route('**/*', (route) => {
                    const url = new URL(route.request().url());
                    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || route.request().method() !== 'GET')
                        return route.abort();
                    if (url.pathname === '/context/WeatherContext.tsx')
                        return route.fulfill({
                            contentType: 'text/javascript',
                            body: `export const WeatherProvider=({children})=>children;export const useWeather=()=>({weatherData:{locationName:'Fictional marine point',current:{windSpeed:8,windGust:8,waveHeight:${known ? '0.3' : 'null'}}},loading:false});`,
                        });
                    return route.continue();
                });
                await page.routeWebSocket('**/*', (socket) => socket.close());
                await page.goto('/e2e/fixtures/anchor-antenna.html?area=none');
                await page.evaluate((scale) => {
                    document.documentElement.style.fontSize = `${16 * scale}px`;
                }, scale);
                const advice = known
                    ? page.getByRole('button', { name: /8 kts now · 5:1 needs 25 m, set rode to 25 metres/ })
                    : page.getByRole('button', {
                          name: 'Wind or sea forecast unavailable; choose rode manually',
                          exact: true,
                      });
                await expect(advice).toBeVisible();
                // Read settled layout, rather than a fractional transformed quad
                // during the existing finite page entrance animation.
                await page.locator('.anchor-setup-page').evaluate(async (element) => {
                    await Promise.all(element.getAnimations().map((animation) => animation.finished));
                });
                if (known) await expect(advice).toBeEnabled();
                else {
                    await expect(advice).toBeDisabled();
                    await expect(advice).toHaveText(/Sea unknown/);
                }
                const before = await page.evaluate(() => ({
                    width: document.documentElement.scrollWidth,
                    height: document.documentElement.scrollHeight,
                }));
                const box = await advice.boundingBox();
                expect(box).not.toBeNull();
                expect(box!.width).toBeGreaterThanOrEqual(44);
                expect(box!.height).toBeGreaterThanOrEqual(44);
                expect(box!.x).toBeGreaterThanOrEqual(0);
                expect(box!.x + box!.width).toBeLessThanOrEqual(width);
                expect(before).toEqual({ width, height: 667 });
                await expect(
                    page.getByRole('button', { name: 'Drop anchor and arm Anchor Watch', exact: true }),
                ).toBeVisible();
                if (known) {
                    await advice.click();
                    await expect(page.getByRole('button', { name: /8 kts now · 5:1 set/ })).toBeVisible();
                } else {
                    await advice.evaluate((element: HTMLButtonElement) => element.click());
                    await expect(page.getByText('30 m', { exact: true })).toBeVisible();
                    expect(await page.getByText('25 m', { exact: true }).count()).toBe(0);
                }
                expect(
                    await page.evaluate(() => ({
                        width: document.documentElement.scrollWidth,
                        height: document.documentElement.scrollHeight,
                    })),
                ).toEqual(before);
                expect(errors).toEqual([]);
                await page.screenshot({
                    path: info.outputPath(`marine-${known ? 'known' : 'unknown'}-${width}-${scale}.png`),
                    animations: 'disabled',
                });
            });
