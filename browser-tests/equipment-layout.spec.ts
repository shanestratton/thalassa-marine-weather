import { expect, test } from '@playwright/test';
import { expectWideFaceDrawn } from '../e2e/helpers/wideFonts';
import {
    SIZES,
    expectCategoryGrid,
    expectCtaAboveTabBar,
    expectHeaderWhole,
    expectNothingSideways,
    expectSheetFits,
    expectTypingFits,
    openBinder,
} from './helpers/binderLayout';

/**
 * Equipment fits one screen (132-B19). The real EquipmentList, its Add
 * equipment and Edit equipment sheets, under a copy of the app's header and
 * tab bar (e2e/fixtures/binder-sheets.tsx), in wide fonts, at 375 x 667 (an
 * SE), 320 x 568 and 390 x 844:
 *
 *  - the register's header, search and cards fit, nothing sideways, and Add
 *    equipment ends above the tab bar;
 *  - each sheet keeps its main button on screen, inside the sheet, while its
 *    fields scroll above it (it sat below the fold on an SE), and with the
 *    keyboard up the field being typed in shows above the button;
 *  - the six categories are the Stores grid: three across, two rows, every
 *    label whole at 320 px ('Electronics' ran out of its pill);
 *  - the notes are folded away until asked for, and open when there are some.
 */

for (const size of SIZES) {
    test(`Equipment at ${size.name}: the register fits, Add equipment above the tab bar`, async ({ page }) => {
        const errors = await openBinder(page, 'equipment', size);
        await expect(page.getByRole('heading', { level: 1, name: 'Equipment' })).toBeVisible({ timeout: 25_000 });
        await expect(page.getByText('Main engine', { exact: true })).toBeVisible();
        await expectWideFaceDrawn(page.getByText('Main engine', { exact: true }));
        await expectHeaderWhole(page, size);
        await expect(page.getByRole('textbox', { name: 'Search equipment' })).toBeVisible();
        await expectCtaAboveTabBar(page, 'Add equipment');
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });

    test(`Equipment at ${size.name}: Add equipment keeps Register on screen`, async ({ page }) => {
        const errors = await openBinder(page, 'equipment', size);
        await page.getByRole('button', { name: 'Add equipment', exact: true }).click({ timeout: 25_000 });
        const sheet = page.getByRole('dialog', { name: 'Add equipment' });
        const register = sheet.getByRole('button', { name: 'Register new equipment' });
        await expectSheetFits(page, sheet, register, size, 'Add equipment');
        await expectWideFaceDrawn(register);
        await expect(register).toBeDisabled();

        const grid = sheet.getByRole('group', { name: 'Equipment category' });
        await expectCategoryGrid(grid, 6, 'the equipment categories');
        await grid.getByRole('button', { name: 'Select Electronics category' }).click();
        await expect(grid.getByRole('button', { name: 'Select Electronics category' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );

        // Notes are one row until asked for; the tap opens the field, in view, with the cursor in it.
        await expect(sheet.getByLabel('Notes (optional)')).toHaveCount(0);
        await sheet.getByRole('button', { name: 'Add notes' }).click();
        await expect(sheet.getByLabel('Notes (optional)')).toBeFocused();

        await sheet.getByRole('textbox', { name: /Equipment name/ }).fill('Liferaft, six-person, Horta service');
        await expect(register).toBeEnabled();
        await expectSheetFits(page, sheet, register, size, 'Add equipment, filled in');

        // With an SE's keyboard and its bar up (300 px), the serial number being
        // typed and Register both show: the sheet's own fields scroll, not the footer.
        await expectTypingFits(page, sheet.getByLabel('Serial number'), register, 300, 'Add equipment, typing');
        expect(errors).toEqual([]);
    });

    test(`Equipment at ${size.name}: Edit equipment keeps Save on screen, its notes open`, async ({ page }) => {
        const errors = await openBinder(page, 'equipment', size);
        await page.getByRole('button', { name: 'Options for Main engine' }).click({ timeout: 25_000 });
        await page.getByRole('button', { name: 'Edit Main engine' }).click();
        const sheet = page.getByRole('dialog', { name: 'Edit equipment' });
        const save = sheet.getByRole('button', { name: 'Save equipment changes' });
        await expectSheetFits(page, sheet, save, size, 'Edit equipment');
        await expectCategoryGrid(sheet.getByRole('group', { name: 'Equipment category' }), 6, 'the categories');
        await expect(sheet.getByLabel('Notes (optional)')).toHaveValue(/Oil and filter every 150 h/);
        expect(errors).toEqual([]);
    });
}
