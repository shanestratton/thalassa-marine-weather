/**
 * PassageProvisionsService — Unit Tests
 *
 * Tests the core fuzzy matching logic (findStoreMatch)
 * and alias management (setAlias, removeAlias, getAllAliases).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { findStoreMatch, setAlias, removeAlias, getAllAliases } from '../services/PassageProvisionsService';
import type { StoresItem } from '../types';

// ── Helpers ──────────────────────────────────────────────────────

const makeStoreItem = (overrides: Partial<StoresItem> = {}): StoresItem => ({
    id: 'store-1',
    user_id: 'user-1',
    item_name: 'Chicken Breast',
    category: 'food' as any,
    quantity: 5,
    min_quantity: 2,
    barcode: '',
    location_zone: '',
    location_specific: '',
    unit: 'kg',
    description: '',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    ...overrides,
} as StoresItem);

const storeItems: StoresItem[] = [
    makeStoreItem({ id: 's1', item_name: 'Chicken Breast' }),
    makeStoreItem({ id: 's2', item_name: 'Beef Brisket' }),
    makeStoreItem({ id: 's3', item_name: 'Olive Oil' }),
    makeStoreItem({ id: 's4', item_name: 'Salt' }),
    makeStoreItem({ id: 's5', item_name: 'Brown Sugar' }),
];

describe('findStoreMatch', () => {
    it('returns exact match with score 1.0', () => {
        const match = findStoreMatch('Chicken Breast', storeItems);
        expect(match).not.toBeNull();
        expect(match!.score).toBe(1.0);
        expect(match!.matchType).toBe('exact');
        expect(match!.item.id).toBe('s1');
    });

    it('is case-insensitive for exact matching', () => {
        const match = findStoreMatch('chicken breast', storeItems);
        expect(match).not.toBeNull();
        expect(match!.matchType).toBe('exact');
    });

    it('trims whitespace for exact matching', () => {
        const match = findStoreMatch('  Salt  ', storeItems);
        expect(match!.matchType).toBe('exact');
        expect(match!.item.id).toBe('s4');
    });

    it('returns fuzzy match for substring (needle in store name)', () => {
        const match = findStoreMatch('beef', storeItems);
        expect(match).not.toBeNull();
        expect(match!.matchType).toBe('fuzzy');
        expect(match!.item.id).toBe('s2'); // Beef Brisket
    });

    it('returns fuzzy match for substring (store name in needle)', () => {
        const match = findStoreMatch('extra virgin olive oil', storeItems);
        expect(match).not.toBeNull();
        expect(match!.matchType).toBe('fuzzy');
        expect(match!.item.id).toBe('s3'); // Olive Oil
    });

    it('returns null for empty needle', () => {
        expect(findStoreMatch('', storeItems)).toBeNull();
    });

    it('returns null for empty store items', () => {
        expect(findStoreMatch('Chicken', [])).toBeNull();
    });

    it('returns null for completely unrelated ingredient', () => {
        expect(findStoreMatch('kryptonite', storeItems)).toBeNull();
    });

    it('returns word-level overlap match', () => {
        // "chicken thigh" should match "chicken breast" via word overlap
        const match = findStoreMatch('chicken thigh', storeItems);
        expect(match).not.toBeNull();
        expect(match!.item.id).toBe('s1'); // Chicken Breast (word "chicken" overlaps)
    });
});

describe('Alias management', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('sets and retrieves an alias', () => {
        setAlias('cilantro', 's1');
        const aliases = getAllAliases();
        expect(aliases['cilantro']).toBe('s1');
    });

    it('is case-insensitive when setting aliases', () => {
        setAlias('Cilantro', 's1');
        const aliases = getAllAliases();
        expect(aliases['cilantro']).toBe('s1');
    });

    it('removes an alias', () => {
        setAlias('cilantro', 's1');
        removeAlias('cilantro');
        const aliases = getAllAliases();
        expect(aliases['cilantro']).toBeUndefined();
    });

    it('findStoreMatch uses alias for matching', () => {
        setAlias('coriander', 's1');
        const match = findStoreMatch('coriander', storeItems);
        expect(match).not.toBeNull();
        expect(match!.matchType).toBe('alias');
        expect(match!.score).toBe(0.95);
        expect(match!.item.id).toBe('s1');
    });

    it('returns empty object when no aliases set', () => {
        expect(getAllAliases()).toEqual({});
    });
});
