/**
 * Seaway Graph — Masterplan Stage IV, Phase 10 verification.
 *
 * "Newport BC channel renders as an ordered gate sequence with correct
 * buoyageBearingDeg; gateExtractor unit tests pass on the real 15-mark
 * BC fixture" (§3 Phase 10). The BC marks below are the same real
 * Moreton Bay AU SENC channel pinned in tests/fairlead.test.ts.
 *
 * Phase 10 is OVERLAY-ONLY: nothing here touches routeInshore.
 */
import { describe, expect, it } from 'vitest';
import {
    extractChartGates,
    extractGeometricGates,
    dedupGates,
    gateDistM,
    CHART_CONFIDENCE,
    GEOMETRIC_CONFIDENCE,
} from '../services/seaway/gateExtractor';
import { compileSeawayGraph } from '../services/seaway/graphCompiler';
import { validateGraph } from '../services/seaway/graphValidate';

/** Real BC channel laterals as chart features (CATLAM + OBJNAM). */
const bcFeature = (seq: number, side: 1 | 2, lat: number, lon: number) => ({
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { CATLAM: side, OBJNAM: `BC${seq}` },
});
// side: 1 = port (red), 2 = stbd (green) — IALA-A, from the AU SENC.
const BC_FEATURES = [
    bcFeature(1, 2, -27.30965, 153.20804),
    bcFeature(3, 2, -27.31917, 153.20148),
    bcFeature(4, 1, -27.32003, 153.20392),
    bcFeature(5, 2, -27.32867, 153.19485),
    bcFeature(6, 1, -27.32983, 153.19708),
    bcFeature(7, 2, -27.33329, 153.19169),
    bcFeature(8, 1, -27.33455, 153.19378),
    bcFeature(9, 2, -27.34404, 153.18419),
    bcFeature(10, 1, -27.34521, 153.18634),
    bcFeature(11, 2, -27.34922, 153.18061),
    bcFeature(12, 1, -27.3501, 153.18312),
    bcFeature(13, 2, -27.3541, 153.17722),
    bcFeature(15, 2, -27.35696, 153.17521),
    bcFeature(19, 2, -27.36122, 153.1712),
    bcFeature(21, 2, -27.3636, 153.17057),
];

const BC1 = { lat: -27.30965, lon: 153.20804 };
const BC21 = { lat: -27.3636, lon: 153.17057 };

const angleDiff = (a: number, b: number): number => {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
};

describe('gateExtractor — tier 1 chart (real BC channel)', () => {
    const { gates } = extractChartGates(BC_FEATURES);

    it('extracts 5 full gates (sequence-adjacent pairs) + 5 half-gates, one channel', () => {
        expect(gates).toHaveLength(10);
        const full = gates.filter((g) => g.portMark && g.stbdMark);
        const half = gates.filter((g) => !g.portMark || !g.stbdMark);
        expect(full).toHaveLength(5); // (3,4) (5,6) (7,8) (9,10) (11,12)
        expect(half).toHaveLength(5); // stbd 1, 13, 15, 19, 21
        expect(new Set(gates.map((g) => g.channelKey)).size).toBe(1);
        expect(gates.every((g) => g.confidence === CHART_CONFIDENCE)).toBe(true);
    });

    it('orders gates by station, seaward → landward, with sane widths', () => {
        const stations = gates.map((g) => g.station);
        expect(stations).toEqual([...stations].sort((a, b) => a - b));
        expect(stations[0]).toBe(1);
        expect(stations[stations.length - 1]).toBe(21);
        for (const g of gates.filter((q) => q.gateWidthM !== undefined)) {
            expect(g.gateWidthM!).toBeGreaterThan(50); // BC gates measure ~230-260 m
            expect(g.gateWidthM!).toBeLessThan(300);
        }
    });

    it('buoyageBearingDeg tracks the local channel direction (BC runs ~212°)', () => {
        const channelBearing = 212; // BC1 → BC21 overall
        for (const g of gates) {
            expect(
                angleDiff(g.buoyageBearingDeg, channelBearing),
                `gate ${g.id} bearing ${g.buoyageBearingDeg.toFixed(0)}°`,
            ).toBeLessThan(50); // the channel curves; every local bearing stays in the SW quadrant
        }
    });

    it('half-gate midpoints sit ON the corridor centreline, not at the mark', () => {
        // The unpaired greens line the stbd side; their gate point must be
        // pulled into the channel (toward the corridor), not sit on the mark.
        const half = gates.filter((g) => !g.portMark);
        for (const h of half.slice(1, -1)) {
            // interior half-gates only — endpoints clamp to the centreline ends
            const mark = h.stbdMark!;
            expect(gateDistM(h.mid, mark)).toBeGreaterThan(20);
        }
    });
});

