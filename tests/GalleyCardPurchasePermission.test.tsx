import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PassageStatus } from '../services/PassagePlanService';

const shoppingMocks = vi.hoisted(() => ({
    getShoppingList: vi.fn(),
    markPurchased: vi.fn(),
}));

vi.mock('../services/ShoppingListService', () => ({
    getShoppingList: shoppingMocks.getShoppingList,
    markPurchased: shoppingMocks.markPurchased,
}));

vi.mock('../services/MealPlanService', () => ({
    getMealsByStatus: vi.fn(() => []),
    calculateMealDays: vi.fn(),
    getCrewCount: vi.fn(async () => 2),
}));

vi.mock('../services/VoyageService', () => ({
    getCachedActiveVoyage: vi.fn(() => null),
    getActiveVoyage: vi.fn(async () => null),
    getDraftVoyages: vi.fn(async () => []),
}));

vi.mock('../services/PassagePlanService', () => ({
    getActivePassageId: vi.fn(() => null),
}));

vi.mock('../utils/system', () => ({
    triggerHaptic: vi.fn(),
}));

import { GalleyCard } from '../components/chat/GalleyCard';

const passageStatus: PassageStatus = {
    visible: true,
    voyageId: 'voyage-1',
    ownerUserId: 'captain-1',
    isOwner: false,
    canEditStores: false,
    canViewMeals: true,
    canViewChat: false,
    canViewRoute: false,
    canViewChecklist: false,
};

const summary = {
    total: 1,
    purchased: 0,
    remaining: 1,
    totalCost: 0,
    currency: 'AUD',
    zones: [
        {
            zone: 'Produce',
            items: [
                {
                    id: 'grocery-1',
                    ingredient_name: 'Tomatoes',
                    required_qty: 4,
                    unit: 'each',
                    market_zone: 'Produce',
                    actual_cost: null,
                    currency: 'AUD',
                    purchased: false,
                    purchased_at: null,
                    store_location: '',
                    provision_id: null,
                    voyage_id: 'voyage-1',
                    notes: null,
                    created_at: '2026-07-23T00:00:00.000Z',
                    updated_at: '2026-07-23T00:00:00.000Z',
                },
            ],
        },
    ],
};

async function openShoppingList(): Promise<HTMLButtonElement> {
    fireEvent.click(screen.getByRole('button', { name: 'Voyage Provisioning' }));
    const shoppingCard = await screen.findByRole('button', { name: /Shopping List — 1 item to buy/ });
    fireEvent.click(shoppingCard);
    return screen.getByRole<HTMLButtonElement>('button', { name: 'Mark Tomatoes as purchased' });
}

describe('GalleyCard purchase permission', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        passageStatus.canEditStores = false;
        shoppingMocks.getShoppingList.mockReturnValue(summary);
        shoppingMocks.markPurchased.mockResolvedValue(undefined);
    });

    it('keeps meal-view crew read-only without verified Stores edit access', async () => {
        render(<GalleyCard passageStatus={passageStatus} />);

        const purchaseButton = await openShoppingList();

        expect(purchaseButton).toBeDisabled();
        expect(screen.getByRole('note')).toHaveTextContent("Ship's Stores are read-only");
        fireEvent.click(purchaseButton);
        expect(shoppingMocks.markPurchased).not.toHaveBeenCalled();
    });

    it('records a quick purchase only after Stores edit access is verified', async () => {
        passageStatus.canEditStores = true;
        render(<GalleyCard passageStatus={passageStatus} />);

        const purchaseButton = await openShoppingList();
        expect(purchaseButton).toBeEnabled();
        fireEvent.click(purchaseButton);

        await waitFor(() => {
            expect(shoppingMocks.markPurchased).toHaveBeenCalledWith(
                'grocery-1',
                undefined,
                undefined,
                'voyage-1',
                'captain-1',
            );
        });
    });

    it('surfaces a failed purchase and leaves the action available to retry', async () => {
        passageStatus.canEditStores = true;
        shoppingMocks.markPurchased.mockRejectedValueOnce(new Error('offline'));
        render(<GalleyCard passageStatus={passageStatus} />);

        const purchaseButton = await openShoppingList();
        fireEvent.click(purchaseButton);

        expect(await screen.findByRole('alert')).toHaveTextContent('could not be recorded');
        await waitFor(() => expect(purchaseButton).toBeEnabled());
    });
});
