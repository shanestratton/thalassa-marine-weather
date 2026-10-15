import { expect, test } from '@playwright/test';
import { expectWideFaceDrawn } from '../e2e/helpers/wideFonts';
import { SIZES, expectCategoryGrid, expectNothingSideways, expectSheetFits, openBinder } from './helpers/binderLayout';

/**
 * The Documents sheet fits one screen (132-B19). The page's cards and menu
 * are measured in documents-layout.spec.ts; this is its Add document and
 * Edit document sheet: the real DocumentsHub under a copy of the app's header
 * and tab bar (e2e/fixtures/binder-sheets.tsx), in wide fonts, at 375 x 667
 * (an SE), 320 x 568 and 390 x 844:
 *
 *  - Add document and Save changes stay on screen, inside the sheet, while
 *    the fields scroll above them (they sat below the fold on an SE);
 *  - the six categories are the Stores grid, every label whole at 320 px
 *    ('Registration' ran out of its pill);
 *  - the notes are folded away until asked for, and open when there are some;
 *  - the search finds a paper by its notes.
 */

for (const size of SIZES) {
    test(`Documents at ${size.name}: Add document keeps its button on screen`, async ({ page }) => {
        const errors = await openBinder(page, 'documents', size);
        await page.getByRole('button', { name: 'Add document', exact: true }).click({ timeout: 25_000 });
        const sheet = page.getByRole('dialog', { name: 'Add document' });
        const add = sheet.getByRole('button', { name: 'Add document', exact: true });
        await expectSheetFits(page, sheet, add, size, 'Add document');
        await expectWideFaceDrawn(add);
        await expect(add).toBeDisabled();
        await expect(sheet.getByText('Document name is required')).toBeVisible();

        const grid = sheet.getByRole('group', { name: 'Document category' });
        await expectCategoryGrid(grid, 6, 'the document categories');
        await grid.getByRole('button', { name: 'Crew IDs category' }).click();
        // The owner's line under the grid, and Save still on screen with it.
        await expect(sheet.getByText('Only you see crew IDs, even when you share Documents with crew.')).toBeVisible();
        await sheet.getByRole('button', { name: 'Add notes' }).click();
        await expect(sheet.getByLabel('Notes (optional)')).toBeFocused();
        await sheet.getByRole('textbox', { name: /Document name/ }).fill('Passport, Søren Holm');
        await expect(add).toBeEnabled();
        await expectSheetFits(page, sheet, add, size, 'Add document, filled in');
        expect(errors).toEqual([]);
    });

    test(`Documents at ${size.name}: Edit document keeps Save on screen, its notes open`, async ({ page }) => {
        const errors = await openBinder(page, 'documents', size);
        await page.getByRole('button', { name: 'Edit Hull insurance, Horta to Opua' }).click({ timeout: 25_000 });
        const sheet = page.getByRole('dialog', { name: 'Edit document' });
        await expectSheetFits(page, sheet, sheet.getByRole('button', { name: 'Save changes' }), size, 'Edit document');
        await expect(sheet.getByLabel('Notes (optional)')).toHaveValue('Policy KX-2231, agent Pico Marine');
        await expect(sheet.getByRole('button', { name: 'Insurance category' })).toHaveAttribute('aria-pressed', 'true');
        expect(errors).toEqual([]);
    });

    test(`Documents at ${size.name}: the search finds a paper by its notes`, async ({ page }) => {
        const errors = await openBinder(page, 'documents', size);
        const search = page.getByRole('textbox', { name: 'Search documents' });
        await search.fill('VJN4417', { timeout: 25_000 });
        await expect(page.getByText('Ship radio licence', { exact: true })).toBeVisible();
        await expect(page.getByText('Registo de Propriedade', { exact: true })).toHaveCount(0);
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });
}
