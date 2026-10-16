import { test, expect } from '@playwright/test';
for (const width of [300, 375])
    test(`berth proposal review and unavailable source fit ${width}px130%`, async ({ page, baseURL }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const errors: string[] = [],
            unexpected: string[] = [];
        const origin = new URL(baseURL!).origin;
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin === origin) return route.continue();
            unexpected.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.routeWebSocket('**/*', (socket) => socket.close());
        await page.goto('/e2e/fixtures/berth139.html');
        await page.addStyleTag({ content: 'html{font-size:130% !important}' });
        const dialog = page.getByRole('dialog', { name: 'Berth passage proposal', exact: true });
        await dialog.getByRole('button', { name: 'Compute fictional berth route', exact: true }).click();
        await expect(dialog.getByRole('status')).toContainText('Both approach portals retained');
        const clocks = dialog.getByRole('list', { name: 'Stage departure clocks' });
        await expect(clocks.getByRole('listitem')).toHaveCount(3);
        const save = dialog.getByRole('button', { name: 'Save as planned route', exact: true });
        await save.scrollIntoViewIfNeeded();
        await expect(save).toBeDisabled();
        for (const button of await dialog.getByRole('button').all()) {
            const b = await button.boundingBox();
            if (b) expect(b.height).toBeGreaterThanOrEqual(44);
        }
        expect(
            await page.evaluate(() => ({
                w: document.documentElement.scrollWidth,
                h: document.documentElement.scrollHeight,
            })),
        ).toEqual({ w: width, h: 667 });
        await page.screenshot({ path: info.outputPath('berth-review.png') });
        const unavailable = dialog.getByRole('button', { name: 'Simulate missing final check', exact: true });
        await unavailable.scrollIntoViewIfNeeded();
        await unavailable.click();
        await expect(dialog.getByRole('alert')).toContainText('No route was adopted');
        await expect(save).toHaveCount(0);
        expect(
            await page.evaluate(() => ({
                w: document.documentElement.scrollWidth,
                h: document.documentElement.scrollHeight,
            })),
        ).toEqual({ w: width, h: 667 });
        await page.screenshot({ path: info.outputPath('berth-unavailable.png') });
        expect(unexpected).toEqual([]);
        expect(errors).toEqual([]);
    });
