/**
 * Tests for deriveTurnMarkers — render-time turn waypoints derived from
 * track geometry. Markers must sit ON actual track points, appear only
 * at genuine turns (one at a sharp corner, several around a wide
 * sweep), and never on straights or anchor jitter.
 */
import { describe, it, expect } from 'vitest';
import { deriveTurnMarkers, TURN_THRESHOLD_DEG } from '../services/shiplog/turnMarkers';
import type { ShipLogEntry } from '../types';

// ── Geometry helpers ────────────────────────────────────────────────
// Around -27.5°S: 1° lat ≈ 111_320 m, 1° lon ≈ 111_320·cos(27.5°) m.
const LAT0 = -27.5;
const LON0 = 153.0;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

/** Offset (north, east) metres from the origin → lat/lon. */
function offset(northM: number, eastM: number): { lat: number; lon: number } {
    return { lat: LAT0 + northM / M_PER_DEG_LAT, lon: LON0 + eastM / M_PER_DEG_LON };
}

let seq = 0;
function entry(northM: number, eastM: number): ShipLogEntry {
    const { lat, lon } = offset(northM, eastM);
    seq += 5_000; // 5 s cadence
    return {
        id: `t${seq}`,
        voyageId: 'v1',
        timestamp: new Date(1_750_000_000_000 + seq).toISOString(),
        latitude: lat,
        longitude: lon,
        entryType: 'auto',
    } as ShipLogEntry;
}

function track(points: Array<[number, number]>): ShipLogEntry[] {
    seq = 0;
    return points.map(([n, e]) => entry(n, e));
}

describe('deriveTurnMarkers', () => {
    it('returns nothing for a straight leg', () => {
        // 1 km due east, 50 m steps
        const pts = track(Array.from({ length: 21 }, (_, i) => [0, i * 50] as [number, number]));
        expect(deriveTurnMarkers(pts)).toEqual([]);
    });

    it('drops exactly one marker at a sharp 90° corner, on an actual track point', () => {
        // 500 m east, then 500 m north
        const east = Array.from({ length: 11 }, (_, i) => [0, i * 50] as [number, number]);
        const north = Array.from({ length: 10 }, (_, i) => [(i + 1) * 50, 500] as [number, number]);
        const pts = track([...east, ...north]);

        const markers = deriveTurnMarkers(pts);
        expect(markers).toHaveLength(1);
        // Marker lies on one of the input points (on-route guarantee).
        const onTrack = pts.some((p) => p.latitude === markers[0].lat && p.longitude === markers[0].lon);
        expect(onTrack).toBe(true);
        // And it's at/near the corner — within the first 100 m of the north leg.
        expect(markers[0].lon).toBeCloseTo(offset(0, 500).lon, 5);
        // Course change reads roughly E → N.
        expect(markers[0].fromCardinal).toBe('E');
        expect(markers[0].toCardinal).toBe('N');
    });

    it('spreads several markers around a wide 180° sweep', () => {
        // Semicircle, radius 200 m, sampled every 10° of arc (~35 m chords):
        // heading changes 180° in total → roughly one marker per 30°.
        const approach = Array.from({ length: 6 }, (_, i) => [0, -300 + i * 50] as [number, number]);
        const arc: Array<[number, number]> = [];
        for (let deg = -90; deg <= 90; deg += 10) {
            const rad = (deg * Math.PI) / 180;
            arc.push([200 * Math.cos(rad) - 0 + 0, 200 * Math.sin(rad)]);
        }
        // Shift arc so it joins the approach: arc starts at (0·cos(-90)=0? ) —
        // entry point of the arc is (cos(-90°)=0 → [0, -200]); approach ends at [0, -50].
        const pts = track([...approach, ...arc.map(([n, e]) => [n, e + 150] as [number, number])]);

        const markers = deriveTurnMarkers(pts);
        expect(markers.length).toBeGreaterThanOrEqual(3);
        expect(markers.length).toBeLessThanOrEqual(Math.ceil(180 / TURN_THRESHOLD_DEG) + 1);
        // Every marker sits on an actual input point.
        for (const m of markers) {
            expect(pts.some((p) => p.latitude === m.lat && p.longitude === m.lon)).toBe(true);
        }
    });

    it('ignores anchor jitter (legs below the minimum length)', () => {
        // Random-ish wander inside a 15 m circle — heading swings wildly
        // but no leg ever reaches MIN_LEG_M.
        const wander: Array<[number, number]> = [
            [0, 0],
            [8, 4],
            [2, 10],
            [-5, 6],
            [-9, -3],
            [-2, -9],
            [6, -7],
            [10, 1],
            [3, 8],
            [-4, 2],
            [-8, -6],
            [1, -10],
        ];
        expect(deriveTurnMarkers(track(wander))).toEqual([]);
    });

    it('cancels alternating ±10° noise on a straight course (signed accumulation)', () => {
        // Course wobbles ±10° about due east — consecutive-leg deltas of
        // 20°, alternating sign. Signed accumulation oscillates 0↔20 and
        // never reaches the 30° threshold; UNSIGNED accumulation would
        // rack up 20° per leg and fire on every second sample.
        const pts: Array<[number, number]> = [[0, 0]];
        let n = 0;
        let e = 0;
        for (let i = 0; i < 20; i++) {
            const bearing = i % 2 === 0 ? 80 : 100; // ±10° about east
            const rad = (bearing * Math.PI) / 180;
            n += 50 * Math.cos(rad);
            e += 50 * Math.sin(rad);
            pts.push([n, e]);
        }
        expect(deriveTurnMarkers(track(pts))).toEqual([]);
    });

    it('excludes manual entries and turn pins from the geometry', () => {
        const east = Array.from({ length: 11 }, (_, i) => [0, i * 50] as [number, number]);
        const pts = track(east);
        // Inject an off-route stored turn pin + manual entry mid-track —
        // they must not create phantom turns.
        const offRoute = offset(400, 250);
        pts.push({
            ...pts[5],
            id: 'pin',
            latitude: offRoute.lat,
            longitude: offRoute.lon,
            entryType: 'waypoint',
            waypointName: 'COG E → N',
        } as ShipLogEntry);
        pts.push({
            ...pts[6],
            id: 'manual',
            latitude: offRoute.lat,
            longitude: offRoute.lon,
            entryType: 'manual',
        } as ShipLogEntry);
        expect(deriveTurnMarkers(pts)).toEqual([]);
    });
});
