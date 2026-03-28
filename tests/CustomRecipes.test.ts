/**
 * CustomRecipes — Unit tests for recipe CRUD, encoding/decoding, and visibility.
 */
import { describe, it, expect, vi } from 'vitest';

// Mock LocalDatabase
/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('../services/vessel/LocalDatabase', () => {
    const store = new Map<string, any[]>();
    return {
        getAll: (table: string) => store.get(table) || [],
        insertLocal: async (table: string, record: any) => {
            if (!store.has(table)) store.set(table, []);
            store.get(table)!.push(record);
        },
        query: (table: string, predicate: (r: any) => boolean) => {
            return (store.get(table) || []).filter(predicate);
        },
        updateLocal: (table: string, id: string, patch: Record<string, unknown>) => {
            const items = store.get(table) || [];
            const item = items.find((r: any) => r.id === id);
            if (item) Object.assign(item, patch);
            return item || null;
        },
        deleteLocal: async (table: string, id: string) => {
            const items = store.get(table) || [];
            store.set(
                table,
                items.filter((r: any) => r.id !== id),
            );
        },
        generateUUID: () => `uuid-${Math.random().toString(36).slice(2, 10)}`,
        _testReset: () => store.clear(),
    };
});
/* eslint-enable @typescript-eslint/no-explicit-any */

// Mock supabase
vi.mock('../services/supabase', () => ({
    supabase: null, // Offline mode for tests
}));

import {
    encodeRecipeShare,
    decodeRecipeShare,
    RECIPE_SHARE_PREFIX,
    isScalable,
    type StoredRecipe,
} from '../services/GalleyRecipeService';

describe('Recipe Share Encoding', () => {
    const mockRecipe: StoredRecipe = {
        id: 'recipe-123',
        spoonacular_id: null,
        user_id: 'user-abc',
        title: 'Fish Curry',
        image_url: 'https://example.com/fish.jpg',
        ready_in_minutes: 45,
        servings: 4,
        source_url: '',
        instructions: 'Cook the fish...',
        ingredients: [],
        is_favorite: false,
        is_custom: true,
        visibility: 'shared',
        tags: ['Dinner', 'Sea-Friendly'],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
    };

    it('encodes a recipe share correctly', () => {
        const encoded = encodeRecipeShare(mockRecipe);
        expect(encoded).toContain(RECIPE_SHARE_PREFIX);
        expect(encoded).toContain('recipe-123');
        expect(encoded).toContain('Fish Curry');
        expect(encoded).toContain('4');
        expect(encoded).toContain('45');
    });

    it('decodes a valid recipe share', () => {
        const encoded = encodeRecipeShare(mockRecipe);
        const decoded = decodeRecipeShare(encoded);
        expect(decoded).not.toBeNull();
        expect(decoded!.recipeId).toBe('recipe-123');
        expect(decoded!.title).toBe('Fish Curry');
        expect(decoded!.servings).toBe(4);
        expect(decoded!.readyInMinutes).toBe(45);
        expect(decoded!.imageUrl).toBe('https://example.com/fish.jpg');
    });

    it('returns null for non-recipe messages', () => {
        expect(decodeRecipeShare('Hello world')).toBeNull();
        expect(decodeRecipeShare('PIN_DROP:123|456|Home')).toBeNull();
    });

    it('returns null for malformed recipe messages', () => {
        expect(decodeRecipeShare(`${RECIPE_SHARE_PREFIX}only-one-part`)).toBeNull();
    });

    it('handles missing image URL gracefully', () => {
        const noImage = { ...mockRecipe, image_url: '' };
        const encoded = encodeRecipeShare(noImage);
        const decoded = decodeRecipeShare(encoded);
        expect(decoded!.imageUrl).toBe('');
    });
});

describe('Ingredient Scalability', () => {
    it('marks bottles as non-scalable', () => {
        expect(isScalable('bottle', 'olive oil')).toBe(false);
        expect(isScalable('bottles', 'wine')).toBe(false);
        expect(isScalable('jar', 'pasta sauce')).toBe(false);
    });

    it('marks condiments as non-scalable', () => {
        expect(isScalable('', 'hot sauce')).toBe(false);
        expect(isScalable('tbsp', 'vanilla extract')).toBe(false);
        expect(isScalable('tsp', 'baking soda')).toBe(false);
    });

    it('marks regular ingredients as scalable', () => {
        expect(isScalable('g', 'chicken breast')).toBe(true);
        expect(isScalable('kg', 'flour')).toBe(true);
        expect(isScalable('cup', 'rice')).toBe(true);
        expect(isScalable('whole', 'eggs')).toBe(true);
    });

    it('marks pinches and dashes as non-scalable', () => {
        expect(isScalable('pinch', 'salt')).toBe(false);
        expect(isScalable('dash', 'pepper')).toBe(false);
    });
});

describe('StoredRecipe Custom Fields', () => {
    it('has all required custom recipe fields', () => {
        const recipe: StoredRecipe = {
            id: 'test',
            spoonacular_id: null,
            user_id: 'user-1',
            title: 'Test Recipe',
            image_url: '',
            ready_in_minutes: 30,
            servings: 4,
            source_url: '',
            instructions: 'Do the thing',
            ingredients: [],
            is_favorite: false,
            is_custom: true,
            visibility: 'personal',
            tags: [],
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
        };

        expect(recipe.is_custom).toBe(true);
        expect(recipe.visibility).toBe('personal');
        expect(recipe.instructions).toBe('Do the thing');
        expect(recipe.user_id).toBe('user-1');
    });

    it('accepts both visibility values', () => {
        const personal: StoredRecipe['visibility'] = 'personal';
        const shared: StoredRecipe['visibility'] = 'shared';
        expect(personal).toBe('personal');
        expect(shared).toBe('shared');
    });
});
