import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    authUserId: 'account-a',
    getUser: vi.fn(),
    from: vi.fn(),
    respond: vi.fn(),
    queries: [] as Array<{
        table: string;
        action: string;
        payload?: unknown;
        options?: unknown;
        filters: Array<{ column: string; value: unknown }>;
        selection?: string;
    }>,
}));

vi.mock('../services/supabase', () => {
    mocks.getUser.mockImplementation(async () => ({
        data: {
            user: mocks.authUserId
                ? {
                      id: mocks.authUserId,
                      user_metadata: { first_name: 'Ada', last_name: 'Sailor' },
                  }
                : null,
        },
        error: null,
    }));

    mocks.from.mockImplementation((table: string) => {
        const query = {
            table,
            action: 'read',
            filters: [] as Array<{ column: string; value: unknown }>,
        } as (typeof mocks.queries)[number];
        mocks.queries.push(query);

        const execute = () => Promise.resolve(mocks.respond(query));
        const builder: Record<string, unknown> = {};
        builder.select = vi.fn((selection?: string) => {
            query.selection = selection;
            return builder;
        });
        builder.insert = vi.fn((payload: unknown) => {
            query.action = 'insert';
            query.payload = payload;
            return builder;
        });
        builder.update = vi.fn((payload: unknown) => {
            query.action = 'update';
            query.payload = payload;
            return builder;
        });
        builder.upsert = vi.fn((payload: unknown, options?: unknown) => {
            query.action = 'upsert';
            query.payload = payload;
            query.options = options;
            return builder;
        });
        builder.delete = vi.fn(() => {
            query.action = 'delete';
            return builder;
        });
        builder.eq = vi.fn((column: string, value: unknown) => {
            query.filters.push({ column, value });
            return builder;
        });
        builder.in = vi.fn((column: string, value: unknown) => {
            query.filters.push({ column, value });
            return builder;
        });
        builder.single = vi.fn(execute);
        builder.maybeSingle = vi.fn(execute);
        builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            execute().then(resolve, reject);
        return builder;
    });

    return {
        supabase: {
            auth: { getUser: mocks.getUser },
            from: mocks.from,
        },
        supabaseUrl: 'https://example.supabase.co',
    };
});

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { VoyageLogService, type VoyageLogConfig } from '../services/VoyageLogService';

function config(ownerId = 'account-a', boatId = 'boat-a', enabled = true): VoyageLogConfig {
    return {
        id: `config-${ownerId}`,
        owner_id: ownerId,
        boat_id: boatId,
        handle: `${ownerId}-boat`,
        api_key: `key-${ownerId}`,
        enabled,
        scope: 'combined',
        track_days: 30,
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
    };
}

function hasFilter(query: (typeof mocks.queries)[number], column: string, value: unknown): boolean {
    return query.filters.some((filter) => filter.column === column && filter.value === value);
}

