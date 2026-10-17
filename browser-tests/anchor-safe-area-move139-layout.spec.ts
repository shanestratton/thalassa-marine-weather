import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    for (const keyboard of [false, true])
        for (const mode of ['pi', 'alarm'])
            test(`Explicit ${mode} area clear fits ${width}px at 130%, keyboard ${keyboard}`, async ({
                page,
            }, info) => {
                await page.setViewportSize({ width, height: 667 });
                await page.route('**/*', (route) =>
                    ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) &&
                    route.request().method() === 'GET'
                        ? route.continue()
                        : route.abort(),
                );
                await page.goto(`/e2e/fixtures/move-anchor.html?${mode}&safeArea`);
                await expect(page.getByRole('button', { name: 'Open Move anchor' })).toBeVisible();
                await page.evaluate(() => {
                    document.documentElement.style.fontSize = '130%';
                    document.documentElement.style.setProperty('--font-sans', 'Verdana, "DejaVu Sans", sans-serif');
                });
                const opener =
                    mode === 'alarm'
                        ? page.getByRole('button', { name: 'Move anchor', exact: true })
                        : page.getByRole('button', { name: 'Open Move anchor' });
                await opener.click();
                const dialog = page.getByRole('dialog', { name: 'Move anchor' });
                await expect(dialog).toBeVisible();
                if (keyboard) {
                    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: 220 })));
                    await expect(page.locator('html')).toHaveAttribute('data-keyboard-open', 'true');
                    await expect
                        .poll(async () => {
                            const box = await dialog.boundingBox();
                            return box!.y + box!.height;
                        })
                        .toBeLessThanOrEqual(447);
                }
                const clear = dialog.getByRole('button', { name: 'Clear area; keep circle watch' });
                await clear.scrollIntoViewIfNeeded();
                await expect(clear).toBeEnabled();
                const box = await clear.boundingBox();
                expect(box).not.toBeNull();
                expect(box!.height).toBeGreaterThanOrEqual(44);
                expect(box!.width).toBeGreaterThanOrEqual(44);
                expect(box!.x).toBeGreaterThanOrEqual(0);
                expect(box!.x + box!.width).toBeLessThanOrEqual(width);
                expect(box!.y).toBeGreaterThanOrEqual(0);
                expect(box!.y + box!.height).toBeLessThanOrEqual(667 - (keyboard ? 220 : 64));
                expect(await clear.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
                await page.screenshot({ path: info.outputPath('explicit-area-clear.png') });
                await clear.click();
                await expect(page.locator('body')).toHaveAttribute('data-area-cleared', 'true');
                await expect(clear).toHaveCount(0);
                expect(
                    await page.evaluate(
                        () =>
                            (window as unknown as { __moveAnchorFixture: { moves: unknown[] } }).__moveAnchorFixture
                                .moves,
                    ),
                ).toEqual([]);
                expect(
                    await page.evaluate(() => ({
                        w: document.documentElement.scrollWidth,
                        h: document.documentElement.scrollHeight,
                    })),
                ).toEqual({ w: width, h: 667 });
            });
