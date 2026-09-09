import { test, expect } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

test.describe('Weather Map', () => {
    test.use({ storageState: ONBOARDED_STORAGE });

    let pageErrors: string[];

    test.beforeEach(async ({ page }) => {
        pageErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));
        await page.goto('/');
        // Charts is the map host in the primary navigation. The old fuzzy
        // “map” query frequently never found a tab, leaving every assertion
        // to pass on the dashboard instead.
        const chartsTab = page.getByRole('tab', { name: 'Navigate to Charts' });
        await expect(chartsTab).toBeEnabled();
        await chartsTab.click();
        await expect(chartsTab).toHaveAttribute('aria-selected', 'true');
    });

    test('charts renders the map host', async ({ page }) => {
        await expect(page.getByTestId('map-hub')).toBeVisible();
    });

    test('does not throw a critical runtime error while mounting charts', async () => {
        expect(pageErrors.filter((message) => /(?:TypeError|ReferenceError)/.test(message))).toEqual([]);
    });
});

for (const mode of ['light', 'dark', 'night'] as const) {
    test.describe(`OBS ${mode} display mode`, () => {
        test.use({
            storageState: {
                ...ONBOARDED_STORAGE,
                origins: ONBOARDED_STORAGE.origins.map((origin) => ({
                    ...origin,
                    localStorage: origin.localStorage.map((entry) => {
                        if (
                            entry.name !== 'thalassa_settings_mirror::anonymous' &&
                            entry.name !== 'CapacitorStorage.thalassa_settings::anonymous'
                        ) {
                            return entry;
                        }
                        const saved = JSON.parse(entry.value);
                        saved.settings.displayMode = mode;
                        return { ...entry, value: JSON.stringify(saved) };
                    }),
                })),
            },
        });

        test('uses the display default and keeps a manual choice when revisiting Charts', async ({ page }) => {
            const initialBase = mode === 'light' ? 'Ocean' : 'Satellite';
            const chosenBase = mode === 'light' ? 'Satellite' : 'Ocean';
            await page.goto('/');
            await page.getByRole('tab', { name: 'Navigate to Charts' }).click();
            await expect(page.getByTestId('map-hub')).toBeVisible();
            const defaultButton = page.getByRole('button', { name: `Map base: ${initialBase}`, exact: true });
            await expect(defaultButton).toBeVisible();
            await defaultButton.click();
            await page.getByRole('menuitemradio', { name: new RegExp(`^${chosenBase} `) }).click();
            await expect(page.getByRole('button', { name: `Map base: ${chosenBase}`, exact: true })).toBeVisible();

            await page.getByRole('tab', { name: 'Navigate to The Glass' }).click();
            await page.getByRole('tab', { name: 'Navigate to Charts' }).click();
            await expect(page.getByRole('button', { name: `Map base: ${chosenBase}`, exact: true })).toBeVisible();
        });
    });
}
