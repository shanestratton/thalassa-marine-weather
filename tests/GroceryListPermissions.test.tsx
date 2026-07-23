import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getShoppingList: vi.fn(),
    markPurchased: vi.fn(),
    unmarkPurchased: vi.fn(),
    addManualItem: vi.fn(),
    permissions: {
        loaded: true,
        isSkipper: false,
        canViewStores: true,
        canEditStores: false,
        canViewGalley: false,
        permissions: {
            can_view_passage_meals: false,
        },
    },
}));

vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: mocks.getShoppingList,
    markPurchased: mocks.markPurchased,
    unmarkPurchased: mocks.unmarkPurchased,
    addManualItem: mocks.addManualItem,
    getVoyageBudget: vi.fn(),
}));
vi.mock('../services/PurchaseUnits', () => ({
    toPurchasable: (_name: string, qty: number, unit: string) => ({
        packageCount: qty,
        packageLabel: unit,
        matched: false,
    }),
}));
vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: vi.fn().mockReturnValue(null),
}));
vi.mock('../hooks/useRealtimeSync', () => ({
    useRealtimeSync: vi.fn(),
}));
vi.mock('../hooks/usePermissions', () => ({
    usePermissions: () => mocks.permissions,
}));
vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { GroceryListPage } from '../components/vessel/GroceryListPage';

const unpurchasedItem = {
    id: 'grocery-needed',
    ingredient_name: 'Tomatoes',
    required_qty: 4,
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

const purchasedItem = {
    ...unpurchasedItem,
    id: 'grocery-purchased',
    ingredient_name: 'Milk',
    market_zone: 'Dairy' as const,
    purchased: true,
    purchased_at: '2026-07-23T01:00:00.000Z',
    purchased_quantity: 4,
    purchased_unit: 'each',
};

function setPermissions({
    loaded = true,
    isSkipper = false,
    canViewStores = true,
    canEditStores = false,
    canViewGalley = false,
    canViewPassageMeals = false,
}: {
    loaded?: boolean;
    isSkipper?: boolean;
    canViewStores?: boolean;
    canEditStores?: boolean;
    canViewGalley?: boolean;
    canViewPassageMeals?: boolean;
}) {
    mocks.permissions.loaded = loaded;
    mocks.permissions.isSkipper = isSkipper;
    mocks.permissions.canViewStores = canViewStores;
    mocks.permissions.canEditStores = canEditStores;
    mocks.permissions.canViewGalley = canViewGalley;
    mocks.permissions.permissions.can_view_passage_meals = canViewPassageMeals;
}

describe('GroceryListPage permissions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setPermissions({});
        mocks.getShoppingList.mockReturnValue({
            total: 2,
            purchased: 1,
            remaining: 1,
            totalCost: 0,
            currency: 'AUD',
            zones: [
                { zone: 'Produce', items: [unpurchasedItem] },
                { zone: 'Dairy', items: [purchasedItem] },
            ],
        });
    });

    it('keeps purchase, undo, and list mutations visibly read-only for view-only crew', () => {
        render(<GroceryListPage onBack={vi.fn()} />);

        const explanation = screen.getByRole('note');
        expect(explanation).toHaveTextContent("Ship's Stores are read-only");

        const purchase = screen.getByRole('button', { name: 'Mark Tomatoes as purchased' });
        expect(purchase).toBeDisabled();
        expect(purchase).toHaveAttribute('aria-describedby', explanation.id);
        fireEvent.click(purchase);
        expect(screen.queryByRole('dialog', { name: /Mark as Purchased/ })).not.toBeInTheDocument();
        expect(mocks.markPurchased).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('tab', { name: /All/ }));
        const undo = screen.getByRole('button', { name: 'Undo Milk' });
        expect(undo).toBeDisabled();
        fireEvent.click(undo);
        expect(mocks.unmarkPurchased).not.toHaveBeenCalled();

        expect(screen.getByRole('button', { name: 'Add item to shopping list' })).toBeDisabled();
    });

    it('lets a Galley meal planner add list items without granting Stores purchase actions', () => {
        setPermissions({ canViewGalley: true });
        render(<GroceryListPage onBack={vi.fn()} />);

        expect(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' })).toBeDisabled();
        expect(screen.getByRole('note')).toHaveTextContent('You can still add items to the shopping list.');

        const add = screen.getByRole('button', { name: 'Add item to shopping list' });
        expect(add).toBeEnabled();
        fireEvent.click(add);
        expect(screen.getByRole('dialog', { name: /Add to Shopping List/ })).toBeInTheDocument();
    });

    it.each([
        ['skipper', { isSkipper: true, canEditStores: true }],
        ['Stores editor', { canEditStores: true }],
    ])('enables purchase recording for a loaded %s', (_label, permission) => {
        setPermissions(permission);
        render(<GroceryListPage onBack={vi.fn()} />);

        expect(screen.queryByRole('note')).not.toBeInTheDocument();
        const purchase = screen.getByRole('button', { name: 'Mark Tomatoes as purchased' });
        expect(purchase).toBeEnabled();
        fireEvent.click(purchase);
        expect(
            within(screen.getByRole('dialog', { name: /Mark as Purchased/ })).getByRole('button', {
                name: 'Confirm purchase of Tomatoes',
            }),
        ).toBeEnabled();
    });

    it('does not flash enabled actions before the permission check finishes', () => {
        setPermissions({
            loaded: false,
            isSkipper: true,
            canEditStores: true,
            canViewGalley: true,
        });
        const { rerender } = render(<GroceryListPage onBack={vi.fn()} />);

        expect(screen.getByRole('status')).toHaveTextContent('Checking your grocery access');
        expect(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Add item to shopping list' })).toBeDisabled();

        setPermissions({ isSkipper: true, canEditStores: true, canViewGalley: true });
        rerender(<GroceryListPage onBack={vi.fn()} />);

        expect(screen.queryByText(/Checking your grocery access/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Add item to shopping list' })).toBeEnabled();
    });

    it('closes an open Stores mutation dialog as soon as permission becomes unresolved', () => {
        setPermissions({ canEditStores: true });
        const { rerender } = render(<GroceryListPage onBack={vi.fn()} />);

        fireEvent.click(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' }));
        expect(screen.getByRole('dialog', { name: /Mark as Purchased/ })).toBeInTheDocument();

        setPermissions({ loaded: false, canEditStores: true });
        rerender(<GroceryListPage onBack={vi.fn()} />);

        expect(screen.queryByRole('dialog', { name: /Mark as Purchased/ })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Mark Tomatoes as purchased' })).toBeDisabled();
        expect(mocks.markPurchased).not.toHaveBeenCalled();
    });
});
