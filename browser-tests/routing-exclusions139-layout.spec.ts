import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    for (const keyboard of [false, true])
        test(`Explicit private no-go ${width}px130% keyboard${keyboard}`, async ({ page }, info) => {
            await page.setViewportSize({ width, height: 667 });
            const unexpected: string[] = [],
                errors: string[] = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.route('**/*', (route) => {
                const url = new URL(route.request().url());
                if (['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET')
                    return route.continue();
                unexpected.push(url.origin + url.pathname);
                return route.abort();
            });
            await page.goto(`/e2e/fixtures/routing-exclusions139.html${keyboard ? '?keyboard' : ''}`);
            const dialog = page.getByRole('dialog', { name: 'Your overlays' }),
                polygon = dialog.getByRole('region', { name: 'Own polygon' }),
                point = dialog.getByRole('region', { name: 'Own point' });
            const avoid = polygon.getByRole('checkbox', { name: 'Avoid while routing' }),
                show = polygon.getByRole('checkbox', { name: 'Show on Obs' }),
                alerts = polygon.getByRole('checkbox', { name: 'Foreground polygon-entry banner and one quiet chime' });
            await expect(avoid).not.toBeChecked();
            await expect(point.getByRole('checkbox', { name: 'Avoid while routing' })).toBeDisabled();
            const read = () =>
                page.evaluate(() =>
                    (
                        window as unknown as { __readManualRouting: () => Promise<{ count: number; current: boolean }> }
                    ).__readManualRouting(),
                );
            expect(await read()).toEqual({ count: 0, current: true });
            await avoid.scrollIntoViewIfNeeded();
            const label = avoid.locator('..');
            const box = await label.boundingBox();
            expect(box!.height).toBeGreaterThanOrEqual(44);
            expect(box!.x).toBeGreaterThanOrEqual(0);
            expect(box!.x + box!.width).toBeLessThanOrEqual(width);
            expect(box!.y + box!.height).toBeLessThanOrEqual(667 - (keyboard ? 220 : 0));
            expect(await label.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
            await page.screenshot({ path: info.outputPath('explicit-no-go-control.png') });
            await avoid.click();
            await expect(avoid).toBeChecked();
            await expect(avoid).toBeEnabled();
            await expect(alerts).not.toBeChecked();
            await expect(show).toBeChecked();
            await show.click();
            await expect(show).not.toBeChecked();
            await expect(show).toBeEnabled();
            expect(await read()).toEqual({ count: 1, current: true });
            await avoid.click();
            await expect(avoid).not.toBeChecked();
            await expect(avoid).toBeEnabled();
            expect(await read()).toEqual({ count: 0, current: true });
            expect(
                await page.evaluate(() => ({
                    w: document.documentElement.scrollWidth,
                    h: document.documentElement.scrollHeight,
                })),
            ).toEqual({ w: width, h: 667 });
            expect(unexpected).toEqual([]);
            expect(errors).toEqual([]);
        });
