
import { test, expect } from '@playwright/test';

/**
 * These tests simulate a post-onboarding state
 * by injecting localStorage with onboarded=true + minimal settings.
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

test.describe('Dashboard Navigation', () => {
    test.use({ storageState: ONBOARDED_STORAGE as any });

    test('dashboard loads with location name', async ({ page }) => {
        await page.goto('/');
        // Wait for dashboard to settle (weather fetch may take time)
        await page.waitForTimeout(3000);
        // Should see the location name somewhere
        await expect(page.getByText('Sydney', { exact: false })).toBeVisible({ timeout: 15000 });
    });

    test('bottom tabs are navigable', async ({ page }) => {
        await page.goto('/');
        await page.waitForTimeout(2000);

        // Check that navigation tabs exist
        const tabs = page.locator('nav, [role="tablist"], .bottom-nav');
        // If no explicit nav, look for common nav text
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
