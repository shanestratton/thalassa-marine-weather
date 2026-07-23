import { beforeEach, describe, expect, it, vi } from 'vitest';

const inventory = vi.hoisted(() => ({
    rows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    getAll: (table: string) => (table === 'inventory_items' ? inventory.rows : []),
    query: vi.fn(() => []),
    insertLocal: vi.fn(),
    generateUUID: vi.fn(() => 'provision-1'),
}));

vi.mock('../services/GalleyRecipeService', () => ({
    scaleIngredient: (amount: number) => amount,
}));

import { calculateProvisions } from '../services/PassageProvisionsService';

function planWithIngredient(name: string, amount: number, unit: string) {
    return {
        days: [
            {
                meals: [
                    {
                        title: 'Test meal',
                        servings: 4,
                        ingredients: [{ name, amount, unit, scalable: true }],
                    },
                ],
            },
        ],
    };
}

describe('PassageProvisionsService unit integrity', () => {
    beforeEach(() => {
        inventory.rows = [];
    });

    it('aggregates separate same-name inventory rows in the recipe unit', () => {
        inventory.rows = [
            { id: 'rice-a', item_name: 'Rice', quantity: 250, unit: 'g' },
            { id: 'rice-b', item_name: 'Rice', quantity: 0.5, unit: 'kg' },
        ];

        const result = calculateProvisions(planWithIngredient('Rice', 1, 'kg') as never, 4);

        expect(result.items[0]).toMatchObject({
            required_qty: 1,
            on_hand_qty: 0.75,
            shortfall_qty: 0.25,
            unit: 'kg',
            status: 'needed',
        });
    });

    it('does not claim mass stock satisfies a volume requirement without density data', () => {
        inventory.rows = [{ id: 'sugar', item_name: 'Sugar', quantity: 1000, unit: 'g' }];

        const result = calculateProvisions(planWithIngredient('Sugar', 2, 'tbsp') as never, 4);

        expect(result.items[0]).toMatchObject({
            on_hand_qty: 0,
            shortfall_qty: 2,
            status: 'needed',
        });
    });
});
