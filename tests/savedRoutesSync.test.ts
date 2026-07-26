import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    upsert: vi.fn(),
    rows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => true,
    supabase: {
        auth: { getUser: (...args: unknown[]) => mocks.getUser(...args) },
        from: () => ({
            upsert: (...args: unknown[]) => mocks.upsert(...args),
            select: () => ({
                order: () => ({
                    limit: async () => ({ data: mocks.rows, error: null }),
                }),
            }),
        }),
    },
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { deleteTrace, getSavedTraceTombstones, saveTrace } from '../services/routeTracer';
import { pushSavedRoute, syncSavedRoutes } from '../services/savedRoutesSync';

const points = [
    { lat: -27.47, lon: 153.02 },
    { lat: -27.1, lon: 153.4 },
];

describe('savedRoutesSync — canonical chain and deletion integrity', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        setAuthIdentityScope('account-a');
        mocks.getUser.mockResolvedValue({ data: { user: { id: 'account-a' } } });
        mocks.upsert.mockResolvedValue({ error: null });
        mocks.rows = [];
    });

    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('pushes and pulls every structural chain/link field', async () => {
        const trace = {
            id: 'trace-leg-2',
            name: 'Woorim - Mooloolaba (2nd Leg)',
            createdAt: '2026-07-26T00:00:00.000Z',
            updatedAt: '2026-07-26T00:02:00.000Z',
            points,
            tripId: 'trace-leg-1',
            legOrdinal: 2,
            destName: 'Mooloolaba',
            plannedRouteId: 'planned_123_route',
            passageVoyageId: '123e4567-e89b-12d3-a456-426614174000',
        };

        await expect(pushSavedRoute(trace)).resolves.toBe('ok');
        expect(mocks.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                trip_id: 'trace-leg-1',
                leg_ordinal: 2,
                dest_name: 'Mooloolaba',
                planned_route_id: 'planned_123_route',
                passage_voyage_id: '123e4567-e89b-12d3-a456-426614174000',
            }),
        );

        mocks.rows = [
            {
                id: 'trace-leg-1',
                name: 'Brisbane - Woorim (1st Leg)',
                points: points.map((point) => [point.lat, point.lon]),
                created_at: '2026-07-25T23:00:00.000Z',
                updated_at: '2026-07-25T23:01:00.000Z',
                deleted: false,
                trip_id: 'trace-leg-1',
                leg_ordinal: 1,
                dest_name: 'Woorim',
                planned_route_id: 'planned_123_root',
                passage_voyage_id: '223e4567-e89b-12d3-a456-426614174000',
            },
            {
                id: trace.id,
                name: trace.name,
                points: points.map((point) => [point.lat, point.lon]),
                created_at: trace.createdAt,
                updated_at: trace.updatedAt,
                deleted: false,
                trip_id: trace.tripId,
                leg_ordinal: trace.legOrdinal,
                dest_name: trace.destName,
                planned_route_id: trace.plannedRouteId,
                passage_voyage_id: trace.passageVoyageId,
            },
        ];
        await expect(syncSavedRoutes()).resolves.toEqual(expect.arrayContaining([expect.objectContaining(trace)]));
    });

    it('keeps a local deletion fence ahead of a stale live cloud row', async () => {
        const { trace } = saveTrace('Brisbane - Moreton', points);
        expect(deleteTrace(trace.id)).toBe(true);
        expect(getSavedTraceTombstones()).toHaveProperty(trace.id);

        mocks.rows = [
            {
                id: trace.id,
                name: trace.name,
                points: points.map((point) => [point.lat, point.lon]),
                created_at: trace.createdAt,
                updated_at: trace.updatedAt ?? trace.createdAt,
                deleted: false,
                trip_id: null,
                leg_ordinal: null,
                dest_name: null,
                planned_route_id: null,
                passage_voyage_id: null,
            },
        ];

        await expect(syncSavedRoutes()).resolves.toEqual([]);
    });

    it('omits a malformed historical passage id instead of failing the whole route upsert', async () => {
        await expect(
            pushSavedRoute({
                id: 'trace-legacy',
                name: 'Legacy route',
                createdAt: '2026-07-26T00:00:00.000Z',
                points,
                passageVoyageId: 'not-a-uuid-from-an-old-cache',
            }),
        ).resolves.toBe('ok');

        expect(mocks.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'trace-legacy', passage_voyage_id: null }),
        );
    });
});
