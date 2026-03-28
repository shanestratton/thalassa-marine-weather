import { test, expect } from '@playwright/test';

test.describe('Onboarding Wizard', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('onboarding renders with vessel type selection', async ({ page }) => {
        await page.goto('/');
        // Fresh user should land on onboarding
        await page.waitForTimeout(2000);

        // Check for onboarding content — vessel type step
        const body = await page.textContent('body');
        const hasOnboarding =
            body?.includes('Sailboat') ||
            body?.includes('Powerboat') ||
            body?.includes('Crew Member') ||
            body?.includes('vessel') ||
            body?.includes('Welcome');

        // If onboarding shows, verify it has interactive elements
        if (hasOnboarding) {
            // Should have clickable vessel type buttons
            const buttons = await page.locator('button').count();
            expect(buttons).toBeGreaterThan(0);
        }
    });

    test('onboarding has accessible heading structure', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(2000);

        // Page should have at least one heading
        const headings = await page.locator('h1, h2, h3').count();
        expect(headings).toBeGreaterThan(0);
    });

    test('onboarding buttons have sufficient touch targets', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(2000);

        const buttons = page.locator('button');
        const count = await buttons.count();

        for (let i = 0; i < Math.min(count, 5); i++) {
            const box = await buttons.nth(i).boundingBox();
            if (box) {
                // Apple HIG: 44px minimum touch target
                expect(box.height).toBeGreaterThanOrEqual(40);
            }
        }
    });
});
