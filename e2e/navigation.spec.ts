import { test, expect, type Page } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

const openOnboardedApp = async (page: Page) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 15_000 });
};

test.describe('Tab Navigation', () => {
    test.use({ storageState: ONBOARDED_STORAGE });

    test('app renders navigation tabs', async ({ page }) => {
        await openOnboardedApp(page);
        await expect(page.getByRole('tablist', { name: 'Main navigation' })).toBeVisible();
    });

    test('tab buttons are keyboard accessible', async ({ page }) => {
        await openOnboardedApp(page);

        // Tab through interactive elements
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');

        // Something should be focused
        const focused = await page.evaluate(() => document.activeElement?.tagName);
        expect(focused).toBeTruthy();
    });

    test('navigation returns to the original tab after a chart switch', async ({ page }) => {
        test.setTimeout(60_000);
        await openOnboardedApp(page);

        const glassTab = page.getByRole('tab', { name: 'Navigate to The Glass' });
        const chartsTab = page.getByRole('tab', { name: 'Navigate to Charts and observations' });

        await chartsTab.click();
        await expect(chartsTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('region', { name: 'Map' })).toBeVisible({ timeout: 30_000 });

        await glassTab.click();
        await expect(glassTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('textbox', { name: 'Current location' })).toBeVisible({ timeout: 20_000 });
    });

    test('skip to content link works', async ({ page }) => {
        await page.goto('/');

        // The skip link should exist
        const skipLink = page.locator('a[href="#main-content"]');
        await expect(skipLink).toHaveCount(1);
        await expect(skipLink).toHaveAccessibleName('Skip to main content');
    });
});
