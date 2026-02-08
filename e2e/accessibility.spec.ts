
import { test, expect } from '@playwright/test';

/**
 * Accessibility-focused E2E tests.
 * Validates ARIA roles, focus management, and keyboard navigation.
 */

const ONBOARDED_STORAGE = {
    cookies: [],
    origins: [{
        origin: 'http://localhost:3000',
        localStorage: [
            { name: 'thalassa_v3_onboarded', value: 'true' },
            {
                name: 'thalassa_v3_settings',
                value: JSON.stringify({
                    defaultLocation: 'Sydney, NSW',
                    units: { speed: 'kts', temp: 'C', distance: 'nm', length: 'm', tideHeight: 'm', waveHeight: 'm', visibility: 'nm', volume: 'l' },
                    vessel: { name: 'Test Vessel', type: 'sail', length: 35, beam: 11, draft: 6, displacement: 12000 },
                    savedLocations: ['Sydney, NSW'],
                }),
            },
        ],
    }],
};

test.describe('Accessibility', () => {
    test.use({ storageState: ONBOARDED_STORAGE as any });

    test('modals have role=dialog and aria-modal', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(3000);

        // Try to open settings modal via gear icon or settings button
        const settingsBtn = page.locator('[aria-label="Settings"], button:has-text("Settings")').first();
        if (await settingsBtn.isVisible()) {
            await settingsBtn.click();
            await page.waitForTimeout(500);
        }

        // Check for any visible dialog elements
        const dialogs = page.locator('[role="dialog"]');
        const dialogCount = await dialogs.count();
        // If a dialog is open, verify aria-modal
        if (dialogCount > 0) {
            const firstDialog = dialogs.first();
            await expect(firstDialog).toHaveAttribute('aria-modal', 'true');
        }
    });

    test('keyboard Tab cycles through interactive elements', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(3000);

        // Press Tab several times and verify focus moves
        const focusedElements: string[] = [];
        for (let i = 0; i < 5; i++) {
            await page.keyboard.press('Tab');
            const tagName = await page.evaluate(() => document.activeElement?.tagName || 'none');
            focusedElements.push(tagName);
        }

        // At least some elements should receive focus (not all BODY)
        const nonBodyFocuses = focusedElements.filter(t => t !== 'BODY');
        expect(nonBodyFocuses.length).toBeGreaterThan(0);
    });

    test('Escape key closes modals', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(3000);

        // Try opening a modal
        const settingsBtn = page.locator('[aria-label="Settings"], button:has-text("Settings")').first();
        if (await settingsBtn.isVisible()) {
            await settingsBtn.click();
            await page.waitForTimeout(500);

            // Press Escape
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);

            // Dialog should be closed
            const dialogs = page.locator('[role="dialog"]');
            const count = await dialogs.count();
            // Either no dialogs, or none visible
            if (count > 0) {
                await expect(dialogs.first()).not.toBeVisible();
            }
        }
    });
});
