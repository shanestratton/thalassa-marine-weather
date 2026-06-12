/**
 * Phase 12 fixtures — the SHADOW router (masterplan §3).
 *
 * shadowCompare is pure over (layers, req, direct), so these run the real
 * engine for `direct` and then shadow it — exactly the live wiring minus
 * the log line. Three scenarios:
 *
 *  • ON-AXIS CHANNEL — a numbered 8-gate channel lying along the direct
 *    line in open deep water: the graph route must exist, thread every
 *    gate (compliance 1), ride the channel for a meaningful share of the
 *    route, and stay within the §3 detour cap (1.35) — here ≈1.0 since
 *    the channel IS the direct line.
 *  • NO MARKS — nothing to shadow ⇒ null (the orchestrator logs nothing).
 *  • WALLED-OFF CHANNEL — marks inside a closed LNDARE ring the
 *    connectors cannot enter ⇒ a REASONED report ('no-entry'), never a
 *    silent drop.
 *
 * The full fixture-corpus arbitration (graph vs hardened Stage II
 * baseline over every golden/seamanship fixture — THE promotion gate) is
 * the shared Lanes A+B half of Phase 12 and is flagged in collab reply
 * 21; these pin the shadow mechanics it will drive.
 *
 * Exclusive lon-regions: 163.0x (channel) · 163.5x (walled) · 163.8x
 * (bare) — NavGrid cache keys on bbox + feature counts.
 */

import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';
import { routeInshore, type RouteRequest } from '../services/inshoreRouterEngine';
import { applyInnerPortalYield, shadowCompare, shadowSummary } from '../services/seaway/seawayRouter';
import type { SeawayPortal } from '../services/seaway/connector';

// ── Synthetic chart helpers (seamanship-suite conventions) ──────────

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

function fc(...features: Feature[]): FeatureCollection {
    return { type: 'FeatureCollection', features };
}

/** Numbered lateral pair (port north / stbd south) as BOYLAT features. */
function gateMarks(lon: number, lat: number, halfDeg: number, key: string, gateIdx: number): Feature[] {
    return [
        {
            type: 'Feature',
            properties: { CATLAM: 1, OBJNAM: `${key}${gateIdx * 2 + 1}` },
            geometry: { type: 'Point', coordinates: [lon, lat + halfDeg] },
        },
        {
            type: 'Feature',
            properties: { CATLAM: 2, OBJNAM: `${key}${gateIdx * 2 + 2}` },
            geometry: { type: 'Point', coordinates: [lon, lat - halfDeg] },
        },
    ];
}

const isResult = (
    r: ReturnType<typeof routeInshore>,
): r is Extract<ReturnType<typeof routeInshore>, { polyline: unknown }> => 'polyline' in r;

const AXIS_LAT = -27.2;
const baseReq = (fromLon: number, toLon: number): RouteRequest => ({
    fromLat: AXIS_LAT,
    fromLon,
    toLat: AXIS_LAT,
    toLon,
    draftM: 2.0,
    safetyM: 0.5,
    resolutionM: 50,
});

describe('shadow — on-axis channel: graph route exists, compliant, within the detour cap (lon 163.00–163.30)', () => {
    // 8 gates at ~500 m spacing along the direct line, ~200 m wide, in
    // uniformly deep water.
    const mPerLon = 111_320 * Math.cos((AXIS_LAT * Math.PI) / 180);
    const GATE_LONS = Array.from({ length: 8 }, (_, k) => 163.13 + (k * 500) / mPerLon);
    const layers = {
        DEPARE: fc(rect(163.05, -27.28, 163.25, -27.12, { DRVAL1: 12, DRVAL2: 20 })),
        BOYLAT: fc(...GATE_LONS.flatMap((lon, k) => gateMarks(lon, AXIS_LAT, 0.0009, 'S', k))),
    };
    const req = baseReq(163.11, 163.19);

    it('reports a graph route that threads every gate', () => {
        const direct = routeInshore(layers, req);
        expect(isResult(direct)).toBe(true);
        if (!isResult(direct)) return;

        const report = shadowCompare(layers, req, direct);
        expect(report).not.toBeNull();
        if (!report) return;
        expect(report.gatesTotal).toBe(8);
        expect(report.edgesTotal).toBe(7);
        expect(report.portalCount).toBeGreaterThanOrEqual(2);

        const g = report.graph;
        expect(g).not.toBeNull();
        if (!g) return;
        // §3 promotion-gate metrics, on this fixture's easy geometry.
        // Compliance is MEASURED via cross-lines since Phase 13: all 8
        // spans crossed between the marks, zero wing crossings.
        expect(g.gateCompliance).toBe(1);
        expect(g.crossLineViolations).toBe(0);
        expect(g.detourRatio).toBeLessThanOrEqual(1.35); // the §3 cap
        expect(g.detourRatio).toBeLessThan(1.1); // ...and here the channel IS the direct line
        expect(g.pctOnGraph).toBeGreaterThan(0.3); // ~3.5 km of channel in a ~9 km route
        expect(g.edgesUsed.length).toBeGreaterThanOrEqual(6);
        expect(g.gateCount).toBeGreaterThanOrEqual(7);
        // Polyline is a sane route: starts near origin, ends near dest.
        const [x0, y0] = g.polyline[0];
        const [x1, y1] = g.polyline[g.polyline.length - 1];
        expect(Math.abs(x0 - req.fromLon)).toBeLessThan(0.005);
        expect(Math.abs(y0 - req.fromLat)).toBeLessThan(0.005);
        expect(Math.abs(x1 - req.toLon)).toBeLessThan(0.005);
        expect(Math.abs(y1 - req.toLat)).toBeLessThan(0.005);
        // Telemetry line renders the numbers (this string IS the Phase 12
        // deliverable until arbitration promotes).
        const line = shadowSummary(report, direct.distanceNM);
        expect(line).toContain('on-graph');
        expect(line).toContain('compliance 100%');
    });
});

