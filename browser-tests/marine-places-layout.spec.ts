import { expect, test } from '@playwright/test';

for (const width of [300, 375])
    test(`marine places persist across cold restart, spare Satellite WAN and fit ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 667 });
        await page.goto('/e2e/fixtures/marine-places.html');
        const dialog = page.getByRole('dialog', { name: 'Marine places' });
        await expect(dialog).toBeVisible();
        expect(
            await page.evaluate(
                () => (window as unknown as { catalogueFixtureRequests: string[] }).catalogueFixtureRequests,
            ),
        ).toEqual([]);
        await page.getByRole('textbox').fill('Coral');
        await page.getByRole('button', { name: 'Search marine places' }).click();
        await expect(page.getByRole('button', { name: /Coral Bay 1 —/ })).toBeVisible();
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await page.getByRole('button', { name: /Coral Bay 1 —/ }).click();
        await expect(page.getByText(/Representative location/)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Forecast in The Glass' })).toBeVisible();
        await expect(page.getByRole('link', { name: /GeoNames · CC BY.*geonames:1$/ })).toHaveAttribute(
            'href',
            'https://www.geonames.org/1/',
        );
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await page.getByRole('button', { name: 'Back to results' }).click();
        await page.getByRole('button', { name: 'Read / save shown area' }).click();
        await expect(page.getByRole('status')).toContainText('2 records shown');
        expect(
            await page.evaluate(() =>
                (window as unknown as { catalogueFixtureRequests: string[] }).catalogueFixtureRequests.some((url) =>
                    url.includes('/noaa/'),
                ),
            ),
        ).toBe(false);
        await page.getByRole('button', { name: 'NOAA-derived data · user agreement' }).click();
        const agreement = page.getByRole('dialog', { name: 'NOAA chart agreement' });
        await expect(agreement.getByLabel('NOAA ENC User Agreement', { exact: true })).toContainText(
            '5. Trademarks and Copyright',
        );
        expect(await agreement.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        await agreement.getByRole('checkbox').check();
        await agreement.getByRole('button', { name: 'Accept NOAA agreement' }).click();
        await expect(agreement).toHaveCount(0);
        await page.getByRole('button', { name: 'Read / save shown area' }).click();
        await expect(page.getByRole('status')).toContainText('3 records shown');
        await expect(page.getByRole('status')).toContainText('Area saved for offline use');
        await expect(page.getByText(/Generated Fiji fixture only/).first()).toBeVisible();
        await page.goto('/e2e/fixtures/marine-places.html?offline=1');
        await page.getByRole('textbox').fill('Coral');
        await page.getByRole('button', { name: 'Search marine places' }).click();
        await expect(page.getByRole('button', { name: /Coral Bay 1 —/ })).toBeVisible();
        await expect(page.getByRole('status')).toContainText('Saved data only');
        expect(
            await page.evaluate(
                () => (window as unknown as { catalogueFixtureRequests: string[] }).catalogueFixtureRequests,
            ),
        ).toEqual([]);
        await page.getByRole('button', { name: 'Delete saved catalogue' }).click();
        await expect(page.getByRole('status')).toHaveText('Saved public catalogue deleted.');
        await page.reload();
        await page.getByRole('textbox').fill('Coral');
        await page.getByRole('button', { name: 'Search marine places' }).click();
        await expect(page.getByRole('status')).toContainText('not been published');
        expect(
            await page.evaluate(
                () => (window as unknown as { catalogueFixtureRequests: string[] }).catalogueFixtureRequests,
            ),
        ).toEqual([]);
        await page.getByRole('button', { name: 'Close', exact: true }).focus();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });
