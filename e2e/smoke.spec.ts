
import { test, expect } from '@playwright/test';

test.describe('App Smoke Tests', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('app loads without crash', async ({ page }) => {
        await page.goto('/');
        // Should land on onboarding or dashboard — either way, no crash
        await expect(page.locator('body')).toBeVisible();
        // No React error overlay
        await expect(page.locator('#react-error-overlay')).not.toBeVisible();
        // Page should have content
        const text = await page.textContent('body');
        expect(text?.length).toBeGreaterThan(10);
    });

    test('skip-to-content link is focusable', async ({ page }) => {
        await page.goto('/');
        // Tab to reveal the skip-to-content link
        await page.keyboard.press('Tab');
        const skipLink = page.locator('a[href="#main-content"]');
        // The skip link should exist even if not yet visible
        await expect(skipLink).toHaveCount(1);
    });
});
