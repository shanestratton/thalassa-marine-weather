import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShipLogEntry } from '../types';

type Row = Record<string, unknown>;
type Response = { data: Row[] | null; error: { message: string; code?: string } | null; count: number | null };
const world = vi.hoisted(() => ({
    all: [] as Row[],
    active: [] as Row[],
    rows: [] as Row[],
    local: [] as ShipLogEntry[],
    intents: [] as Array<{ voyageId: string; archived: boolean; requestedAt: number }>,
    deleted: new Set<string>(),
    deletedOperations: new Set<string>(),
    rpcCalls: [] as Array<{ archived: boolean; from: number; to: number }>,
    rowCalls: [] as Array<{ filters: Record<string, unknown>; columns: string; from: number; to: number }>,
    rpcError: null as Response['error'],
    rpcFailureAt: null as number | null,
    rowFailureAt: null as number | null,
    serverCap: 500,
    sessionUser: 'account-a',
    ledgerError: false,
    delay: null as Promise<void> | null,
    archiveIntents: vi.fn(),
}));

function rpcQuery(includeArchived: boolean) {
    const query = {
        order: () => query,
        async range(from: number, to: number): Promise<Response> {
            const callIndex = world.rpcCalls.length;
            world.rpcCalls.push({ archived: includeArchived, from, to });
            const rows = includeArchived ? world.all : world.active;
            if (world.delay) await world.delay;
            if (world.rpcError || callIndex === world.rpcFailureAt) {
                return { data: null, error: world.rpcError ?? { message: 'network failed' }, count: null };
            }
            return {
                data: rows.slice(from, Math.min(to + 1, from + world.serverCap)),
                error: null,
                count: rows.length,
            };
        },
    };
    return query;
}

function rowQuery() {
    const filters: Record<string, unknown> = {};
    let columns = '';
    let defaultBucket = false;
    const query = {
        select(value: string) {
            columns = value;
            return query;
        },
        eq(key: string, value: unknown) {
            filters[key] = value;
            return query;
        },
        or() {
            defaultBucket = true;
            return query;
        },
        order: () => query,
        async range(from: number, to: number): Promise<Response> {
            const index = world.rowCalls.length;
            world.rowCalls.push({ filters, columns, from, to });
            if (index === world.rowFailureAt) return { data: null, error: { message: 'network failed' }, count: null };
            const rows = world.rows
                .filter(
                    (row) =>
                        Object.entries(filters).every(([key, value]) => row[key] === value) &&
                        (!defaultBucket || [null, '', 'default_voyage'].includes(row.voyage_id as string | null)),
                )
                .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
            return {
                data: rows.slice(from, Math.min(to + 1, from + world.serverCap)),
                error: null,
                count: rows.length,
            };
        },
    };
    return query;
}

vi.mock('../services/supabase', () => ({
    supabase: {
        rpc: (_name: string, args: { p_include_archived: boolean }) => rpcQuery(args.p_include_archived),
        from: () => rowQuery(),
    },
    getCurrentUserId: async () => world.sessionUser,
}));
vi.mock('../services/shiplog/OfflineQueue', () => ({
    getVoyageArchiveIntentSnapshot: (...args: unknown[]) => world.archiveIntents(...args),
    getOfflineEntries: async () => world.local,
    filterEntryTombstonedRows: async (rows: Row[]) =>
        rows.filter((row) => !world.deletedOperations.has(String(row.client_operation_id))),
    filterVoyageTombstonedEntries: async (rows: Array<{ voyageId: string }>) =>
        rows.filter((row) => !world.deleted.has(row.voyageId)),
    applyVoyageArchiveIntentOverlay: async (rows: Array<{ voyageId: string; timestamp: string; archived?: boolean }>) =>
        rows.map((row) => {
            const intent = world.intents.find((item) => item.voyageId === row.voyageId);
            return intent && (row.voyageId !== 'default_voyage' || Date.parse(row.timestamp) <= intent.requestedAt)
                ? { ...row, archived: intent.archived }
                : row;
        }),
}));

import { getArchivedVoyageSummaries, getLifetimeVoyageSummaries } from '../services/shiplog/ArchivedVoyageSummary';
import { setAuthIdentityScope } from '../services/authIdentityScope';

function rollup(voyageId: string, count = 100, extra: Row = {}): Row {
    return {
        voyage_id: voyageId,
        entry_count: count,
        started_at: '2026-09-18T00:00:00Z',
        ended_at: '2026-09-19T00:00:00Z',
        departed_at: '2026-09-18T01:00:00Z',
        total_distance_nm: 120,
        avg_speed_kts: 6.2,
        first_lat: -27.2,
        first_lon: 153.1,
        last_lat: -23.8,
        last_lon: 151.2,
        passage_group_id: 'passage-one',
        ...extra,
    };
}

