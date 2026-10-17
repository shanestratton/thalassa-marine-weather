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
    pageSettled,
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
 *  - a run's items and its Complete fit, clear of the tab bar;
 *  - opened empty, the title stays whole when the second item brings the ⋮
 *    (132-B20).
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
        await pageSettled(page);
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

    // A new skipper's first checklist (132-B20 review): the page opens empty,
    // with no ⋮, and its second item brings the ⋮ (Reorder items) after the
    // header was measured. At 320 x 568 'CHECKLISTS' was then cut by 18 px with
    // '‹ BOAT BINDER' still beside it.
    test(`Checklists at ${size.name}: from empty, the title stays whole when the ⋮ arrives`, async ({ page }) => {
        const errors = await openBinder(page, 'checklists', size, { empty: true });
        await expect(page.getByRole('heading', { level: 1, name: 'Checklists' })).toBeVisible({ timeout: 25_000 });
        await expect(page.getByRole('button', { name: 'Page actions' })).toHaveCount(0);
        await expectHeaderWhole(page, size);

        await page.getByRole('button', { name: 'New checklist', exact: true }).click();
        // 'New checklist' while there is none, 'Add to checklists' once there is.
        const sheet = page.getByRole('dialog', { name: /^(New checklist|Add to checklists)$/ });
        await sheet.getByRole('textbox', { name: /Checklist name/ }).fill('Pre-start');
        await sheet.getByRole('button', { name: 'Add checklist', exact: true }).click();
        // The sheet stays open and turns to Item, under the checklist just made.
        for (const item of ['Engine oil level', 'Fuel on']) {
            const field = sheet.getByRole('textbox', { name: /Check item/ });
            await expect(field).toHaveValue('');
            await field.fill(item);
            await sheet.getByRole('button', { name: 'Add item', exact: true }).click();
            await expect(page.getByText(item, { exact: true })).toBeAttached();
        }
        await sheet.getByRole('button', { name: 'Close' }).click();
        await expect(sheet).toHaveCount(0);

        await expect(page.getByRole('button', { name: 'Page actions' })).toBeVisible();
        await expectHeaderWhole(page, size);
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });
}
