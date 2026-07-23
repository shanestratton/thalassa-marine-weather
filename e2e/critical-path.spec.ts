import { test, expect } from '@playwright/test';
import { DISCLAIMER_STORAGE } from './helpers/storageState';

test.describe('Critical Path', () => {
    test.use({ storageState: DISCLAIMER_STORAGE });

    test('anonymous first run reaches the useful empty state', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Use my location' })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Choose a port on the map' })).toBeEnabled();
    });

    test('anonymous browsing exposes the primary navigation', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('tablist', { name: 'Main navigation' })).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Navigate to Charts' })).toBeEnabled();
    });

    test('anonymous user can move from the Glass to Charts', async ({ page }) => {
        await page.goto('/');
        const chartsTab = page.getByRole('tab', { name: 'Navigate to Charts' });
        await chartsTab.click();
        await expect(chartsTab).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('#main-content')).toBeVisible();
    });
});
