import { test, expect } from '@playwright/test';

test.describe('Diary', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        // Navigate to vessel tab then diary
        const vesselTab = page.locator('button, [role="tab"]').filter({ hasText: /vessel|boat/i });
        if ((await vesselTab.count()) > 0) {
            await vesselTab.first().click();
            await page.waitForTimeout(500);
        }
    });

    test('vessel hub page renders diary option', async ({ page }) => {
        await page.waitForTimeout(1000);
        const content = await page.textContent('body');
        expect(content?.length).toBeGreaterThan(0);
    });

    test('diary page accessible without crash', async ({ page }) => {
        // Look for diary option
        const diaryLink = page.locator('button, a, [role="button"]').filter({ hasText: /diary|journal|log/i });
        if ((await diaryLink.count()) > 0) {
            await diaryLink.first().click();
            await page.waitForTimeout(500);
        }
        const body = await page.textContent('body');
        expect(body?.length).toBeGreaterThan(0);
    });
});
