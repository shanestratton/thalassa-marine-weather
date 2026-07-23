import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    rpc: vi.fn(),
    from: vi.fn(),
    getCurrentUserId: vi.fn(),
    cacheGet: vi.fn(),
    cacheSet: vi.fn(),
    filterTombstones: vi.fn(),
    overlayArchive: vi.fn(),
    archiveIntents: vi.fn(),
}));

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

import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    __resetRpcLatchForTests,
    getCachedVoyageSummaries,
    getVoyageEntries,
    getVoyageSummaries,
    type VoyageSummary,
} from '../services/shiplog/VoyageSummary';

interface QueryResponse {
    data: Record<string, unknown>[] | null;
    error: { message: string } | null;
}

interface QueryCall {
    table: string;
    columns: string | null;
    filters: Array<[string, unknown]>;
    range: [number, number] | null;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function queryFor(table: string, response: Promise<QueryResponse>, calls: QueryCall[]) {
    const call: QueryCall = { table, columns: null, filters: [], range: null };
    calls.push(call);
    const query = {
        select(columns: string) {
            call.columns = columns;
            return query;
        },
        eq(column: string, value: unknown) {
            call.filters.push([column, value]);
            return query;
        },
        order() {
            return query;
        },
        range(from: number, to: number) {
            call.range = [from, to];
            return query;
        },
        or() {
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

function dbRow(owner: string, voyageId: string, index = 0): Record<string, unknown> {
    return {
        id: `${voyageId}-${index}`,
        user_id: owner,
        voyage_id: voyageId,
        timestamp: `2026-07-23T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        latitude: -27,
        longitude: 153,
        cumulative_distance_nm: index,
        speed_kts: 5,
        entry_type: 'auto',
        source: 'device',
        is_on_water: true,
        archived: false,
    };
}

function rpcRow(voyageId: string): Record<string, unknown> {
    return {
        voyage_id: voyageId,
        entry_count: 1,
        started_at: '2026-07-23T00:00:00.000Z',
        ended_at: '2026-07-23T01:00:00.000Z',
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

beforeEach(() => {
    vi.clearAllMocks();
    __resetRpcLatchForTests();
    setAuthIdentityScope('account-a');
    mocks.getCurrentUserId.mockResolvedValue('account-a');
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(undefined);
    mocks.filterTombstones.mockImplementation(async (rows: unknown[]) => rows);
    mocks.overlayArchive.mockImplementation(async (rows: unknown[]) => rows);
    mocks.archiveIntents.mockResolvedValue([]);
    mocks.from.mockImplementation((table: string) => queryFor(table, Promise.resolve({ data: [], error: null }), []));
});

describe('VoyageSummary exact identity isolation', () => {
    it('drops a late A RPC result instead of returning or caching it in B', async () => {
        const rpc = deferred<{ data: Record<string, unknown>[]; error: null }>();
        mocks.rpc.mockReturnValueOnce(rpc.promise);
        const request = getVoyageSummaries();
        await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        rpc.resolve({ data: [rpcRow('voyage-a')], error: null });

        await expect(request).resolves.toEqual([]);
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('does not let a late A missing-RPC error poison B’s availability latch', async () => {
        const rpcA = deferred<{
            data: null;
            error: { code: string; message: string };
        }>();
        mocks.rpc.mockReturnValueOnce(rpcA.promise);
        const requestA = getVoyageSummaries();
        await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        mocks.getCurrentUserId.mockResolvedValue('account-b');
        rpcA.resolve({
            data: null,
            error: { code: 'PGRST202', message: 'function get_voyage_summaries does not exist' },
        });
        await expect(requestA).resolves.toEqual([]);

        mocks.rpc.mockResolvedValueOnce({ data: [rpcRow('voyage-b')], error: null });
        await expect(getVoyageSummaries()).resolves.toEqual([expect.objectContaining({ voyageId: 'voyage-b' })]);
        expect(mocks.rpc).toHaveBeenCalledTimes(2);
    });

    it('pins every fallback page to A and abandons accumulated rows after A→B', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: null,
            error: { code: 'OTHER', message: 'temporary RPC failure' },
        });
        const pageTwo = deferred<QueryResponse>();
        const responses = [
            Promise.resolve({
                data: Array.from({ length: 1000 }, (_, index) => dbRow('account-a', 'voyage-a', index)),
                error: null,
            }),
            pageTwo.promise,
        ];
        const calls: QueryCall[] = [];
        mocks.from.mockImplementation((table: string) => queryFor(table, responses.shift()!, calls));

        const request = getVoyageSummaries();
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        setAuthIdentityScope('account-b');
        pageTwo.resolve({ data: [dbRow('account-a', 'voyage-a', 1000)], error: null });

        await expect(request).resolves.toEqual([]);
        expect(calls).toHaveLength(2);
        expect(
            calls.every((call) =>
                call.filters.some(([column, value]) => column === 'user_id' && value === 'account-a'),
            ),
        ).toBe(true);
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('fails closed when a fallback row does not belong to the captured owner', async () => {
        mocks.rpc.mockResolvedValueOnce({
            data: null,
            error: { code: 'OTHER', message: 'temporary RPC failure' },
        });
        const calls: QueryCall[] = [];
        mocks.from.mockImplementation((table: string) =>
            queryFor(table, Promise.resolve({ data: [dbRow('account-b', 'voyage-b')], error: null }), calls),
        );

        await expect(getVoyageSummaries()).resolves.toEqual([]);
        expect(calls[0].columns).toContain('user_id');
        expect(mocks.cacheSet).toHaveBeenCalledWith([], getAuthIdentityScope());
    });

    it('rejects a session owner that disagrees with the captured scope before RPC', async () => {
        mocks.getCurrentUserId.mockResolvedValueOnce('account-b');

        await expect(getVoyageSummaries()).resolves.toEqual([]);

        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('drops a late cached A read when B becomes current', async () => {
        const read = deferred<VoyageSummary[]>();
        mocks.cacheGet.mockReturnValueOnce(read.promise);
        const request = getCachedVoyageSummaries();
        await vi.waitFor(() => expect(mocks.cacheGet).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        read.resolve([
            {
                voyageId: 'voyage-a',
                entryCount: 1,
                startedAt: '2026-07-23T00:00:00.000Z',
                endedAt: '2026-07-23T01:00:00.000Z',
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
            },
        ]);

        await expect(request).resolves.toEqual([]);
    });

    it('pins a voyage-entry request to owner and voyage and drops its late page', async () => {
        const page = deferred<QueryResponse>();
        const calls: QueryCall[] = [];
        mocks.from.mockImplementation((table: string) => queryFor(table, page.promise, calls));
        const request = getVoyageEntries(' voyage-a ');
        await vi.waitFor(() => expect(calls).toHaveLength(1));

        setAuthIdentityScope('account-b');
        page.resolve({ data: [dbRow('account-a', 'voyage-a')], error: null });

        await expect(request).resolves.toEqual([]);
        expect(calls[0].filters).toEqual(
            expect.arrayContaining([
                ['user_id', 'account-a'],
                ['voyage_id', 'voyage-a'],
            ]),
        );
    });

    it('fails closed on a voyage-entry row outside the requested owner/voyage', async () => {
        const calls: QueryCall[] = [];
        mocks.from.mockImplementation((table: string) =>
            queryFor(table, Promise.resolve({ data: [dbRow('account-b', 'voyage-b')], error: null }), calls),
        );

        await expect(getVoyageEntries('voyage-a')).resolves.toEqual([]);
        expect(calls[0].filters).toEqual(
            expect.arrayContaining([
                ['user_id', 'account-a'],
                ['voyage_id', 'voyage-a'],
            ]),
        );
    });
});