describe('VoyageLogService identity fencing', () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.authUserId = 'account-a';
        mocks.queries.length = 0;
        mocks.getUser.mockClear();
        mocks.from.mockClear();
        mocks.respond.mockReset().mockImplementation((query: (typeof mocks.queries)[number]) => {
            if (query.table === 'boats' && query.action === 'read') {
                return { data: { id: 'boat-a', owner_id: 'account-a' }, error: null };
            }
            if (query.table === 'voyage_log_configs' && query.action === 'read') {
                return { data: config(), error: null };
            }
            return { data: null, error: null };
        });
        VoyageLogService.lastError = null;
    });

    it('authenticates once and explicitly scopes combined-config reads', async () => {
        await expect(VoyageLogService.getConfig()).resolves.toMatchObject({
            owner_id: 'account-a',
            boat_id: 'boat-a',
            scope: 'combined',
        });

        expect(mocks.getUser).toHaveBeenCalledTimes(1);
        const boatQuery = mocks.queries.find((query) => query.table === 'boats');
        const configQuery = mocks.queries.find((query) => query.table === 'voyage_log_configs');
        expect(boatQuery && hasFilter(boatQuery, 'owner_id', 'account-a')).toBe(true);
        expect(configQuery && hasFilter(configQuery, 'owner_id', 'account-a')).toBe(true);
        expect(configQuery && hasFilter(configQuery, 'boat_id', 'boat-a')).toBe(true);
        expect(configQuery && hasFilter(configQuery, 'scope', 'combined')).toBe(true);
    });

    it('drops a deferred account-A auth result before issuing any account-B query', async () => {
        let resolveAuth!: (value: {
            data: { user: { id: string; user_metadata: Record<string, never> } };
            error: null;
        }) => void;
        mocks.getUser.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveAuth = resolve;
                }),
        );

        const pending = VoyageLogService.getConfig();
        setAuthIdentityScope('account-b');
        mocks.authUserId = 'account-b';
        resolveAuth({
            data: { user: { id: 'account-a', user_metadata: {} } },
            error: null,
        });

        await expect(pending).resolves.toBeNull();
        expect(mocks.queries).toHaveLength(0);
        expect(VoyageLogService.lastError).toBeNull();
    });

    it('scopes hidden-voyage and passage-link reads to the captured user', async () => {
        mocks.respond.mockImplementation((query: (typeof mocks.queries)[number]) => {
            if (query.table === 'voyage_log_hidden_voyages') {
                return {
                    data: [
                        { user_id: 'account-a', voyage_id: 'voyage-a' },
                        { user_id: 'account-b', voyage_id: 'voyage-b' },
                    ],
                    error: null,
                };
            }
            if (query.table === 'voyage_plan_links') {
                return {
                    data: [
                        { user_id: 'account-a', voyage_id: 'voyage-a', plan_voyage_id: 'plan-a' },
                        { user_id: 'account-b', voyage_id: 'voyage-b', plan_voyage_id: 'plan-b' },
                    ],
                    error: null,
                };
            }
            return { data: null, error: null };
        });

        await expect(VoyageLogService.getHiddenVoyageIds()).resolves.toEqual(new Set(['voyage-a']));
        await expect(VoyageLogService.getPlanLinks()).resolves.toEqual(new Map([['voyage-a', 'plan-a']]));

        for (const query of mocks.queries) {
            expect(hasFilter(query, 'user_id', 'account-a')).toBe(true);
        }
    });

    it('binds a delayed mutation to account A and never leaks its failure through B lastError', async () => {
        let resolveMutation!: (value: { data: null; error: { message: string } }) => void;
        mocks.respond.mockImplementation((query: (typeof mocks.queries)[number]) => {
            if (query.table === 'voyage_log_hidden_voyages') {
                return new Promise((resolve) => {
                    resolveMutation = resolve;
                });
            }
            return { data: null, error: null };
        });

        const pending = VoyageLogService.setVoyageHidden(' voyage-a ', true);
        await vi.waitFor(() =>
            expect(
                mocks.queries.some((query) => query.table === 'voyage_log_hidden_voyages' && query.action === 'upsert'),
            ).toBe(true),
        );
        const mutation = mocks.queries.find((query) => query.table === 'voyage_log_hidden_voyages')!;
        expect(mutation.payload).toEqual({ user_id: 'account-a', voyage_id: 'voyage-a' });

        setAuthIdentityScope('account-b');
        mocks.authUserId = 'account-b';
        resolveMutation({ data: null, error: { message: 'late account A failure' } });

        await expect(pending).resolves.toBe(false);
        expect(VoyageLogService.lastError).toBeNull();
        setAuthIdentityScope('account-a');
        expect(VoyageLogService.lastError).toBeNull();
    });

    it('uses one captured user through ensureEnabled and scopes every read/update', async () => {
        mocks.respond.mockImplementation((query: (typeof mocks.queries)[number]) => {
            if (query.table === 'boats' && query.action === 'read') {
                return { data: { id: 'boat-a', owner_id: 'account-a' }, error: null };
            }
            if (query.table === 'boat_members' && query.action === 'insert') {
                return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
            }
            if (query.table === 'voyage_log_configs' && query.action === 'read') {
                return { data: config('account-a', 'boat-a', false), error: null };
            }
            if (query.table === 'voyage_log_configs' && query.action === 'update') {
                return { data: config('account-a', 'boat-a', true), error: null };
            }
            return { data: null, error: null };
        });

        await expect(VoyageLogService.ensureEnabled()).resolves.toMatchObject({ enabled: true });
        expect(mocks.getUser).toHaveBeenCalledTimes(1);

        const memberInsert = mocks.queries.find((query) => query.table === 'boat_members')!;
        expect(memberInsert.payload).toMatchObject({ user_id: 'account-a', boat_id: 'boat-a' });
        const update = mocks.queries.find(
            (query) => query.table === 'voyage_log_configs' && query.action === 'update',
        )!;
        expect(hasFilter(update, 'owner_id', 'account-a')).toBe(true);
        expect(hasFilter(update, 'boat_id', 'boat-a')).toBe(true);
        expect(hasFilter(update, 'scope', 'combined')).toBe(true);
    });

    it('scopes unlink deletes by immutable user and voyage ids', async () => {
        await expect(VoyageLogService.setVoyagePlanLink(' voyage-a ', null)).resolves.toBe(true);

        const mutation = mocks.queries.find((query) => query.table === 'voyage_plan_links')!;
        expect(mutation.action).toBe('delete');
        expect(hasFilter(mutation, 'user_id', 'account-a')).toBe(true);
        expect(hasFilter(mutation, 'voyage_id', 'voyage-a')).toBe(true);
    });
});
