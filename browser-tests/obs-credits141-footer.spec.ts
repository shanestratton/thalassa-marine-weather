import { test, expect } from '@playwright/test';
for (const width of [300, 375, 430])
    test(`credits Close stays pinned above real map ${width}px130%`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'blob:') return route.continue();
            if (url.hostname === 'api.mapbox.com' && url.pathname === '/map-sessions/v1')
                return route.fulfill({ status: 200, body: '' });
            if (url.hostname === 'events.mapbox.com' && url.pathname === '/events/v2')
                return route.fulfill({ status: 204, body: '' });
            return route.abort();
        });
        await page.goto('/e2e/fixtures/obs-credits137.html');
        await page.addStyleTag({ content: 'html{font-size:130%}' });
        const row = page.getByTestId('obs-credits-rollup');
        await expect(row).toBeVisible();
        const before = await page.evaluate(() => window.__creditsFixture.bounds());
        await page.getByRole('button', { name: 'Credits', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Map credits & source status' });
        const close = dialog.getByRole('button', { name: 'Close credits', exact: true });
        await expect(close).toBeVisible();
        await dialog.evaluate(async (element) => {
            await Promise.all(
                element
                    .getAnimations({ subtree: true })
                    .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
                    .map((a) => a.finished),
            );
        });
        const pinned = await close.boundingBox();
        expect(pinned).not.toBeNull();
        await dialog.getByRole('link').last().scrollIntoViewIfNeeded();
        expect(await close.boundingBox()).toEqual(pinned);
        expect(pinned!.width).toBeGreaterThanOrEqual(44);
        expect(pinned!.height).toBeGreaterThanOrEqual(44);
        expect(pinned!.x).toBeGreaterThanOrEqual(0);
        expect(pinned!.x + pinned!.width).toBeLessThanOrEqual(width);
        expect(pinned!.y + pinned!.height).toBeLessThanOrEqual(667);
        expect(
            await close.evaluate((element) => {
                const r = element.getBoundingClientRect();
                return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            }),
        ).toBe(true);
        expect(await page.evaluate(() => window.__creditsFixture.bounds())).toEqual(before);
        expect(
            await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]),
        ).toEqual([width, 667]);
        await page.screenshot({ path: info.outputPath('pinned-close.png'), animations: 'disabled' });
        await close.click();
        await expect(dialog).toHaveCount(0);
        expect(await page.evaluate(() => window.__creditsFixture.bounds())).toEqual(before);
        expect(errors).toEqual([]);
    });
