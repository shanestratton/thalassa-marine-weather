import { expect, test, type Page } from '@playwright/test';
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
 * Maintenance fits one screen, and has a search (132-B19). The real
 * MaintenanceHub with the forty suggested tasks, an open repair, a paused
 * task and a repair marked fixed, engine hours not yet entered, under a copy
 * of the app's header and tab bar (e2e/fixtures/binder-sheets.tsx), in wide
 * fonts, at 375 x 667 (an SE), 320 x 568 and 390 x 844:
 *
 *  - the search sits under the engine-hours row, the list keeps room for a
 *    task under it, and Add task ends above the tab bar;
 *  - the search finds a task by its notes ('weed', the seeded strainer's
 *    plain wording), and opens Paused and Fixed on what it finds there;
 *  - New task and Edit task keep their button on screen while the fields
 *    scroll above it, pick category and schedule on the Stores grid with
 *    every label whole at 320 px ('Six-monthly', 'Engine hours'), and fold
 *    the notes away until asked for.
 */

const cards = (page: Page) => page.getByRole('button', { name: /^Options for / });

for (const size of SIZES) {
    test(`Maintenance at ${size.name}: search under the hours, a task in view, Add task above the tab bar`, async ({
        page,
    }) => {
        const errors = await openBinder(page, 'maintenance', size);
        await expect(page.getByRole('heading', { level: 1, name: 'Maintenance' })).toBeVisible({ timeout: 25_000 });
        await expectHeaderWhole(page, size);
        const search = page.getByRole('textbox', { name: 'Search maintenance tasks' });
        await expect(search).toBeVisible();
        await expectWideFaceDrawn(search);
        await expectCtaAboveTabBar(page, 'Add task');

        // Between the search and Add task the first task's name still shows
        // whole, with a phone's home indicator taking its share of the list.
        const m = await search.evaluate((input, inset) => {
            const list = input.parentElement!.nextElementSibling!;
            const box = list.getBoundingClientRect();
            const first = list.querySelector('h3')!.getBoundingClientRect();
            const hours = document.querySelector('[aria-label^="Engine hours not set"]')!.getBoundingClientRect();
            return {
                searchBelowHours: input.getBoundingClientRect().top >= hours.bottom - 0.5,
                firstShows: first.top >= box.top - 0.5 && first.bottom <= box.bottom - inset + 0.5,
                list: Math.round(box.height - inset),
                spare: Math.round(box.bottom - inset - first.bottom),
            };
        }, size.insets.bottom);
        // Under the real header (its SKIPPER · BETA badge wraps in wide fonts)
        // the list is tight at 320 x 568: 64 px, the first name 8 px clear in
        // Verdana. Noted on every run so CI's DejaVu Sans figure is on record.
        test.info().annotations.push({
            type: 'list room',
            description: `${m.list} px at ${size.name}, the first task's name ${m.spare} px clear`,
        });
        expect(m.searchBelowHours, 'the search sits under the engine-hours row').toBe(true);
        expect(m.firstShows, `the first task's name shows whole (list ${m.list} px)`).toBe(true);
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });

    test(`Maintenance at ${size.name}: the search finds by notes, and opens Paused and Fixed`, async ({ page }) => {
        const errors = await openBinder(page, 'maintenance', size);
        const search = page.getByRole('textbox', { name: 'Search maintenance tasks' });
        await expect(cards(page).first()).toBeVisible({ timeout: 25_000 });
        expect(await cards(page).count()).toBeGreaterThanOrEqual(10);

        // By its notes: the seeded strainer check says plain 'weed' now.
        await search.fill('weed');
        await expect(cards(page)).toHaveCount(1);
        await expect(page.getByRole('button', { name: 'Options for Inspect Raw Water Strainer' })).toBeVisible();

        await search.fill('antifoul');
        await expect(page.getByRole('button', { name: 'Paused (1)' })).toHaveAttribute('aria-expanded', 'true');
        await expect(
            page.getByRole('button', { name: 'Options for Antifoul the hull at the haul-out in Whangārei' }),
        ).toBeVisible();

        await search.fill('tricolour');
        await expect(page.getByRole('button', { name: 'Fixed (1)' })).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByRole('button', { name: 'Options for Masthead tricolour flickering' })).toBeVisible();
        // The navigation lights' notes name the tricolour too.
        await expect(page.getByRole('button', { name: 'Options for Test Navigation Lights' })).toBeVisible();

        await search.fill('watermaker');
        await expect(page.getByText('No tasks match')).toBeVisible();
        await expect(cards(page)).toHaveCount(0);
        await expectNothingSideways(page);
        expect(errors).toEqual([]);
    });

    test(`Maintenance at ${size.name}: New task keeps Create task on screen`, async ({ page }) => {
        const errors = await openBinder(page, 'maintenance', size);
        await page.getByRole('button', { name: 'Add task', exact: true }).click({ timeout: 25_000 });
        const sheet = page.getByRole('dialog', { name: 'New task' });
        const create = sheet.getByRole('button', { name: 'Create task' });
        await expectSheetFits(page, sheet, create, size, 'New task');
        await expect(create).toBeDisabled();
        await expectCategoryGrid(sheet.getByRole('group', { name: 'Task category' }), 5, 'the task categories');
        const schedule = sheet.getByRole('group', { name: 'Schedule' });
        await expectCategoryGrid(schedule, 6, 'the schedules');
        await expect(sheet.getByLabel('Notes (optional)')).toHaveCount(0);

        // Engine hours: two more fields, and Create task still on screen.
        await schedule.getByRole('button', { name: 'Engine hours' }).click();
        await expect(sheet.getByLabel('Interval (hours)')).toBeVisible();
        await sheet.getByRole('textbox', { name: /Task name/ }).fill('Change the saildrive oil');
        await expect(create).toBeEnabled();
        await expectSheetFits(page, sheet, create, size, 'New task, by engine hours');

        // A repair asks for no schedule.
        await sheet.getByRole('button', { name: 'Repair', exact: true }).click();
        await expect(sheet.getByRole('group', { name: 'Schedule' })).toHaveCount(0);
        await expectSheetFits(page, sheet, create, size, 'New task, a repair');
        expect(errors).toEqual([]);
    });

    test(`Maintenance at ${size.name}: Edit task keeps Save on screen, its notes open`, async ({ page }) => {
        const errors = await openBinder(page, 'maintenance', size);
        await page.getByRole('button', { name: 'Options for Inspect Raw Water Strainer' }).click({ timeout: 25_000 });
        await page
            .getByRole('dialog', { name: 'Inspect Raw Water Strainer' })
            .getByRole('button', { name: 'Edit task' })
            .click();
        const sheet = page.getByRole('dialog', { name: 'Edit task' });
        await expectSheetFits(page, sheet, sheet.getByRole('button', { name: 'Save changes' }), size, 'Edit task');
        await expectCategoryGrid(sheet.getByRole('group', { name: 'Task category' }), 6, 'the task categories');
        await expectCategoryGrid(sheet.getByRole('group', { name: 'Schedule' }), 6, 'the schedules');
        await expect(sheet.getByLabel('Notes (optional)')).toHaveValue(
            'Check for weed, jellyfish, and debris. Clean basket if blocked.',
        );
        expect(errors).toEqual([]);
    });
}
