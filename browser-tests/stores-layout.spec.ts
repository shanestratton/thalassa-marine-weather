import { expect, test } from '@playwright/test';
import { expectWideFaceDrawn } from '../e2e/helpers/wideFonts';
import {
    SIZES,
    expectCategoryGrid,
    expectCtaAboveTabBar,
    expectHeaderWhole,
    expectNothingSideways,
    expectSheetFits,
    openBinder,
} from './helpers/binderLayout';

/**
 * Ship's Stores fits one screen (132-B19). The real InventoryList, its Add
 * item and Edit item sheets, under a copy of the app's header and tab bar
 * (e2e/fixtures/binder-sheets.tsx), in wide fonts, at 375 x 667 (an SE),
 * 320 x 568 and 390 x 844:
 *
 *  - the page's header, search and cards fit, nothing sideways, and Add
 *    item ends above the tab bar;
 *  - each sheet keeps its main button on screen while its fifteen-category
 *    grid (five rows) and fields scroll above it: Save was a long scroll
 *    below the fold on an SE. The grid's own measure is
 *    stores-category-grid-layout.spec.ts.
 */

for (const size of SIZES) {
    test(`Stores at ${size.name}: the page fits, Add item above the tab bar`, async ({ page }) => {
        const errors = await openBinder(page, 'stores', size);
        await expect(page.getByRole('heading', { level: 1, name: "Ship's Stores" })).toBeVisible({
            timeout: 25_000,
        });
        await expect(page.getByText('Raw-water impeller', { exact: true })).toBeVisible();
        await expectWideFaceDrawn(page.getByText('Raw-water impeller', { exact: true }));
        await expectHeaderWhole(page, size);
        await expectCtaAboveTabBar(page, 'Add item');
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });

    test(`Stores at ${size.name}: Add item keeps Cancel and Add item on screen`, async ({ page }) => {
        const errors = await openBinder(page, 'stores', size);
        await page.getByRole('button', { name: 'Add item', exact: true }).click({ timeout: 25_000 });
        const sheet = page.getByRole('dialog', { name: 'Add item' });
        const add = sheet.getByRole('button', { name: 'Add item', exact: true });
        await expectSheetFits(page, sheet, add, size, 'Add item');
        await expectSheetFits(page, sheet, sheet.getByRole('button', { name: 'Cancel adding item' }), size, 'Cancel');
        await expectCategoryGrid(sheet.getByRole('group', { name: 'Store category' }), 15, 'the store categories');
        await sheet.getByRole('textbox', { name: /Item name/ }).fill('Racor 2010PM-OR fuel filter');
        await expect(add).toBeEnabled();
        expect(errors).toEqual([]);
    });

    test(`Stores at ${size.name}: Edit item keeps Save on screen`, async ({ page }) => {
        const errors = await openBinder(page, 'stores', size);
        await page.getByRole('button', { name: 'Edit Fusibles lame 15 A' }).click({ timeout: 25_000 });
        const sheet = page.getByRole('dialog', { name: 'Edit item' });
        await expectSheetFits(
            page,
            sheet,
            sheet.getByRole('button', { name: 'Save inventory item changes' }),
            size,
            'Edit item',
        );
        await expect(
            sheet.getByRole('group', { name: 'Store category' }).getByRole('button', { name: 'Electrical' }),
        ).toHaveAttribute('aria-pressed', 'true');
        expect(errors).toEqual([]);
    });
}
