import { expect, test } from '@playwright/test';

for (const size of [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 220, height: 740 },
    { width: 768, height: 1024 },
]) {
    test(`offshore comparison contains its table and keeps Close reachable at ${size.width}x${size.height}`, async ({
        page,
    }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
        });
        await page.setViewportSize(size);
        await page.goto('/e2e/fixtures/offshore-comparison.html');
        const sheet = page.getByRole('dialog', { name: 'Compare offshore forecasts' });
        await expect(sheet).toBeVisible();
        await expect(sheet.getByRole('row')).toHaveCount(5);
        await expect(sheet.getByText('Model forecast unavailable.')).toHaveCount(2);
        await expect(sheet.getByText(/Unknown/).first()).toBeVisible();
        const box = await sheet.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const close = sheet.getByRole('button', { name: 'Close comparison', exact: true });
        await expect(close).toBeVisible();
        await close.click();
        await expect(sheet).not.toBeVisible();
        expect(errors).toEqual([]);
    });
}
