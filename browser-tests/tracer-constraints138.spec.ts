import { expect, test } from '@playwright/test';
for (const width of [300, 375])
    test(`Tracer choices preserve original marks and restore safely at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 812 });
        const remote: string[] = [];
        await page.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol === 'blob:') return route.continue();
            remote.push(url.hostname);
            return route.abort();
        });
        await page.goto('/e2e/fixtures/tracer-constraints138.html');
        await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
        await page.getByRole('spinbutton', { name: 'Passing offset in metres' }).fill('100');
        await page.getByRole('button', { name: 'Leave port' }).click();
        await expect(page.getByRole('button', { name: 'Leave port' })).toHaveAttribute('aria-pressed', 'true');
        await expect(
            page.getByText('Original mark 0.00000, 1.00000; numbered pin is its passing point.'),
        ).toBeVisible();
        let points = JSON.parse((await page.getByTestId('point-intent').textContent())!);
        expect(points[1]).toMatchObject({
            constraint: { lat: 0, lon: 1, leaveSide: 'port', standOffM: 100, courseBearing: 90 },
        });
        expect(points[1].lat).toBeLessThan(0);
        expect(await page.locator('main').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
        await page.getByRole('button', { name: 'Save local route' }).click();
        await expect(page.getByText('Saved locally', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Reverse draft' }).click();
        await expect(page.getByRole('button', { name: 'Leave starboard' })).toHaveAttribute('aria-pressed', 'true');
        await page.getByRole('button', { name: 'Restore saved route' }).click();
        await expect(page.getByRole('button', { name: 'Leave port' })).toHaveAttribute('aria-pressed', 'true');
        await page.reload();
        await expect(page.getByRole('button', { name: 'Leave port' })).toHaveAttribute('aria-pressed', 'true');
        points = JSON.parse((await page.getByTestId('point-intent').textContent())!);
        expect(points[1].constraint.standOffM).toBe(100);
        await page.evaluate(
            () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
        );
        await page.screenshot({ path: test.info().outputPath('tracer-side-choice.png') });
        await page.getByRole('button', { name: 'Change fixture account' }).click();
        await expect(page.getByTestId('point-intent')).toHaveText('[]');
        await expect(page.getByRole('button', { name: 'Leave port' })).toHaveCount(0);
        expect(remote).toEqual([]);
    });
