import { expect, test } from '@playwright/test';
test.use({ hasTouch: true });
for (const size of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 820, height: 1180 },
]) {
    test(`official chart controls fit and zoom at ${size.width}`, async ({ page, browserName }) => {
        await page.setViewportSize(size);
        await page.goto('/e2e/fixtures/synoptic-charts.html?largeText');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(page.getByRole('img')).toBeVisible();
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.getByRole('button', { name: 'Zoom in' }).click();
        await expect(page.getByRole('img')).toHaveCSS('transform', /1.5/);
        await page.getByRole('button', { name: 'Fit chart' }).click();
        await expect(page.getByRole('img')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
        if (browserName === 'chromium') {
            const image = page.getByRole('region', { name: 'Official chart image' });
            await image.scrollIntoViewIfNeeded();
            const box = (await image.boundingBox())!;
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [
                    { id: 1, x: box.x + 60, y: box.y + 80 },
                    { id: 2, x: box.x + 160, y: box.y + 80 },
                ],
            });
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [
                    { id: 1, x: box.x + 60, y: box.y + 80 },
                    { id: 2, x: box.x + 210, y: box.y + 80 },
                ],
            });
            await expect(page.getByRole('img')).toHaveCSS('transform', /1.5/);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await cdp.detach();
        }
        await page.getByRole('button', { name: /Update saved chart/ }).scrollIntoViewIfNeeded();
        await expect(page.getByRole('button', { name: /Update saved chart/ })).toBeInViewport();
        await page.getByRole('button', { name: 'Close official charts' }).click();
        await expect(page.locator('html')).toHaveAttribute('data-closed', 'true');
    });
}
