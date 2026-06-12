/**
 * FAIRING fixtures — the marker-stepping field bug (2026-06-13,
 * Pinkenba→Newport, ROUTING_COLLAB replies "A 23"/26).
 *
 * Mechanism: each Pass-5 channel_midpoint is a preferred-cost disc in
 * 4× water with EXIT_PENALTY_M stickiness — A*'s cost-optimal path
 * maximises in-disc distance, entering each bead aimed to harvest it
 * and bending on exit: straight legs disc-to-disc, a kink per gate.
 * smoothPath correctly refuses to fair it (the straight chord loses the
 * disc discounts — cost-no-worse). Seamanship-correct THROUGH the
 * gates, never faired BETWEEN them.
 *
 * The fix (the documented carve-out from cost-no-worse): a fairing pass
 * that collapses chords across midpoint-disc sequences ONLY when
 *   (a) every chord cell is navigable, non-caution, non-unvouched;
 *   (b) the chord passes within the GATE HALF-WIDTH of every midpoint
 *       the subpath served (the "may I cut this corner" question);
 *   (c) chord cost ≤ subpath cost × FAIRING_MAX_COST_FACTOR — bounded
 *       give-back, so a marked DOG-LEG around a hazard (cost ratio ≥
 *       ~3× on the gate-shortcut fixture) can never be erased.
 *
 * This fixture is the Pinkenba shape in miniature: a zigzag chain of 8
 * production-shaped midpoints (discs + Step-5 FAIRWY ribbons) whose
 * gates are 400 m wide with ±150 m alternating offsets — wider than
 * the 100 m ribbon half-width, so the helmsman's near-straight fair
 * line leaves the preferred band between beads (the live geometry),
 * yet still passes inside every gate. Pre-fix the route
 * kinks at most beads; post-fix ≤ 1 kink near gates and every gate is
 * still served within its half-width.
 *
 * Exclusive lon-region 166.x.
 */

import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { routeInshore, type RouteRequest } from '../services/inshoreRouterEngine';

// ── Production-shaped synthetic chart (seamanship-suite conventions) ─

function rect(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
    props: Record<string, unknown> = {},
): Feature {
    return {
        type: 'Feature',
        properties: props,
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat],
                ],
            ],
        },
    };
}
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

const AXIS_LAT = -27.2;
const M_LAT = 1 / 110_540;
const M_PER_LON = 111_320 * Math.cos((AXIS_LAT * Math.PI) / 180);

interface LatLon {
    lat: number;
    lon: number;
}

/** The orchestrator's Step-4 midpoint feature, exactly as Pass 5 sees it. */
const midpointFeature = (p: LatLon, pairDistanceM: number): Feature => ({
    type: 'Feature',
    properties: { _class: 'channel_midpoint', _pairDistanceM: pairDistanceM },
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
});

/** The orchestrator's Step-5 synthetic FAIRWY ribbon between chained
 *  midpoints (HALF_WIDTH 100 m, segments ≤ 1.2 km). */
const ribbonSegments = (midpoints: LatLon[]): Feature[] => {
    const out: Feature[] = [];
    const HALF_W = 100;
    for (let i = 0; i < midpoints.length - 1; i++) {
        const a = midpoints[i];
        const b = midpoints[i + 1];
        const dxM = (b.lon - a.lon) * M_PER_LON;
        const dyM = (b.lat - a.lat) / M_LAT;
        const lenM = Math.hypot(dxM, dyM);
        if (lenM < 1 || lenM > 1200) continue;
        const pDLon = ((-dyM / lenM) * HALF_W) / M_PER_LON;
        const pDLat = (dxM / lenM) * HALF_W * M_LAT;
        out.push({
            type: 'Feature',
            properties: { _layer: 'FAIRWY', _class: 'synthetic-channel-segment', _source: 'chain-ordered' },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [a.lon + pDLon, a.lat + pDLat],
                        [a.lon - pDLon, a.lat - pDLat],
                        [b.lon - pDLon, b.lat - pDLat],
                        [b.lon + pDLon, b.lat + pDLat],
                        [a.lon + pDLon, a.lat + pDLat],
                    ],
                ],
            },
        });
    }
    return out;
};