function row(id: string, voyageId: string | null, n: number, archived = true): Row {
    return {
        id,
        user_id: 'account-a',
        voyage_id: voyageId,
        timestamp: new Date(Date.parse('2026-09-18T00:00:00Z') + n * 60_000).toISOString(),
        archived,
        latitude: -27 + n * 0.0001,
        longitude: 153,
        cumulative_distance_nm: n * 0.1,
        speed_kts: 5,
        entry_type: 'auto',
        source: 'device',
    };
}

beforeEach(() => {
    setAuthIdentityScope('account-a');
    world.all = [];
    world.active = [];
    world.rows = [];
    world.local = [];
    world.intents = [];
    world.deleted.clear();
    world.deletedOperations.clear();
    world.rpcCalls.length = 0;
    world.rowCalls.length = 0;
    world.rpcError = null;
    world.rpcFailureAt = null;
    world.rowFailureAt = null;
    world.serverCap = 500;
    world.sessionUser = 'account-a';
    world.ledgerError = false;
    world.delay = null;
    world.archiveIntents.mockReset().mockImplementation(async () => {
        if (world.ledgerError) throw new Error('durable ledger unreadable');
        return [...world.intents];
    });
});

describe('complete all-history lifetime summaries', () => {
    it('keeps the full mixed-state voyage, including the complete elapsed span and average', async () => {
        world.all = [rollup('mixed', 30000)];
        world.active = [rollup('mixed', 10000, { avg_speed_kts: 2, started_at: '2026-09-18T20:00:00Z' })];
        world.rows = [row('old-archived', 'mixed', 1, true), row('new-active', 'mixed', 2, false)];
        const complete = await getLifetimeVoyageSummaries();
        expect(complete).toEqual([
            expect.objectContaining({
                voyageId: 'mixed',
                entryCount: 30000,
                startedAt: '2026-09-18T00:00:00Z',
                departedAt: '2026-09-18T01:00:00Z',
                avgSpeedKts: 6.2,
                totalDistanceNM: 120,
            }),
        ]);
        expect(world.rpcCalls.every((call) => call.archived)).toBe(true);
        // No history read for the 30,000-point voyage; only the legacy null bucket.
        expect(world.rowCalls).toHaveLength(1);
        expect(world.rowCalls[0].filters.voyage_id).toBeUndefined();
        world.active = [];
        world.intents = [{ voyageId: 'mixed', archived: true, requestedAt: Date.now() }];
        expect(await getLifetimeVoyageSummaries()).toEqual(complete);
        world.active = [...world.all];
        world.intents = [{ voyageId: 'mixed', archived: false, requestedAt: Date.now() }];
        expect(await getLifetimeVoyageSummaries()).toEqual(complete);
    });

    it('loads more than 1,000 whole-history summaries even with a lower server cap', async () => {
        world.all = Array.from({ length: 1003 }, (_, index) => rollup(`voyage-${index}`));
        world.serverCap = 100;
        expect(await getLifetimeVoyageSummaries()).toHaveLength(1003);
        expect(world.rpcCalls.at(-1)?.from).toBe(1000);
    });

    it('treats valid empty history as empty, not as a failed fetch', async () => {
        await expect(getLifetimeVoyageSummaries()).resolves.toEqual([]);
    });

    it('rejects a failed later page without returning partial totals', async () => {
        world.all = Array.from({ length: 501 }, (_, index) => rollup(`voyage-${index}`));
        world.rpcFailureAt = 1;
        await expect(getLifetimeVoyageSummaries()).rejects.toThrow();
        expect(world.rowCalls).toHaveLength(0);
    });

    it('rejects unavailable RPC rather than substituting a capped point download', async () => {
        world.rpcError = { code: 'PGRST202', message: 'function get_voyage_summaries does not exist' };
        await expect(getLifetimeVoyageSummaries()).rejects.toThrow();
        expect(world.rowCalls).toHaveLength(0);
    });

    it('rejects corrupt aggregate times and failed legacy-bucket reconciliation', async () => {
        world.all = [rollup('invalid', 10, { ended_at: 'not-a-date' })];
        await expect(getLifetimeVoyageSummaries()).rejects.toThrow('Invalid lifetime');
        world.all = [rollup('valid')];
        world.rowFailureAt = 0;
        await expect(getLifetimeVoyageSummaries()).rejects.toThrow();
    });

    it('respects durable voyage deletes while preserving conservative queued tails', async () => {
        world.all = [rollup('deleted', 5000), rollup('live', 100)];
        world.deleted.add('deleted');
        world.local = [
            {
                id: 'offline-tail',
                userId: 'account-a',
                voyageId: 'live',
                timestamp: '2026-09-19T01:00:00Z',
                latitude: -23.7,
                longitude: 151.1,
                entryType: 'auto',
                positionFormatted: '',
                cumulativeDistanceNM: 125,
                speedKts: 10,
                source: 'device',
            },
        ];
        const complete = await getLifetimeVoyageSummaries();
        expect(complete).toHaveLength(1);
        expect(complete[0]).toMatchObject({
            voyageId: 'live',
            entryCount: 100,
            totalDistanceNM: 125,
            avgSpeedKts: 6.2,
            departedAt: '2026-09-18T01:00:00Z',
        });
    });

    it('rejects changed account and mismatched auth session', async () => {
        world.sessionUser = 'account-b';
        await expect(getLifetimeVoyageSummaries()).rejects.toThrow();
        world.sessionUser = 'account-a';
        let resume!: () => void;
        world.delay = new Promise<void>((resolve) => {
            resume = resolve;
        });
        const pending = getLifetimeVoyageSummaries();
        await vi.waitFor(() => expect(world.rpcCalls).toHaveLength(1));
        setAuthIdentityScope('account-b');
        resume();
        await expect(pending).rejects.toThrow();
    });
});