describe('graphCompiler — BC channel end-to-end (overlay compile)', () => {
    const { graph, rejected } = compileSeawayGraph({ chartFeatures: BC_FEATURES });

    it('compiles one channel with 10 stations and 9 consecutive edges', () => {
        expect(graph.channels).toHaveLength(1);
        expect(graph.channels[0].gateIds).toHaveLength(10);
        expect(graph.edges).toHaveLength(9);
        expect(rejected).toHaveLength(0);
        // Edges connect CONSECUTIVE stations in order.
        const order = graph.channels[0].gateIds;
        graph.edges.forEach((e, i) => {
            expect(e.fromGateId).toBe(order[i]);
            expect(e.toGateId).toBe(order[i + 1]);
        });
    });

    it('edge polylines pass through the gate midpoints (geometry is the law)', () => {
        const byId = new Map(graph.gates.map((g) => [g.id, g]));
        for (const e of graph.edges) {
            const from = byId.get(e.fromGateId)!;
            const to = byId.get(e.toGateId)!;
            expect(gateDistM(e.polyline[0], from.mid)).toBeLessThan(1);
            expect(gateDistM(e.polyline[e.polyline.length - 1], to.mid)).toBeLessThan(1);
            expect(e.lengthM).toBeGreaterThan(100);
            expect(e.depthSource).toBe('marks-vouched'); // no sampler provided
        }
        // Total graph length ≈ the ~7 km BC channel.
        const total = graph.edges.reduce((s, e) => s + e.lengthM, 0);
        expect(total).toBeGreaterThan(5_500);
        expect(total).toBeLessThan(8_500);
    });

    it('charted depth sampler upgrades edges to depthSource=charted', () => {
        const { graph: g2 } = compileSeawayGraph({
            chartFeatures: BC_FEATURES,
            depthSampler: () => 12, // uniform 12 m DEPARE
        });
        expect(g2.edges.every((e) => e.depthSource === 'charted' && e.controllingDepthM === 12)).toBe(true);
    });
});

describe('graphValidate — land aborts the edge, visibly', () => {
    it('rejects exactly the edge crossing a hard-blocked patch, keeps the rest', () => {
        const { graph } = compileSeawayGraph({ chartFeatures: BC_FEATURES });
        // Block a small patch on the centreline between stations 7 and 9.
        const blockedCentre = { lat: -27.339, lon: 153.188 };
        const { graph: validated, rejected } = validateGraph(graph, (p) => gateDistM(p, blockedCentre) < 120);
        expect(rejected.length).toBeGreaterThanOrEqual(1);
        expect(rejected.every((r) => r.reason === 'crosses-hard-blocked' && r.at)).toBe(true);
        expect(validated.edges.length).toBe(graph.edges.length - rejected.length);
    });
});

describe('gateExtractor — tier 3 geometric (find_entrance_gate port)', () => {
    // Two clean unnumbered gates 200 m wide + a cross-channel decoy pair
    // whose midpoint lands on "land" between channels.
    const mPerLat = 1 / 110_540;
    const g1Lat = -27.4;
    const g2Lat = -27.4 - 700 * mPerLat;
    const marks = [
        { side: 'port' as const, lat: g1Lat, lon: 153.5 },
        { side: 'stbd' as const, lat: g1Lat + 200 * mPerLat, lon: 153.5 },
        { side: 'port' as const, lat: g2Lat, lon: 153.5 },
        { side: 'stbd' as const, lat: g2Lat + 200 * mPerLat, lon: 153.5 },
    ];
    const landBetween = { lat: (g1Lat + g2Lat) / 2, lon: 153.5 };

    it('pairs mutual-best within the width window; midpoint-on-land pairings are rejected', () => {
        const gates = extractGeometricGates(marks, {
            isNavigableWater: (p) => gateDistM(p, landBetween) > 150,
        });
        expect(gates).toHaveLength(2);
        for (const g of gates) {
            expect(g.confidence).toBe(GEOMETRIC_CONFIDENCE);
            expect(g.gateWidthM!).toBeGreaterThan(150);
            expect(g.gateWidthM!).toBeLessThan(250);
        }
    });

    it('sub-floor confidence: geometric gates render but form no edges', () => {
        const { graph } = compileSeawayGraph({
            unnumberedMarks: marks,
            isNavigableWater: (p) => gateDistM(p, landBetween) > 150,
        });
        expect(graph.gates).toHaveLength(2); // on the overlay…
        expect(graph.edges).toHaveLength(0); // …but no uncorroborated edges
    });
});

describe('dedupGates — chart wins geometry within 80 m', () => {
    it('drops the geometric twin of a chart gate', () => {
        const { gates: chartGates } = extractChartGates(BC_FEATURES);
        const full = chartGates.find((g) => g.portMark && g.stbdMark)!;
        const twin = {
            ...full,
            id: 'geo#dup',
            confidence: GEOMETRIC_CONFIDENCE,
            mid: { lat: full.mid.lat + 0.0003, lon: full.mid.lon }, // ~33 m away
        };
        const deduped = dedupGates([...chartGates, twin]);
        expect(deduped).toHaveLength(chartGates.length);
        expect(deduped.find((g) => g.id === 'geo#dup')).toBeUndefined();
    });
});
