import { describe, expect, it } from 'vitest';
import { spliceNtmBarTransit, type NavGrid } from '../services/inshoreRouterEngine';

const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);
const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number =>
    Math.hypot((b.lon - a.lon) * mPerLon(a.lat), (b.lat - a.lat) * M_PER_LAT);

/** All-navigable-water grid (cells = 10 m, no land) spanning the given points. */
function waterGrid(points: Array<{ lat: number; lon: number }>): NavGrid {
    const minLat = Math.min(...points.map((p) => p.lat)) - 0.01;
    const maxLat = Math.max(...points.map((p) => p.lat)) + 0.01;
    const minLon = Math.min(...points.map((p) => p.lon)) - 0.01;
    const maxLon = Math.max(...points.map((p) => p.lon)) + 0.01;
    const midLat = (minLat + maxLat) / 2;
    const dLat = 50 / M_PER_LAT;
    const dLon = 50 / mPerLon(midLat);
    const width = Math.ceil((maxLon - minLon) / dLon);
    const height = Math.ceil((maxLat - minLat) / dLat);
    return {
        width,
        height,
        minLat,
        minLon,
        dLat,
        dLon,
        cells: new Float32Array(width * height).fill(10),
        preferred: new Uint8Array(width * height),
    };
}

// The real Mooloolah bar promulgated transit (services/ntmRouting.ts pack.trackline):
// entrance-mouth midpoint → REF 2 → REF 1 → 150 m seaward extension.
const MOUTH = { lat: -26.67968, lon: 153.132498 };
const REF2 = { lat: -(26 + 40.7927 / 60), lon: 153 + 7.9164 / 60 };
const REF1 = { lat: -(26 + 40.8675 / 60), lon: 153 + 7.8257 / 60 };
const SEAWARD = { lat: -26.682042, lon: 153.129317 };
const TRACKLINE = [MOUTH, REF2, REF1, SEAWARD];
const barLines = [{ pts: TRACKLINE.map((p) => ({ lat: p.lat, lon: p.lon })) }];

const minDistTo = (poly: [number, number][], p: { lat: number; lon: number }): number =>
    Math.min(...poly.map(([lon, lat]) => distM({ lat, lon }, p)));

describe('NtM promulgated bar transit splice', () => {
    // An OUTBOUND route from Mooloolaba marina that crosses the bar but MISSES
    // the REF marks (the bug Shane hit: "we put the markers there but we are
    // not adhering to them").
    const ORIGIN = { lat: -26.6839, lon: 153.1203 }; // marina berth
    const badRoute: [number, number][] = [
        [ORIGIN.lon, ORIGIN.lat],
        [153.133, -26.677], // crosses the bar NORTH of the REF marks — misses them
        [153.128, -26.7], // offshore, now heading SOUTH toward Newport
        [153.11, -26.95], // continuing south down the coast
    ];
    const canal = badRoute.map(() => false); // per-vertex red
    const channel = badRoute.slice(0, -1).map(() => false); // per-segment yellow
    const offshore = badRoute.map(() => false); // per-vertex offshore

    it('rides the route dead-on through both REF marks', () => {
        // Pre-condition: the input route genuinely misses the marks.
        expect(minDistTo(badRoute, REF1)).toBeGreaterThan(150);
        expect(minDistTo(badRoute, REF2)).toBeGreaterThan(150);

        const grid = waterGrid([ORIGIN, ...TRACKLINE, ...badRoute.map(([lon, lat]) => ({ lat, lon }))]);
        const r = spliceNtmBarTransit(badRoute, canal, channel, offshore, barLines, grid);

        expect(r.spliced).toBe(true);
        // After the splice the route passes dead-on through both REF marks.
        expect(minDistTo(r.polyline, REF1)).toBeLessThan(5);
        expect(minDistTo(r.polyline, REF2)).toBeLessThan(5);
        // …in the correct order (mouth → REF2 → REF1 → seaward), not doubled back.
        const iRef2 = r.polyline.findIndex(([lon, lat]) => distM({ lat, lon }, REF2) < 5);
        const iRef1 = r.polyline.findIndex(([lon, lat]) => distM({ lat, lon }, REF1) < 5);
        expect(iRef2).toBeGreaterThanOrEqual(0);
        expect(iRef1).toBeGreaterThan(iRef2);
    });

    it('marks the bar transit YELLOW and keeps the masks aligned', () => {
        const grid = waterGrid([ORIGIN, ...TRACKLINE, ...badRoute.map(([lon, lat]) => ({ lat, lon }))]);
        const r = spliceNtmBarTransit(badRoute, canal, channel, offshore, barLines, grid);

        expect(r.spliced).toBe(true);
        // Per-vertex masks align to the polyline; per-segment yellow is N-1.
        expect(r.canalMask.length).toBe(r.polyline.length);
        expect(r.offshoreVtx.length).toBe(r.polyline.length);
        expect(r.channelSeg.length).toBe(r.polyline.length - 1);
        // The ridden transit is YELLOW (marked channel) and never red/offshore.
        expect(r.channelSeg.some(Boolean)).toBe(true);
        expect(r.canalMask.some(Boolean)).toBe(false);
    });

    it('is ORIGIN-SCOPED — never touches a route that is nowhere near the bar', () => {
        // A Newport-only route (40 NM south) must be returned byte-for-byte:
        // this is the guard that prevents the 40 NM regression that got the
        // global trackline injection removed on 2026-07-03.
        const newport: [number, number][] = [
            [153.05, -27.2],
            [153.06, -27.18],
            [153.07, -27.16],
        ];
        const grid = waterGrid([...newport.map(([lon, lat]) => ({ lat, lon })), ...TRACKLINE]);
        const r = spliceNtmBarTransit(
            newport,
            newport.map(() => false),
            newport.slice(0, -1).map(() => false),
            newport.map(() => false),
            barLines,
            grid,
        );
        expect(r.spliced).toBe(false);
        expect(r.polyline).toEqual(newport);
    });

    it('no-ops when there is no bar pack in scope', () => {
        const grid = waterGrid(badRoute.map(([lon, lat]) => ({ lat, lon })));
        const r = spliceNtmBarTransit(badRoute, canal, channel, offshore, [], grid);
        expect(r.spliced).toBe(false);
        expect(r.polyline).toEqual(badRoute);
    });
});
