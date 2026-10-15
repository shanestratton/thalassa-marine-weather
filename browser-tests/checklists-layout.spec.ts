import { expect, test } from '@playwright/test';
import { expectWideFaceDrawn } from '../e2e/helpers/wideFonts';
import {
    SIZES,
    expectCtaAboveTabBar,
    expectHeaderWhole,
    expectNoClippedText,
    expectNothingSideways,
    expectSheetFits,
    openBinder,
} from './helpers/binderLayout';

/**
 * Checklists fit one screen (132-B19). The real ChecklistsPage with two
 * lists, under a copy of the app's header and tab bar
 * (e2e/fixtures/binder-sheets.tsx), in wide fonts, at 375 x 667 (an SE),
 * 320 x 568 and 390 x 844:
 *
 *  - the page's header, search and lists fit, nothing sideways, and 'Add
 *    checklist or item' ends above the tab bar;
 *  - the Add and Edit item sheets keep their buttons on screen;
 *  - a run's items and its Complete fit, clear of the tab bar.
 */

for (const size of SIZES) {
    test(`Checklists at ${size.name}: the page fits, Add above the tab bar`, async ({ page }) => {
        const errors = await openBinder(page, 'checklists', size);
        await expect(page.getByRole('heading', { level: 1, name: 'Checklists' })).toBeVisible({ timeout: 25_000 });
        const long = page.getByText('Leaving the mooring at Ponta Delgada', { exact: true });
        await expect(long).toBeVisible();
        await expectWideFaceDrawn(long);
        await expectHeaderWhole(page, size);
        await expect(page.getByRole('textbox', { name: 'Search checklists' })).toBeVisible();
        await expectNoClippedText(long, 'the list name');
        await expectCtaAboveTabBar(page, 'Add checklist or item');
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });

    test(`Checklists at ${size.name}: the Add and Edit item sheets keep their buttons on screen`, async ({ page }) => {
        const errors = await openBinder(page, 'checklists', size);
        await page.getByRole('button', { name: 'Add checklist or item', exact: true }).click({ timeout: 25_000 });
        const sheet = page.getByRole('dialog', { name: 'Add to checklists' });
        // With lists already made, an item is what it adds first.
        await expectSheetFits(page, sheet, sheet.getByRole('button', { name: 'Add item' }), size, 'Add item');
        await sheet.getByRole('button', { name: 'Checklist', exact: true }).click();
        await expectSheetFits(page, sheet, sheet.getByRole('button', { name: 'Add checklist' }), size, 'Add checklist');
        await sheet.getByRole('button', { name: 'Close' }).click();
        await expect(sheet).toHaveCount(0);

        await page.getByRole('button', { name: 'Edit checklist item: Raw-water seacock open' }).click();
        const edit = page.getByRole('dialog', { name: 'Edit item' });
        await expectSheetFits(page, edit, edit.getByRole('button', { name: 'Save changes' }), size, 'Edit item');
        await expectSheetFits(page, edit, edit.getByRole('button', { name: 'Delete item' }), size, 'Delete item');
        expect(errors).toEqual([]);
    });

    test(`Checklists at ${size.name}: a run's items and Complete fit`, async ({ page }) => {
        const errors = await openBinder(page, 'checklists', size);
        await page.getByRole('button', { name: 'Run Leaving the mooring at Ponta Delgada' }).click({ timeout: 25_000 });
        const complete = page.getByRole('button', { name: 'Complete checklist run' });
        await expect(complete).toBeVisible();
        await complete.scrollIntoViewIfNeeded();
        const m = await complete.evaluate((button, inset) => {
            const r = button.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
                top: r.top,
                bottom: r.bottom + inset,
                H: window.innerHeight,
                reached: !!hit && (hit === button || button.contains(hit)),
            };
        }, size.insets.bottom);
        expect(m.top, 'Complete is on screen').toBeGreaterThanOrEqual(0);
        expect(m.bottom, 'Complete clears the home indicator').toBeLessThanOrEqual(m.H + 0.5);
        expect(m.reached, 'a tap on Complete reaches it').toBe(true);
        await expectNoClippedText(page.getByRole('button', { name: 'Exit checklist run' }), 'Exit');
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });
}
