import { describe, it, expect } from 'vitest';
import { classifyTrackKind, groupByVoyage } from '../services/shiplog/RoutesAndTracks';
import type { ShipLogEntry } from '../types/navigation';

/**
 * Local-badge logic for the route picker — Week 1c.
 *
 * The flag is set inside groupByVoyage based on whether the
 * voyageId appears in the `cloudVoyageIds` set passed in by
 * `fetchRoutesAndTracks`. Cases we care about:
 *
 *   - Offline-only voyageId → isLocal: true (un-authed user's plan)
 *   - Cloud-only voyageId → isLocal: false (already synced)
 *   - Both (mid-flight)  → isLocal: false (cloud wins; the queue
 *                          entries will be removed when
 *                          syncOfflineQueue() succeeds)
 *
 * Each test builds a couple of polylines with ≥2 GPS points so the
 * filter in groupByVoyage doesn't drop them (it skips groups with
 * <2 valid coordinates).
 */

function entry(voyageId: string, lat: number, lon: number, tsOffsetSec = 0): ShipLogEntry {
    return {
        id: `${voyageId}_${tsOffsetSec}`,
        voyageId,
        timestamp: new Date(Date.UTC(2026, 4, 16, 10, 0, tsOffsetSec)).toISOString(),
        latitude: lat,
        longitude: lon,
        distanceNM: 1,
    } as unknown as ShipLogEntry;
}

describe('groupByVoyage — isLocal tagging', () => {
    it('tags a planned voyageId that exists in cloud as isLocal=false', () => {
        const entries: ShipLogEntry[] = [
            entry('planned_001', -33.8568, 151.2153, 0),
            entry('planned_001', -33.6, 151.3, 60),
        ];
        const cloudIds = new Set(['planned_001']);

        const groups = groupByVoyage(entries, cloudIds);
        expect(groups).toHaveLength(1);
        expect(groups[0].id).toBe('planned_001');
        expect(groups[0].isLocal).toBe(false);
    });

    it('tags a planned voyageId NOT in cloud as isLocal=true (un-authed user plan)', () => {
        const entries: ShipLogEntry[] = [
            entry('planned_002', 41.4901, -71.3128, 0),
            entry('planned_002', 41.1717, -71.5589, 60),
        ];
        const cloudIds = new Set<string>(); // empty cloud — un-authed user

        const groups = groupByVoyage(entries, cloudIds);
        expect(groups).toHaveLength(1);
        expect(groups[0].id).toBe('planned_002');
        expect(groups[0].isLocal).toBe(true);
    });

    it('handles mixed cloud + offline — cloud wins when both present', () => {
        // Mid-sync state: cloud has planned_A, offline queue still
        // has both planned_A (about to be removed by sync) and
        // planned_B (just saved offline).
        const entries: ShipLogEntry[] = [
            entry('planned_A', -33.85, 151.21, 0),
            entry('planned_A', -33.6, 151.3, 60),
            entry('planned_B', 41.5, -71.3, 0),
            entry('planned_B', 41.2, -71.6, 60),
        ];
        const cloudIds = new Set(['planned_A']);

        const groups = groupByVoyage(entries, cloudIds);
        const byId: Record<string, boolean> = {};
        for (const g of groups) byId[g.id] = g.isLocal;

        expect(byId['planned_A']).toBe(false); // already in cloud
        expect(byId['planned_B']).toBe(true); // local-only
    });

    it('tracks (non-planned voyageIds) get the same isLocal treatment', () => {
        // A GPS-tracked passage saved offline still gets isLocal:true
        // — the badge applies to tracks as well as planned routes.
        const entries: ShipLogEntry[] = [entry('track_xyz', -33.85, 151.21, 0), entry('track_xyz', -33.6, 151.3, 60)];
        const cloudIds = new Set<string>();

        const groups = groupByVoyage(entries, cloudIds);
        expect(groups).toHaveLength(1);
        expect(groups[0].id).toBe('track_xyz');
        expect(groups[0].isLocal).toBe(true);
    });
});

describe('classifyTrackKind — sea/land verdict for the voyage picker', () => {
    const fix = (
        overrides: Partial<Pick<ShipLogEntry, 'isOnWater' | 'speedKts'>>,
        i: number,
        lat = -27.2,
        lon = 153.2,
    ) => ({
        timestamp: new Date(Date.UTC(2026, 6, 3, 10, 0, i * 60)).toISOString(),
        latitude: lat,
        longitude: lon,
        ...overrides,
    });

    it('majority isOnWater=false → land (the car-drive case)', () => {
        const entries = [0, 1, 2, 3].map((i) => fix({ isOnWater: i > 2 }, i));
        expect(classifyTrackKind(entries)).toBe('land');
    });

    it('majority isOnWater=true → sea, even with a landish berth fix', () => {
        const entries = [0, 1, 2, 3].map((i) => fix({ isOnWater: i > 0 }, i));
        expect(classifyTrackKind(entries)).toBe('sea');
    });

    it('no water data: recorded SOG at car speeds → land', () => {
        const entries = [0, 1, 2, 3].map((i) => fix({ speedKts: 28 }, i));
        expect(classifyTrackKind(entries)).toBe('land');
    });

    it('no water data: recorded SOG at passage speeds → sea', () => {
        const entries = [0, 1, 2, 3].map((i) => fix({ speedKts: 6.5 }, i));
        expect(classifyTrackKind(entries)).toBe('sea');
    });

    it('no water data, no SOG: derives leg speed from fixes (car pace → land)', () => {
        // ~0.01° lat per minute ≈ 0.6 NM/min ≈ 36 kn.
        const entries = [0, 1, 2, 3].map((i) => fix({}, i, -27.2 + i * 0.01));
        expect(classifyTrackKind(entries)).toBe('land');
    });

    it('no signal at all → unknown (never hide a legit old passage)', () => {
        const entries = [0, 1].map((i) => fix({}, i));
        expect(classifyTrackKind(entries)).toBe('unknown');
    });

    it('groupByVoyage stamps kind on tracks and sea on planned routes', () => {
        const mk = (voyageId: string, i: number, onWater: boolean): ShipLogEntry =>
            ({
                id: `${voyageId}_${i}`,
                voyageId,
                timestamp: new Date(Date.UTC(2026, 6, 3, 10, 0, i * 60)).toISOString(),
                latitude: -27.2 + i * 0.001,
                longitude: 153.2,
                isOnWater: onWater,
            }) as unknown as ShipLogEntry;
        const entries = [
            mk('drive_home', 0, false),
            mk('drive_home', 1, false),
            mk('passage_0703', 0, true),
            mk('passage_0703', 1, true),
            mk('planned_x', 0, false),
            mk('planned_x', 1, false),
        ];
        const groups = groupByVoyage(entries, new Set<string>());
        const kinds: Record<string, string> = {};
        for (const g of groups) kinds[g.id] = g.kind;
        expect(kinds['drive_home']).toBe('land');
        expect(kinds['passage_0703']).toBe('sea');
        expect(kinds['planned_x']).toBe('sea'); // planned = sea by construction
    });
});
