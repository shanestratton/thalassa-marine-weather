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

test('departure has one persistent Now action and no OK button', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('tab', { name: 'Navigate to Plan', exact: true }).click();
    const planner = page.locator('.route-planner-page');
    const date = planner.getByLabel('Departure date', { exact: true });
    const now = planner.getByRole('button', { name: 'Now', exact: true });
    await expect(date).toBeVisible();
    await expect(now).toBeVisible();
    await expect(now).toBeEnabled();
    await expect(planner.getByRole('button', { name: 'OK', exact: true })).toHaveCount(0);
    const originalSize = await now.boundingBox();
    const today = await date.inputValue();
    const future = new Date(`${today}T12:00:00Z`);
    future.setUTCDate(future.getUTCDate() + 2);
    const scheduledDate = future.toISOString().slice(0, 10);
    await date.fill(scheduledDate);
    await expect(date).toHaveValue(scheduledDate);
    await expect(planner.getByText('leaving now', { exact: true })).toHaveCount(0);

    for (let press = 0; press < 2; press++) {
        await now.click();
        await expect(now).toBeVisible();
        await expect(now).toBeEnabled();
        await expect(date).toHaveValue(today);
        await expect(planner.getByText('leaving now', { exact: true })).toBeVisible();
        const size = await now.boundingBox();
        expect(size?.width).toBe(originalSize?.width);
        expect(size?.height).toBe(originalSize?.height);
        await expect(planner.getByRole('button', { name: 'OK', exact: true })).toHaveCount(0);
    }
});
