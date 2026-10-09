/**
 * A copied trip leg must get its own Log row (126-16a, MEASURED trap). A copy
 * keeps its source's places, so its planned-route mirror has the same
 * "Akaroa → Pigeon Bay" label; checked at the same departure it lands on the
 * same calendar day. The old label + day duplicate guard refused it, MapHub
 * swallowed the refusal, and the follow sheet then showed the leg as "Not in
 * the log yet". A Route Tracer mirror now dedupes on its saved route id; plans
 * without one (the AI planner) keep the label + day guard.
 *
 * Fictional legs on Banks Peninsula, New Zealand.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoyagePlan } from '../types';
import type { TraceLegVerdict, TracePoint } from '../services/routeTracer';

const mocks = vi.hoisted(() => ({
    fetchRoutes: vi.fn(),
    invalidate: vi.fn(),
    getCurrentUser: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    backfill: vi.fn(),
    queue: vi.fn(),
    tombstone: vi.fn(),
    createVoyage: vi.fn(),
    deleteVoyage: vi.fn(),
    refreshVoyage: vi.fn(),
    resolveActiveBoatId: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        from: () => {
            const chain = { eq: () => chain, in: (...args: unknown[]) => mocks.backfill(...args) };
            return {
                upsert: (...args: unknown[]) => mocks.upsert(...args),
                update: (...args: unknown[]) => {
                    mocks.update(...args);
                    return chain;
                },
            };
        },
    },
    getCurrentUser: (...args: unknown[]) => mocks.getCurrentUser(...args),
}));
vi.mock('../services/shiplog/OfflineQueue', () => ({
    queueOfflineEntry: (...args: unknown[]) => mocks.queue(...args),
    addVoyageTombstone: (...args: unknown[]) => mocks.tombstone(...args),
}));
vi.mock('../services/shiplog/RoutesAndTracks', () => ({
    fetchRoutesAndTracks: (...args: unknown[]) => mocks.fetchRoutes(...args),
    invalidateRoutesAndTracks: (...args: unknown[]) => mocks.invalidate(...args),
}));
vi.mock('../services/VoyageService', () => ({
    createVoyage: (...args: unknown[]) => mocks.createVoyage(...args),
    deleteVoyageById: (...args: unknown[]) => mocks.deleteVoyage(...args),
    refreshSavedRouteVoyageVerification: (...args: unknown[]) => mocks.refreshVoyage(...args),
}));
vi.mock('../services/PassagePlanService', () => ({ setActivePassage: vi.fn() }));
vi.mock('../services/ShipLogService', () => ({
    ShipLogService: { resolveActiveBoatId: (...args: unknown[]) => mocks.resolveActiveBoatId(...args) },
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { DUPLICATE_PASSAGE_PLAN_ERROR, savePassagePlanToLogbookWithLinks } from '../services/shiplog/PassagePlanSave';
import { evaluateTraceRelease } from '../services/traceVerification';

const DEPART = Date.parse('2026-11-14T19:00:00Z');
const AKAROA = { lat: -43.806, lon: 172.968 };
const PIGEON_BAY = { lat: -43.68, lon: 172.9 };

const clear: TraceLegVerdict = {
    grade: 'clear',
    issues: [],
    minDepthM: 12,
    minAt: AKAROA,
    needsTide: false,
    nudge: null,
    nudgeTo: null,
};

/** A checked Route Tracer leg, as MapHub's Save hands it to the mirror. */
function tracePlan(points: TracePoint[]): VoyagePlan {
    const verification = evaluateTraceRelease(
        points,
        'ready',
        points.slice(1).map(() => clear),
        new Set(),
        {
            draftM: 2.1,
            draftAssumed: false,
            encRegistryVersion: 1,
            encRegistryFingerprint: 'NZ5X0001@1',
            departureMs: DEPART,
            tideWindowLabel: '',
        },
        '2026-11-13T08:00:00.000Z',
    ).verification!;
    expect(verification).toBeTruthy();
    return {
        origin: 'Akaroa',
        destination: 'Pigeon Bay',
        departureDate: new Date(DEPART).toISOString(),
        originCoordinates: points[0],
        destinationCoordinates: points[points.length - 1],
        distanceApprox: '9.1 NM',
        durationApprox: '1.7 hours',
        overview: 'Hand-traced route',
        waypoints: points.slice(1, -1).map((p, i) => ({ name: `Pin ${i + 2}`, coordinates: p })),
        routeGeoJSON: {
            type: 'Feature',
            properties: { _source: 'route-tracer', traceVerification: verification },
            geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) },
        },
    } as VoyagePlan;
}

