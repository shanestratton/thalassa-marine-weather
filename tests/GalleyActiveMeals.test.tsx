/**
 * The Galley page, cleaned up (132-B17; binder audit GAL-11).
 *
 * Active meals listed every planned meal in the order it was saved, under a
 * 112 px decorative gradient and a raw '2026-10-09 · dinner'. Now Today and
 * Next come first, then Later, each in the order the meals are eaten, under
 * plain dates; a meal from a day that has passed is listed last, under
 * Earlier, never dropped. The page also gets the house load states: a read
 * that fails shows LoadErrorState (never "No active meals"), with its own
 * trace, and offline the header says "Saved locally".
 *
 * Days are the phone's local days (131-B11). The clock is set to Thursday
 * 15 October 2026, 10:00 local. Fictional data only: the 'Kestrel' galley.
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { User } from '@supabase/supabase-js';
import type { MealPlan } from '../services/MealPlanService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getMealsByStatus: vi.fn(),
    getStoredRecipes: vi.fn(),
    getShoppingList: vi.fn(),
}));

vi.mock('../stores/authStore', async () => {
    const { create } = await import('zustand');
    const useAuthStore = create<{ user: User | null; authChecked: boolean }>()(() => ({
        user: null,
        authChecked: true,
    }));
    return { useAuthStore };
});
vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: mocks.getShoppingList,
    markPurchased: vi.fn(),
    unmarkPurchased: vi.fn(),
    addManualItem: vi.fn(),
    recentRetailers: vi.fn(() => []),
}));
vi.mock('../services/MealPlanService', () => ({
    getMealsByStatus: mocks.getMealsByStatus,
    getMealPlans: vi.fn(() => []),
    getStoresAvailability: vi.fn(() => []),
    startCooking: vi.fn(),
    completeMeal: vi.fn(),
    saveLeftovers: vi.fn(),
    skipMeal: vi.fn(),
}));
vi.mock('../services/GalleyRecipeService', () => ({
    getStoredRecipes: mocks.getStoredRecipes,
    getMealSteps: vi.fn(async () => []),
    createCustomRecipe: vi.fn(),
    updateCustomRecipe: vi.fn(),
}));
vi.mock('../services/galley/recipeImagePurge', () => ({ purgeOrphanRecipeImagesWhenIdle: vi.fn() }));
vi.mock('../services/PassagePlanService', () => ({
    NO_PASSAGE_ACCESS: {
        visible: false,
        voyageId: null,
        ownerUserId: null,
        isOwner: false,
        canEditStores: false,
        canViewMeals: false,
        canViewChat: false,
        canViewRoute: false,
        canViewChecklist: false,
    },
    getActivePassageId: vi.fn(() => null),
    getPassageStatus: vi.fn(),
}));
vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: vi.fn(() => null) }));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn() }));
vi.mock('../hooks/usePermissions', () => ({
    usePermissions: () => ({
        loaded: true,
        isSkipper: true,
        canViewStores: true,
        canEditStores: true,
        canViewGalley: true,
        permissions: { can_view_passage_meals: true },
    }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { GalleyPage } from '../components/vessel/GalleyPage';
import { activeMealSections, mealDayLabel, mealSlotName, mealWhenLine } from '../services/galley/activeMeals';

const SKIPPER = { id: 'skipper-1', email: 'skipper@kestrel.example.test' } as User;
/** Thursday 15 October 2026, 10:00 on the phone's clock. */
const NOW = new Date(2026, 9, 15, 10, 0);
let warn: MockInstance<typeof console.warn>;

function meal(id: string, title: string, planned_date: string, overrides: Partial<MealPlan> = {}): MealPlan {
    return {
        id,
        user_id: 'skipper-1',
        voyage_id: null,
        recipe_id: null,
        spoonacular_id: null,
        title,
        planned_date,
        meal_slot: 'dinner',
        servings_planned: 4,
        ingredients: [{ name: 'Rice', amount: 2, unit: 'cup', scalable: true, aisle: 'Pantry' }],
        status: 'reserved',
        cook_started_at: null,
        completed_at: null,
        leftovers_saved: false,
        notes: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        ...overrides,
    };
}

