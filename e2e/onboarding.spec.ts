import { test, expect } from '@playwright/test';

test.describe('First-run legal gate', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('shows the navigation disclaimer before app content', async ({ page }) => {
        await page.goto('/');
        const dialog = page.getByRole('dialog', { name: 'Important Notice' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('Not for Navigation')).toBeVisible();
    });

    test('requires reading before acceptance and then opens the app', async ({ page }) => {
        await page.goto('/');
        const disclaimer = page.getByRole('document', { name: 'Navigation disclaimer text' });
        await expect(page.getByRole('button', { name: /Accept navigation disclaimer/i })).toHaveCount(0);
        await disclaimer.evaluate((element) => element.scrollTo(0, element.scrollHeight));

        const accept = page.getByRole('button', { name: /Accept navigation disclaimer/i });
        await expect(accept).toBeVisible();
        await accept.click();
        await expect(page.getByRole('dialog', { name: 'Important Notice' })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Welcome aboard' })).toBeVisible();
    });

    test('accept control meets the mobile touch-target minimum', async ({ page }) => {
        await page.goto('/');
        const disclaimer = page.getByRole('document', { name: 'Navigation disclaimer text' });
        await disclaimer.evaluate((element) => element.scrollTo(0, element.scrollHeight));
        const box = await page.getByRole('button', { name: /Accept navigation disclaimer/i }).boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
    });
});
