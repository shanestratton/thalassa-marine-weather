import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredRecipe } from '../services/GalleyRecipeService';

const databaseMocks = vi.hoisted(() => ({
    insertLocal: vi.fn(),
    query: vi.fn(),
    updateLocal: vi.fn(),
}));

const supabaseMocks = vi.hoisted(() => {
    const recipesEq = vi.fn().mockResolvedValue({ data: [], error: null });
    const communityEq = vi.fn().mockResolvedValue({ data: [], error: null });
    const recipesUpdate = vi.fn(() => ({ eq: recipesEq }));
    const communityUpdate = vi.fn(() => ({ eq: communityEq }));
    const from = vi.fn((table: string) => ({
        update: table === 'community_recipes' ? communityUpdate : recipesUpdate,
    }));
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } });

    return {
        from,
        getUser,
        recipesEq,
        communityEq,
        recipesUpdate,
        communityUpdate,
    };
});

vi.mock('../services/vessel/LocalDatabase', () => ({
    getAll: vi.fn(() => []),
    insertLocal: databaseMocks.insertLocal,
    query: databaseMocks.query,
    updateLocal: databaseMocks.updateLocal,
    generateUUID: vi.fn(() => 'generated-id'),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getUser: supabaseMocks.getUser,
        },
        from: supabaseMocks.from,
    },
}));

vi.mock('../services/ProfilePhotoService', () => ({
    compressImage: vi.fn(),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    }),
}));

import { createCustomRecipe, updateCustomRecipe } from '../services/GalleyRecipeService';

const recipe: StoredRecipe = {
    id: 'recipe-1',
    spoonacular_id: null,
    user_id: 'user-1',
    title: 'Sea Curry',
    image_url: 'https://example.test/curry.jpg',
    ready_in_minutes: 45,
    servings: 4,
    source_url: '',
    instructions: 'Warm the pan',
    ingredients: [],
    is_favorite: false,
    is_custom: true,
    visibility: 'personal',
    tags: [],
    created_at: '2026-07-22T08:00:00.000Z',
    updated_at: '2026-07-22T08:00:00.000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
    supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    databaseMocks.query.mockReturnValue([recipe]);
    databaseMocks.insertLocal.mockImplementation(async (_table: string, record: StoredRecipe) => record);
    databaseMocks.updateLocal.mockImplementation(async (_table: string, _id: string, patch: Partial<StoredRecipe>) => ({
        ...recipe,
        ...patch,
    }));
});

describe('custom recipe update persistence', () => {
    it('still creates the local-first recipe when auth verification is offline', async () => {
        supabaseMocks.getUser.mockRejectedValue(new Error('offline'));

        const created = await createCustomRecipe({
            title: '  Offline Stew  ',
            instructions: 'Combine everything',
            ready_in_minutes: 30,
            servings: 4,
            ingredients: [],
            tags: [],
            visibility: 'personal',
        });

        expect(created).toEqual(
            expect.objectContaining({
                title: 'Offline Stew',
                user_id: null,
                is_custom: true,
            }),
        );
        expect(databaseMocks.insertLocal).toHaveBeenCalledWith('recipes', created);
        expect(supabaseMocks.from).not.toHaveBeenCalled();
    });

    it('updates local storage and both compatible cloud recipe stores', async () => {
        const updated = await updateCustomRecipe('recipe-1', {
            title: 'Harbour Curry',
            instructions: 'Warm the pan\nAdd the fish',
            image_url: '',
            visibility: 'shared',
            servings: 6,
        });

        expect(updated).toEqual(expect.objectContaining({ title: 'Harbour Curry', visibility: 'shared' }));
        expect(databaseMocks.updateLocal).toHaveBeenCalledWith(
            'recipes',
            'recipe-1',
            expect.objectContaining({
                title: 'Harbour Curry',
                instructions: 'Warm the pan\nAdd the fish',
            }),
        );
        expect(supabaseMocks.recipesUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Harbour Curry',
                visibility: 'shared',
            }),
        );
        expect(supabaseMocks.recipesEq).toHaveBeenCalledWith('id', 'recipe-1');
        expect(supabaseMocks.communityUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Harbour Curry',
                image_url: null,
                visibility: 'community',
                servings: 6,
                instructions: [
                    { number: 1, step: 'Warm the pan' },
                    { number: 2, step: 'Add the fish' },
                ],
            }),
        );
        expect(supabaseMocks.communityEq).toHaveBeenCalledWith('id', 'recipe-1');
    });

    it('does not write when the recipe is not a locally owned custom recipe', async () => {
        databaseMocks.query.mockReturnValue([]);

        await expect(updateCustomRecipe('missing-recipe', { title: 'Nope' })).resolves.toBeNull();
        expect(databaseMocks.updateLocal).not.toHaveBeenCalled();
        expect(supabaseMocks.from).not.toHaveBeenCalled();
    });

    it("does not update another signed-in sailor's local recipe copy", async () => {
        supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: 'another-user' } } });

        await expect(updateCustomRecipe('recipe-1', { title: 'Nope' })).resolves.toBeNull();
        expect(databaseMocks.updateLocal).not.toHaveBeenCalled();
        expect(supabaseMocks.from).not.toHaveBeenCalled();
    });
});
