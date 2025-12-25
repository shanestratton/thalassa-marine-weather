
import { test, expect } from '@playwright/test';

test.describe('Critical Path', () => {
  // Reset storage state before test
  test.use({ storageState: { cookies: [], origins: [] } });

  test('User can onboard, view dashboard, and plan a route', async ({ page }) => {
    // 1. Initial Load & Redirect to Onboarding
    await page.goto('/');
    
    // Verify Welcome Screen
    await expect(page.getByText('Welcome to Thalassa')).toBeVisible();
    await page.getByRole('button', { name: 'Get Started' }).click();

    // 2. Set Home Port
    await expect(page.getByText('Where is your Home Port?')).toBeVisible();
    const input = page.getByPlaceholder('e.g. Newport, RI');
    await input.fill('San Francisco, CA');
    await page.getByRole('button', { name: 'Next' }).click();

    // 3. Select Vessel Type
    await expect(page.getByText('What brings you to the water?')).toBeVisible();
    await page.getByText('Sailing').click();
    await page.getByRole('button', { name: 'Next' }).click();

    // 4. Vessel Details (Use Defaults)
    await expect(page.getByText('Tell us about your boat')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    // 5. Unit Preferences & Finish
    await expect(page.getByText('Unit Preferences')).toBeVisible();
    await page.getByRole('button', { name: 'Launch Dashboard' }).click();

    // 6. Verify Dashboard Load
    // Wait for the location title to appear (simulating data fetch)
    await expect(page.getByText('San Francisco, CA', { exact: false })).toBeVisible({ timeout: 15000 });
    
    // Verify key widgets are present
    await expect(page.getByText('Wind')).toBeVisible();
    await expect(page.getByText('Captain\'s Log')).toBeVisible();

    // 7. Navigate to Passage Planner
    // Click the bottom navigation bar item
    await page.getByText('Passage').click();

    // 8. Verify Route Planner
    await expect(page.getByText('Passage Planning')).toBeVisible();
    
    // Verify inputs are pre-filled or available
    const startPort = page.getByPlaceholder('Start Port');
    await expect(startPort).toHaveValue('San Francisco, CA');
    
    await page.getByPlaceholder('End Port').fill('Santa Barbara, CA');
    
    // Check unlock state (Assuming default is Pro for dev, or Locked)
    // If LOCKED:
    if (await page.getByText('Unlock Route Intelligence').isVisible()) {
        await expect(page.getByText('Premium Feature')).toBeVisible();
    } else {
        // If PRO:
        await expect(page.getByRole('button', { name: 'Chart Route' })).toBeVisible();
    }
  });
});
