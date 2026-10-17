import { test, expect, type Locator } from '@playwright/test';
async function hit(control: Locator, width: number) {
    await control.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await expect
        .poll(() =>
            control.evaluate((el, viewport) => {
                const r = el.getBoundingClientRect();
                let l = r.left,
                    t = r.top,
                    right = r.right,
                    b = r.bottom;
                for (let p = el.parentElement; p; p = p.parentElement) {
                    const css = getComputedStyle(p),
                        box = p.getBoundingClientRect();
                    if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
                        l = Math.max(l, box.left);
                        right = Math.min(right, box.right);
                    }
                    if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
                        t = Math.max(t, box.top);
                        b = Math.min(b, box.bottom);
                    }
                }
                const point = document.elementFromPoint((l + right) / 2, (t + b) / 2);
                return (
                    right - l >= 44 &&
                    b - t >= 44 &&
                    l >= 0 &&
                    right <= viewport &&
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
    test(`satellite wind ${width}px130% stays bounded`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) =>
            ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
                ? route.continue()
                : route.abort(),
        );
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.goto('/e2e/fixtures/ascat141.html');
        await expect(page.locator('html')).toHaveAttribute('data-ascat-reads', '0');
        const before = await page.getByTestId('map').boundingBox();
        const toggle = page.getByRole('button', { name: 'Satellite wind', exact: true });
        await hit(toggle, width);
        await toggle.click();
        await expect(page.locator('html')).toHaveAttribute('data-ascat-reads', '3');
        const inspect = page.getByRole('button', { name: 'Inspect vector', exact: true });
        await hit(inspect, width);
        await inspect.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await dialog.evaluate(async (element) => {
            await Promise.all(
                element
                    .getAnimations({ subtree: true })
                    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                    .map((a) => a.finished),
            );
        });
        await expect(dialog.getByText(/Satellite 23 kt SE/)).toBeVisible();
        await expect(dialog.getByText(/Forecast comparison unavailable/)).toBeVisible();
        const close = dialog.getByRole('button', { name: 'Close satellite wind', exact: true });
        await hit(close, width);
        const pinned = await close.boundingBox();
        await dialog.getByText(/Contains modified EUMETSAT/).scrollIntoViewIfNeeded();
        await hit(close, width);
        expect(await close.boundingBox()).toEqual(pinned);
        expect(
            await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]),
        ).toEqual([width, 667]);
        expect(await page.getByTestId('map').boundingBox()).toEqual(before);
        await page.screenshot({ path: info.outputPath('satellite-popup.png'), animations: 'disabled' });
        await close.click();
        const credits = page.getByRole('button', { name: 'Credits', exact: true });
        await hit(credits, width);
        await credits.click();
        await expect(page.getByRole('dialog').getByText(/Last 24 hours of original UTC/)).toBeVisible();
        const closeCredits = page.getByRole('button', { name: 'Close credits', exact: true });
        await hit(closeCredits, width);
        await closeCredits.click();
        await page.getByRole('button', { name: 'Hide all', exact: true }).click();
        expect(
            await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]),
        ).toEqual([width, 667]);
        expect(await page.getByTestId('map').boundingBox()).toEqual(before);
        await expect(page.locator('html')).toHaveAttribute('data-ascat-reads', '3');
        expect(errors).toEqual([]);
    });
