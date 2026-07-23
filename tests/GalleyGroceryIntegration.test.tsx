import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MealPlan } from '../services/MealPlanService';
import type { ShoppingListSummary } from '../services/ShoppingListService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mealMocks = vi.hoisted(() => ({
    getMealsByStatus: vi.fn(),
    getStoresAvailability: vi.fn(),
    startCooking: vi.fn(),
    completeMeal: vi.fn(),
}));

const shoppingMocks = vi.hoisted(() => ({
    getShoppingList: vi.fn(),
    markPurchased: vi.fn(),
    unmarkPurchased: vi.fn(),
    addManualItem: vi.fn(),
}));

const realtimeMocks = vi.hoisted(() => ({
    useRealtimeSync: vi.fn(),
}));

vi.mock('../services/MealPlanService', () => ({
    getMealsByStatus: mealMocks.getMealsByStatus,
    getMealPlans: vi.fn(),
    getStoresAvailability: mealMocks.getStoresAvailability,
    startCooking: mealMocks.startCooking,
    completeMeal: mealMocks.completeMeal,
}));

vi.mock('../services/GalleyRecipeService', () => ({
    getStoredRecipes: vi.fn(() => []),
    createCustomRecipe: vi.fn(),
    updateCustomRecipe: vi.fn(),
}));

vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: shoppingMocks.getShoppingList,
    markPurchased: shoppingMocks.markPurchased,
    unmarkPurchased: shoppingMocks.unmarkPurchased,
    addManualItem: shoppingMocks.addManualItem,
    getVoyageBudget: vi.fn(),
    reconcileGroceryInventoryMirror: vi.fn(async () => ({ repaired: 0, errors: [] })),
}));

vi.mock('../services/PurchaseUnits', () => ({
    toPurchasable: (_name: string, qty: number, unit: string) => ({
        packageCount: qty,
        packageLabel: unit,
        matched: false,
    }),
}));

vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: vi.fn(() => null),
}));

vi.mock('../hooks/useRealtimeSync', () => ({
    useRealtimeSync: realtimeMocks.useRealtimeSync,
}));

vi.mock('../hooks/usePermissions', () => ({
    usePermissions: () => ({
        loaded: true,
        isSkipper: true,
        role: 'skipper',
        permissions: {
            can_view_stores: true,
            can_edit_stores: true,
            can_view_galley: true,
            can_view_nav: true,
            can_view_weather: true,
            can_edit_log: true,
            can_view_passage: true,
            can_view_passage_meals: true,
            can_view_passage_chat: true,
            can_view_passage_route: true,
            can_view_passage_checklist: true,
        },
        canViewStores: true,
        canEditStores: true,
        canViewGalley: true,
        canViewNav: true,
        canViewWeather: true,
        canEditLog: true,
        canViewCosts: true,
        canViewPassports: true,
        canManageCrew: true,
    }),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }),
}));

vi.mock('../components/passage/GalleyCookingMode', () => ({
    GalleyCookingMode: ({ meal, onClose }: { meal: MealPlan; onClose: () => void; onComplete: () => void }) => (
        <div role="dialog" aria-label={`Cooking Mode: ${meal.title}`}>
            <button type="button" onClick={onClose}>
                Close cooking mode
            </button>
        </div>
    ),
}));

import { GalleyPage } from '../components/vessel/GalleyPage';

const meal: MealPlan = {
    id: 'meal-1',
    voyage_id: 'voyage-1',
    recipe_id: 'recipe-1',
    spoonacular_id: 123,
    title: 'Sea pasta',
    planned_date: '2026-07-23',
    meal_slot: 'dinner',
    servings_planned: 4,
    ingredients: [],
    status: 'reserved',
    cook_started_at: null,
    completed_at: null,
    leftovers_saved: false,
    notes: null,
    created_at: '2026-07-23T07:00:00.000Z',
    updated_at: '2026-07-23T07:00:00.000Z',
};

const groceryItem = {
    id: 'grocery-1',
    ingredient_name: 'Tomatoes',
    required_qty: 4,
    unit: 'each',
    market_zone: 'Produce' as const,
    actual_cost: null,
    currency: 'AUD',
    purchased: false,
    purchased_at: null,
    store_location: '',
    provision_id: null,
    voyage_id: null,
    notes: null,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
};

let shoppingSummary: ShoppingListSummary;

