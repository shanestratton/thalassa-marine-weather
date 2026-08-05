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
    deleteLocal: vi.fn(),
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
        insertError: null as Failure,
        insertApplyThenThrow: false,
        insertReturnNull: false,
        updateErrors: { recipes: null, community_recipes: null } as Record<Table, Failure>,
        updateZero: new Set<Table>(),
        deleteErrors: { recipes: null, community_recipes: null } as Record<Table, Failure>,
        deleteZero: new Set<Table>(),
        storageRemoveError: null as Failure,
    };

    const getSession = vi.fn();
    const getUser = vi.fn();
    const upload = vi.fn();
    const getPublicUrl = vi.fn();
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
        if (tableName === 'chat_profiles') {
            return {
                select: vi.fn(() => chain(async () => ({ data: { display_name: 'Test Sailor' }, error: null }))),
            };
        }

        const table = tableName as Table;
        return {
            select: vi.fn(() =>
                chain(async (filters) => {
                    state.events.push(`${table}:read`);
                    return { data: filtered(state.rows[table], filters), error: null };
                }),
            ),
            insert: vi.fn((payload: Row) =>
                chain(async () => {
                    state.events.push(`${table}:insert`);
                    if (state.insertError) return { data: null, error: state.insertError };
                    state.rows[table] = { ...payload };
                    if (state.insertApplyThenThrow) throw new Error('response lost after commit');
                    return { data: state.insertReturnNull ? null : { ...payload }, error: null };
                }),
            ),
            update: vi.fn((payload: Record<string, unknown>) =>
                chain(async (filters) => {
                    state.events.push(`${table}:update`);
                    if (state.updateErrors[table]) return { data: null, error: state.updateErrors[table] };
                    const row = filtered(state.rows[table], filters);
                    if (!row || state.updateZero.has(table)) return { data: null, error: null };
                    const updated = { ...row, ...payload } as Row;
                    state.rows[table] = updated;
                    return { data: { ...updated }, error: null };
                }),
            ),
            delete: vi.fn(() =>
                chain(async (filters) => {
                    state.events.push(`${table}:delete`);
                    if (state.deleteErrors[table]) return { data: null, error: state.deleteErrors[table] };
                    const row = filtered(state.rows[table], filters);
                    if (!row || state.deleteZero.has(table)) return { data: null, error: null };
                    state.rows[table] = null;
                    return { data: { id: row.id, user_id: row.user_id }, error: null };
                }),
            ),
            upsert: vi.fn(async () => ({ error: null })),
        };
    });

    return {
        from,
        getPublicUrl,
        getSession,
        getUser,
        remove,
        state,
        storageFrom: vi.fn(() => ({ getPublicUrl, remove, upload })),
        upload,
    };
});

