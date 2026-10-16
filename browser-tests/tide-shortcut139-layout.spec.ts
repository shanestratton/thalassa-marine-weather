import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`Tide shortcut current-source control ${width}px130%`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 667 });
        const unexpected: string[] = [],
            errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) && route.request().method() === 'GET')
                return route.continue();
            unexpected.push(url.origin + url.pathname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/tide-shortcut139.html');
        const control = page.getByTestId('tide-shortcut-control');
        await expect(control).toBeVisible();
        const card = page.locator('.thalassa-passage-banner > div').first();
        const extent = () =>
            card.evaluate((n) => {
                const b = n.getBoundingClientRect();
                return {
                    width: b.width,
                    height: b.height,
                    bottom: b.bottom,
                    max: getComputedStyle(n).maxHeight,
                    pageWidth: document.documentElement.scrollWidth,
                    pageHeight: document.documentElement.scrollHeight,
                    viewport: [innerWidth, innerHeight],
                    clientWidth: n.clientWidth,
                    scrollWidth: n.scrollWidth,
                };
            });
        const before = await extent();
        await control.locator('summary').click();
        const toggle = control.getByRole('checkbox', { name: 'Consider a tide-gated shortcut' });
        await expect(toggle).not.toBeChecked();
        await toggle.check();
        await expect(control).toContainText('No original sampled tide product with reviewed navigation rights');
        await expect(control).toContainText('WorldTides remain informational');
        const input = control.getByLabel('Tide shortcut arrival buffer in minutes');
        await input.scrollIntoViewIfNeeded();
        await input.fill('30');
        await input.blur();
        await expect(input).toHaveValue('30');
        await expect
            .poll(() =>
                page.evaluate(() => (window as unknown as { __tide139: { reads: () => number } }).__tide139.reads()),
            )
            .toBeGreaterThanOrEqual(2);
        await expect(control).toContainText('No automatic wait or departure change');
        const after = await extent();
        expect(after.width).toBe(before.width);
        expect(after.max).toBe(before.max);
        expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
        expect(after.bottom).toBeLessThanOrEqual(667 - 104 + 1);
        expect(after.pageWidth).toBeLessThanOrEqual(width);
        expect(after.pageHeight).toBeLessThanOrEqual(667);
        expect(after.scrollWidth).toBeLessThanOrEqual(after.clientWidth + 1);
        expect(await input.evaluate((n) => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
        await expect(page.getByTestId('passage-route-unverified')).toContainText('not verified');
        expect(
            await page.evaluate(() => (window as unknown as { __tide139: { calls: () => number } }).__tide139.calls()),
        ).toBe(0);
        expect(unexpected).toEqual([]);
        expect(errors).toEqual([]);
        await info.attach('fixed-card-and-page-extents', {
            body: JSON.stringify({ before, after, unexpected, errors }, null, 2),
            contentType: 'application/json',
        });
        await page.screenshot({ path: info.outputPath('tide-shortcut-held.png'), fullPage: true });
    });