describe('Galley production workflows', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('user-1');
        shoppingSummary = {
            total: 1,
            purchased: 0,
            remaining: 1,
            totalCost: 0,
            currency: 'AUD',
            zones: [{ zone: 'Produce', items: [groceryItem] }],
        };
        shoppingMocks.getShoppingList.mockImplementation(() => shoppingSummary);
        mealMocks.getMealsByStatus.mockReturnValue([]);
        mealMocks.getStoresAvailability.mockReturnValue([]);
    });

    it('exposes its primary sections as a keyboard-operable tab set', () => {
        render(<GalleyPage onBack={vi.fn()} />);

        expect(screen.getByRole('tablist', { name: 'Galley sections' })).toBeInTheDocument();
        const activeTab = screen.getByRole('tab', { name: /Active Meals/ });
        const recipesTab = screen.getByRole('tab', { name: /Saved Recipes/ });
        expect(activeTab).toHaveAttribute('aria-selected', 'true');
        expect(activeTab).toHaveAttribute('aria-controls', 'galley-active-panel');
        expect(recipesTab).toHaveAttribute('tabindex', '-1');

        fireEvent.keyDown(activeTab, { key: 'ArrowRight' });

        expect(recipesTab).toHaveFocus();
        expect(recipesTab).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'galley-recipes-tab');

        fireEvent.keyDown(recipesTab, { key: 'Home' });
        expect(activeTab).toHaveFocus();
        expect(activeTab).toHaveAttribute('aria-selected', 'true');
    });

    it('opens the full grocery workflow from the Galley summary and restores focus on return', async () => {
        render(<GalleyPage onBack={vi.fn()} />);

        const opener = screen.getByRole('button', { name: 'Open shopping list, 1 item remaining' });
        opener.focus();
        fireEvent.click(opener);

        expect(screen.getByRole('heading', { name: 'Grocery List' })).toBeInTheDocument();
        expect(screen.getByRole('tablist', { name: 'Shopping list filters' })).toBeInTheDocument();
        const remainingTab = screen.getByRole('tab', { name: /Need/ });
        expect(remainingTab).toHaveAttribute('aria-selected', 'true');
        fireEvent.keyDown(remainingTab, { key: 'ArrowRight' });
        const purchasedTab = screen.getByRole('tab', { name: /Done/ });
        expect(purchasedTab).toHaveAttribute('aria-selected', 'true');
        expect(purchasedTab).toHaveFocus();
        fireEvent.keyDown(purchasedTab, { key: 'Home' });
        expect(remainingTab).toHaveAttribute('aria-selected', 'true');
        expect(remainingTab).toHaveFocus();
        expect(screen.getByRole('progressbar', { name: 'Shopping progress' })).toHaveAttribute(
            'aria-valuetext',
            '0 of 1 items purchased',
        );

        fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

        await waitFor(() => {
            expect(screen.getByRole('heading', { name: 'Galley' })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Open shopping list, 1 item remaining' })).toHaveFocus();
        });
    });

    it('keeps the shopping workflow reachable when the list is empty', () => {
        shoppingSummary = {
            total: 0,
            purchased: 0,
            remaining: 0,
            totalCost: 0,
            currency: 'AUD',
            zones: [],
        };
        render(<GalleyPage onBack={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Open empty shopping list' }));
        expect(screen.getByRole('heading', { name: 'Grocery List' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Add item to shopping list' })).toBeEnabled();
    });

    it('refreshes the Galley shopping summary when a realtime list update arrives', () => {
        render(<GalleyPage onBack={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Open shopping list, 1 item remaining' })).toBeInTheDocument();
        const realtimeCall = realtimeMocks.useRealtimeSync.mock.calls
            .filter(([table]) => table === 'shopping_list')
            .at(-1);
        expect(realtimeCall).toBeDefined();

        shoppingSummary = {
            ...shoppingSummary,
            purchased: 1,
            remaining: 0,
            zones: [
                {
                    zone: 'Produce',
                    items: [{ ...groceryItem, purchased: true, purchased_at: '2026-07-23T08:00:00.000Z' }],
                },
            ],
        };
        act(() => {
            (realtimeCall?.[1] as () => void)();
        });

        expect(screen.getByRole('button', { name: 'Open shopping list, all items purchased' })).toBeInTheDocument();
    });

    it('accepts fractional manual quantities and keeps both sheets scroll-safe on short screens', async () => {
        render(<GalleyPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Open shopping list, 1 item remaining' }));

        fireEvent.click(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' }));
        const purchaseDialog = screen.getByRole('dialog', { name: /Mark as Purchased/ });
        expect(purchaseDialog).toHaveClass('overflow-y-auto', 'overscroll-contain');
        expect(purchaseDialog.style.maxHeight).toContain('100dvh');
        expect(within(purchaseDialog).getByText("Adds 4 each to Ship's Stores.")).toBeInTheDocument();
        fireEvent.click(within(purchaseDialog).getByRole('button', { name: 'Cancel marking Tomatoes as purchased' }));

        fireEvent.click(screen.getByRole('button', { name: 'Add item to shopping list' }));
        const addDialog = screen.getByRole('dialog', { name: /Add to Shopping List/ });
        expect(addDialog).toHaveClass('overflow-y-auto', 'overscroll-contain');
        expect(addDialog.style.maxHeight).toContain('100dvh');

        fireEvent.change(within(addDialog).getByRole('textbox', { name: 'Item Name' }), {
            target: { value: 'Olive oil' },
        });
        const quantityInput = within(addDialog).getByRole('spinbutton', { name: 'Qty' });
        expect(quantityInput).toHaveAttribute('min', '0.0001');
        expect(quantityInput).toHaveAttribute('step', 'any');
        fireEvent.change(quantityInput, { target: { value: '0.5' } });
        fireEvent.change(within(addDialog).getByRole('combobox', { name: 'Unit' }), {
            target: { value: 'L' },
        });
        fireEvent.click(within(addDialog).getByRole('button', { name: 'Add item to grocery list' }));

        await waitFor(() => {
            expect(shoppingMocks.addManualItem).toHaveBeenCalledWith({
                name: 'Olive oil',
                qty: 0.5,
                unit: 'L',
                zone: 'General',
                voyageId: null,
                ownerUserId: 'user-1',
            });
        });
    });

    it('opens canonical cooking mode without immediately completing or consuming the meal', () => {
        mealMocks.getMealsByStatus.mockImplementation((status: string) => (status === 'reserved' ? [meal] : []));
        render(<GalleyPage onBack={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: /Cook Now/ }));

        expect(screen.getByRole('dialog', { name: 'Cooking Mode: Sea pasta' })).toBeInTheDocument();
        expect(mealMocks.startCooking).not.toHaveBeenCalled();
        expect(mealMocks.completeMeal).not.toHaveBeenCalled();
    });
});