describe('complete summary-first voyage archive', () => {
    it('returns all five trips/41,858 points intact instead of truncating at the newest 10,000 points', async () => {
        const counts = [820, 1043, 5691, 18286, 16018];
        world.all = counts.map((count, index) => rollup(`voyage-${index}`, count));
        const summaries = await getArchivedVoyageSummaries();
        expect(summaries).toHaveLength(5);
        expect(summaries.reduce((total, summary) => total + summary.entryCount, 0)).toBe(41858);
        expect(summaries[4]).toEqual(
            expect.objectContaining({
                voyageId: 'voyage-4',
                entryCount: 16018,
                totalDistanceNM: 120,
                firstLat: -27.2,
                lastLat: -23.8,
                departedAt: '2026-09-18T01:00:00Z',
                passageGroupId: 'passage-one',
            }),
        );
        expect(world.rpcCalls).toHaveLength(2);
        expect(world.rowCalls).toHaveLength(0);
    });

    it('ranges the RPC beyond 1,000 voyages, including when the server cap is below our page size', async () => {
        world.serverCap = 100;
        world.all = Array.from({ length: 1003 }, (_, index) => rollup(`voyage-${index}`, 10000));
        expect(await getArchivedVoyageSummaries()).toHaveLength(1003);
        expect(world.rpcCalls.some((call) => call.archived && call.from === 1000)).toBe(true);
        expect(world.rowCalls).toHaveLength(0);
    });

    it('overlays pending archive/unarchive immediately without redownloading whole voyages', async () => {
        world.all = [rollup('archive-me', 18286), rollup('restore-me', 16018)];
        world.active = [rollup('archive-me', 18286)];
        world.intents = [
            { voyageId: 'archive-me', archived: true, requestedAt: Date.now() },
            { voyageId: 'restore-me', archived: false, requestedAt: Date.now() },
        ];
        expect(await getArchivedVoyageSummaries()).toEqual([
            expect.objectContaining({ voyageId: 'archive-me', entryCount: 18286, passageGroupId: 'passage-one' }),
        ]);
        expect(world.rowCalls).toHaveLength(0);
    });

    it('rebuilds a mixed archive-state voyage from only the archived subset and preserves passage membership', async () => {
        world.all = [rollup('mixed', 3)];
        world.active = [rollup('mixed', 1)];
        world.rows = [row('first', 'mixed', 0), row('last', 'mixed', 20), row('not-archived', 'mixed', 30, false)];
        expect(await getArchivedVoyageSummaries()).toEqual([
            expect.objectContaining({
                voyageId: 'mixed',
                entryCount: 2,
                totalDistanceNM: 2,
                firstLat: -27,
                lastLat: -26.998,
                passageGroupId: 'passage-one',
            }),
        ]);
        expect(world.rowCalls[0].columns).not.toBe('*');
        expect(world.rowCalls[0].filters).toEqual({ user_id: 'account-a', voyage_id: 'mixed' });
    });

    it('respects default-voyage archive time boundaries without archiving later ungrouped fixes', async () => {
        world.all = [rollup('default_voyage', 2)];
        world.active = [rollup('default_voyage', 2)];
        world.rows = [row('before', null, 0, false), row('after', '', 10, false)];
        world.intents = [
            { voyageId: 'default_voyage', archived: true, requestedAt: Date.parse('2026-09-18T00:05:00Z') },
        ];
        expect(await getArchivedVoyageSummaries()).toEqual([
            expect.objectContaining({ voyageId: 'default_voyage', entryCount: 1, endedAt: world.rows[0].timestamp }),
        ]);
    });

    it('includes unsynced archived entries, deduplicates interrupted cloud ACKs, and applies deletion truth', async () => {
        world.all = [rollup('archived', 1), rollup('deleted')];
        world.rows = [{ ...row('cloud', 'archived', 0), client_operation_id: 'same-operation' }];
        world.local = [
            { id: 'offline_same-operation', queue_id: 'same-operation', voyageId: 'archived', archived: true },
            {
                id: 'offline_new',
                queue_id: 'new',
                voyageId: 'archived',
                archived: true,
                timestamp: '2026-09-18T01:00:00Z',
                latitude: -26.8,
                longitude: 153,
                cumulativeDistanceNM: 4,
            },
        ] as unknown as ShipLogEntry[];
        world.deleted.add('deleted');
        expect(await getArchivedVoyageSummaries()).toEqual([
            expect.objectContaining({ voyageId: 'archived', entryCount: 2, totalDistanceNM: 4 }),
        ]);
    });

    it('falls back to complete lightweight pages beyond 10,000 points if the RPC is not deployed', async () => {
        world.rpcError = { code: 'PGRST202', message: 'missing RPC' };
        world.rows = Array.from({ length: 10502 }, (_, n) => row(`point-${n}`, n < 2 ? 'oldest-trip' : 'long-trip', n));
        const summaries = await getArchivedVoyageSummaries();
        expect(summaries).toHaveLength(2);
        expect(summaries.find((summary) => summary.voyageId === 'oldest-trip')?.entryCount).toBe(2);
        expect(summaries.reduce((n, summary) => n + summary.entryCount, 0)).toBe(10502);
        expect(world.rowCalls.some((call) => call.from === 10500)).toBe(true);
        expect(world.rowCalls.every((call) => call.filters.user_id === 'account-a' && call.columns !== '*')).toBe(true);
    });

    it('rejects a failed second RPC page instead of silently hiding older voyages', async () => {
        world.all = Array.from({ length: 501 }, (_, n) => rollup(`v-${n}`));
        world.rpcFailureAt = 2;
        await expect(getArchivedVoyageSummaries()).rejects.toThrow('complete voyage archive');
    });

    it('rejects a failed fallback page instead of reporting a partial archive', async () => {
        world.rpcError = { code: 'PGRST202', message: 'missing RPC' };
        world.rows = Array.from({ length: 501 }, (_, n) => row(`p-${n}`, 'trip', n));
        world.rowFailureAt = 1;
        await expect(getArchivedVoyageSummaries()).rejects.toThrow('complete voyage archive');
    });

    it('distinguishes a successful empty archive from unavailable auth and unreadable local truth', async () => {
        await expect(getArchivedVoyageSummaries()).resolves.toEqual([]);
        world.sessionUser = 'account-b';
        await expect(getArchivedVoyageSummaries()).rejects.toThrow('Sign in');
        world.sessionUser = 'account-a';
        world.ledgerError = true;
        await expect(getArchivedVoyageSummaries()).rejects.toThrow('ledger unreadable');
    });

    it('rejects late results after account switches, including A → B → A', async () => {
        world.all = [rollup('a-private-trip')];
        let release!: () => void;
        world.delay = new Promise<void>((resolve) => {
            release = resolve;
        });
        const pending = getArchivedVoyageSummaries();
        await vi.waitFor(() => expect(world.rpcCalls).toHaveLength(2));
        setAuthIdentityScope('account-b');
        setAuthIdentityScope('account-a');
        release();
        await expect(pending).rejects.toThrow('account changed');
    });

    it('retries when a durable unarchive is accepted while the summaries are in flight', async () => {
        world.all = [rollup('restore-during-read')];
        // Use a stable receipt timestamp across retry snapshots.
        const now = Date.now();
        world.archiveIntents
            .mockReset()
            .mockResolvedValueOnce([])
            .mockResolvedValue([{ voyageId: 'restore-during-read', archived: false, requestedAt: now }]);
        await expect(getArchivedVoyageSummaries()).resolves.toEqual([]);
        expect(world.rpcCalls).toHaveLength(4);
    });
});