describe('shadow — the shadow NEVER builds a grid', () => {
    it("a result whose grid is not in cache ⇒ reasoned 'grid-not-cached', no compile, no build", () => {
        // Same corridor as the on-axis fixture, but the RouteResult's bbox
        // is doctored to a key no pass ever built (the review's fine-pass
        // scenario: result.bbox@50m was a guaranteed miss that paid a
        // synchronous build on the main thread and polluted the LRU).
        const mPerLon = 111_320 * Math.cos((AXIS_LAT * Math.PI) / 180);
        const GATE_LONS = Array.from({ length: 8 }, (_, k) => 163.13 + (k * 500) / mPerLon);
        const layers = {
            DEPARE: fc(rect(163.05, -27.28, 163.25, -27.12, { DRVAL1: 12, DRVAL2: 20 })),
            BOYLAT: fc(...GATE_LONS.flatMap((lon, k) => gateMarks(lon, AXIS_LAT, 0.0009, 'S', k))),
        };
        const req = baseReq(163.11, 163.19);
        const direct = routeInshore(layers, req);
        expect(isResult(direct)).toBe(true);
        if (!isResult(direct)) return;

        const doctored = { ...direct, bbox: [1.0, 1.0, 1.2, 1.2] as [number, number, number, number] };
        const report = shadowCompare(layers, req, doctored);
        expect(report).not.toBeNull();
        if (!report) return;
        expect(report.graph).toBeNull();
        expect(report.reason).toBe('grid-not-cached');
        // Returned BEFORE compiling — the only timing recorded is the
        // (read-only) grid lookup.
        expect(report.phaseTimings.compile).toBeUndefined();
        expect(shadowSummary(report, direct.distanceNM)).toContain('grid-not-cached');
    });
});

describe('shadow — corridors without marks or without access', () => {
    it('no lateral marks ⇒ null (nothing to shadow, no grid work paid)', () => {
        const layers = {
            DEPARE: fc(rect(163.78, -27.28, 163.95, -27.12, { DRVAL1: 12, DRVAL2: 20 })),
        };
        const req = baseReq(163.8, 163.88);
        const direct = routeInshore(layers, req);
        expect(isResult(direct)).toBe(true);
        if (!isResult(direct)) return;
        expect(shadowCompare(layers, req, direct)).toBeNull();
    });

    it("a channel walled inside a closed LNDARE ring ⇒ reasoned 'no-entry', never silent", () => {
        const mPerLon = 111_320 * Math.cos((AXIS_LAT * Math.PI) / 180);
        const ringLat = -27.19;
        const gateLons = Array.from({ length: 4 }, (_, k) => 163.535 + (k * 500) / mPerLon);
        const layers = {
            DEPARE: fc(rect(163.45, -27.3, 163.65, -27.1, { DRVAL1: 12, DRVAL2: 20 })),
            // Closed ring around the channel: four wall rectangles.
            LNDARE: fc(
                rect(163.52, -27.175, 163.6, -27.17), // north wall
                rect(163.52, -27.21, 163.6, -27.205), // south wall
                rect(163.52, -27.21, 163.525, -27.17), // west wall
                rect(163.595, -27.21, 163.6, -27.17), // east wall
            ),
            BOYLAT: fc(...gateLons.flatMap((lon, k) => gateMarks(lon, ringLat, 0.0009, 'W', k))),
        };
        // Route passes well south of the ring through open water.
        const req: RouteRequest = { ...baseReq(163.48, 163.62), fromLat: -27.26, toLat: -27.26 };
        const direct = routeInshore(layers, req);
        expect(isResult(direct)).toBe(true);
        if (!isResult(direct)) return;

        const report = shadowCompare(layers, req, direct);
        expect(report).not.toBeNull();
        if (!report) return;
        expect(report.graph).toBeNull();
        expect(report.reason).toBe('no-entry');
        expect(report.gatesTotal).toBe(4);
        expect(shadowSummary(report, direct.distanceNM)).toContain('no-entry');
    });
});

describe('inner-portal yield (§3 Phase 13)', () => {
    const portal = (
        id: string,
        kind: SeawayPortal['kind'],
        channelKeys: string[],
        end?: 'seaward' | 'inner',
    ): SeawayPortal => ({
        id,
        kind,
        lat: -27,
        lon: 163,
        channelKeys,
        end,
        snapped: true,
    });

    it("drops an end:'inner' portal when a junction serves the same channel; seaward and unrelated portals stay", () => {
        const portals = [
            portal('A/portal-seaward', 'portal', ['A'], 'seaward'),
            portal('A/portal-inner', 'portal', ['A'], 'inner'),
            portal('junction:A+B', 'junction', ['A', 'B']),
            portal('C/portal-inner', 'portal', ['C'], 'inner'), // no junction owns C
        ];
        const kept = applyInnerPortalYield(portals).map((p) => p.id);
        expect(kept).toContain('A/portal-seaward');
        expect(kept).toContain('junction:A+B');
        expect(kept).toContain('C/portal-inner');
        expect(kept).not.toContain('A/portal-inner');
    });

    it('no junctions ⇒ nothing yields', () => {
        const portals = [portal('A/portal-inner', 'portal', ['A'], 'inner')];
        expect(applyInnerPortalYield(portals)).toHaveLength(1);
    });
});
