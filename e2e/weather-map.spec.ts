import { test, expect } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

test.describe('Weather Map', () => {
    test.use({ storageState: ONBOARDED_STORAGE });

    let pageErrors: string[];

    test.beforeEach(async ({ page }) => {
        pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));
        await page.goto('/');
        // Charts is the map host in the primary navigation. The old fuzzy
        // “map” query frequently never found a tab, leaving every assertion
        // to pass on the dashboard instead.
        const chartsTab = page.getByRole('tab', { name: 'Navigate to Charts' });
        await expect(chartsTab).toBeEnabled();
        await chartsTab.click();
        await expect(chartsTab).toHaveAttribute('aria-selected', 'true');
    });

    test('charts renders the map host', async ({ page }) => {
        await expect(page.getByTestId('map-hub')).toBeVisible();
    });

    test('does not throw a critical runtime error while mounting charts', async () => {
        expect(pageErrors.filter((message) => /(?:TypeError|ReferenceError)/.test(message))).toEqual([]);
    });
});
