import { describe, expect, it } from 'vitest';
import {
    allDiaryPublicTrip,
    buildPublicTripCatalogue,
    PUBLIC_ALL_DIARY_TRIP_ID,
    PUBLIC_LATEST_TRIP_ID,
    resolvePublicTripSelection,
} from '../supabase/functions/_shared/public-trip-selector';

describe('public Voyage Log trip selector', () => {
    it('catalogues actual tracks only, keeps their useful metadata, and puts the active trip first', () => {
        const trips = buildPublicTripCatalogue(
            [
                {
                    voyage_id: 'voyage-older',
                    timestamp: '2026-07-20T00:00:00.000Z',
                    cumulative_distance_nm: 0,
                },
                {
                    voyage_id: 'voyage-older',
                    timestamp: '2026-07-20T05:00:00.000Z',
                    cumulative_distance_nm: 18.27,
                },
                {
                    voyage_id: 'voyage-active',
                    timestamp: '2026-07-19T02:00:00.000Z',
                    cumulative_distance_nm: 4.44,
                },
                {
                    voyage_id: 'planned_future_route',
                    timestamp: '2026-07-22T00:00:00.000Z',
                    cumulative_distance_nm: 99,
                },
                { voyage_id: '', timestamp: '2026-07-22T01:00:00.000Z' },
                { timestamp: '2026-07-22T02:00:00.000Z' },
            ],
            'voyage-active',
            new Set(['voyage-older']),
        );

        expect(trips.map((trip) => trip.id)).toEqual(['voyage-active', 'voyage-older']);
        expect(trips[0]).toMatchObject({
            kind: 'track',
            active: true,
            point_count: 1,
            distance_nm: 4.4,
            has_route: false,
        });
        expect(trips[1]).toMatchObject({
            kind: 'track',
            active: false,
            point_count: 2,
            started_at: '2026-07-20T00:00:00.000Z',
            ended_at: '2026-07-20T05:00:00.000Z',
            distance_nm: 18.3,
            has_route: true,
        });
        expect(trips[0].label).toMatch(/^Live track/);
        expect(trips[1].label).toMatch(/^Track/);
    });

    it('orders completed tracks newest-first when no current track is active', () => {
        const trips = buildPublicTripCatalogue(
            [
                { voyage_id: 'early', timestamp: '2026-07-01T01:00:00.000Z' },
                { voyage_id: 'late', timestamp: '2026-07-02T01:00:00.000Z' },
                { voyage_id: 'late', timestamp: '2026-07-02T03:00:00.000Z' },
            ],
            null,
        );

        expect(trips.map((trip) => trip.id)).toEqual(['late', 'early']);
    });

    it('resolves latest, explicit historical, all-diary, and legacy requests without inventing a track', () => {
        const trips = buildPublicTripCatalogue(
            [{ voyage_id: 'voyage-a', timestamp: '2026-07-20T00:00:00.000Z' }],
            null,
        );

        expect(resolvePublicTripSelection(trips, null)).toEqual({ mode: 'legacy', trip: null });
        expect(resolvePublicTripSelection(trips, '')).toMatchObject({ mode: 'track', trip: { id: 'voyage-a' } });
        expect(resolvePublicTripSelection(trips, PUBLIC_LATEST_TRIP_ID)).toMatchObject({
            mode: 'track',
            trip: { id: 'voyage-a' },
        });
        expect(resolvePublicTripSelection(trips, 'voyage-a')).toMatchObject({
            mode: 'track',
            trip: { id: 'voyage-a' },
        });
        expect(resolvePublicTripSelection(trips, PUBLIC_ALL_DIARY_TRIP_ID)).toEqual({
            mode: 'all-diary',
            trip: allDiaryPublicTrip(),
        });
        expect(resolvePublicTripSelection(trips, 'planned_future_route')).toBeNull();
    });

    it('falls back to all diary entries when latest is requested before a track has recorded a point', () => {
        expect(resolvePublicTripSelection([], PUBLIC_LATEST_TRIP_ID)).toEqual({
            mode: 'all-diary',
            trip: allDiaryPublicTrip(),
        });
    });
});
