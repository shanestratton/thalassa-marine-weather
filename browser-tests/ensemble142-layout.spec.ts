import { test, expect } from '@playwright/test';
for (const width of [300, 375]) {
    test(`142 genuine ensemble fits ${width}px at130% without page growth`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const external: string[] = [];
        await page.route('**/*', (route) => {
            const host = new URL(route.request().url()).hostname;
            if (host === '127.0.0.1' || host === 'localhost') return route.continue();
            external.push(host);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/ensemble142.html?scale=130');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-ensemble-reads', '0');
        const extent = () =>
            page.evaluate(() => ({
                width: document.documentElement.scrollWidth,
                height: document.documentElement.scrollHeight,
            }));
        const before = await extent();
        await dialog.getByRole('button', { name: 'Ensemble bands · IFS / EC46' }).click();
        await expect(dialog.getByText(/Wind ≥25 kt in 26 of 51/)).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-ensemble-reads', '1');
        const product = dialog.getByRole('button', { name: 'EC46 · 46 days' });
        await product.click();
        await expect(dialog.getByText(/ECMWF EC46 ·/)).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-ensemble-reads', '2');
        const input = dialog.getByRole('slider');
        await input.scrollIntoViewIfNeeded();
        for (const control of [input, product, dialog.getByRole('button', { name: 'Show gusts' })]) {
            await control.evaluate((node) => node.scrollIntoView({ block: 'center' }));
            const fit = await control.evaluate((node) => {
                const box = node.getBoundingClientRect();
                const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                return {
                    height: box.height,
                    inside: box.left >= 0 && box.right <= innerWidth,
                    hit: !!hit && node.contains(hit),
                    hitElement: hit?.outerHTML.slice(0, 160),
                };
            });
            expect(fit.height, JSON.stringify(fit)).toBeGreaterThanOrEqual(43.5);
            expect(fit, JSON.stringify(fit)).toMatchObject({ inside: true, hit: true });
        }
        await dialog.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
        });
        const close = dialog.getByRole('button', { name: 'Close', exact: true });
        await expect(close).toBeInViewport();
        expect(
            await close.evaluate((node) => {
                const r = node.getBoundingClientRect();
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return r.height >= 44 && r.width >= 44 && !!hit && node.contains(hit);
            }),
        ).toBe(true);
        expect(await extent()).toEqual(before);
        expect(before).toEqual({ width, height: 667 });
        expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        expect(external).toEqual([]);
        await page.screenshot({ path: info.outputPath('ensemble-bottom.png') });
        await close.click();
        await expect(dialog).toHaveCount(0);
    });
}
