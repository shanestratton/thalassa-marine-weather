import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredRecipe } from '../services/GalleyRecipeService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const RECIPE_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_PATH = `${OWNER_ID}/${RECIPE_ID}.jpg`;
const LEGACY_PATH = `${RECIPE_ID}.jpg`;
const photoUrl = (path: string) => `https://example.supabase.co/storage/v1/object/public/recipe-photos/${path}`;

const databaseMocks = vi.hoisted(() => ({
    insertLocal: vi.fn(),
    query: vi.fn(),
    updateLocal: vi.fn(),
}));

const mediaMocks = vi.hoisted(() => ({
    capture: vi.fn(),
    retain: vi.fn(),
    retire: vi.fn(),
}));

const supabaseMocks = vi.hoisted(() => {
    type Table = 'recipes' | 'community_recipes';
    type Row = Record<string, unknown> & { id: string; user_id: string };
    type Failure = { message: string } | null;

    const state = {
        rows: { recipes: null, community_recipes: null } as Record<Table, Row | null>,
        events: [] as string[],
        updateErrors: { recipes: null, community_recipes: null } as Record<Table, Failure>,
        updateZero: new Set<Table>(),
        updateGates: { recipes: null, community_recipes: null } as Record<Table, Promise<void> | null>,
        storageRemoveError: null as Failure,
    };

    const getSession = vi.fn();
    const getUser = vi.fn();
    const remove = vi.fn(async (paths: string[]) => {
        state.events.push(`storage:remove:${paths.join(',')}`);
        return { error: state.storageRemoveError };
    });

    function filtered(row: Row | null, filters: Array<[string, unknown]>): Row | null {
        if (!row) return null;
        return filters.every(([key, value]) => row[key] === value) ? { ...row } : null;
    }

    function chain(finalize: (filters: Array<[string, unknown]>) => Promise<unknown>) {
        const filters: Array<[string, unknown]> = [];
        const value = {
            eq: vi.fn((column: string, expected: unknown) => {
                filters.push([column, expected]);
                return value;
            }),
            select: vi.fn(() => value),
            maybeSingle: vi.fn(() => finalize(filters)),
            single: vi.fn(() => finalize(filters)),
        };
        return value;
    }

    const from = vi.fn((tableName: string) => {
        const table = tableName as Table;
        return {
            select: vi.fn(() =>
                chain(async (filters) => {
                    state.events.push(`${table}:read`);
                    return { data: filtered(state.rows[table], filters), error: null };
                }),
            ),
            update: vi.fn((payload: Record<string, unknown>) =>
                chain(async (filters) => {
                    state.events.push(`${table}:update`);
                    if (state.updateGates[table]) await state.updateGates[table];
                    if (state.updateErrors[table]) return { data: null, error: state.updateErrors[table] };
                    const row = filtered(state.rows[table], filters);
                    if (!row || state.updateZero.has(table)) return { data: null, error: null };
                    const updated = { ...row, ...payload } as Row;
                    state.rows[table] = updated;
                    return { data: { ...updated }, error: null };
                }),
            ),
            upsert: vi.fn(async () => ({ data: null, error: null })),
        };
    });

    return {
        from,
        getSession,
        getUser,
        remove,
        state,
        storageFrom: vi.fn(() => ({ remove })),
    };
});

vi.mock('../services/vessel/LocalDatabase', () => ({
    generateUUID: vi.fn(() => 'generated-id'),
    getAll: vi.fn(() => []),
    insertLocal: databaseMocks.insertLocal,
    query: databaseMocks.query,
    updateLocal: databaseMocks.updateLocal,
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getSession: supabaseMocks.getSession, getUser: supabaseMocks.getUser },
        from: supabaseMocks.from,
        storage: { from: supabaseMocks.storageFrom },
    },
}));

vi.mock('../services/OwnedMediaCleanupService', () => ({
    captureOwnedMediaAuthorization: mediaMocks.capture,
    retainUncertainOwnedMedia: mediaMocks.retain,
    retireOwnedMedia: mediaMocks.retire,
}));

vi.mock('../services/ProfilePhotoService', () => ({ compressImage: vi.fn() }));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { createCustomRecipe, updateCustomRecipe } from '../services/GalleyRecipeService';

