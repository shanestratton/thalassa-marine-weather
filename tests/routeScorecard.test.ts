/**
 * Unit tests for the route-quality scorecard (Phase 1) — the instrument
 * itself must be trustworthy before any engine phase is judged by it.
 *
 * Geometry is built near lat 0 where 0.001° lon ≈ 111.32 m and
 * 0.001° lat ≈ 110.54 m, keeping hand-computed expectations honest.
 */

import { describe, expect, it } from 'vitest';
import {
    auditGates,
    auditStepping,
    channelDisciplinePct,
    xtePercentiles,
    turnCount,
    cautionRunLengthsM,
    distanceRatio,
    polylineLengthM,
    type Gate,
    type Polyline,
} from './helpers/routeScorecard';

// A north-running channel at lon 0: gates are east-west pairs the route
// should thread. Port mark west, starboard mark east (heading north).
const gateAt = (lat: number, halfWidthDegLon = 0.001): Gate => ({
    port: { lat, lon: -halfWidthDegLon },
    stbd: { lat, lon: +halfWidthDegLon },
});

describe('auditGates — the wrongSidePasses headline metric', () => {
    it('a route threading every gate scores all-passed, zero wrong-side', () => {
        const gates = [gateAt(0.01), gateAt(0.02), gateAt(0.03)];
        const route: Polyline = [
            [0, 0],
            [0, 0.04], // straight up the middle, through all three
        ];
        const a = auditGates(route, gates);
        expect(a).toEqual({ gatesTotal: 3, gatesPassed: 3, gatesMissed: 0, wrongSidePasses: 0 });
    });

    it('a route passing OUTSIDE the starboard mark scores a wrongSidePass', () => {
        const gates = [gateAt(0.01)];
        // Route swings out to lon 0.0015 — outside the stbd mark at 0.001,
        // crossing its outboard wing (wing length covers ~150 m ≈ 0.00135°).
        const route: Polyline = [
            [0.0015, 0],
            [0.0015, 0.02],
        ];
        const a = auditGates(route, gates);
        expect(a.wrongSidePasses).toBe(1);
        expect(a.gatesPassed).toBe(0);
    });

    it('a route far outside the wings misses the gate entirely', () => {
        const gates = [gateAt(0.01)];
        // lon 0.01 ≈ 1113 m off-axis — beyond the 150 m wing reach.
        const route: Polyline = [
            [0.01, 0],
            [0.01, 0.02],
        ];
        const a = auditGates(route, gates);
        expect(a).toMatchObject({ gatesMissed: 1, gatesPassed: 0, wrongSidePasses: 0 });
    });

    it('clipping a mark exactly counts as wrong-side (conservative)', () => {
        const gates = [gateAt(0.01)];
        const route: Polyline = [
            [0.001, 0], // passes exactly over the stbd mark
            [0.001, 0.02],
        ];
        const a = auditGates(route, gates);
        expect(a.wrongSidePasses).toBe(1);
    });

    it('empty gate list is a clean zero audit', () => {
        const a = auditGates(
            [
                [0, 0],
                [0, 1],
            ],
            [],
        );
        expect(a).toEqual({ gatesTotal: 0, gatesPassed: 0, gatesMissed: 0, wrongSidePasses: 0 });
    });
});

describe('channelDisciplinePct + xtePercentiles', () => {
    const centreline = [
        { lat: 0, lon: 0 },
        { lat: 0.05, lon: 0 },
    ];

    it('a route ON the centreline scores 100% discipline, ~0 XTE', () => {
        const route: Polyline = [
            [0, 0],
            [0, 0.05],
        ];
        expect(channelDisciplinePct(route, centreline)).toBe(100);
        const x = xtePercentiles(route, centreline);
        expect(x.p50M).toBeLessThan(1);
        expect(x.p95M).toBeLessThan(1);
    });

    it('a route 200 m off a 100 m corridor scores 0% discipline, ~200 m XTE', () => {
        // lon 0.0018 ≈ 200 m at lat 0
        const route: Polyline = [
            [0.0018, 0],
            [0.0018, 0.05],
        ];
        expect(channelDisciplinePct(route, centreline, { halfWidthM: 100 })).toBe(0);
        const x = xtePercentiles(route, centreline);
        expect(x.p50M).toBeGreaterThan(190);
        expect(x.p50M).toBeLessThan(210);
    });

    it('a route half-in half-out scores ~50%', () => {
        // First half on the centreline, second half 300 m east.
        const route: Polyline = [
            [0, 0],
            [0, 0.025],
            [0.0027, 0.0251], // sharp jog out
            [0.0027, 0.05],
        ];
        const pct = channelDisciplinePct(route, centreline, { halfWidthM: 100 });
        expect(pct).toBeGreaterThan(35);
        expect(pct).toBeLessThan(65);
    });
});

