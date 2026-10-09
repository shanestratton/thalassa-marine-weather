/**
 * Galley screens leave a trace when an action fails (126-B2b, binder audit
 * GAL-13). The Grocery List, Cooking Mode, the recipe editor and the Galley
 * page caught every failure, showed the sailor a message and logged nothing,
 * so a bug report came with no trace. Each catch now logs one warn with its
 * own reason and the error message, never an id, a name or a title. What the
 * sailor sees is unchanged, word for word.
 *
 * The components are real; their services are stubs that fail on cue (the
 * services' own catches are covered by GalleyLogging.test.ts). Fictional data
 * only: the 'Kestrel' galley (skipper-1), 'Feijoada', 'Ψαρόσουπα', 'Shackle
 * pins', the Horta → Ponta Delgada passage.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { User } from '@supabase/supabase-js';
import type { MealPlan } from '../services/MealPlanService';
import type { StoredRecipe } from '../services/GalleyRecipeService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getShoppingList: vi.fn(),
    markPurchased: vi.fn(),
    unmarkPurchased: vi.fn(),
    addManualItem: vi.fn(),
    startCooking: vi.fn(),
    completeMeal: vi.fn(),
    saveLeftovers: vi.fn(),
    skipMeal: vi.fn(),
    getMealSteps: vi.fn(),
    createCustomRecipe: vi.fn(),
    updateCustomRecipe: vi.fn(),
    getActivePassageId: vi.fn(),
    getPassageStatus: vi.fn(),
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
    markPurchased: mocks.markPurchased,
    unmarkPurchased: mocks.unmarkPurchased,
    addManualItem: mocks.addManualItem,
    getVoyageBudget: vi.fn(() => ({ totalSpent: 0, byZone: [] })),
}));

vi.mock('../services/MealPlanService', () => ({
    getMealsByStatus: vi.fn(() => []),
    getMealPlans: vi.fn(() => []),
    getStoresAvailability: vi.fn(() => []),
    startCooking: mocks.startCooking,
    completeMeal: mocks.completeMeal,
    saveLeftovers: mocks.saveLeftovers,
    skipMeal: mocks.skipMeal,
}));

vi.mock('../services/GalleyRecipeService', () => ({
    getStoredRecipes: vi.fn(() => []),
    getMealSteps: mocks.getMealSteps,
    createCustomRecipe: mocks.createCustomRecipe,
    updateCustomRecipe: mocks.updateCustomRecipe,
}));

vi.mock('../services/galley/recipeImagePurge', () => ({
    purgeOrphanRecipeImagesWhenIdle: vi.fn(),
}));

vi.mock('../services/PurchaseUnits', () => ({
    toPurchasable: (_name: string, quantity: number, unit: string) => ({
        packageCount: quantity,
        packageLabel: unit,
        inventoryQuantity: quantity,
        inventoryUnit: unit,
        matched: false,
    }),
}));

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
    getActivePassageId: mocks.getActivePassageId,
    getPassageStatus: mocks.getPassageStatus,
}));

vi.mock('../services/VoyageService', () => ({ getCachedActiveVoyage: vi.fn(() => null) }));
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
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn() }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { useAuthStore } from '../stores/authStore';
import { GroceryListPage } from '../components/vessel/GroceryListPage';
import { GalleyCookingMode } from '../components/passage/GalleyCookingMode';
import { RecipeEditor } from '../components/galley/RecipeEditor';
import { GalleyPage } from '../components/vessel/GalleyPage';

const SKIPPER = { id: 'skipper-1', email: 'skipper@kestrel.example.test' } as User;
const NOW = '2026-10-10T00:00:00.000Z';
type WarnSpy = MockInstance<typeof console.warn>;
let warn: WarnSpy;

function warnings(reason: string): string[] {
    return warn.mock.calls
        .filter((call) => call.some((part) => part === reason))
        .map((call) => call.map((part) => String(part)).join(' '));
}

const needed = {
    id: 'grocery-needed',
    user_id: 'skipper-1',
    ingredient_name: 'Tomatoes',
    required_qty: 4,
    unit: 'each',
    market_zone: 'Produce' as const,
    actual_cost: null,
    currency: 'EUR',
    purchased: false,
    purchased_at: null,
    purchase_retailer: null,
    purchased_quantity: null,
    purchased_unit: null,
    store_location: 'Galley',
    provision_id: null,
    voyage_id: null,
    notes: null,
    created_at: NOW,
    updated_at: NOW,
};
const bought = {
    ...needed,
    id: 'grocery-bought',
    ingredient_name: 'Milk',
    market_zone: 'Dairy' as const,
    purchased: true,
    purchased_at: NOW,
    purchased_quantity: 4,
    purchased_unit: 'each',
};

function cookingMeal(overrides: Partial<MealPlan> = {}): MealPlan {
    return {
        id: 'meal-feijoada',
        user_id: 'skipper-1',
        voyage_id: null,
        recipe_id: null,
        spoonacular_id: null,
        title: 'Feijoada',
        planned_date: '2026-10-12',
        meal_slot: 'dinner',
        servings_planned: 4,
        ingredients: [{ name: 'Black beans', amount: 500, unit: 'g', scalable: true, aisle: 'Pantry' }],
        status: 'reserved',
        cook_started_at: null,
        completed_at: null,
        leftovers_saved: false,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
        ...overrides,
    };
}

function storedRecipe(instructions: string): StoredRecipe {
    return {
        id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
        spoonacular_id: null,
        user_id: 'skipper-1',
        title: 'Ψαρόσουπα',
        image_url: '',
        ready_in_minutes: 45,
        servings: 4,
        source_url: '',
        instructions,
        ingredients: [{ name: 'Fish', amount: 1, unit: 'kg', scalable: true, aisle: 'Seafood' }],
        is_favorite: false,
        is_custom: true,
        visibility: 'personal',
        tags: [],
        created_at: NOW,
        updated_at: NOW,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAuthIdentityScope('skipper-1');
    useAuthStore.setState({ user: SKIPPER });
    mocks.getShoppingList.mockReturnValue({
        total: 2,
        purchased: 1,
        remaining: 1,
        totalCost: 0,
        currency: 'EUR',
        zones: [
            { zone: 'Produce', items: [needed] },
            { zone: 'Dairy', items: [bought] },
        ],
    });
    mocks.getMealSteps.mockResolvedValue([{ number: 1, step: 'Simmer the beans.' }]);
    mocks.getActivePassageId.mockReturnValue(null);
});

afterEach(() => {
    setAuthIdentityScope(null);
    useAuthStore.setState({ user: null });
    warn.mockRestore();
});

describe('Grocery List', () => {
    it('galley: load-list — the list cannot be read', async () => {
        mocks.getShoppingList.mockImplementation(() => {
            throw new Error('[LocalDB] Not initialized. Call initLocalDatabase() first.');
        });
        render(<GroceryListPage onBack={vi.fn()} />);

        expect(await screen.findByText('The shopping list could not be loaded. Please try again.')).toBeInTheDocument();
        expect(warnings('galley: load-list')).toEqual([expect.stringContaining('Not initialized')]);
    });

    it('galley: purchase-confirm — confirming a purchase fails', async () => {
        mocks.markPurchased.mockRejectedValue(new Error('No space left on device'));
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' }));
        fireEvent.click(
            within(screen.getByRole('dialog', { name: /Mark as purchased/ })).getByRole('button', {
                name: 'Confirm purchase of Tomatoes',
            }),
        );

        expect(
            await screen.findByText('Tomatoes could not be marked as purchased. Please try again.'),
        ).toBeInTheDocument();
        expect(warnings('galley: purchase-confirm')).toEqual([expect.stringContaining('No space left on device')]);
        expect(warnings('galley: purchase-confirm')[0]).not.toContain('Tomatoes');
    });

    it('galley: purchase-skip-price — skipping the price fails', async () => {
        mocks.markPurchased.mockRejectedValue(new Error('No space left on device'));
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' }));
        fireEvent.click(screen.getByRole('button', { name: 'Skip price and mark Tomatoes as purchased' }));

        expect(
            await screen.findByText('Tomatoes could not be marked as purchased. Please try again.'),
        ).toBeInTheDocument();
        expect(warnings('galley: purchase-skip-price')).toHaveLength(1);
        expect(warnings('galley: purchase-confirm')).toEqual([]);
    });

    it('galley: purchase-untick — putting an item back on the list fails', async () => {
        mocks.unmarkPurchased.mockRejectedValue(new Error('No space left on device'));
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('tab', { name: /All/ }));
        fireEvent.click(screen.getByRole('button', { name: 'Undo Milk' }));

        expect(
            await screen.findByText('Milk could not be returned to the shopping list. Please try again.'),
        ).toBeInTheDocument();
        expect(warnings('galley: purchase-untick')).toEqual([expect.stringContaining('No space left on device')]);
    });

    it('galley: add-item — adding an item by hand fails', async () => {
        mocks.addManualItem.mockRejectedValue(new Error('No space left on device'));
        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Add item to shopping list' }));
        fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Shackle pins' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add item to grocery list' }));

        expect(await screen.findByText('Shackle pins could not be added. Please try again.')).toBeInTheDocument();
        expect(warnings('galley: add-item')).toEqual([expect.stringContaining('No space left on device')]);
        expect(warnings('galley: add-item')[0]).not.toContain('Shackle pins');
    });
});

describe('Cooking Mode', () => {
    it('galley: cook-directions — the directions cannot be read, the checklist stands in', async () => {
        mocks.getMealSteps.mockRejectedValue(new Error('[LocalDB] Not initialized.'));
        render(<GalleyCookingMode meal={cookingMeal({ status: 'cooking' })} onClose={vi.fn()} onComplete={vi.fn()} />);

        expect(
            await screen.findByText(
                'Detailed recipe directions are unavailable. Use this galley checklist with your saved recipe source.',
            ),
        ).toBeInTheDocument();
        expect(warnings('galley: cook-directions')).toEqual([expect.stringContaining('Not initialized')]);
    });

    it('galley: cook-start — starting fails', async () => {
        mocks.startCooking.mockRejectedValue(new Error('No space left on device'));
        render(<GalleyCookingMode meal={cookingMeal()} onClose={vi.fn()} onComplete={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Start Cooking/ }));

        expect(await screen.findByText('Cooking mode could not be started. Please try again.')).toBeInTheDocument();
        expect(warnings('galley: cook-start')).toEqual([expect.stringContaining('No space left on device')]);
    });

    it('galley: cook-skip — skipping fails', async () => {
        mocks.skipMeal.mockRejectedValue(new Error('No space left on device'));
        const onClose = vi.fn();
        render(<GalleyCookingMode meal={cookingMeal()} onClose={onClose} onComplete={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Skip this meal/ }));

        expect(await screen.findByText('The meal could not be skipped. Please try again.')).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(warnings('galley: cook-skip')).toEqual([expect.stringContaining('No space left on device')]);
    });

    async function readyToServe() {
        render(
            <GalleyCookingMode meal={cookingMeal({ status: 'cooking' })} onClose={vi.fn()} onComplete={onComplete} />,
        );
        fireEvent.click(await screen.findByRole('button', { name: 'Mark complete: Step 1, Simmer the beans.' }));
        await screen.findByText(/Ready to Serve/);
    }
    let onComplete = vi.fn();

    it('galley: cook-complete — completing fails, and Stores are said to be untouched', async () => {
        onComplete = vi.fn();
        mocks.completeMeal.mockRejectedValue(new Error('No space left on device'));
        await readyToServe();
        fireEvent.click(screen.getByRole('button', { name: /Complete & Subtract from Stores/ }));

        expect(
            await screen.findByText("The meal could not be completed, so Ship's Stores were not updated."),
        ).toBeInTheDocument();
        expect(onComplete).not.toHaveBeenCalled();
        expect(warnings('galley: cook-complete')).toEqual([expect.stringContaining('No space left on device')]);
    });

    it('galley: leftovers — the meal completes, the leftovers cannot be saved', async () => {
        onComplete = vi.fn();
        mocks.completeMeal.mockResolvedValue(true);
        mocks.saveLeftovers.mockRejectedValue(new Error('No space left on device'));
        await readyToServe();
        fireEvent.click(screen.getByRole('button', { name: 'Decrease servings consumed' }));
        fireEvent.click(screen.getByRole('button', { name: /serves as Leftovers/ }));
        fireEvent.click(screen.getByRole('button', { name: /Complete & Subtract from Stores/ }));

        await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
        expect(mocks.saveLeftovers).toHaveBeenCalledWith('meal-feijoada', 1);
        expect(warnings('galley: leftovers')).toEqual([expect.stringContaining('No space left on device')]);
        expect(warnings('galley: cook-complete')).toEqual([]);
    });
});

describe('Recipe editor', () => {
    it('galley: recipe-step-parse — only directions that look like stored steps and are not', () => {
        const { unmount } = render(
            <RecipeEditor onClose={vi.fn()} onSaved={vi.fn()} recipe={storedRecipe('Clean the fish.\nSimmer.')} />,
        );
        // Plain text is the editor's own format: nothing to trace.
        expect(warnings('galley: recipe-step-parse')).toEqual([]);
        unmount();

        render(
            <RecipeEditor
                onClose={vi.fn()}
                onSaved={vi.fn()}
                recipe={storedRecipe('[{"number":1,"step":"Clean the fish."}')}
            />,
        );
        const lines = warnings('galley: recipe-step-parse');
        expect(lines).toHaveLength(1);
        // The recipe's own text is never quoted.
        expect(lines[0]).not.toMatch(/Clean the fish|Ψαρόσουπα/);
    });

    it('galley: recipe-save — saving fails, the same message is shown', async () => {
        mocks.createCustomRecipe.mockRejectedValue(new Error('No space left on device'));
        render(<RecipeEditor onClose={vi.fn()} onSaved={vi.fn()} />);
        fireEvent.change(screen.getByRole('textbox', { name: 'Recipe Title' }), { target: { value: 'Feijoada' } });
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 2' }));
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 3' }));
        fireEvent.change(screen.getByRole('textbox', { name: 'Ingredient 1 name' }), {
            target: { value: 'Black beans' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 4' }));
        fireEvent.click(screen.getByRole('button', { name: 'Continue to step 5' }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save recipe' }));
        });

        expect(
            await screen.findByText('The recipe could not be saved. Check your storage and try again.'),
        ).toBeInTheDocument();
        expect(warnings('galley: recipe-save')).toEqual([expect.stringContaining('No space left on device')]);
        expect(warnings('galley: recipe-save')[0]).not.toContain('Feijoada');
    });
});

describe('Galley page', () => {
    it('galley: passage-status — the selected passage cannot be checked', async () => {
        mocks.getActivePassageId.mockReturnValue('0b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e');
        mocks.getPassageStatus.mockRejectedValue(new Error('Failed to fetch'));
        render(<GalleyPage onBack={vi.fn()} />);

        await waitFor(() => expect(mocks.getPassageStatus).toHaveBeenCalled());
        await waitFor(() =>
            expect(warnings('galley: passage-status')).toEqual([expect.stringContaining('Failed to fetch')]),
        );
        expect(warnings('galley: passage-status')[0]).not.toMatch(/0b1c2d3e/);
    });
});
