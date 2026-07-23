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
        // Wait for dashboard to settle
        await page.waitForTimeout(3000);

        // Dismiss feature intro modal if it appears ("Your Weather" intro slides)
        const skipBtn = page.getByText('Skip', { exact: true });
        if (await skipBtn.isVisible({ timeout: 2000 })) {
            await skipBtn.click();
            await page.waitForTimeout(1000);
        }

        // Should see meaningful content — not a blank page
        const body = await page.textContent('body');
        expect(body?.length).toBeGreaterThan(50);

        // Check for weather-related UI elements (may or may not have API data)
        const hasContent = async () => {
            try {
                if (await page.getByText('Sydney', { exact: false }).first().isVisible()) return true;
            } catch {
                /* noop */
            }
            try {
                if (await page.getByText('WX', { exact: false }).first().isVisible()) return true;
            } catch {
                /* noop */
            }
            try {
                if (await page.locator('[class*="hero"], [class*="dashboard"], nav').first().isVisible()) return true;
            } catch {
                /* noop */
            }
            return false;
        };
        expect(await hasContent()).toBe(true);
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
        await page.waitForTimeout(3000);
        // The root should have either theme-onshore or theme-offshore
        const root = page.locator('[class*="theme-"]');
        const count = await root.count();
        expect(count).toBeGreaterThan(0);
    });
});
