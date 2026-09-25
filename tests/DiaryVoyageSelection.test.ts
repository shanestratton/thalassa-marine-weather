import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    captureDiaryTripContext,
    loadDiaryTripChoices,
    validateDiaryTripSelection,
} from '../services/diaryVoyageSelection';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';

const mocks = vi.hoisted(() => ({
    boat: vi.fn(),
    active: vi.fn(),
    summaries: vi.fn(),
    from: vi.fn(),
    deleted: false,
    archived: false,
}));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        resolveActiveBoatId: mocks.boat,
        resolveActiveVoyageId: mocks.active,
        getVoyageSummaries: mocks.summaries,
    },
}));
vi.mock('../services/supabase', () => ({ supabase: { from: mocks.from } }));
vi.mock('../services/shiplog/OfflineQueue', () => ({
    filterVoyageTombstonedEntries: async (rows: unknown[]) => (mocks.deleted ? [] : rows),
    applyVoyageArchiveIntentOverlay: async (rows: object[]) =>
        rows.map((row) => ({ ...row, archived: mocks.archived })),
}));

const boatId = '11111111-1111-4111-8111-111111111111';
const trip = (voyageId = 'sailed'): VoyageSummary => ({
    voyageId,
    startedAt: '2026-09-24T01:00:00Z',
    endedAt: '2026-09-24T03:00:00Z',
    totalDistanceNM: 15.6,
    entryCount: 500,
    avgSpeedKts: 6,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: -20,
    firstLon: 149,
    lastLat: -21,
    lastLon: 150,
    firstIsOnWater: true,
    landFraction: 0,
});
let ambiguous = false;
let missing = false;
let offline = false;
let queries: { column: string; value: string }[][];

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('skipper');
    mocks.boat.mockResolvedValue(boatId);
    mocks.active.mockResolvedValue('active');
    mocks.summaries.mockResolvedValue([trip()]);
    mocks.deleted = false;
    mocks.archived = false;
    ambiguous = false;
    missing = false;
    offline = false;
    queries = [];
    mocks.from.mockImplementation(() => {
        const filters: { column: string; value: string }[] = [];
        queries.push(filters);
        let mismatch = false;
        const query = {
            select: () => query,
            eq: (column: string, value: string) => {
                filters.push({ column, value });
                return query;
            },
            or: (value: string) => {
                mismatch = value.startsWith('boat_id');
                return query;
            },
            limit: async () => ({
                error: offline ? new Error('offline') : null,
                data: mismatch
                    ? ambiguous
                        ? [{ boat_id: null }]
                        : []
                    : missing
                      ? []
                      : [
                            {
                                user_id: 'skipper',
                                boat_id: boatId,
                                voyage_id: filters.find((filter) => filter.column === 'voyage_id')?.value,
                            },
                        ],
            }),
        };
        return query;
    });
});

describe('diary trip selection', () => {
    it('defaults to the actual active recording, never the newest completed trip', async () => {
        expect(await captureDiaryTripContext()).toMatchObject({ boatId, originalVoyageId: 'active' });
        mocks.active.mockResolvedValue(undefined);
        expect(await captureDiaryTripContext()).toMatchObject({ originalVoyageId: null });
        expect(mocks.summaries).not.toHaveBeenCalled();
    });

    it('includes just-recording tracks, not planned routes or imports, with bounded owner/boat probes', async () => {
        mocks.summaries.mockResolvedValue([
            trip(),
            { ...trip('planned'), isPlannedRoute: true },
            { ...trip('import'), isImported: true },
        ]);
        const context = await captureDiaryTripContext();
        expect(await loadDiaryTripChoices(context)).toEqual([{ voyageId: 'sailed', label: '24 Sept 2026 · 15.6 nm' }]);
        expect(queries).toHaveLength(2);
        for (const query of queries) expect(query).toContainEqual({ column: 'user_id', value: 'skipper' });
        expect(queries[0]).toContainEqual({ column: 'boat_id', value: boatId });
    });

    it.each(['legacy', 'missing', 'offline', 'archived', 'deleted'])(
        'rejects %s historical membership without substituting a trip',
        async (kind) => {
            ambiguous = kind === 'legacy';
            missing = kind === 'missing';
            offline = kind === 'offline';
            mocks.archived = kind === 'archived';
            mocks.deleted = kind === 'deleted';
            const context = await captureDiaryTripContext();
            expect(await loadDiaryTripChoices(context)).toEqual([]);
            await expect(validateDiaryTripSelection(context, 'sailed')).rejects.toThrow('no longer available');
        },
    );

    it('allows active and No trip offline, but refuses a vessel or identity switch', async () => {
        const context = await captureDiaryTripContext();
        offline = true;
        await expect(validateDiaryTripSelection(context, 'active')).resolves.toBeUndefined();
        await expect(validateDiaryTripSelection(context, null)).resolves.toBeUndefined();
        expect(mocks.from).not.toHaveBeenCalled();
        mocks.boat.mockResolvedValue('another-boat');
        await expect(validateDiaryTripSelection(context, null)).rejects.toThrow();
        setAuthIdentityScope('other-user');
        await expect(validateDiaryTripSelection(context, 'active')).rejects.toThrow();
    });

    it('edits keep their original boat even if the current fleet selection changed', async () => {
        const context = { scope: getAuthIdentityScope(), boatId, originalVoyageId: 'old-trip', entryId: 'entry' };
        mocks.boat.mockResolvedValue('other-boat');
        await expect(validateDiaryTripSelection(context, 'old-trip')).resolves.toBeUndefined();
        await expect(validateDiaryTripSelection(context, 'sailed')).resolves.toBeUndefined();
        expect(mocks.boat).not.toHaveBeenCalled();
    });

    it('caps initial candidates and displayed choices', async () => {
        mocks.summaries.mockResolvedValue(Array.from({ length: 40 }, (_, i) => trip(`trip-${i}`)));
        expect(await loadDiaryTripChoices(await captureDiaryTripContext())).toHaveLength(8);
        expect(queries).toHaveLength(24);
    });

    it('revalidates a choice removed after loading', async () => {
        const context = await captureDiaryTripContext();
        expect(await loadDiaryTripChoices(context)).toHaveLength(1);
        mocks.summaries.mockResolvedValue([]);
        await expect(validateDiaryTripSelection(context, 'sailed')).rejects.toThrow();
    });

    it('still saves the active association while the history picker times out', async () => {
        vi.useFakeTimers();
        try {
            const context = await captureDiaryTripContext();
            mocks.summaries.mockReturnValue(new Promise(() => {}));
            const history = expect(loadDiaryTripChoices(context)).rejects.toThrow('deadline');
            await expect(validateDiaryTripSelection(context, 'active')).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(6_001);
            await history;
            expect(mocks.from).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
