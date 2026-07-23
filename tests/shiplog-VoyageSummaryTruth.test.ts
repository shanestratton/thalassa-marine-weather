import { beforeEach, describe, expect, it, vi } from 'vitest';

interface QueryResponse {
    data: Record<string, unknown>[] | null;
    error: { message: string } | null;
}

interface QueryCall {
    table: string;
    columns: string | null;
    filters: Array<[string, unknown]>;
    ors: string[];
}

const mocks = vi.hoisted(() => ({
    rpc: vi.fn(),
    from: vi.fn(),
    getCurrentUserId: vi.fn(),
    cacheGet: vi.fn(),
    cacheSet: vi.fn(),
    filterTombstones: vi.fn(),
    overlayArchive: vi.fn(),
    archiveIntents: vi.fn(),
    responses: [] as Array<Promise<QueryResponse>>,
    calls: [] as QueryCall[],
}));

function queryFor(table: string, response: Promise<QueryResponse>) {
    const call: QueryCall = { table, columns: null, filters: [], ors: [] };
    mocks.calls.push(call);
    const query = {
        select(columns: string) {
            call.columns = columns;
            return query;
        },
        eq(column: string, value: unknown) {
            call.filters.push([column, value]);
            return query;
        },
        or(expression: string) {
            call.ors.push(expression);
            return query;
        },
        order() {
            return query;
        },
        range() {
            return query;
        },
        then<TResult1 = QueryResponse, TResult2 = never>(
            onFulfilled?: ((value: QueryResponse) => TResult1 | PromiseLike<TResult1>) | null,
            onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
            return response.then(onFulfilled, onRejected);
        },
    };
    return query;
}

vi.mock('../services/supabase', () => ({
    supabase: {
        rpc: (...args: unknown[]) => mocks.rpc(...args),
        from: (...args: unknown[]) => mocks.from(...args),
    },
    getCurrentUserId: (...args: unknown[]) => mocks.getCurrentUserId(...args),
}));

vi.mock('../services/shiplog/VoyageSummaryCache', () => ({
    getCachedSummaries: (...args: unknown[]) => mocks.cacheGet(...args),
    setCachedSummaries: (...args: unknown[]) => mocks.cacheSet(...args),
}));

