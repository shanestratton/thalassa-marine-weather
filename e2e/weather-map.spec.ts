import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { ONBOARDED_STORAGE } from './helpers/storageState';

// The build's default base (useMapBase defaultMapBase): Relief + Sat once the
// relief tiles have an address (since 2026-10-06), Satellite before then.
const reliefSource = readFileSync(new URL('../components/map/reliefBase.ts', import.meta.url), 'utf8');
const reliefConfigured = Boolean(
    process.env.VITE_RELIEF_TILE_BASE || /RELIEF_R2_URL_PLACEHOLDER = '[^']+'/.test(reliefSource),
);

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
        const chartsTab = page
            .getByRole('navigation', { name: 'Main', exact: true })
            .getByRole('button', { name: 'Obs', exact: true });
        await expect(chartsTab).toBeEnabled();
        await chartsTab.click();
        await expect(chartsTab).toHaveAttribute('aria-current', 'page');
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
            const initialBase = reliefConfigured ? 'Relief + Sat' : 'Satellite';
            const chosenBase = 'Ocean';
            await page.goto('/');
            await page
                .getByRole('navigation', { name: 'Main', exact: true })
                .getByRole('button', { name: 'Obs', exact: true })
                .click();
            await expect(page.getByTestId('map-hub')).toBeVisible();
            const defaultButton = page.getByRole('button', { name: `Map base: ${initialBase}`, exact: true });
            await expect(defaultButton).toBeVisible();
            await defaultButton.click();
            await page.getByRole('menuitemradio', { name: new RegExp(`^${chosenBase} `) }).click();
            await expect(page.getByRole('button', { name: `Map base: ${chosenBase}`, exact: true })).toBeVisible();

            await page
                .getByRole('navigation', { name: 'Main', exact: true })
                .getByRole('button', { name: 'The Glass', exact: true })
                .click();
            await page
                .getByRole('navigation', { name: 'Main', exact: true })
                .getByRole('button', { name: 'Obs', exact: true })
                .click();
            await expect(page.getByRole('button', { name: `Map base: ${chosenBase}`, exact: true })).toBeVisible();
        });
    });
}
