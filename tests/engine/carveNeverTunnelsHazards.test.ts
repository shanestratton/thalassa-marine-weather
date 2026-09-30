/**
 * The rescue carves never tunnel a charted hazard's buffer, and the final
 * geometry is audited against the chart's hazards (round-3 review,
 * 2026-09-30).
 *
 * The endpoint carve (a 60 m forced-navigable bubble at the origin) and the
 * component-bridge carve overwrote hazard-buffer cells; only clearanceBarred
 * was exempt, and nothing audited hazards on the final geometry. Measured by
 * the review with a charted WRECKS point, obstructionBufferM 60, strict, deep
 * S-57 water: an origin 70 m from the wreck (outside its buffer) gave a route
 * 49 m from it, all teal; an origin 50 m away, 35 m.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import { hazardBufferSegments } from '../../services/engine/safetyAudit';

const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const LAT = -26.6;
const LON0 = 154.2;
const mPerLon = 111_320 * Math.cos((LAT * Math.PI) / 180);
const deep: Feature = {
    type: 'Feature',
    properties: { acronym: 'DEPARE', DRVAL1: 12, DRVAL2: 20 },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [LON0 - 0.05, LAT - 0.05],
                [LON0 + 0.08, LAT - 0.05],
                [LON0 + 0.08, LAT + 0.05],
                [LON0 - 0.05, LAT + 0.05],
                [LON0 - 0.05, LAT - 0.05],
            ],
        ],
    },
};
const wreck: Feature = {
    type: 'Feature',
    properties: { acronym: 'WRECKS', rcid: 7 },
    geometry: { type: 'Point', coordinates: [LON0, LAT] },
};
const layers = { DEPARE: fc(deep), WRECKS: fc(wreck) };

/** Closest approach of a polyline to the wreck, metres (local frame). */
function gapM(r: RouteResult): number {
    const ky = 110_540;
    let best = Infinity;
    for (let i = 0; i + 1 < r.polyline.length; i++) {
        const [ax, ay] = r.polyline[i];
        const [bx, by] = r.polyline[i + 1];
        const dx = (bx - ax) * mPerLon;
        const dy = (by - ay) * ky;
        const qx = (LON0 - ax) * mPerLon;
        const qy = (LAT - ay) * ky;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, (qx * dx + qy * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(qx - t * dx, qy - t * dy));
    }
    return best;
}

/** Origin `originOffsetM` west of the wreck; destination 1.5 km east and
 * 1.5 km south — the way out passes the wreck (measured without the carve
 * fix: 53.5 m from it for a 70 m origin, 47 m for a 50 m one). */
const req = (originOffsetM: number): RouteRequest => ({
    fromLat: LAT,
    fromLon: LON0 - originOffsetM / mPerLon,
    toLat: LAT - 1500 / 110_540,
    toLon: LON0 + 1500 / mPerLon,
    draftM: 2.4,
    safetyM: 0.5,
    obstructionBufferM: 60,
    unchartedPolicy: 'strict',
});

describe('the origin carve never re-opens a charted wreck’s buffer', () => {
    it('an origin 70 m from the wreck (outside its 60 m buffer): the route keeps clear of the buffer', () => {
        const r = routeInshore(layers, req(70));
        if ('error' in r) throw new Error(r.error);
        // The buffer blocks every 50 m cell it touches; chords between cell
        // centres may shave a few metres off it, never tens (was 53.5 m).
        expect(gapM(r)).toBeGreaterThan(58);
    });

    it('whatever still passes inside the buffer is flagged caution, never clean water', () => {
        for (const off of [70, 50]) {
            const r = routeInshore(layers, req(off));
            if ('error' in r) throw new Error(r.error);
            const near = hazardBufferSegments(r.polyline, layers, 60, 2.9);
            near.forEach((n, i) => {
                if (n) expect(r.cautionMask?.[i], `origin ${off} m, segment ${i}`).toBe(true);
            });
        }
    });
});

describe('hazardBufferSegments — the final geometry against the chart’s hazards', () => {
    const line: [number, number][] = [
        [LON0 - 0.01, LAT + 40 / 110_540],
        [LON0 + 0.01, LAT + 40 / 110_540],
        [LON0 + 0.02, LAT + 500 / 110_540],
    ];
    it('a segment 40 m from an unknown-depth wreck is inside a 60 m buffer; one 500 m off is not', () => {
        expect(hazardBufferSegments(line, layers, 60, 2.9)).toEqual([true, false]);
        expect(hazardBufferSegments(line, layers, 30, 2.9)).toEqual([false, false]);
    });
    it('a wreck charted deep enough over it, or router furniture with no S-57 identity, is not read', () => {
        const deepWreck = { ...wreck, properties: { acronym: 'WRECKS', VALSOU: 15 } };
        expect(hazardBufferSegments(line, { WRECKS: fc(deepWreck) }, 60, 2.9)).toEqual([false, false]);
        const disc = { ...wreck, properties: { _class: 'direct-hazard' } };
        expect(hazardBufferSegments(line, { OBSTRN: fc(disc) }, 60, 2.9)).toEqual([false, false]);
    });
});