/** As they were saved, which is not the order they are eaten. */
const SAVED_ORDER = [
    meal('m-sat', 'Paella', '2026-10-17', { meal_slot: 'dinner' }),
    meal('m-tue', 'Fish curry', '2026-10-13'),
    meal('m-today-dinner', 'Lentil dal', '2026-10-15', { meal_slot: 'dinner' }),
    meal('m-fri-lunch', 'Wraps', '2026-10-16', { meal_slot: 'lunch' }),
    meal('m-today-breakfast', 'Kedgeree', '2026-10-15', { meal_slot: 'breakfast' }),
    meal('m-fri-breakfast', 'Porridge', '2026-10-16', { meal_slot: 'breakfast' }),
    meal('m-yesterday', 'Pasta', '2026-10-14'),
    meal('m-cooking', 'Chowder', '2026-10-14', { status: 'cooking', meal_slot: 'lunch' }),
];

const titles = (sections: ReturnType<typeof activeMealSections>) =>
    sections.map((section) => [section.title, section.meals.map((m) => m.title)]);

describe('the order the meals are eaten (GAL-11)', () => {
    it('Today (the pot on the stove first), Next, Later, then Earlier, each through the day', () => {
        expect(titles(activeMealSections(SAVED_ORDER, NOW))).toEqual([
            ['Today', ['Chowder', 'Kedgeree', 'Lentil dal']],
            ['Next', ['Porridge', 'Wraps']],
            ['Later', ['Paella']],
            ['Earlier', ['Pasta', 'Fish curry']],
        ]);
    });

    it('Next is the next day with a meal, however far off', () => {
        const sections = activeMealSections(
            [meal('m-1', 'Paella', '2026-10-20'), meal('m-2', 'Stew', '2026-10-25')],
            NOW,
        );
        expect(titles(sections)).toEqual([
            ['Next', ['Paella']],
            ['Later', ['Stew']],
        ]);
    });

    it('a date that will not read is kept, at the end of Later', () => {
        const sections = activeMealSections(
            [meal('m-1', 'Mystery', 'someday'), meal('m-2', 'Stew', '2026-10-25')],
            NOW,
        );
        expect(titles(sections)).toEqual([
            ['Next', ['Stew']],
            ['Later', ['Mystery']],
        ]);
        expect(sections.flatMap((section) => section.meals)).toHaveLength(2);
    });

    it('no meals, no sections', () => {
        expect(activeMealSections([], NOW)).toEqual([]);
    });

    it('a synced day (UTC midnight) is still that day', () => {
        const synced = meal('m-1', 'Damper', '2026-10-16T00:00:00+00:00');
        expect(activeMealSections([synced], NOW)[0].title).toBe('Next');
        expect(mealDayLabel(synced.planned_date, NOW)).toBe('Tomorrow');
    });
});

describe('plain dates', () => {
    it('today, tomorrow and yesterday by name; other days as the phone writes them', () => {
        expect(mealDayLabel('2026-10-15', NOW)).toBe('Today');
        expect(mealDayLabel('2026-10-16', NOW)).toBe('Tomorrow');
        expect(mealDayLabel('2026-10-14', NOW)).toBe('Yesterday');
        expect(mealDayLabel('2026-10-17', NOW)).toBe(
            new Date(2026, 9, 17).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
        );
        expect(mealDayLabel('2027-01-02', NOW)).toContain('2027');
        expect(mealDayLabel('not a day', NOW)).toBe('No date');
    });

    it("the line under a meal's title, with no raw date and no lower-case slot", () => {
        expect(mealWhenLine(meal('m', 'Stew', '2026-10-16', { meal_slot: 'lunch' }), NOW)).toBe(
            'Tomorrow · Lunch · 4 serves',
        );
        expect(
            mealWhenLine(meal('m', 'Toast', '2026-10-15', { meal_slot: 'breakfast', servings_planned: 1 }), NOW),
        ).toBe('Today · Breakfast · 1 serve');
        expect(mealSlotName('snack')).toBe('Snack');
    });
});

