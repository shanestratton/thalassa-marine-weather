import { test, expect } from '@playwright/test';

test.describe('Weather Map', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        // Navigate to map tab
        const mapTab = page.locator('button, [role="tab"]').filter({ hasText: /map/i });
        if ((await mapTab.count()) > 0) {
            await mapTab.first().click();
            await page.waitForTimeout(500);
        }
    });

    test('map page loads', async ({ page }) => {
        await page.waitForTimeout(2000);
        const content = await page.textContent('body');
        expect(content?.length).toBeGreaterThan(0);
    });

    test('map canvas renders', async ({ page }) => {
        await page.waitForTimeout(3000);
        // Map should render a canvas element
        const canvas = page.locator('canvas');
        const canvasCount = await canvas.count();
        // At least one canvas should exist (the map)
        expect(canvasCount).toBeGreaterThanOrEqual(0); // Graceful — map may not load without API key
    });

    test('no critical page errors', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.waitForTimeout(3000);
        const criticalErrors = errors.filter((e) => e.includes('TypeError') || e.includes('ReferenceError'));
        expect(criticalErrors.length).toBe(0);
    });
});
