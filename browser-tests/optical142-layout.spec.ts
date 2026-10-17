import { test, expect, type Locator } from '@playwright/test';
async function hit(control: Locator, width: number) {
    await expect
        .poll(() =>
            control.evaluate((el, w) => {
                const r = el.getBoundingClientRect();
                let l = r.left,
                    t = r.top,
                    right = r.right,
                    b = r.bottom;
                for (let p = el.parentElement; p; p = p.parentElement) {
                    const css = getComputedStyle(p),
                        v = p.getBoundingClientRect();
                    if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
                        l = Math.max(l, v.left);
                        right = Math.min(right, v.right);
                    }
                    if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
                        t = Math.max(t, v.top);
                        b = Math.min(b, v.bottom);
                    }
                }
                const point = document.elementFromPoint((l + right) / 2, (t + b) / 2);
                return (
                    right - l >= 44 &&
                    b - t >= 44 &&
                    l >= 0 &&
                    right <= w &&
                    t >= 0 &&
                    b <= 667 &&
                    !!point &&
                    (point === el || el.contains(point))
                );
            }, width),
        )
        .toBe(true);
}
for (const width of [300, 375])
    test(`optical flashes ${width}px130% preserve viewport`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**/*', (r) =>
            ['127.0.0.1', 'localhost'].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort(),
        );
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.goto('/e2e/fixtures/optical142.html');
        await expect(page.locator('html')).toHaveAttribute('data-optical-reads', '0');
        const before = await page.getByTestId('map').boundingBox(),
            toggle = page.getByRole('button', { name: 'Satellite flashes', exact: true });
        await hit(toggle, width);
        await toggle.click();
        await expect(page.locator('html')).toHaveAttribute('data-optical-reads', '3');
        await expect(page.locator('html')).toHaveAttribute('data-optical-features', '6');
        const credit = page.getByRole('button', { name: /^Credits/ });
        await hit(credit, width);
        await credit.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await dialog.evaluate(async (el) => {
            await Promise.allSettled(
                el
                    .getAnimations({ subtree: true })
                    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                    .map((a) => a.finished),
            );
        });
        const detail = dialog.getByRole('region', { name: 'Satellite optical flashes', exact: true });
        await expect(detail).toContainText('cloud centroids, not ground-strike');
        await expect(detail).toContainText('No lightning alerts use this layer');
        const close = dialog.getByRole('button', { name: 'Close credits', exact: true });
        await hit(close, width);
        const pinned = await close.boundingBox();
        const scroll = dialog.locator('[data-modal-sheet-body]');
        await scroll.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
        });
        expect(await scroll.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        await hit(close, width);
        expect(await close.boundingBox()).toEqual(pinned);
        expect(
            await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]),
        ).toEqual([width, 667]);
        expect(await page.getByTestId('map').boundingBox()).toEqual(before);
        await page.screenshot({ path: info.outputPath('optical-credits.png'), animations: 'disabled' });
        await close.click();
        await page.getByRole('button', { name: 'Hide all', exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-optical-features', '0');
        await expect(page.locator('html')).toHaveAttribute('data-optical-reads', '3');
        expect(await page.getByTestId('map').boundingBox()).toEqual(before);
        expect(errors).toEqual([]);
    });