describe('the Galley page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        setAuthIdentityScope('skipper-1');
        useAuthStore.setState({ user: SKIPPER });
        mocks.getMealsByStatus.mockImplementation((status: string) => SAVED_ORDER.filter((m) => m.status === status));
        mocks.getStoredRecipes.mockReturnValue([]);
        mocks.getShoppingList.mockReturnValue({
            total: 1,
            purchased: 0,
            remaining: 1,
            totalCost: 0,
            currency: 'AUD',
            zones: [],
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        warn.mockRestore();
        setAuthIdentityScope(null);
        useAuthStore.setState({ user: null });
        useUIStore.setState({ isOffline: false });
    });

    const warnings = (reason: string) => warn.mock.calls.filter((call) => call.includes(reason));

    it('lists the meals under Today, Next, Later and Earlier, in the order they are eaten, under plain dates', () => {
        render(<GalleyPage onBack={vi.fn()} />);
        const panel = screen.getByRole('tabpanel', { name: /Active meals/ });
        const headings = within(panel)
            .getAllByRole('heading', { level: 2 })
            .map((heading) => heading.textContent);
        expect(headings).toEqual(['Today(3)', 'Next(2)', 'Later(1)', 'Earlier(2)']);
        const cards = within(panel)
            .getAllByRole('heading', { level: 3 })
            .map((heading) => heading.textContent);
        expect(cards).toEqual([
            'Chowder',
            'Kedgeree',
            'Lentil dal',
            'Porridge',
            'Wraps',
            'Paella',
            'Pasta',
            'Fish curry',
        ]);

        expect(within(panel).getByText('Yesterday · Lunch · 4 serves')).toBeInTheDocument();
        expect(within(panel).getByText('Cooking now')).toBeInTheDocument();
        expect(within(panel).getByText('Today · Breakfast · 4 serves')).toBeInTheDocument();
        expect(within(panel).getByText('Tomorrow · Breakfast · 4 serves')).toBeInTheDocument();
        expect(within(panel).getByText(/not cooked yet, so their ingredients are still set aside/)).toBeInTheDocument();
        // No raw stored date, no 112 px decorative hero.
        expect(panel.textContent).not.toMatch(/2026-10-\d\d/);
        expect(panel.querySelector('.h-28')).toBeNull();
        expect(screen.getByRole('button', { name: 'Resume cooking' })).toBeInTheDocument();
    });

    it('says "Saved locally" offline, as its binder siblings do', () => {
        useUIStore.setState({ isOffline: true });
        render(<GalleyPage onBack={vi.fn()} />);
        expect(screen.getByText('Saved locally')).toBeInTheDocument();
    });

    it('meals that cannot be read: LoadErrorState, never "No active meals", and a trace with its own reason', () => {
        mocks.getMealsByStatus.mockImplementation(() => {
            throw new Error('[LocalDB] Not initialized.');
        });
        render(<GalleyPage onBack={vi.fn()} />);
        expect(screen.getByRole('heading', { name: "Couldn't load your planned meals" })).toBeInTheDocument();
        expect(screen.queryByText('No active meals')).not.toBeInTheDocument();
        expect(warnings('galley: load-meals')).toHaveLength(1);
        expect(String(warnings('galley: load-meals')[0])).toContain('Not initialized');

        mocks.getMealsByStatus.mockImplementation((status: string) => SAVED_ORDER.filter((m) => m.status === status));
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(screen.getByRole('heading', { name: 'Chowder' })).toBeInTheDocument();
    });

    it('recipes that cannot be read: LoadErrorState on the Saved recipes tab, not "No saved recipes"', () => {
        mocks.getStoredRecipes.mockImplementation(() => {
            throw new Error('[LocalDB] Not initialized.');
        });
        render(<GalleyPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('tab', { name: /Saved recipes/ }));
        expect(screen.getByRole('heading', { name: "Couldn't load your saved recipes" })).toBeInTheDocument();
        expect(screen.queryByText('No saved recipes')).not.toBeInTheDocument();
        expect(warnings('galley: load-recipes')).not.toHaveLength(0);
    });

    it('a grocery list that cannot be read here still opens, to try again there', () => {
        mocks.getShoppingList.mockImplementation(() => {
            throw new Error('[LocalDB] Not initialized.');
        });
        render(<GalleyPage onBack={vi.fn()} />);
        const opener = screen.getByRole('button', { name: 'Open shopping list, which could not be read here' });
        expect(opener).toHaveTextContent('It could not be read here. Open it to try again.');
        expect(warnings('galley: load-shopping')).not.toHaveLength(0);
        fireEvent.click(opener);
        expect(screen.getByRole('heading', { name: "Couldn't load the grocery list" })).toBeInTheDocument();
    });

    it('an empty galley still says so, with no load error', () => {
        mocks.getMealsByStatus.mockReturnValue([]);
        render(<GalleyPage onBack={vi.fn()} />);
        expect(screen.getByRole('heading', { name: 'No active meals' })).toBeInTheDocument();
        expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
    });
});