vi.mock('../services/shiplog/OfflineQueue', () => ({
    filterVoyageTombstonedEntries: (...args: unknown[]) => mocks.filterTombstones(...args),
    applyVoyageArchiveIntentOverlay: (...args: unknown[]) => mocks.overlayArchive(...args),
    getVoyageArchiveIntentSnapshot: (...args: unknown[]) => mocks.archiveIntents(...args),
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    __resetRpcLatchForTests,
    getCachedVoyageSummaries,
    getVoyageEntries,
    getVoyageSummaries,
    type VoyageSummary,
} from '../services/shiplog/VoyageSummary';

function rpcRow(voyageId: string): Record<string, unknown> {
    return {
        voyage_id: voyageId,
        entry_count: 2,
        started_at: '2026-07-24T00:00:00.000Z',
        ended_at: '2026-07-24T01:00:00.000Z',
        total_distance_nm: 5,
        avg_speed_kts: 5,
        has_manual: false,
        is_planned_route: false,
        is_imported: false,
        first_lat: -27,
        first_lon: 153,
        last_lat: -27.1,
        last_lon: 153.1,
        first_is_on_water: true,
        land_fraction: 0,
    };
}

function dbRow(
    voyageId: string | null,
    timestamp: string,
    options: { id?: string; archived?: boolean; distance?: number } = {},
): Record<string, unknown> {
    return {
        id: options.id ?? `${voyageId ?? 'null'}-${timestamp}`,
        user_id: 'account-a',
        voyage_id: voyageId,
        timestamp,
        latitude: -27,
        longitude: 153,
        cumulative_distance_nm: options.distance ?? 1,
        speed_kts: 5,
        entry_type: 'auto',
        source: 'device',
        is_on_water: true,
        archived: options.archived ?? false,
    };
}

function cachedSummary(voyageId: string): VoyageSummary {
    return {
        voyageId,
        entryCount: 2,
        startedAt: '2026-07-24T00:00:00.000Z',
        endedAt: '2026-07-24T01:00:00.000Z',
        totalDistanceNM: 5,
        avgSpeedKts: 5,
        hasManual: false,
        isPlannedRoute: false,
        isImported: false,
        firstLat: -27,
        firstLon: 153,
        lastLat: -27.1,
        lastLon: 153.1,
        firstIsOnWater: true,
        landFraction: 0,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.responses.length = 0;
    mocks.calls.length = 0;
    __resetRpcLatchForTests();
    setAuthIdentityScope('account-a');
    mocks.getCurrentUserId.mockResolvedValue('account-a');
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(undefined);
    mocks.filterTombstones.mockImplementation(async (rows: unknown[]) => rows);
    mocks.overlayArchive.mockImplementation(async (rows: unknown[]) => rows);
    mocks.archiveIntents.mockResolvedValue([]);
    mocks.from.mockImplementation((table: string) =>
        queryFor(table, mocks.responses.shift() ?? Promise.resolve({ data: [], error: null })),
    );
});

describe('VoyageSummary durable read truth', () => {
    it('filters RPC and cached summaries through the owner-scoped deletion ledger', async () => {
        mocks.rpc.mockResolvedValue({
            data: [rpcRow('deleted-voyage'), rpcRow('kept-voyage')],
            error: null,
        });
        mocks.filterTombstones.mockImplementation(async (rows: Array<{ voyageId?: string }>, scope: unknown) => {
            expect(scope).toEqual(expect.objectContaining({ userId: 'account-a' }));
            return rows.filter((row) => row.voyageId !== 'deleted-voyage');
        });

        await expect(getVoyageSummaries()).resolves.toEqual([expect.objectContaining({ voyageId: 'kept-voyage' })]);

        mocks.cacheGet.mockResolvedValue([cachedSummary('deleted-voyage'), cachedSummary('kept-voyage')]);
        await expect(getCachedVoyageSummaries()).resolves.toEqual([
            expect.objectContaining({ voyageId: 'kept-voyage' }),
        ]);
        expect(mocks.cacheSet).toHaveBeenCalledWith(
            [expect.objectContaining({ voyageId: 'kept-voyage' })],
            expect.objectContaining({ userId: 'account-a' }),
        );
    });

    it('never lets a pending archive repaint from RPC or cache', async () => {
        mocks.rpc.mockResolvedValue({ data: [rpcRow('archive-me')], error: null });
        mocks.overlayArchive.mockImplementation(async (rows: Array<{ voyageId?: string; archived?: boolean }>) =>
            rows.map((row) => (row.voyageId === 'archive-me' ? { ...row, archived: true } : row)),
        );

        await expect(getVoyageSummaries()).resolves.toEqual([]);
        mocks.cacheGet.mockResolvedValue([cachedSummary('archive-me')]);
        await expect(getCachedVoyageSummaries()).resolves.toEqual([]);
    });

    it('queries archived rows and overlays the desired state for a pending unarchive', async () => {
        mocks.archiveIntents.mockResolvedValue([{ voyageId: 'restore-me', archived: false, requestedAt: Date.now() }]);
        mocks.responses.push(
            Promise.resolve({ data: [], error: null }),
            Promise.resolve({
                data: [
                    dbRow('restore-me', '2026-07-24T00:00:00.000Z', {
                        archived: true,
                        distance: 7,
                    }),
                ],
                error: null,
            }),
        );
        mocks.overlayArchive.mockImplementation(async (rows: Array<{ voyageId?: string; archived?: boolean }>) =>
            rows.map((row) => (row.voyageId === 'restore-me' ? { ...row, archived: false } : row)),
        );

        await expect(getVoyageSummaries()).resolves.toEqual([
            expect.objectContaining({ voyageId: 'restore-me', entryCount: 1, totalDistanceNM: 7 }),
        ]);
        expect(mocks.calls).toHaveLength(2);
        expect(mocks.calls[1].filters).toContainEqual(['voyage_id', 'restore-me']);
        expect(mocks.calls[1].ors).not.toContain('archived.is.null,archived.eq.false');
    });

    it('rebuilds the default bucket from NULL, empty, and literal sentinel rows after the delete boundary', async () => {
        const boundary = Date.parse('2026-07-24T00:30:00.000Z');
        mocks.rpc.mockResolvedValue({ data: [rpcRow('default_voyage')], error: null });
        mocks.responses.push(
            Promise.resolve({
                data: [
                    dbRow(null, '2026-07-24T00:00:00.000Z', { id: 'old', distance: 99 }),
                    dbRow('', '2026-07-24T01:00:00.000Z', { id: 'new-empty', distance: 2 }),
                    dbRow('default_voyage', '2026-07-24T02:00:00.000Z', {
                        id: 'new-literal',
                        distance: 4,
                    }),
                ],
                error: null,
            }),
        );
        mocks.filterTombstones.mockImplementation(async (rows: Array<{ voyageId?: string; timestamp?: string }>) =>
            rows.filter(
                (row) =>
                    row.voyageId !== 'default_voyage' ||
                    (typeof row.timestamp === 'string' && Date.parse(row.timestamp) > boundary),
            ),
        );

        await expect(getVoyageSummaries()).resolves.toEqual([
            expect.objectContaining({
                voyageId: 'default_voyage',
                entryCount: 2,
                startedAt: '2026-07-24T01:00:00.000Z',
                totalDistanceNM: 4,
            }),
        ]);
        expect(mocks.calls[0].ors).toContain('voyage_id.is.null,voyage_id.eq.,voyage_id.eq.default_voyage');
    });

    it('uses the same default bucket and durable boundary for detail reads', async () => {
        const boundary = Date.parse('2026-07-24T00:30:00.000Z');
        mocks.responses.push(
            Promise.resolve({
                data: [
                    dbRow(null, '2026-07-24T00:00:00.000Z', { id: 'old' }),
                    dbRow('', '2026-07-24T01:00:00.000Z', { id: 'empty' }),
                    dbRow('default_voyage', '2026-07-24T02:00:00.000Z', { id: 'literal' }),
                ],
                error: null,
            }),
        );
        mocks.filterTombstones.mockImplementation(async (rows: Array<{ timestamp?: string }>) =>
            rows.filter((row) => typeof row.timestamp === 'string' && Date.parse(row.timestamp) > boundary),
        );

        const entries = await getVoyageEntries('default_voyage');
        expect(entries.map((entry) => entry.id)).toEqual(['empty', 'literal']);
        expect(entries.every((entry) => entry.voyageId === 'default_voyage')).toBe(true);
        expect(mocks.calls[0].ors).toContain('voyage_id.is.null,voyage_id.eq.,voyage_id.eq.default_voyage');
    });

    it('re-applies deletion truth after a late RPC companion query resolves', async () => {
        let deleted = false;
        const lateDefaultRows = deferred<QueryResponse>();
        mocks.rpc.mockResolvedValue({ data: [rpcRow('late-voyage')], error: null });
        mocks.responses.push(lateDefaultRows.promise);
        mocks.filterTombstones.mockImplementation(async (rows: Array<{ voyageId?: string }>) =>
            deleted ? rows.filter((row) => row.voyageId !== 'late-voyage') : rows,
        );

        const request = getVoyageSummaries();
        await vi.waitFor(() => expect(mocks.calls).toHaveLength(1));
        deleted = true;
        lateDefaultRows.resolve({ data: [], error: null });

        await expect(request).resolves.toEqual([]);
        expect(mocks.cacheSet).toHaveBeenCalledWith([], expect.objectContaining({ userId: 'account-a' }));
    });
});