// ── Kink metric (Claude A's stepping definition, locally computed) ──

const headingDeg = (a: [number, number], b: [number, number]): number =>
    (Math.atan2((b[0] - a[0]) * M_PER_LON, (b[1] - a[1]) / M_LAT) * 180) / Math.PI;

function kinksNearGates(polyline: [number, number][], gates: LatLon[], minTurnDeg = 20, nearM = 150): number {
    let count = 0;
    for (let i = 1; i < polyline.length - 1; i++) {
        let turn = headingDeg(polyline[i], polyline[i + 1]) - headingDeg(polyline[i - 1], polyline[i]);
        while (turn > 180) turn -= 360;
        while (turn < -180) turn += 360;
        if (Math.abs(turn) < minTurnDeg) continue;
        const [lon, lat] = polyline[i];
        const near = gates.some((g) => Math.hypot((g.lon - lon) * M_PER_LON, (g.lat - lat) / M_LAT) <= nearM);
        if (near) count++;
    }
    return count;
}

const distToSegmentM = (p: LatLon, a: [number, number], b: [number, number]): number => {
    const ax = (a[0] - p.lon) * M_PER_LON;
    const ay = (a[1] - p.lat) / M_LAT;
    const bx = (b[0] - p.lon) * M_PER_LON;
    const by = (b[1] - p.lat) / M_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    return Math.hypot(ax + dx * t, ay + dy * t);
};

function minDistToPolylineM(p: LatLon, polyline: [number, number][]): number {
    let best = Infinity;
    for (let i = 1; i < polyline.length; i++) {
        const d = distToSegmentM(p, polyline[i - 1], polyline[i]);
        if (d < best) best = d;
    }
    return best;
}

// ── The Pinkenba miniature ──────────────────────────────────────────

const GATE_WIDTH_M = 400;
const MIDPOINTS: LatLon[] = Array.from({ length: 8 }, (_, k) => ({
    lat: AXIS_LAT + (k % 2 === 0 ? 150 : -150) * M_LAT, // zigzag ±150 m — beyond the 100 m ribbon half-width
    lon: 166.13 + (k * 700) / M_PER_LON,
}));

const layers = {
    DEPARE: fc(rect(166.05, -27.28, 166.27, -27.12, { DRVAL1: 12, DRVAL2: 20 })),
    BOYLAT: fc(...MIDPOINTS.map((m) => midpointFeature(m, GATE_WIDTH_M))),
    FAIRWY: fc(...ribbonSegments(MIDPOINTS)),
};
const req: RouteRequest = {
    fromLat: AXIS_LAT,
    fromLon: 166.1,
    toLat: AXIS_LAT,
    toLon: 166.21,
    draftM: 2.0,
    safetyM: 0.5,
    resolutionM: 50,
};

describe('fairing — the marker-stepping fix (lon 166.00–166.30)', () => {
    it('the faired route serves every gate within its half-width with ≤1 kink near gates', () => {
        const r = routeInshore(layers, req);
        expect('polyline' in r).toBe(true);
        if (!('polyline' in r)) return;

        // Seamanship preserved: the route still passes within the gate
        // half-width of EVERY midpoint (it transits the channel, faired
        // or not).
        for (const m of MIDPOINTS) {
            expect(minDistToPolylineM(m, r.polyline)).toBeLessThanOrEqual(GATE_WIDTH_M / 2 + 25);
        }
        // The stepping is gone: at most one ≥20° turn within 150 m of a
        // gate (pre-fix this reads ~one kink per bead).
        expect(kinksNearGates(r.polyline, MIDPOINTS)).toBeLessThanOrEqual(1);
        // And nothing pathological appeared in exchange.
        expect((r.cautionMask ?? []).filter(Boolean)).toHaveLength(0);
        const directNM = (0.11 * M_PER_LON) / 1852;
        expect(r.distanceNM).toBeLessThan(directNM * 1.15);
    });
});