const sourceLeg = [AKAROA, { lat: -43.75, lon: 172.95 }, PIGEON_BAY];
const copiedLeg = [{ lat: -43.8061, lon: 172.968 }, { lat: -43.75, lon: 172.95 }, PIGEON_BAY];

/** What the Log already holds: a leg's mirror, same label, same day. */
const mirrorOf = (savedRouteId: string | undefined, links: { id?: string; linkedPlanId?: string } = {}) => ({
    id: links.id ?? 'planned_source',
    voyageId: links.id ?? 'planned_source',
    ...(links.linkedPlanId ? { linkedPlanId: links.linkedPlanId } : {}),
    label: 'Akaroa → Pigeon Bay',
    sublabel: '',
    timestamp: DEPART,
    distanceNm: 9.1,
    entryCount: 3,
    kind: 'sea',
    ...(savedRouteId ? { savedRouteId } : {}),
});

beforeEach(() => {
    vi.clearAllMocks();
    setAuthIdentityScope('account-a');
    mocks.getCurrentUser.mockResolvedValue({ id: 'account-a' });
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.backfill.mockResolvedValue({ error: null, count: 3 });
    mocks.queue.mockResolvedValue('queued');
    mocks.createVoyage.mockResolvedValue({ voyage: { id: 'voyage-new' } });
    mocks.resolveActiveBoatId.mockResolvedValue(undefined);
    mocks.refreshVoyage.mockImplementation(async (voyageId: string) => ({ voyage: { id: voyageId } }));
});

describe('the Log mirror of a traced leg dedupes on its saved route id', () => {
    it('a copy with the same label on the same day still gets its own Log row', async () => {
        mocks.fetchRoutes.mockResolvedValue({ routes: [mirrorOf('trace-source')], tracks: [] });
        const saved = await savePassagePlanToLogbookWithLinks(tracePlan(copiedLeg), { savedRouteId: 'trace-copy' });
        expect(saved).toMatchObject({ plannedRouteId: expect.stringMatching(/^planned_/) });
        expect(mocks.upsert).toHaveBeenCalledOnce();
        const rows = mocks.upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
        expect(rows.every((row) => row.saved_route_id === 'trace-copy')).toBe(true);
    });

    it('two different legs, one label, one day: both write', async () => {
        mocks.fetchRoutes.mockResolvedValue({ routes: [], tracks: [] });
        await savePassagePlanToLogbookWithLinks(tracePlan(sourceLeg), { savedRouteId: 'trace-source' });
        mocks.fetchRoutes.mockResolvedValue({ routes: [mirrorOf('trace-source')], tracks: [] });
        await savePassagePlanToLogbookWithLinks(tracePlan(copiedLeg), { savedRouteId: 'trace-copy' });
        expect(mocks.upsert).toHaveBeenCalledTimes(2);
    });

    it('the same saved route, mirrored and linked, whose row will not refresh, is the duplicate; nothing is written', async () => {
        mocks.refreshVoyage.mockResolvedValue({
            voyage: null,
            error: 'Saved-route planning link could not be verified',
        });
        mocks.fetchRoutes.mockResolvedValue({
            routes: [mirrorOf('trace-copy', { id: 'planned_copy', linkedPlanId: 'voyage-copy' })],
            tracks: [],
        });
        await expect(
            savePassagePlanToLogbookWithLinks(tracePlan(copiedLeg), {
                savedRouteId: 'trace-copy',
                existingPlannedRouteId: 'planned_copy',
                existingPassageVoyageId: 'voyage-copy',
            }),
        ).rejects.toThrow(DUPLICATE_PASSAGE_PLAN_ERROR);
        // Tried once through the trace's own ids, never again as an adoption.
        expect(mocks.refreshVoyage).toHaveBeenCalledOnce();
        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.queue).not.toHaveBeenCalled();
        expect(mocks.createVoyage).not.toHaveBeenCalled();
    });

    it('a plan with no saved route keeps the label + day guard', async () => {
        mocks.fetchRoutes.mockResolvedValue({ routes: [mirrorOf(undefined)], tracks: [] });
        const plan: VoyagePlan = { ...tracePlan(copiedLeg), routeGeoJSON: undefined };
        await expect(savePassagePlanToLogbookWithLinks(plan)).rejects.toThrow(DUPLICATE_PASSAGE_PLAN_ERROR);
        expect(mocks.upsert).not.toHaveBeenCalled();
    });
});

