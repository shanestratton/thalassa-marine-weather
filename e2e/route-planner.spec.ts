import { test, expect } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

test.use({ storageState: ONBOARDED_STORAGE });

test('planner parks the comfort card without hiding departure or route controls', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Navigate to Plan', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Route Planner', exact: true })).toBeVisible();

    const planner = page.locator('.route-planner-page');
    await expect(planner).toBeVisible();
    await expect(planner.getByRole('button', { name: /Comfort/i })).toHaveCount(0);
    await expect(planner.getByLabel('Departure date', { exact: true })).toBeVisible();
    await expect(planner.getByLabel('Departure date', { exact: true })).toBeEnabled();
    await expect(planner.getByRole('button', { name: /From a past voyage/i })).toBeVisible();
    await expect(planner.getByRole('button', { name: /Saved routes/i })).toBeVisible();

    await planner.getByRole('button', { name: 'Page actions', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Route Planner actions' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Import GPX/i })).toBeEnabled();
});
