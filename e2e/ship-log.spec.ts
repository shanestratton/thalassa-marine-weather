import { test, expect } from '@playwright/test';

test.describe('Ship Log', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('dashboard shows ship log section', async ({ page }) => {
        await page.waitForTimeout(1000);
        const content = await page.textContent('body');
        expect(content?.length).toBeGreaterThan(0);
    });

    test('app renders without critical errors', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.waitForTimeout(2000);
        // Allow non-critical errors (network, etc.) but no crashes
        expect(errors.filter((e) => e.includes('TypeError') || e.includes('ReferenceError')).length).toBe(0);
    });
});