/**
 * Review, 2026-10-09: the mirror write landed, then iOS killed the app before
 * the trace was stamped with its ids. Every later Save skipped the refresh (no
 * ids), found the mirror, and was refused, so the trace could never link and
 * the Trip sheet said "Not in the log yet" for good. Its own mirror is now
 * adopted: the ids come back for MapHub to link, nothing new is written.
 */
describe('a saved route whose mirror never reached it adopts that mirror', () => {
    it('its planning row is refreshed with the new check and both ids come back', async () => {
        mocks.fetchRoutes.mockResolvedValue({
            routes: [
                mirrorOf('trace-source'),
                mirrorOf('trace-copy', { id: 'planned_copy', linkedPlanId: 'voyage-copy' }),
            ],
            tracks: [],
        });
        const saved = await savePassagePlanToLogbookWithLinks(tracePlan(copiedLeg), { savedRouteId: 'trace-copy' });
        expect(saved).toEqual({ plannedRouteId: 'planned_copy', passageVoyageId: 'voyage-copy' });
        expect(mocks.refreshVoyage).toHaveBeenCalledOnce();
        expect(mocks.refreshVoyage.mock.calls[0].slice(0, 2)).toEqual(['voyage-copy', 'trace-copy']);
        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.queue).not.toHaveBeenCalled();
        expect(mocks.createVoyage).not.toHaveBeenCalled();
    });

    it('a mirror with no planning row behind it gives its planned route id alone', async () => {
        mocks.fetchRoutes.mockResolvedValue({ routes: [mirrorOf('trace-copy', { id: 'planned_copy' })], tracks: [] });
        const saved = await savePassagePlanToLogbookWithLinks(tracePlan(copiedLeg), { savedRouteId: 'trace-copy' });
        expect(saved).toEqual({ plannedRouteId: 'planned_copy', passageVoyageId: null });
        expect(mocks.refreshVoyage).not.toHaveBeenCalled();
        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.createVoyage).not.toHaveBeenCalled();
    });

    it('if that planning row will not refresh, it stays the duplicate and nothing is written', async () => {
        mocks.refreshVoyage.mockResolvedValue({ voyage: null, error: 'offline' });
        mocks.fetchRoutes.mockResolvedValue({
            routes: [mirrorOf('trace-copy', { id: 'planned_copy', linkedPlanId: 'voyage-copy' })],
            tracks: [],
        });
        await expect(
            savePassagePlanToLogbookWithLinks(tracePlan(copiedLeg), { savedRouteId: 'trace-copy' }),
        ).rejects.toThrow(DUPLICATE_PASSAGE_PLAN_ERROR);
        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(mocks.createVoyage).not.toHaveBeenCalled();
    });

    it('a trace already linked to a mirror without a planning row is a quiet duplicate, not a loop', async () => {
        mocks.fetchRoutes.mockResolvedValue({ routes: [mirrorOf('trace-copy', { id: 'planned_copy' })], tracks: [] });
        await expect(
            savePassagePlanToLogbookWithLinks(tracePlan(copiedLeg), {
                savedRouteId: 'trace-copy',
                existingPlannedRouteId: 'planned_copy',
            }),
        ).rejects.toThrow(DUPLICATE_PASSAGE_PLAN_ERROR);
        expect(mocks.upsert).not.toHaveBeenCalled();
    });
});