describe('shape metrics', () => {
    it('turnCount counts only deltas above the threshold', () => {
        // 90° turn then straight then gentle 10° wiggle.
        const route: Polyline = [
            [0, 0],
            [0, 0.01], // north
            [0.01, 0.01], // hard east turn (90°)
            [0.02, 0.0117], // ~10° lift — below the 25° default
        ];
        expect(turnCount(route)).toBe(1);
    });

    it('cautionRunLengthsM groups consecutive flagged segments', () => {
        // Four segments of ~1105 m each (0.01° lat); mask: T T F T
        const route: Polyline = [
            [0, 0],
            [0, 0.01],
            [0, 0.02],
            [0, 0.03],
            [0, 0.04],
        ];
        const runs = cautionRunLengthsM(route, [true, true, false, true]);
        expect(runs.length).toBe(2);
        expect(runs[0]).toBeGreaterThan(2150);
        expect(runs[0]).toBeLessThan(2300);
        expect(runs[1]).toBeGreaterThan(1050);
        expect(runs[1]).toBeLessThan(1160);
    });

    it('distanceRatio is 1.0 for a straight line and >1 for a dog-leg', () => {
        const from = { lat: 0, lon: 0 };
        const to = { lat: 0, lon: 0.02 };
        const straight: Polyline = [
            [0, 0],
            [0.02, 0],
        ];
        expect(distanceRatio(straight, from, to)).toBeCloseTo(1.0, 2);
        const dogleg: Polyline = [
            [0, 0],
            [0.01, 0.01],
            [0.02, 0],
        ];
        expect(distanceRatio(dogleg, from, to)).toBeGreaterThan(1.3);
    });

    it('polylineLengthM matches haversine on a known leg', () => {
        // 0.01° of latitude ≈ 1105.7 m
        const len = polylineLengthM([
            [0, 0],
            [0, 0.01],
        ]);
        expect(len).toBeGreaterThan(1100);
        expect(len).toBeLessThan(1115);
    });
});

describe('auditStepping — the marker-stepping signature (collab replies 23/26)', () => {
    // Gates every ~500 m along an east-west channel at lat 0.
    const gates: Gate[] = [0.005, 0.01, 0.015].map((lon) => ({
        port: { lat: 0.0009, lon },
        stbd: { lat: -0.0009, lon },
    }));

    it('a fair straight transit has zero kinks', () => {
        const straight: Polyline = [
            [0, 0],
            [0.005, 0],
            [0.01, 0],
            [0.015, 0],
            [0.02, 0],
        ];
        const a = auditStepping(straight, gates);
        expect(a.kinkCount).toBe(0);
        expect(a.kinksNearGate).toBe(0);
        expect(a.alternationPairs).toBe(0);
    });

    it('bead-to-bead stair-stepping reads as alternating kinks AT the gates', () => {
        // Path doglegs ~40 m off-axis between gates and bends at each
        // midpoint — the Pass-5 disc signature from the field repro.
        const step: Polyline = [
            [0, 0.0013],
            [0.005, 0], // kink at gate 1 midpoint (~55° turn)
            [0.0075, 0.0013],
            [0.01, 0], // kink at gate 2 midpoint
            [0.0125, 0.0013],
            [0.015, 0], // kink at gate 3 midpoint
            [0.02, 0.0013],
        ];
        const a = auditStepping(step, gates);
        expect(a.kinkCount).toBeGreaterThanOrEqual(3);
        expect(a.kinksNearGate).toBeGreaterThanOrEqual(3);
        expect(a.alternationPairs).toBeGreaterThanOrEqual(2);
    });

    it('a double-back registers as a ~180-degree max kink', () => {
        const back: Polyline = [
            [0, 0],
            [0.01, 0],
            [0.005, 0.00001],
            [0.015, 0.0001],
        ];
        const a = auditStepping(back, []);
        expect(a.maxKinkDeg).toBeGreaterThan(170);
    });

    it('threshold and proximity are tunable', () => {
        const gentle: Polyline = [
            [0, 0],
            [0.005, 0.0008], // ~18° turn at the apex — under the default 20°
            [0.01, 0],
        ];
        expect(auditStepping(gentle, gates).kinkCount).toBe(0);
        expect(auditStepping(gentle, gates, { thresholdDeg: 8 }).kinkCount).toBeGreaterThan(0);
    });
});