const localRecipe = (imagePath = OWNER_PATH, visibility: StoredRecipe['visibility'] = 'shared'): StoredRecipe => ({
    id: RECIPE_ID,
    spoonacular_id: null,
    user_id: OWNER_ID,
    title: 'Sea Curry',
    image_url: photoUrl(imagePath),
    ready_in_minutes: 45,
    servings: 4,
    source_url: '',
    instructions: 'Warm the pan',
    ingredients: [],
    is_favorite: false,
    is_custom: true,
    visibility,
    tags: [],
    created_at: '2026-07-22T08:00:00.000Z',
    updated_at: '2026-07-22T08:00:00.000Z',
});

function cloudRow(table: 'recipes' | 'community_recipes', imagePath = OWNER_PATH) {
    return {
        id: RECIPE_ID,
        user_id: OWNER_ID,
        title: 'Sea Curry',
        instructions: table === 'recipes' ? 'Warm the pan' : [{ number: 1, step: 'Warm the pan' }],
        image_url: photoUrl(imagePath),
        ready_in_minutes: 45,
        servings: 4,
        ingredients: [],
        tags: [],
        is_favorite: false,
        visibility: table === 'recipes' ? 'shared' : 'community',
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    supabaseMocks.state.rows.recipes = cloudRow('recipes');
    supabaseMocks.state.rows.community_recipes = cloudRow('community_recipes');
    supabaseMocks.state.events.splice(0);
    supabaseMocks.state.updateErrors.recipes = null;
    supabaseMocks.state.updateErrors.community_recipes = null;
    supabaseMocks.state.updateZero.clear();
    supabaseMocks.state.updateGates.recipes = null;
    supabaseMocks.state.updateGates.community_recipes = null;
    supabaseMocks.state.storageRemoveError = null;
    supabaseMocks.getSession.mockResolvedValue({
        data: { session: { access_token: 'owner-token', user: { id: OWNER_ID } } },
        error: null,
    });
    supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } }, error: null });
    mediaMocks.capture.mockResolvedValue({ ownerId: OWNER_ID, accessToken: 'owner-token' });
    mediaMocks.retain.mockReturnValue(true);
    mediaMocks.retire.mockImplementation(async () => {
        supabaseMocks.state.events.push('media:retire');
        return true;
    });
    databaseMocks.query.mockReturnValue([localRecipe()]);
    databaseMocks.insertLocal.mockImplementation(async (_table: string, record: StoredRecipe) => record);
    databaseMocks.updateLocal.mockImplementation(async (_table: string, _id: string, patch: Partial<StoredRecipe>) => {
        supabaseMocks.state.events.push('local:update');
        return { ...localRecipe(), ...patch };
    });
    setAuthIdentityScope(OWNER_ID);
});

