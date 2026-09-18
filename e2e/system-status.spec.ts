import { test, expect } from '@playwright/test';
import { DISCLAIMER_STORAGE } from './helpers/storageState';

test.describe('System status', () => {
    test.use({ storageState: DISCLAIMER_STORAGE });

    test('an unconnected gateway is neutral, not an invented fault', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();
        await page.getByRole('button', { name: /^System status:/ }).click();

        const dialog = page.getByRole('dialog', { name: 'System Status' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('NMEA Backbone', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'View NMEA Backbone' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Fix NMEA Backbone' })).toHaveCount(0);
        await expect(dialog.getByText('GPS sentences / sec')).toHaveCount(0);

        await dialog.getByRole('button', { name: 'Close system status' }).click();
        await expect(dialog).toHaveCount(0);
        expect(errors).toEqual([]);
    });
});
