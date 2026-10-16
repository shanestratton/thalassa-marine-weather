import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`reviewed underway route keeps the original at ${width}px with wide text`, async ({ page }) => {
        await page.setViewportSize({ width, height: 667 });
        const remote: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['localhost', '127.0.0.1'].includes(url.hostname) || url.protocol === 'blob:') return route.continue();
            remote.push(url.hostname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/route-replan138.html');
        await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
        const review = page.getByRole('region', { name: 'Original and proposed route' });
        await expect(review).toBeVisible();
        await expect(review.getByRole('button', { name: 'Accept reviewed route' })).toBeDisabled();
        await page.evaluate(() =>
            (window as unknown as { __routeReplan138: { ready: () => void } }).__routeReplan138.ready(),
        );
        await expect(review.getByRole('button', { name: 'Accept reviewed route' })).toBeEnabled();
        expect(await review.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await expect(review).toContainText('Original · grey dashed');
        await expect(review).toContainText('12.0 NM');
        await expect(review).toContainText('1.2 NM');
        await review.scrollIntoViewIfNeeded();
        await page.evaluate(
            () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        );
        await page.screenshot({ path: test.info().outputPath('route-comparison.png') });
        // This fixture has no authenticated active voyage. Real acceptance must
        // fail before any backend write; a forged ready UI is not authority.
        await review.getByRole('button', { name: 'Accept reviewed route' }).click();
        await expect(review.getByRole('status')).toContainText('changed');
        expect(
            await page.evaluate(() =>
                (window as unknown as { __routeReplan138: { followedId: () => string } }).__routeReplan138.followedId(),
            ),
        ).toBe('fictional-original');
        await review.getByRole('button', { name: 'Keep original route' }).click();
        await expect(page.getByText('Comparison closed. Original route retained.')).toBeVisible();
        expect(remote).toEqual([]);
    });