describe('custom recipe update persistence', () => {
    it('still creates a local-only recipe when auth verification is offline', async () => {
        supabaseMocks.getSession.mockRejectedValue(new Error('offline'));
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

        expect(created).toEqual(expect.objectContaining({ title: 'Offline Stew', user_id: null, is_custom: true }));
        expect(databaseMocks.insertLocal).toHaveBeenCalledWith('recipes', created);
        expect(supabaseMocks.from).not.toHaveBeenCalled();
    });

    it('confirms both cloud rows and read-back before media cleanup and the local write', async () => {
        const updated = await updateCustomRecipe(RECIPE_ID, {
            title: 'Harbour Curry',
            instructions: 'Warm the pan\nAdd the fish',
            image_url: '',
            visibility: 'shared',
            servings: 6,
        });

        expect(updated).toEqual(expect.objectContaining({ title: 'Harbour Curry', visibility: 'shared' }));
        expect(supabaseMocks.state.events).toEqual([
            'recipes:read',
            'community_recipes:read',
            'recipes:update',
            'community_recipes:update',
            'recipes:read',
            'community_recipes:read',
            'media:retire',
            'local:update',
        ]);
        expect(supabaseMocks.state.rows.community_recipes).toEqual(
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
    });

    it('treats an RLS zero-row update as failure and keeps the local/media retry handle', async () => {
        supabaseMocks.state.updateZero.add('recipes');

        await expect(updateCustomRecipe(RECIPE_ID, { image_url: '', title: 'No false success' })).resolves.toBeNull();

        expect(mediaMocks.retire).not.toHaveBeenCalled();
        expect(databaseMocks.updateLocal).not.toHaveBeenCalled();
    });

    it('honours auth generation when the account changes during cloud mutation', async () => {
        let releaseUpdate!: () => void;
        supabaseMocks.state.updateGates.recipes = new Promise<void>((resolve) => {
            releaseUpdate = resolve;
        });

        const pending = updateCustomRecipe(RECIPE_ID, { image_url: '', title: 'Owner A edit' });
        await vi.waitFor(() => expect(supabaseMocks.state.events).toContain('recipes:update'));
        setAuthIdentityScope(OTHER_USER_ID);
        releaseUpdate();

        await expect(pending).resolves.toBeNull();
        expect(mediaMocks.retire).not.toHaveBeenCalled();
        expect(databaseMocks.updateLocal).not.toHaveBeenCalled();
    });

    it('inspects both mutation results before retiring any old media', async () => {
        supabaseMocks.state.updateErrors.community_recipes = { message: 'community update failed' };

        await expect(updateCustomRecipe(RECIPE_ID, { image_url: '', title: 'Partial edit' })).resolves.toBeNull();

        expect(mediaMocks.retire).not.toHaveBeenCalled();
        expect(databaseMocks.updateLocal).not.toHaveBeenCalled();
    });

    it('retires old minus new for a shared legacy-to-owner replacement', async () => {
        databaseMocks.query.mockReturnValue([localRecipe(LEGACY_PATH)]);
        supabaseMocks.state.rows.recipes = cloudRow('recipes', LEGACY_PATH);
        supabaseMocks.state.rows.community_recipes = cloudRow('community_recipes', LEGACY_PATH);

        await expect(
            updateCustomRecipe(RECIPE_ID, { image_url: photoUrl(OWNER_PATH), visibility: 'shared' }),
        ).resolves.toEqual(expect.objectContaining({ image_url: photoUrl(OWNER_PATH) }));

        expect(supabaseMocks.remove).toHaveBeenCalledWith([LEGACY_PATH]);
        expect(mediaMocks.retire).not.toHaveBeenCalled();
        expect(supabaseMocks.state.events.indexOf(`storage:remove:${LEGACY_PATH}`)).toBeLessThan(
            supabaseMocks.state.events.indexOf('local:update'),
        );
    });

    it('retires the old managed path when a shared recipe clears its image', async () => {
        await expect(updateCustomRecipe(RECIPE_ID, { image_url: '', visibility: 'shared' })).resolves.toEqual(
            expect.objectContaining({ image_url: '' }),
        );

        expect(mediaMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: OWNER_ID }),
            expect.objectContaining({ ownerId: OWNER_ID }),
            'recipe-photos',
            OWNER_PATH,
        );
    });

    it('clears public image references before a recipe can become personal', async () => {
        await expect(
            updateCustomRecipe(RECIPE_ID, { visibility: 'personal', image_url: photoUrl(OWNER_PATH) }),
        ).resolves.toEqual(expect.objectContaining({ visibility: 'personal', image_url: '' }));

        expect(supabaseMocks.state.rows.recipes).toEqual(
            expect.objectContaining({ visibility: 'personal', image_url: null }),
        );
        expect(supabaseMocks.state.rows.community_recipes).toEqual(
            expect.objectContaining({ visibility: 'private', image_url: null }),
        );
        expect(mediaMocks.retire).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'recipe-photos',
            OWNER_PATH,
        );
    });

    it("does not write a missing recipe or another account owner's recipe", async () => {
        databaseMocks.query.mockReturnValue([]);
        await expect(updateCustomRecipe('missing-recipe', { title: 'Nope' })).resolves.toBeNull();

        databaseMocks.query.mockReturnValue([localRecipe()]);
        mediaMocks.capture.mockResolvedValue(null);
        await expect(updateCustomRecipe(RECIPE_ID, { title: 'Nope' })).resolves.toBeNull();

        expect(databaseMocks.updateLocal).not.toHaveBeenCalled();
    });
});
