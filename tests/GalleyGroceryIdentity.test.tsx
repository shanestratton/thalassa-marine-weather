import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import type { ShoppingItem, ShoppingListSummary } from '../services/ShoppingListService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    getStoredRecipes: vi.fn(),
    getShoppingList: vi.fn(),
    markPurchased: vi.fn(),
}));

vi.mock('../stores/authStore', async () => {
    const { create } = await import('zustand');
    const useAuthStore = create<{ user: User | null; authChecked: boolean }>()(() => ({
        user: null,
        authChecked: true,
    }));
    return { useAuthStore };
});

vi.mock('../services/MealPlanService', () => ({
    getMealsByStatus: vi.fn(() => []),
    getMealPlans: vi.fn(() => []),
    getStoresAvailability: vi.fn(() => []),
}));

vi.mock('../services/GalleyRecipeService', () => ({
    getStoredRecipes: mocks.getStoredRecipes,
    createCustomRecipe: vi.fn(),
    updateCustomRecipe: vi.fn(),
}));

vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: mocks.getShoppingList,
    markPurchased: mocks.markPurchased,
    unmarkPurchased: vi.fn(),
    addManualItem: vi.fn(),
    getVoyageBudget: vi.fn(() => ({ totalSpent: 0, byZone: [] })),
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
    getActivePassageId: vi.fn(() => null),
    getPassageStatus: vi.fn(),
}));

vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: vi.fn(() => null),
}));

vi.mock('../hooks/usePermissions', () => ({
    usePermissions: () => ({
        loaded: true,
        canEditStores: true,
        canViewGalley: true,
        permissions: { can_view_passage_meals: true },
    }),
}));

vi.mock('../hooks/useRealtimeSync', () => ({
    useRealtimeSync: vi.fn(),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

vi.mock('../components/galley/RecipeEditor', () => ({
    RecipeEditor: () => null,
}));

vi.mock('../components/passage/GalleyCookingMode', () => ({
    GalleyCookingMode: () => null,
}));

import { useAuthStore } from '../stores/authStore';
import { GalleyPage } from '../components/vessel/GalleyPage';
import { GroceryListPage } from '../components/vessel/GroceryListPage';

const accountA = { id: 'account-a', email: 'a@example.test' } as User;
const accountB = { id: 'account-b', email: 'b@example.test' } as User;

const accountAItem = {
    id: 'a-item',
    user_id: 'account-a',
    ingredient_name: 'Account A tomatoes',
    required_qty: 2,
    unit: 'each',
    market_zone: 'Produce' as const,
    actual_cost: null,
    currency: 'AUD',
    purchased: false,
    purchased_at: null,
    purchase_retailer: null,
    purchased_quantity: null,
    purchased_unit: null,
    store_location: 'Galley',
    provision_id: null,
    voyage_id: null,
    notes: null,
    created_at: '2026-07-23T00:00:00.000Z',
    updated_at: '2026-07-23T00:00:00.000Z',
};

const accountBItem = {
    ...accountAItem,
    id: 'b-item',
    user_id: 'account-b',
    ingredient_name: 'Account B milk',
    market_zone: 'Dairy' as const,
};

function summaryFor(item: ShoppingItem): ShoppingListSummary {
    return {
        total: 1,
        purchased: 0,
        remaining: 1,
        totalCost: 0,
        currency: 'AUD',
        zones: [{ zone: item.market_zone, items: [item] }],
    };
}

function switchAccount(user: User): void {
    setAuthIdentityScope(user.id);
    useAuthStore.setState({ user });
}

describe('Galley and Grocery account boundaries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        switchAccount(accountA);
        mocks.getStoredRecipes.mockImplementation(() => {
            const userId = useAuthStore.getState().user?.id;
            return userId === accountA.id
                ? [
                      {
                          id: 'a-recipe',
                          spoonacular_id: null,
                          user_id: accountA.id,
                          title: 'Account A private curry',
                          image_url: '',
                          ready_in_minutes: 20,
                          servings: 2,
                          source_url: '',
                          instructions: '[]',
                          ingredients: [],
                          is_favorite: false,
                          is_custom: true,
                          visibility: 'private' as const,
                          tags: [],
                          created_at: '2026-07-23T00:00:00.000Z',
                          updated_at: '2026-07-23T00:00:00.000Z',
                      },
                  ]
                : [];
        });
        mocks.getShoppingList.mockImplementation(() =>
            summaryFor(useAuthStore.getState().user?.id === accountA.id ? accountAItem : accountBItem),
        );
        mocks.markPurchased.mockResolvedValue(undefined);
    });

    it('synchronously hides account A recipes when auth switches to B', () => {
        render(<GalleyPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('tab', { name: /Saved Recipes/ }));
        expect(screen.getByText('Account A private curry')).toBeInTheDocument();

        act(() => switchAccount(accountB));

        expect(screen.queryByText('Account A private curry')).not.toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /Saved Recipes \(0\)/ })).toBeInTheDocument();
    });

    it('drops an account A purchase completion after B becomes active', async () => {
        let resolvePurchase!: () => void;
        mocks.markPurchased.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                resolvePurchase = resolve;
            }),
        );

        render(<GroceryListPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Mark Account A tomatoes as purchased' }));
        fireEvent.click(
            within(screen.getByRole('dialog', { name: /Mark as Purchased/ })).getByRole('button', {
                name: 'Confirm purchase of Account A tomatoes',
            }),
        );
        expect(mocks.markPurchased).toHaveBeenCalledWith('a-item', undefined, undefined, null, accountA.id);

        act(() => switchAccount(accountB));
        expect(screen.queryByText('Account A tomatoes')).not.toBeInTheDocument();
        expect(await screen.findByText('Account B milk')).toBeInTheDocument();

        await act(async () => {
            resolvePurchase();
            await Promise.resolve();
        });

        await waitFor(() => expect(screen.getByText('Account B milk')).toBeInTheDocument());
        expect(screen.queryByText('Account A tomatoes')).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: /Mark as Purchased/ })).not.toBeInTheDocument();
    });
});
