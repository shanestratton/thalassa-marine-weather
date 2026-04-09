import { describe, it, expect } from 'vitest';
import { toPurchasable, toPurchasableList } from '../services/PurchaseUnits';

describe('toPurchasable', () => {
    describe('known ingredient matching', () => {
        it('matches sugar by keyword', () => {
            const result = toPurchasable('white sugar', 500, 'g');
            expect(result.matched).toBe(true);
            expect(result.packageLabel).toContain('kg');
        });

        it('matches olive oil', () => {
            const result = toPurchasable('olive oil', 100, 'ml');
            expect(result.matched).toBe(true);
            expect(result.packageLabel).toContain('bottle');
        });

        it('matches flour variants', () => {
            expect(toPurchasable('plain flour', 500, 'g').matched).toBe(true);
            expect(toPurchasable('self-raising flour', 250, 'g').matched).toBe(true);
            expect(toPurchasable('bread flour', 1000, 'g').matched).toBe(true);
        });

        it('matches honey', () => {
            const result = toPurchasable('honey', 2, 'tbsp');
            expect(result.matched).toBe(true);
            expect(result.packageLabel).toContain('jar');
        });
    });

    describe('unit conversion — grams', () => {
        it('converts kg to g', () => {
            const result = toPurchasable('sugar', 2, 'kg');
            expect(result.packageCount).toBe(2); // 2kg needs 2 × 1kg bags
        });

        it('converts oz to g', () => {
            const result = toPurchasable('flour', 8, 'oz');
            // 8 oz = 226.8g → 1 × 1kg bag
            expect(result.packageCount).toBe(1);
        });

        it('converts lb to g', () => {
            const result = toPurchasable('sugar', 3, 'lb');
            // 3 lb = 1360.8g → 2 × 1kg bags
            expect(result.packageCount).toBe(2);
        });
    });

    describe('unit conversion — ml', () => {
        it('converts cups to ml', () => {
            const result = toPurchasable('olive oil', 3, 'cups');
            // 3 cups = 720ml → 2 × 500ml bottles
            expect(result.packageCount).toBe(2);
        });

        it('converts tbsp to ml', () => {
            const result = toPurchasable('soy sauce', 2, 'tbsp');
            // 2 tbsp = 30ml → 1 × 250ml bottle
            expect(result.packageCount).toBe(1);
        });

        it('converts liters to ml', () => {
            const result = toPurchasable('olive oil', 2, 'liters');
            // 2L = 2000ml → 4 × 500ml bottles
            expect(result.packageCount).toBe(4);
        });
    });

    describe('unit conversion — whole items', () => {
        it('handles eggs by dozen', () => {
            const result = toPurchasable('eggs', 6, 'whole');
            expect(result.matched).toBe(true);
        });

        it('handles bread as loaf', () => {
            const result = toPurchasable('white bread', 1, 'whole');
            expect(result.matched).toBe(true);
            expect(result.packageLabel).toContain('loaf');
        });
    });

    describe('unmatched ingredients', () => {
        it('returns matched=false for unknown ingredients', () => {
            const result = toPurchasable('truffle oil', 1, 'tbsp');
            expect(result.matched).toBe(false);
            expect(result.name).toBe('truffle oil');
        });

        it('returns raw quantity for unmatched', () => {
            const result = toPurchasable('pixie dust', 3, 'drops');
            expect(result.matched).toBe(false);
            expect(result.packageCount).toBe(3);
        });
    });

    describe('package rounding', () => {
        it('always rounds up to at least 1 package', () => {
            const result = toPurchasable('sugar', 1, 'g');
            // 1g of sugar still needs 1 × 1kg bag
            expect(result.packageCount).toBe(1);
        });

        it('rounds up partial packages', () => {
            const result = toPurchasable('sugar', 1500, 'g');
            // 1500g → 2 × 1kg bags
            expect(result.packageCount).toBe(2);
        });
    });

    describe('specific keyword priority', () => {
        it('matches caster sugar before generic sugar', () => {
            const caster = toPurchasable('caster sugar', 500, 'g');
            expect(caster.matched).toBe(true);
            expect(caster.packageLabel).toContain('1kg');
        });

        it('matches extra virgin olive oil before olive oil', () => {
            const ev = toPurchasable('extra virgin olive oil', 250, 'ml');
            expect(ev.matched).toBe(true);
        });
    });
});

describe('toPurchasableList', () => {
    it('converts a batch of ingredients', () => {
        const list = toPurchasableList([
            { name: 'sugar', totalQty: 500, unit: 'g' },
            { name: 'olive oil', totalQty: 100, unit: 'ml' },
            { name: 'mystery spice', totalQty: 1, unit: 'tsp' },
        ]);
        expect(list).toHaveLength(3);
        expect(list[0].matched).toBe(true);
        expect(list[1].matched).toBe(true);
        expect(list[2].matched).toBe(false);
    });

    it('returns empty array for empty input', () => {
        expect(toPurchasableList([])).toEqual([]);
    });
});