vi.mock('../services/vessel/LocalDatabase', () => ({
    deleteLocal: databaseMocks.deleteLocal,
    generateUUID: vi.fn(() => RECIPE_ID),
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

vi.mock('../services/ProfilePhotoService', () => ({
    compressImage: vi.fn(async (value: Blob) => value),
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
    deleteCustomRecipe,
    PrivateRecipePhotoUnavailableError,
    saveCustomRecipe,
} from '../services/GalleyRecipeService';

const localRecipe = (imagePath = LEGACY_PATH): StoredRecipe => ({
    id: RECIPE_ID,
    spoonacular_id: null,
    user_id: OWNER_ID,
    title: 'Safe Harbour Stew',
    image_url: photoUrl(imagePath),
    ready_in_minutes: 30,
    servings: 2,
    source_url: '',
    instructions: 'Simmer',
    ingredients: [],
    is_favorite: false,
    is_custom: true,
    visibility: 'shared',
    tags: [],
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
});

function cloudRow(table: 'recipes' | 'community_recipes', imagePath: string) {
    return {
        id: RECIPE_ID,
        user_id: OWNER_ID,
        title: 'Safe Harbour Stew',
        image_url: photoUrl(imagePath),
        visibility: table === 'recipes' ? 'shared' : 'community',
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    supabaseMocks.state.rows.recipes = cloudRow('recipes', OWNER_PATH);
    supabaseMocks.state.rows.community_recipes = cloudRow('community_recipes', LEGACY_PATH);
    supabaseMocks.state.events.splice(0);
    supabaseMocks.state.insertError = null;
    supabaseMocks.state.insertApplyThenThrow = false;
    supabaseMocks.state.insertReturnNull = false;
    supabaseMocks.state.updateErrors.recipes = null;
    supabaseMocks.state.updateErrors.community_recipes = null;
    supabaseMocks.state.updateZero.clear();
    supabaseMocks.state.deleteErrors.recipes = null;
    supabaseMocks.state.deleteErrors.community_recipes = null;
    supabaseMocks.state.deleteZero.clear();
    supabaseMocks.state.storageRemoveError = null;
    supabaseMocks.getSession.mockResolvedValue({
        data: { session: { access_token: 'owner-token', user: { id: OWNER_ID } } },
        error: null,
    });
    supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: OWNER_ID } }, error: null });
    supabaseMocks.upload.mockImplementation(async (path: string) => ({ data: { path }, error: null }));
    supabaseMocks.getPublicUrl.mockImplementation((path: string) => ({ data: { publicUrl: photoUrl(path) } }));
    mediaMocks.capture.mockResolvedValue({ ownerId: OWNER_ID, accessToken: 'owner-token' });
    mediaMocks.retain.mockReturnValue(true);
    mediaMocks.retire.mockImplementation(async () => {
        supabaseMocks.state.events.push('media:retire');
        return true;
    });
    databaseMocks.query.mockReturnValue([localRecipe()]);
    databaseMocks.insertLocal.mockResolvedValue(undefined);
    databaseMocks.deleteLocal.mockImplementation(async () => {
        supabaseMocks.state.events.push('local:delete');
        return true;
    });
    setAuthIdentityScope(OWNER_ID);
});

describe('recipe photo save ownership', () => {
    const input = () => ({
        title: 'Community supper',
        imageFile: new Blob(['photo'], { type: 'image/jpeg' }),
        readyInMinutes: 20,
        servings: 1,
        ingredients: [],
        instructions: [],
        visibility: 'community' as const,
    });

    it('rejects a private photo before auth, storage, database, or local writes', async () => {
        await expect(saveCustomRecipe({ ...input(), visibility: 'private' })).rejects.toBeInstanceOf(
            PrivateRecipePhotoUnavailableError,
        );

        expect(supabaseMocks.getUser).not.toHaveBeenCalled();
        expect(supabaseMocks.upload).not.toHaveBeenCalled();
        expect(databaseMocks.insertLocal).not.toHaveBeenCalled();
    });

    it('retires the exact fresh path when identity changes before any database mutation', async () => {
        let finishUpload!: (value: { data: { path: string }; error: null }) => void;
        supabaseMocks.upload.mockReturnValue(
            new Promise((resolve) => {
                finishUpload = resolve;
            }),
        );

        const pending = saveCustomRecipe(input());
        await vi.waitFor(() => expect(supabaseMocks.upload).toHaveBeenCalledOnce());
        setAuthIdentityScope(OTHER_USER_ID);
        finishUpload({ data: { path: OWNER_PATH }, error: null });

        await expect(pending).rejects.toBeInstanceOf(Error);
        expect(mediaMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: OWNER_ID }),
            expect.objectContaining({ ownerId: OWNER_ID }),
            'recipe-photos',
            OWNER_PATH,
        );
        expect(supabaseMocks.state.events).not.toContain('community_recipes:insert');
    });

    it('retires the exact fresh path after a definite database non-commit', async () => {
        supabaseMocks.state.rows.community_recipes = null;
        supabaseMocks.state.insertError = { message: 'insert rejected' };

        await expect(saveCustomRecipe(input())).resolves.toBeNull();

        expect(mediaMocks.retire).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'recipe-photos',
            OWNER_PATH,
        );
        expect(mediaMocks.retain).not.toHaveBeenCalled();
        expect(databaseMocks.insertLocal).not.toHaveBeenCalled();
    });

    it('retains reference-aware cleanup when the insert applied but its response was lost', async () => {
        supabaseMocks.state.rows.community_recipes = null;
        supabaseMocks.state.insertApplyThenThrow = true;

        await expect(saveCustomRecipe(input())).resolves.toBeNull();

        expect(mediaMocks.retain).toHaveBeenCalledWith(
            expect.objectContaining({ userId: OWNER_ID }),
            'recipe-photos',
            OWNER_PATH,
            { kind: 'recipe-photo', recipeId: RECIPE_ID },
        );
        expect(mediaMocks.retire).not.toHaveBeenCalled();
        expect(supabaseMocks.state.rows.community_recipes).toEqual(
            expect.objectContaining({ id: RECIPE_ID, user_id: OWNER_ID, image_url: photoUrl(OWNER_PATH) }),
        );
        expect(databaseMocks.insertLocal).not.toHaveBeenCalled();
    });

    it('does not call a missing returned owner row a successful save', async () => {
        supabaseMocks.state.rows.community_recipes = null;
        supabaseMocks.state.insertReturnNull = true;

        await expect(saveCustomRecipe(input())).resolves.toBeNull();

        expect(mediaMocks.retain).toHaveBeenCalledOnce();
        expect(mediaMocks.retire).not.toHaveBeenCalled();
        expect(databaseMocks.insertLocal).not.toHaveBeenCalled();
    });
});

