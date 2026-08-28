import { test, expect } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

/**
 * These tests simulate a post-onboarding state
 * by injecting localStorage with onboarded=true + minimal settings.
 */

test.describe('Dashboard Navigation', () => {
    test.use({ storageState: ONBOARDED_STORAGE });

    test('dashboard loads with content', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

        // Dismiss feature intro modal if it appears ("Your Weather" intro slides)
        const skipBtn = page.getByText('Skip', { exact: true });
        if (await skipBtn.isVisible({ timeout: 2000 })) {
            await skipBtn.click();
            await page.waitForTimeout(1000);
        }

        await expect(page.getByRole('textbox', { name: 'Current location' })).toHaveValue('Sydney, NSW');
        await expect(page.getByRole('region', { name: 'Weather metrics dashboard' })).toBeVisible();
    });

    test('bottom tabs are navigable', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(2000);

        // Check that navigation tabs exist
        const logTab = page.getByText("Captain's Log");
        if (await logTab.isVisible()) {
            await logTab.click();
            await page.waitForTimeout(1000);
            // Should show log page content
            await expect(page.getByText('Log', { exact: false })).toBeVisible();
        }
    });

    test('theme classes are applied to root', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
        // ThemeProvider keeps its original wrapper for scoped styles and also
        // mirrors the theme to <html> so body-portaled overlays inherit it.
        const documentThemeRoot = page.locator('html[data-theme][class*="theme-"]');
        const providerThemeRoot = page.locator('#root > [data-theme][class*="theme-"]');

        await expect(documentThemeRoot).toHaveCount(1);
        await expect(providerThemeRoot).toHaveCount(1);

        const [documentTheme, providerTheme] = await Promise.all([
            documentThemeRoot.getAttribute('data-theme'),
            providerThemeRoot.getAttribute('data-theme'),
        ]);
        expect(documentTheme).toMatch(/^(onshore|offshore)$/);
        expect(providerTheme).toBe(documentTheme);
    });
});
