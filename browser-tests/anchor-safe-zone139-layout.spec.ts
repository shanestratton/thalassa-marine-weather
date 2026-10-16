import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    for (const keyboard of [false, true])
        test(`Manual safe-area sheet fits ${width}px at 130%, keyboard ${keyboard}`, async ({ page }, info) => {
            await page.setViewportSize({ width, height: 667 });
            await page.route('**/*', (route) =>
                ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) &&
                route.request().method() === 'GET'
                    ? route.continue()
                    : route.abort(),
            );
            await page.goto(`/e2e/fixtures/anchor-safe-zone139.html${keyboard ? '?keyboard' : ''}`);
            const dialog = page.getByRole('dialog', { name: 'Anchor safe area' });
            await expect(dialog).toBeVisible();
            if (keyboard) await page.getByRole('button', { name: 'Exclude wedges' }).click();
            const save = page.getByRole('button', { name: 'Use safe area' }),
                clear = page.getByRole('button', { name: 'Use circle only' });
            await expect(save).toBeEnabled();
            if (keyboard) {
                const input = page.getByRole('spinbutton', { name: 'Wedge 1 start true bearing' });
                await input.scrollIntoViewIfNeeded();
                const field = await input.boundingBox();
                const footer = await clear.boundingBox();
                expect(field!.height).toBeGreaterThanOrEqual(44);
                expect(field!.y + field!.height).toBeLessThanOrEqual(footer!.y);
            } else {
                const preview = page.getByRole('img');
                await preview.scrollIntoViewIfNeeded();
                const plot = await preview.boundingBox();
                const footer = await clear.boundingBox();
                expect(plot!.height).toBeGreaterThanOrEqual(180);
                expect(plot!.y + plot!.height).toBeLessThanOrEqual(footer!.y);
            }
            for (const control of [save, clear, page.getByRole('button', { name: 'Close safe-area editor' })]) {
                const box = await control.boundingBox();
                expect(box).not.toBeNull();
                expect(box!.height).toBeGreaterThanOrEqual(44);
                expect(box!.width).toBeGreaterThanOrEqual(44);
                expect(box!.x).toBeGreaterThanOrEqual(0);
                expect(box!.x + box!.width).toBeLessThanOrEqual(width);
                expect(box!.y + box!.height).toBeLessThanOrEqual(667 - (keyboard ? 220 : 64));
                expect(await control.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
            }
            const extent = await page.evaluate(() => ({
                w: document.documentElement.scrollWidth,
                h: document.documentElement.scrollHeight,
            }));
            expect(extent.w).toBe(width);
            expect(extent.h).toBe(667);
            await page.screenshot({ path: info.outputPath('safe-area.png') });
            await save.click();
            await expect(page.locator('body')).toHaveAttribute('data-closed', 'true');
            const payload = JSON.parse((await page.locator('body').getAttribute('data-saved')) ?? 'null');
            expect(payload.token).toBe('synthetic-watch-token');
            expect(payload.value.kind).toBe(keyboard ? 'wedges' : 'polygon');
        });
