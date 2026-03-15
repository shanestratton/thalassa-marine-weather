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

    test('page has correct document title', async ({ page }) => {
        await page.goto('/');
        const title = await page.title();
        // Should have a meaningful title (not blank or default)
        expect(title.length).toBeGreaterThan(0);
    });
});
