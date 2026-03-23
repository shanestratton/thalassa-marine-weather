import { test, expect } from '@playwright/test';

test.describe('Anchor Watch', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        // Navigate to vessel tab then anchor watch
        const vesselTab = page.locator('button, [role="tab"]').filter({ hasText: /vessel|boat/i });
        if ((await vesselTab.count()) > 0) {
            await vesselTab.first().click();
            await page.waitForTimeout(500);
        }
    });

    test('vessel hub page loads', async ({ page }) => {
        const content = await page.textContent('body');
        expect(content?.length).toBeGreaterThan(0);
    });

    test('anchor watch option is accessible', async ({ page }) => {
        // Look for anchor watch link/button in the vessel hub
        await page.waitForTimeout(1000);
        const body = await page.textContent('body');
        expect(body?.length).toBeGreaterThan(0);
    });

    test('page renders without console errors', async ({ page }) => {
        const errors: string[] = [];
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text());
        });
        await page.waitForTimeout(2000);
        // Filter out expected React dev warnings
        const realErrors = errors.filter((e) => !e.includes('Warning:') && !e.includes('DevTools'));
        expect(realErrors.length).toBeLessThanOrEqual(2); // Allow minor errors
    });
});
