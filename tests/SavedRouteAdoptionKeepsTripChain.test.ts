import { beforeEach, describe, expect, it } from 'vitest';

/**
 * A route fetched from the account onto a second device used to arrive bare —
 * no trip id, no leg ordinal, no planned mirror — so the follow sheet listed a
 * passage's legs as unrelated day sails and the publish could not find the
 * mirror (2026-09-08). The fetch now carries the chain and adoption keeps it.
 */
import { adoptServerRoute, loadSavedTraces } from '../services/routeTracer';
import { savedRouteFetchExtras } from '../services/savedRoutePoints';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const points = [
    { lat: -27.2, lon: 153.1 },
    { lat: -26.8, lon: 153.2 },
];

beforeEach(() => {
    localStorage.clear();
    setAuthIdentityScope('skipper');
});

describe('savedRouteFetchExtras', () => {
    it('maps the saved_routes chain columns and drops junk', () => {
        expect(
            savedRouteFetchExtras({
                trip_id: 'trip-1',
                leg_ordinal: 3,
                dest_name: 'Airlie Beach',
                planned_route_id: 'planned-3',
                passage_voyage_id: 'passage-3',
                updated_at: '2026-09-07T10:00:00.000Z',
            }),
        ).toEqual({
            tripId: 'trip-1',
            legOrdinal: 3,
            destName: 'Airlie Beach',
            plannedRouteId: 'planned-3',
            passageVoyageId: 'passage-3',
            updatedAt: '2026-09-07T10:00:00.000Z',
        });
        expect(savedRouteFetchExtras({ trip_id: '', leg_ordinal: 0, dest_name: null, planned_route_id: 7 })).toEqual(
            {},
        );
    });
});

describe('adoptServerRoute', () => {
    // A trip's id IS its first leg's id, and the load path repairs a chain
    // whose leg 1 is missing — so leg 1 is adopted first, as a real pull does.
    const adoptLegOne = () =>
        adoptServerRoute('route-1', 'Newport → Mooloolaba (1st Leg)', points, undefined, {
            tripId: 'route-1',
            legOrdinal: 1,
            destName: 'Mooloolaba',
        });

    it('keeps the trip chain and mirror it was handed', () => {
        adoptLegOne();
        const trace = adoptServerRoute('route-3', 'Mackay → Airlie (3rd Leg)', points, undefined, {
            tripId: 'route-1',
            legOrdinal: 3,
            destName: 'Airlie Beach',
            plannedRouteId: 'planned-3',
            passageVoyageId: 'passage-3',
            updatedAt: '2026-09-07T10:00:00.000Z',
        });
        expect(trace).toMatchObject({
            id: 'route-3',
            tripId: 'route-1',
            legOrdinal: 3,
            destName: 'Airlie Beach',
            plannedRouteId: 'planned-3',
            passageVoyageId: 'passage-3',
            updatedAt: '2026-09-07T10:00:00.000Z',
        });
        const stored = loadSavedTraces().find((t) => t.id === 'route-3');
        expect(stored?.tripId).toBe('route-1');
        expect(stored?.legOrdinal).toBe(3);
        expect(stored?.plannedRouteId).toBe('planned-3');
    });

    it('a re-adoption without extras keeps the chain the local copy already had', () => {
        adoptLegOne();
        adoptServerRoute('route-3', 'Leg 3', points, undefined, { tripId: 'route-1', legOrdinal: 3 });
        const again = adoptServerRoute('route-3', 'Leg 3 renamed', points);
        expect(again).toMatchObject({ tripId: 'route-1', legOrdinal: 3, name: 'Leg 3 renamed' });
    });

    it('a bare adoption (the old call shape) still works', () => {
        const trace = adoptServerRoute('route-solo', 'Day sail', points);
        expect(trace).toMatchObject({ id: 'route-solo', name: 'Day sail' });
        expect(trace?.tripId).toBeUndefined();
    });
});
