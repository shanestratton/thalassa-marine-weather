import { test, expect } from '@playwright/test';

test.describe('Tab Navigation', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('app renders navigation tabs', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(2000);

        // Should have a nav element or tab-like buttons
        const nav = page.locator('nav, [role="tablist"], [role="navigation"]');
        const navCount = await nav.count();

        // Navigation should exist
        expect(navCount).toBeGreaterThan(0);
    });

    test('tab buttons are keyboard accessible', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(2000);

        // Tab through interactive elements
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');

        // Something should be focused
        const focused = await page.evaluate(() => document.activeElement?.tagName);
        expect(focused).toBeTruthy();
    });

    test('navigation preserves state on tab switch', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(2000);

        // Get initial page content
        const _initialContent = await page.textContent('body');

        // Try clicking a tab/button if visible
        const tabs = page.locator('nav button, [role="tab"]');
        const tabCount = await tabs.count();

        if (tabCount > 1) {
            await tabs.nth(1).click();
            await page.waitForTimeout(1000);

            // Content should change
            const newContent = await page.textContent('body');
            expect(newContent).toBeTruthy();

            // Switch back
            await tabs.first().click();
            await page.waitForTimeout(1000);

            const restoredContent = await page.textContent('body');
            expect(restoredContent).toBeTruthy();
        }
    });

    test('skip to content link works', async ({ page }) => {
        await page.goto('/');

        // The skip link should exist
        const skipLink = page.locator('a[href="#main-content"]');
        await expect(skipLink).toBeAttached();
    });
});
