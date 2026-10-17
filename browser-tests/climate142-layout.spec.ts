import { test, expect } from '@playwright/test';
for (const width of [300, 375]) {
    test(`142 checked climate fits ${width}px at130% without page growth`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const external: string[] = [];
        await page.route('**/*', (route) => {
            const host = new URL(route.request().url()).hostname;
            if (host === '127.0.0.1' || host === 'localhost') return route.continue();
            external.push(host);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/climate142.html?scale=130');
        const dialog = page.getByRole('dialog', { name: 'Trip climate' });
        await expect(dialog).toBeVisible();
        const extent = () =>
            page.evaluate(() => ({
                width: document.documentElement.scrollWidth,
                height: document.documentElement.scrollHeight,
            }));
        const before = await extent();
        await expect(page.locator('html')).toHaveAttribute('data-climate-reads', '0');
        const open = dialog.getByRole('button', { name: '30-year wind and wave climate' });
        await open.click();
        await expect(dialog.getByText(/100% of route length/)).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-climate-reads', '3');
        const month = dialog.getByRole('combobox', { name: 'Climate month' });
        await month.selectOption('1');
        await expect(month).toHaveValue('1');
        const roses = dialog.getByRole('img');
        await expect(roses).toHaveCount(2);
        for (const rose of await roses.all()) {
            await rose.evaluate((node) => node.scrollIntoView({ block: 'center' }));
            expect(
                await rose.evaluate((node) => {
                    const r = node.getBoundingClientRect();
                    return r.left >= 0 && r.right <= innerWidth && r.width > 50 && r.height > 50;
                }),
            ).toBe(true);
        }
        await page.screenshot({ path: info.outputPath('climate-roses.png') });
        for (const control of [month, dialog.getByRole('button', { name: 'Hide wind and wave climate' })]) {
            await control.evaluate((node) => node.scrollIntoView({ block: 'center' }));
            expect(
                await control.evaluate((node) => {
                    const r = node.getBoundingClientRect();
                    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                    return r.height >= 43.5 && r.left >= 0 && r.right <= innerWidth && !!hit && node.contains(hit);
                }),
            ).toBe(true);
        }
        const credits = dialog.getByText(/Data: Copernicus Climate Change Service/);
        await credits.scrollIntoViewIfNeeded();
        const close = dialog.getByRole('button', { name: 'Close climate' });
        await expect(close).toBeInViewport();
        expect(
            await close.evaluate((node) => {
                const r = node.getBoundingClientRect();
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return r.height >= 44 && !!hit && node.contains(hit);
            }),
        ).toBe(true);
        expect(await extent()).toEqual(before);
        expect(before).toEqual({ width, height: 667 });
        expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        expect(external).toEqual([]);
        await page.screenshot({ path: info.outputPath('climate-bottom.png') });
        await close.click();
        await expect(dialog).toHaveCount(0);
    });
}
