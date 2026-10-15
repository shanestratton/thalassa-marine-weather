/**
 * MealCalendar — component tests
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock service dependencies
vi.mock('../services/MealPlanService', () => ({
    scheduleMeal: vi.fn().mockResolvedValue(undefined),
    unscheduleMeal: vi.fn().mockResolvedValue(undefined),
    copyMealPlan: vi.fn().mockResolvedValue(undefined),
    getStoresAvailability: vi.fn(() => []),
}));

vi.mock('../services/GalleyRecipeService', () => ({
    scaleIngredient: vi.fn((amount: number) => amount),
    searchRecipes: vi.fn().mockResolvedValue([]),
    getGalleyDifficulty: vi.fn(() => ({ score: 1, label: 'Simple', emoji: '🟢' })),
    getRecipeImageUrl: vi.fn(() => ''),
    NAUTICAL_TAG_DEFS: [],
    deriveNauticalTags: vi.fn(() => []),
    isScalable: vi.fn(() => true),
    saveCustomRecipe: vi.fn().mockResolvedValue({ id: 'recipe-1' }),
}));

vi.mock('../services/ShoppingListService', () => ({
    addManualItem: vi.fn().mockResolvedValue(undefined),
    getShoppingList: vi.fn(() => ({ total: 0, purchased: 0, remaining: 0, totalCost: 0, currency: 'AUD', zones: [] })),
}));

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

vi.mock('../components/chat/CaptainsTable', () => ({
    CaptainsTable: () => <button>Community recipe result</button>,
}));

import { MealCalendar } from '../components/chat/MealCalendar';
import { copyMealPlan, getStoresAvailability, scheduleMeal, unscheduleMeal } from '../services/MealPlanService';
import type { MealPlan } from '../services/MealPlanService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getAll, getFullQueue, initLocalDatabase } from '../services/vessel/LocalDatabase';
import { searchRecipes } from '../services/GalleyRecipeService';
import { addManualItem, getShoppingList } from '../services/ShoppingListService';

describe('MealCalendar', () => {
    const baseProps = {
        crewCount: 4,
        voyageId: 'v1',
        ownerUserId: 'owner-1',
        voyageName: 'Brisbane to Sydney',
        activeMeals: [],
        onMealsChanged: vi.fn(),
        cookingMealId: null,
        onCookNow: vi.fn(),
        shoppingSummary: null,
        onCrewCountChange: vi.fn(),
        onShoppingChanged: vi.fn(),
    };

    beforeEach(() => vi.clearAllMocks());

    it('renders "Set Voyage Dates" when mealDays is null', () => {
        render(<MealCalendar {...baseProps} mealDays={null} />);
        expect(screen.getByText('Set Voyage Dates')).toBeDefined();
    });

    it('renders instruction text when no dates set', () => {
        render(<MealCalendar {...baseProps} mealDays={null} />);
        expect(screen.getByText(/Add departure and arrival dates/)).toBeDefined();
    });

    it('renders day grid when mealDays provided', () => {
        const mealDays = {
            dates: ['2026-03-27', '2026-03-28'],
            emergencyDates: new Set<string>(),
            passageDays: 2,
            emergencyDays: 0,
            totalDays: 2,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByText('Day 1')).toBeDefined();
        expect(screen.getByText('Day 2')).toBeDefined();
    });

    it('renders grid role for accessibility', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByRole('grid', { name: 'Meal calendar' })).toBeDefined();
    });

    it('renders crew count stepper', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByLabelText('Decrease crew count')).toBeDefined();
        expect(screen.getByLabelText('Increase crew count')).toBeDefined();
    });

    it('renders empty slot buttons for each meal slot', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        // 3 slots per day (Brekky, Lunch, Dinner per SLOT_CONFIG)
        expect(screen.getByLabelText(/Add Brekky meal/)).toBeDefined();
        expect(screen.getByLabelText(/Add Lunch meal/)).toBeDefined();
        expect(screen.getByLabelText(/Add Dinner meal/)).toBeDefined();
    });

    it('saves a popular meal as a simple planned meal without searching for a recipe', async () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);

        fireEvent.click(screen.getByRole('button', { name: /Add Dinner meal/ }));
        fireEvent.change(screen.getByRole('combobox', { name: 'Pick a popular recipe' }), {
            target: { value: 'Pad Thai' },
        });

        await waitFor(() =>
            expect(scheduleMeal).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'Pad Thai',
                    ingredients: [],
                    isSimpleMeal: true,
                    servings: 4,
                }),
                '2026-03-27',
                'dinner',
                'v1',
                4,
                'owner-1',
            ),
        );
        expect(searchRecipes).not.toHaveBeenCalled();
        expect(baseProps.onMealsChanged).toHaveBeenCalledTimes(1);
    });

    it('contains the recipe picker and restores focus after Escape', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        const opener = screen.getByRole('button', { name: /Add Brekky meal/ });
        opener.focus();
        fireEvent.click(opener);

        const search = screen.getByRole('textbox', { name: 'Search recipes' });
        expect(screen.getByRole('dialog', { name: /Add Brekky recipe/ })).toContainElement(search);
        expect(search).toHaveFocus();
        expect(search).toHaveAttribute('enterkeyhint', 'search');
        expect(search).not.toHaveAttribute('data-no-keyboard-scroll');
        expect(screen.getByRole('textbox', { name: 'Quick add meal name' })).not.toHaveAttribute(
            'data-no-keyboard-scroll',
        );
        fireEvent.keyDown(search, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: /Add Brekky recipe/ })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('keeps nested recipe-library focus above the picker and restores each layer in order', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        const opener = screen.getByRole('button', { name: /Add Brekky meal/ });
        fireEvent.click(opener);

        const libraryOpener = screen.getByRole('button', { name: 'Browse Community Recipes' });
        fireEvent.click(libraryOpener);
        const libraryClose = screen.getByRole('button', { name: 'Close recipe browser' });
        expect(screen.getByRole('dialog', { name: 'Recipe Library' })).toContainElement(libraryClose);
        expect(libraryClose).toHaveFocus();

        fireEvent.keyDown(libraryClose, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Recipe Library' })).not.toBeInTheDocument();
        expect(libraryOpener).toHaveFocus();

        fireEvent.keyDown(libraryOpener, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: /Add Brekky recipe/ })).not.toBeInTheDocument();
        expect(opener).toHaveFocus();
    });

    it('gives a nested custom-recipe dialog keyboard priority over the picker', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        fireEvent.click(screen.getByRole('button', { name: /Add Brekky meal/ }));

        const formOpener = screen.getByRole('button', { name: 'Create Custom Recipe' });
        fireEvent.click(formOpener);
        const titleInput = screen.getByRole('textbox', { name: 'Recipe name' });
        expect(screen.getByRole('dialog', { name: /New Recipe/ })).toContainElement(titleInput);
        expect(titleInput).toHaveFocus();

        fireEvent.keyDown(titleInput, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: /New Recipe/ })).not.toBeInTheDocument();
        expect(formOpener).toHaveFocus();
        expect(screen.getByRole('dialog', { name: /Add Brekky recipe/ })).toBeInTheDocument();
    });

    it('renders voyage name in header', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByText(/Brisbane to Sydney/)).toBeDefined();
    });

    it('marks buffer days distinctively', () => {
        const mealDays = {
            dates: ['2026-03-27', '2026-03-28'],
            emergencyDates: new Set(['2026-03-28']),
            passageDays: 1,
            emergencyDays: 1,
            totalDays: 2,
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} />);
        expect(screen.getByText('Buffer')).toBeDefined();
    });

    it('renders provision CTA when meals exist', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        const meal = {
            id: 'm1',
            user_id: 'owner-1',
            title: 'Eggs',
            planned_date: '2026-03-27',
            meal_slot: 'breakfast' as const,
            servings_planned: 4,
            status: 'reserved' as const,
            spoonacular_id: null,
            voyage_id: null,
            recipe_id: null,
            cook_started_at: null,
            completed_at: null,
            leftovers_saved: false,
            notes: null,
            created_at: '2026-03-27T00:00:00Z',
            updated_at: '2026-03-27T00:00:00Z',
            ingredients: [],
        };
        render(<MealCalendar {...baseProps} mealDays={mealDays} activeMeals={[meal]} />);
        expect(screen.getByLabelText(/items to shopping list|fully stocked/i)).toBeDefined();
    });

    it('scopes stores and shopping reads to the selected voyage owner', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        const meal = {
            id: 'm-scope',
            user_id: 'owner-1',
            title: 'Scoped Pasta',
            planned_date: '2026-03-27',
            meal_slot: 'dinner' as const,
            servings_planned: 4,
            status: 'reserved' as const,
            spoonacular_id: null,
            voyage_id: 'v1',
            recipe_id: null,
            cook_started_at: null,
            completed_at: null,
            leftovers_saved: false,
            notes: null,
            created_at: '2026-03-27T00:00:00Z',
            updated_at: '2026-03-27T00:00:00Z',
            ingredients: [{ name: 'Pasta', amount: 2, unit: 'kg', aisle: 'Pasta and Rice', scalable: true }],
        };

        render(<MealCalendar {...baseProps} mealDays={mealDays} activeMeals={[meal]} />);

        expect(getStoresAvailability).toHaveBeenCalledWith('v1', 'owner-1');
        expect(getShoppingList).toHaveBeenCalledWith('v1', 'owner-1');
    });

    it('passes the selected voyage and authoritative owner when adding provisions', async () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        const meal = {
            id: 'm-provision',
            user_id: 'owner-1',
            title: 'Scoped Pasta',
            planned_date: '2026-03-27',
            meal_slot: 'dinner' as const,
            servings_planned: 4,
            status: 'reserved' as const,
            spoonacular_id: null,
            voyage_id: 'v1',
            recipe_id: null,
            cook_started_at: null,
            completed_at: null,
            leftovers_saved: false,
            notes: null,
            created_at: '2026-03-27T00:00:00Z',
            updated_at: '2026-03-27T00:00:00Z',
            ingredients: [{ name: 'Pasta', amount: 2, unit: 'kg', aisle: 'Pasta and Rice', scalable: true }],
        };

        render(<MealCalendar {...baseProps} mealDays={mealDays} activeMeals={[meal]} />);
        fireEvent.click(screen.getByRole('button', { name: 'Add 1 items to shopping list' }));

        await waitFor(() =>
            expect(addManualItem).toHaveBeenCalledWith({
                name: 'Pasta',
                qty: 2,
                unit: 'kg',
                notes: 'Passage provision',
                voyageId: 'v1',
                ownerUserId: 'owner-1',
            }),
        );
    });

    it('fails closed when a shared voyage owner is unavailable', () => {
        const mealDays = {
            dates: ['2026-03-27'],
            emergencyDates: new Set<string>(),
            passageDays: 1,
            emergencyDays: 0,
            totalDays: 1,
        };
        const meal = {
            id: 'm-ownerless',
            user_id: '',
            title: 'Ownerless Pasta',
            planned_date: '2026-03-27',
            meal_slot: 'dinner' as const,
            servings_planned: 4,
            status: 'reserved' as const,
            spoonacular_id: null,
            voyage_id: 'v1',
            recipe_id: null,
            cook_started_at: null,
            completed_at: null,
            leftovers_saved: false,
            notes: null,
            created_at: '2026-03-27T00:00:00Z',
            updated_at: '2026-03-27T00:00:00Z',
            ingredients: [{ name: 'Pasta', amount: 2, unit: 'kg', aisle: 'Pasta and Rice', scalable: true }],
        };

        render(<MealCalendar {...baseProps} ownerUserId={null} mealDays={mealDays} activeMeals={[meal]} />);
        fireEvent.click(screen.getByRole('button', { name: 'Add 1 items to shopping list' }));

        expect(addManualItem).not.toHaveBeenCalled();
    });

    // 126-B2a (GAL-02): copy and move clone the planned meal; they never
    // rebuild a fake search result, so no recipe copy and no display key.
    describe('long-press copy and move (Horta → Ponta Delgada)', () => {
        const FEIJOADA = '3f2b6c1e-8a4d-4e7f-9b21-5c6d7e8f9a0b';
        const mealDays = {
            dates: ['2026-10-12', '2026-10-13'],
            emergencyDates: new Set<string>(),
            passageDays: 2,
            emergencyDays: 0,
            totalDays: 2,
        };
        const planned = (overrides: Partial<MealPlan>): MealPlan => ({
            id: 'm-feijoada',
            user_id: 'owner-1',
            voyage_id: 'v1',
            recipe_id: FEIJOADA,
            spoonacular_id: null,
            title: 'Feijoada',
            planned_date: '2026-10-12',
            meal_slot: 'dinner',
            servings_planned: 4,
            ingredients: [{ name: 'Black beans', amount: 500, unit: 'g', aisle: 'Dry', scalable: true }],
            status: 'reserved',
            cook_started_at: null,
            completed_at: null,
            leftovers_saved: false,
            notes: 'Soak the beans the night before',
            created_at: '2026-10-01T00:00:00Z',
            updated_at: '2026-10-01T00:00:00Z',
            ...overrides,
        });

        let phone = 0;

        beforeEach(async () => {
            // A fresh local database (account scope) per test.
            phone += 1;
            localStorage.setItem('thalassa_localdb_moved_to_library', '1');
            setAuthIdentityScope(`galley-phone-${phone}`);
            await initLocalDatabase(`galley-phone-${phone}`);
            // The real copy, over the real local database.
            const actual =
                await vi.importActual<typeof import('../services/MealPlanService')>('../services/MealPlanService');
            vi.mocked(copyMealPlan).mockImplementation(actual.copyMealPlan);
        });

        async function longPressThenPickDay2(meal: MealPlan, action: 'copy' | 'move') {
            render(
                <MealCalendar
                    {...baseProps}
                    voyageName="Horta → Ponta Delgada"
                    mealDays={mealDays}
                    activeMeals={[meal]}
                />,
            );
            fireEvent.touchStart(screen.getByRole('button', { name: new RegExp(`Dinner: ${meal.title}`) }));
            const dialog = await screen.findByRole('dialog', { name: `Copy ${meal.title}` }, { timeout: 2000 });
            if (action === 'move') fireEvent.click(within(dialog).getByRole('button', { name: /Move/ }));
            fireEvent.click(within(dialog).getByRole('button', { name: /^Day 2/ }));
            await waitFor(() => expect(copyMealPlan).toHaveBeenCalledTimes(1));
            await waitFor(() => expect(baseProps.onMealsChanged).toHaveBeenCalled());
        }

        it('copies a recipe meal: the same recipe link, no recipe insert, the source kept', async () => {
            const meal = planned({});
            await longPressThenPickDay2(meal, 'copy');

            expect(copyMealPlan).toHaveBeenCalledWith(meal, '2026-10-13', 'v1', 'owner-1');
            expect(getAll<MealPlan>('meal_plans')).toEqual([
                expect.objectContaining({
                    planned_date: '2026-10-13',
                    meal_slot: 'dinner',
                    recipe_id: FEIJOADA,
                    spoonacular_id: null,
                    title: 'Feijoada',
                    notes: 'Soak the beans the night before',
                    user_id: 'owner-1',
                }),
            ]);
            expect(getAll('recipes')).toEqual([]);
            expect(getFullQueue().map((item) => item.table_name)).toEqual(['meal_plans']);
            expect(scheduleMeal).not.toHaveBeenCalled();
            expect(unscheduleMeal).not.toHaveBeenCalled();
        });

        it('moves a simple meal: null ids on the target, the source deleted, no recipe insert', async () => {
            const meal = planned({
                id: 'm-pizza',
                title: 'Pizza night',
                recipe_id: null,
                ingredients: [],
                notes: null,
            });
            await longPressThenPickDay2(meal, 'move');

            expect(getAll<MealPlan>('meal_plans')).toEqual([
                expect.objectContaining({
                    planned_date: '2026-10-13',
                    title: 'Pizza night',
                    recipe_id: null,
                    spoonacular_id: null,
                }),
            ]);
            await waitFor(() => expect(unscheduleMeal).toHaveBeenCalledWith('m-pizza'));
            expect(getAll('recipes')).toEqual([]);
            expect(scheduleMeal).not.toHaveBeenCalled();
        });
    });

    // 131-B11: the grid is this phone's days, and a meal saved on any other
    // day still shows, on a row of its own. A 07:00 Saturday departure from
    // Brisbane, in on Monday evening: Friday 21:00 to Monday 08:00 in UTC.
    describe('a planned meal never drops out of the grid (131-B11)', () => {
        const DEPARTS = '2026-10-16T21:00:00+00:00';
        const ARRIVES = '2026-10-19T08:00:00+00:00';
        const was = process.env.TZ;
        afterEach(() => {
            if (was === undefined) delete process.env.TZ;
            else process.env.TZ = was;
        });

        /** The passage's days on a phone in this zone, from the real calculateMealDays. */
        async function passageOn(zone: string, eta = ARRIVES) {
            process.env.TZ = zone;
            const actual =
                await vi.importActual<typeof import('../services/MealPlanService')>('../services/MealPlanService');
            return actual.calculateMealDays(DEPARTS, eta);
        }
        const meal = (id: string, title: string, planned_date: string, meal_slot: MealPlan['meal_slot']): MealPlan => ({
            id,
            user_id: 'owner-1',
            voyage_id: 'v1',
            recipe_id: null,
            spoonacular_id: null,
            title,
            planned_date,
            meal_slot,
            servings_planned: 4,
            ingredients: [],
            status: 'reserved',
            cook_started_at: null,
            completed_at: null,
            leftovers_saved: false,
            notes: null,
            created_at: '2026-10-10T00:00:00Z',
            updated_at: '2026-10-10T00:00:00Z',
        });
        /** A day as the grid writes it. */
        const day = (key: string) =>
            new Intl.DateTimeFormat(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                timeZone: 'UTC',
            }).format(new Date(`${key}T12:00:00Z`));
        /** Each day row's label, top to bottom. */
        const rows = () => screen.getAllByRole('row').map((row) => row.getAttribute('aria-label'));

        it("shows an old plan's first-day meals, saved on the UTC Friday, above Saturday's Day 1 in Brisbane", async () => {
            const mealDays = await passageOn('Australia/Brisbane');
            expect(mealDays.dates).toEqual(['2026-10-17', '2026-10-18', '2026-10-19']);
            // Planned before 131-B11, when Day 1 of this passage was the UTC Friday.
            const old = [
                meal('m-porridge', 'Porridge', '2026-10-16', 'breakfast'),
                meal('m-wrap', 'Chicken Wrap', '2026-10-16', 'lunch'),
                meal('m-stew', 'Beef Stew', '2026-10-17', 'dinner'),
            ];
            render(<MealCalendar {...baseProps} mealDays={mealDays} activeMeals={old} />);

            expect(rows()).toEqual([
                day('2026-10-16'),
                `Day 1 — ${day('2026-10-17')}`,
                `Day 2 — ${day('2026-10-18')}`,
                `Day 3 — ${day('2026-10-19')}`,
            ]);
            const friday = screen.getAllByRole('row')[0];
            expect(within(friday).getByRole('button', { name: /^Brekky: Porridge/ })).toBeInTheDocument();
            expect(within(friday).getByRole('button', { name: /^Lunch: Chicken Wrap/ })).toBeInTheDocument();
            expect(
                within(friday).getByRole('button', { name: `Add Dinner meal for ${day('2026-10-16')}` }),
            ).toBeInTheDocument();
            expect(within(friday).queryByText(/^Day /)).not.toBeInTheDocument();

            // The cook can move it onto Day 1 from the same list of days.
            fireEvent.touchStart(screen.getByRole('button', { name: /^Brekky: Porridge/ }));
            const dialog = await screen.findByRole('dialog', { name: 'Copy Porridge' }, { timeout: 2000 });
            const targets = within(dialog)
                .getAllByRole('button')
                .filter((b) => !/Copy|Move|Cancel/.test(b.textContent ?? ''));
            expect(targets.map((b) => b.textContent)).toEqual([
                `${day('2026-10-16')}current`,
                `Day 1${day('2026-10-17')}`,
                `Day 2${day('2026-10-18')}`,
                `Day 3${day('2026-10-19')}`,
            ]);
            expect(targets[0]).toBeDisabled();
            expect(targets[1]).toBeEnabled();
        });

        it("shows the skipper's Monday dinner, saved on a Brisbane phone, after Sunday on a phone in Los Angeles", async () => {
            const mealDays = await passageOn('America/Los_Angeles');
            expect(mealDays.dates).toEqual(['2026-10-16', '2026-10-17', '2026-10-18']);
            const shared = [
                meal('m-curry', 'Fish Curry', '2026-10-17', 'dinner'),
                // The skipper's Day 3, Monday in Brisbane: past this phone's grid.
                meal('m-chilli', 'Chilli Con Carne', '2026-10-19', 'dinner'),
            ];
            render(<MealCalendar {...baseProps} mealDays={mealDays} activeMeals={shared} />);

            expect(rows()).toEqual([
                `Day 1 — ${day('2026-10-16')}`,
                `Day 2 — ${day('2026-10-17')}`,
                `Day 3 — ${day('2026-10-18')}`,
                day('2026-10-19'),
            ]);
            const monday = screen.getAllByRole('row')[3];
            expect(within(monday).getByRole('button', { name: /^Dinner: Chilli Con Carne/ })).toBeInTheDocument();
            expect(
                within(screen.getAllByRole('row')[1]).getByRole('button', { name: /^Dinner: Fish Curry/ }),
            ).toBeInTheDocument();
        });

        it.each(['America/Los_Angeles', 'Australia/Brisbane'])(
            'a plan with every meal on a passage day shows exactly the passage days, on a phone in %s',
            async (zone) => {
                // In on Wednesday: five passage days and two buffer days.
                const mealDays = await passageOn(zone, '2026-10-21T08:00:00+00:00');
                expect(mealDays).toMatchObject({ passageDays: 5, emergencyDays: 2 });
                const plan = [
                    meal('m-eggs', 'Scrambled Eggs', mealDays.dates[0], 'breakfast'),
                    meal('m-pad', 'Pad Thai', mealDays.dates[2], 'dinner'),
                    meal('m-beans', 'Baked Beans on Toast', mealDays.dates[6], 'lunch'),
                ];
                render(<MealCalendar {...baseProps} mealDays={mealDays} activeMeals={plan} />);

                expect(rows()).toEqual(
                    mealDays.dates.map((d, i) => `Day ${i + 1} — ${day(d)}${i >= 5 ? ' (buffer day)' : ''}`),
                );
                expect(screen.getAllByText('Buffer')).toHaveLength(2);
            },
        );
    });
});
