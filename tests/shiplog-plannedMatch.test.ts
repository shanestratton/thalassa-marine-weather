/**
 * Tests for matchPlannedRouteByCoords — the coordinate-based join that
 * overlays a planned route on its sailed voyage in the track viewer.
 */
import { describe, it, expect } from 'vitest';
import { matchPlannedRouteByCoords, type VoyageSummary } from '../services/shiplog/VoyageSummary';

function sv(over: Partial<VoyageSummary>): VoyageSummary {
    return {
        voyageId: 'v',
        entryCount: 5,
        startedAt: '2026-06-01T00:00:00Z',
        endedAt: '2026-06-01T05:00:00Z',
        totalDistanceNM: 30,
        avgSpeedKts: 6,
        hasManual: false,
        isPlannedRoute: false,
        isImported: false,
        firstLat: -27.0,
        firstLon: 153.0,
        lastLat: -26.7,
        lastLon: 153.1,
        firstIsOnWater: true,
        landFraction: 0,
        ...over,
    };
}

describe('matchPlannedRouteByCoords', () => {
    const sailed = sv({ voyageId: 'sailed' });

    it('matches a planned route with near-identical start/end', () => {
        const planned = sv({
            voyageId: 'planned_1',
            isPlannedRoute: true,
            firstLat: -27.005,
            firstLon: 153.004,
            lastLat: -26.702,
            lastLon: 153.103,
        });
        expect(matchPlannedRouteByCoords(sailed, [planned])).toBe('planned_1');
    });

    it('does not match when the endpoints are far apart', () => {
        const planned = sv({
            voyageId: 'planned_far',
            isPlannedRoute: true,
            firstLat: -30.0,
            firstLon: 150.0,
            lastLat: -29.0,
            lastLon: 151.0,
        });
        expect(matchPlannedRouteByCoords(sailed, [planned])).toBeNull();
    });

    it('ignores non-planned candidates and the voyage itself', () => {
        const otherSailed = sv({ voyageId: 'other', isPlannedRoute: false });
        expect(matchPlannedRouteByCoords(sailed, [otherSailed, sailed])).toBeNull();
    });

    it('picks the closest of several planned candidates', () => {
        const near = sv({
            voyageId: 'near',
            isPlannedRoute: true,
            firstLat: -27.001,
            firstLon: 153.001,
            lastLat: -26.701,
            lastLon: 153.101,
        });
        const looser = sv({
            voyageId: 'looser',
            isPlannedRoute: true,
            firstLat: -27.02,
            firstLon: 153.02,
            lastLat: -26.72,
            lastLon: 153.12,
        });
        expect(matchPlannedRouteByCoords(sailed, [looser, near])).toBe('near');
    });

    it('returns null when the sailed voyage has no coords', () => {
        const noCoords = sv({ voyageId: 's', firstLat: null, firstLon: null, lastLat: null, lastLon: null });
        const planned = sv({ voyageId: 'p', isPlannedRoute: true });
        expect(matchPlannedRouteByCoords(noCoords, [planned])).toBeNull();
    });

    it('respects a custom tolerance', () => {
        const planned = sv({
            voyageId: 'p',
            isPlannedRoute: true,
            firstLat: -27.05, // ~3 NM off
            firstLon: 153.0,
            lastLat: -26.7,
            lastLon: 153.1,
        });
        expect(matchPlannedRouteByCoords(sailed, [planned], 1)).toBeNull();
        expect(matchPlannedRouteByCoords(sailed, [planned], 5)).toBe('p');
    });
});