describe('custom recipe deletion ordering', () => {
    it('makes both rows private, removes exact owner and legacy media, deletes exact rows, then local', async () => {
        await expect(deleteCustomRecipe(RECIPE_ID)).resolves.toEqual({
            status: 'deleted',
            scope: 'cloud-and-local',
            message: 'Recipe and its photo were deleted everywhere.',
        });

        expect(supabaseMocks.state.events).toEqual([
            'recipes:read',
            'community_recipes:read',
            'recipes:update',
            'community_recipes:update',
            'recipes:read',
            'community_recipes:read',
            'media:retire',
            `storage:remove:${LEGACY_PATH}`,
            'community_recipes:delete',
            'recipes:delete',
            'recipes:read',
            'community_recipes:read',
            'local:delete',
        ]);
        expect(databaseMocks.deleteLocal).toHaveBeenCalledWith('recipes', RECIPE_ID);
    });

    it('stops before media or deletion when RLS reports zero affected privacy rows', async () => {
        supabaseMocks.state.updateZero.add('community_recipes');

        await expect(deleteCustomRecipe(RECIPE_ID)).resolves.toEqual(expect.objectContaining({ status: 'pending' }));

        expect(mediaMocks.retire).not.toHaveBeenCalled();
        expect(supabaseMocks.remove).not.toHaveBeenCalled();
        expect(supabaseMocks.state.events).not.toContain('community_recipes:delete');
        expect(databaseMocks.deleteLocal).not.toHaveBeenCalled();
    });

    it('retains both ownership rows and the local retry handle when legacy media removal fails', async () => {
        supabaseMocks.state.storageRemoveError = { message: 'storage unavailable' };

        await expect(deleteCustomRecipe(RECIPE_ID)).resolves.toEqual(expect.objectContaining({ status: 'pending' }));

        expect(mediaMocks.retain).toHaveBeenCalledWith(
            expect.objectContaining({ userId: OWNER_ID }),
            'recipe-photos',
            LEGACY_PATH,
            { kind: 'recipe-photo', recipeId: RECIPE_ID },
        );
        expect(supabaseMocks.state.events).not.toContain('community_recipes:delete');
        expect(databaseMocks.deleteLocal).not.toHaveBeenCalled();
        expect(supabaseMocks.state.rows.community_recipes).toEqual(
            expect.objectContaining({ visibility: 'private', image_url: null }),
        );
    });

    it('keeps the local retry handle when an exact cloud delete affects zero rows', async () => {
        supabaseMocks.state.deleteZero.add('community_recipes');

        await expect(deleteCustomRecipe(RECIPE_ID)).resolves.toEqual(expect.objectContaining({ status: 'pending' }));

        expect(supabaseMocks.state.events).toContain('community_recipes:delete');
        expect(supabaseMocks.state.events).not.toContain('recipes:delete');
        expect(databaseMocks.deleteLocal).not.toHaveBeenCalled();
    });

    it("does not touch another sailor's rows, media, or local recipe", async () => {
        mediaMocks.capture.mockResolvedValue(null);
        supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: OTHER_USER_ID } }, error: null });

        await expect(deleteCustomRecipe(RECIPE_ID)).resolves.toEqual(expect.objectContaining({ status: 'not-owner' }));

        expect(mediaMocks.retire).not.toHaveBeenCalled();
        expect(supabaseMocks.remove).not.toHaveBeenCalled();
        expect(supabaseMocks.state.events).toEqual([]);
        expect(databaseMocks.deleteLocal).not.toHaveBeenCalled();
    });
});
