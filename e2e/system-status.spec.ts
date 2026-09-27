import { test, expect } from '@playwright/test';
import { DISCLAIMER_STORAGE } from './helpers/storageState';

test.describe('System status', () => {
    test.use({ storageState: DISCLAIMER_STORAGE });

    test('an unconnected gateway is neutral, not an invented fault', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();
        await page.getByRole('button', { name: /^Systems and GPS source/ }).click();

        const dialog = page.getByRole('dialog', { name: 'System status' });
        await expect(dialog).toBeVisible();
        // Named after the page it opens (UX scorecard run 7).
        await expect(dialog.getByText('NMEA gateway', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'View NMEA gateway' })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Fix NMEA gateway' })).toHaveCount(0);
        await expect(dialog.getByText('GPS sentences / sec')).toHaveCount(0);

        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        expect(errors).toEqual([]);
    });
});
