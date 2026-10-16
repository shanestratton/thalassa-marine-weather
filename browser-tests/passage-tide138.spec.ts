import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`Passage tide actions and RAM fences fit ${width}px at 130%`, async ({ page }) => {
        await page.setViewportSize({ width, height: 812 });
        const remote: string[] = [];
        await page.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (['localhost', '127.0.0.1'].includes(u.hostname) || u.protocol === 'blob:') return route.continue();
            remote.push(u.hostname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/passage-tide138.html');
        await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
        const dialog = page.getByRole('dialog', { name: 'Route report' });
        const extent = () =>
            dialog.evaluate((n) => {
                const b = n.getBoundingClientRect();
                return {
                    x: b.x,
                    y: b.y,
                    width: b.width,
                    height: b.height,
                    max: getComputedStyle(n).maxHeight,
                    pageWidth: document.documentElement.scrollWidth,
                    pageHeight: document.documentElement.scrollHeight,
                    viewport: [innerWidth, innerHeight],
                };
            });
        const before = await extent();
        await page.getByRole('button', { name: 'Tides, bridges and waiting', exact: true }).click();
        const calls = () =>
            page.evaluate(() => (window as unknown as { __tide138: { calls: () => number } }).__tide138.calls());
        const startCalls = await calls();
        await page.getByRole('button', { name: 'Read aboard', exact: true }).click();
        await expect(page.getByTestId('passage-tide-review-results')).toBeVisible();
        expect(await calls()).toBe(startCalls);
        await page.getByText('Installed chart and holding references', { exact: true }).click();
        await expect(page.getByTestId('passage-tide-review-results')).toContainText('PRIVATE FICTIONAL BRIDGE');
        await expect(page.getByTestId('passage-tide-review-results')).toContainText('epoch unknown');
        await page.getByRole('button', { name: 'Load official table', exact: true }).click();
        await expect(page.getByTestId('passage-tide-review-results')).toContainText('Synthetic official event station');
        await expect(page.getByTestId('passage-tide-review-results')).toContainText('Official high/low table');
        await page.getByRole('button', { name: 'Load up to 3 nearby stations', exact: true }).click();
        await expect(page.getByTestId('passage-tide-review-results')).toContainText('Synthetic nearby prediction');
        await expect(page.getByTestId('passage-tide-review-results')).toContainText(
            'WorldTides navigation permission is unverified',
        );
        await page.getByText('Review a holding wait before this point', { exact: true }).click();
        await page.getByLabel('UKC (m)', { exact: true }).fill('0.8');
        await expect(page.getByTestId('passage-tide-review-results')).toBeVisible();
        await page.getByRole('button', { name: 'Review wait evidence', exact: true }).click();
        await expect(page.getByTestId('passage-tide-review-results')).toContainText('Checked wait unavailable');
        await expect(page.getByRole('button', { name: 'Accept Wait point and recheck route' })).toHaveCount(0);
        const loaded = await extent();
        expect(loaded.width).toBe(before.width);
        expect(loaded.max).toBe(before.max);
        expect(loaded.height).toBeLessThanOrEqual(812 * 0.85 + 1);
        expect(loaded.pageWidth).toBeLessThanOrEqual(width);
        expect(loaded.pageHeight).toBeLessThanOrEqual(812);
        expect(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
        await test
            .info()
            .attach('report-extent', { body: JSON.stringify({ before, loaded }), contentType: 'application/json' });
        await page.getByRole('button', { name: 'Review wait evidence', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: test.info().outputPath('passage-tide-wait.png') });
        expect(
            await page.evaluate(() =>
                (window as unknown as { __tide138: { localText: () => string } }).__tide138.localText(),
            ),
        ).not.toContain('PRIVATE FICTIONAL BRIDGE');
        await page.evaluate(() =>
            (window as unknown as { __tide138: { queueEdit: () => void } }).__tide138.queueEdit(),
        );
        await expect(page.getByTestId('passage-tide-review-results')).toHaveCount(0);
        expect(
            await page.evaluate(() =>
                (window as unknown as { __tide138: { queuedRefused: () => boolean } }).__tide138.queuedRefused(),
            ),
        ).toBe(true);
        expect(
            await page.evaluate(() =>
                (window as unknown as { __tide138: { points: () => { name?: string }[] } }).__tide138
                    .points()
                    .some((p) => p.name === 'Wait'),
            ),
        ).toBe(false);
        await page.evaluate(() => (window as unknown as { __tide138: { hold: () => void } }).__tide138.hold());
        await page.getByRole('button', { name: 'Load up to 3 nearby stations', exact: true }).click();
        await expect
            .poll(() =>
                page.evaluate(() =>
                    (window as unknown as { __tide138: { pending: () => boolean } }).__tide138.pending(),
                ),
            )
            .toBe(true);
        await page.evaluate(() =>
            (
                window as unknown as { __tide138: { changeBoat: () => void; release: () => void } }
            ).__tide138.changeBoat(),
        );
        await page.evaluate(() => (window as unknown as { __tide138: { release: () => void } }).__tide138.release());
        await expect(page.getByTestId('passage-tide-review-results')).toHaveCount(0);
        expect(remote).toEqual([]);
    });
