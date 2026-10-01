/**
 * The lead-graph search (Phase 3, 2026-10-01; services/seaway/leadGraphSearch).
 * SHADOW ONLY — these pin the search and its promotion verdict; nothing in the
 * live route reads them yet (Phase 3b).
 *
 * Synthetic only (the repo is public): a hand-built 50 m grid and hand-built
 * lead graphs in open water near 161.5E, 31.5S. Lead cells are marked
 * preferred, as the engine's Pass 5b cost bands make a charted lead's water
 * cheaper than the sea beside it.
 */
import { describe, expect, it } from 'vitest';
import { cellCostMultiplier, type NavGrid } from '../../services/inshoreRouterEngine';
import type { LeadDepthClass, LeadEdge, LeadGraph, LeadNode } from '../../services/routing/leadCompiler';
import {
    LEAD_DETOUR_CAP,
    leadPromotionVerdict,
    leadShadowSummary,
    searchLeadGraph,
    type LeadSearchReport,
} from '../../services/seaway/leadGraphSearch';
import { arrivalBearingDeg, targetFromLeadNode } from '../../services/seaway/connector';
import type { GateNode } from '../../services/seaway/types';

const RES_M = 50;
const MIN_LON = 161.5;
const MIN_LAT = -31.5;
const M_PER_DEG_LAT = 111_320;

function makeGrid(width: number, height: number, depth: number): NavGrid {
    const midLat = MIN_LAT + (height * RES_M) / M_PER_DEG_LAT / 2;
    const mPerLon = 111_320 * Math.cos((midLat * Math.PI) / 180);
    return {
        width,
        height,
        minLon: MIN_LON,
        minLat: MIN_LAT,
        dLon: RES_M / mPerLon,
        dLat: RES_M / M_PER_DEG_LAT,
        cells: new Float32Array(width * height).fill(depth),
        preferred: new Uint8Array(width * height),
    };
}
const at = (g: NavGrid, x: number, y: number): { lon: number; lat: number } => ({
    lon: g.minLon + (x + 0.5) * g.dLon,
    lat: g.minLat + (y + 0.5) * g.dLat,
});
const node = (g: NavGrid, id: string, x: number, y: number): LeadNode => ({ id, ...at(g, x, y) });
const metres = (a: LeadNode, b: LeadNode): number => {
    const mPerLon = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    return Math.hypot((b.lon - a.lon) * mPerLon, (b.lat - a.lat) * 110_540);
};
const bearing = (a: LeadNode, b: LeadNode): number => {
    const mPerLon = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    return ((Math.atan2((b.lon - a.lon) * mPerLon, (b.lat - a.lat) * 110_540) * 180) / Math.PI + 360) % 360;
};
function edge(
    id: string,
    kind: LeadEdge['kind'],
    from: LeadNode,
    to: LeadNode,
    cls: LeadDepthClass,
    networkId: string,
): LeadEdge {
    return {
        id,
        spanId: id,
        kind,
        trust: 'chart',
        from: from.id,
        to: to.id,
        coordinates: [
            [from.lon, from.lat],
            [to.lon, to.lat],
        ],
        lengthM: metres(from, to),
        bearingDeg: bearing(from, to),
        oneWay: true,
        networkId,
        sourceIds: [`NAVLNE ZZ-SYN ${id}`],
        rcids: [1],
        sourceLandM: 0,
        depth: { minDepthM: 12, uncoveredM: 0, class: cls, review: [] },
    };
}
function graphOf(nodes: LeadNode[], edges: LeadEdge[]): LeadGraph {
    const networks = [...new Set(edges.map((e) => e.networkId))].map((id) => ({
        id,
        nodeIds: [...new Set(edges.filter((e) => e.networkId === id).flatMap((e) => [e.from, e.to]))],
        spanIds: edges.filter((e) => e.networkId === id).map((e) => e.spanId),
    }));
    return {
        draftM: 2.4,
        ukcM: 0.5,
        draftAssumed: false,
        nodes,
        edges,
        networks,
        spans: [],
        dropped: [],
        clippedLandM: 0,
        compileMs: 0,
    };
}
/** Mark a lead's own cells preferred (the engine's lead cost band). */
function preferAlong(g: NavGrid, a: LeadNode, b: LeadNode): void {
    const steps = Math.ceil(metres(a, b) / 10);
    for (let k = 0; k <= steps; k++) {
        const lon = a.lon + ((b.lon - a.lon) * k) / steps;
        const lat = a.lat + ((b.lat - a.lat) * k) / steps;
        const x = Math.floor((lon - g.minLon) / g.dLon);
        const y = Math.floor((lat - g.minLat) / g.dLat);
        g.preferred[y * g.width + x] = 1;
    }
}
const straight = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) => ({
    polyline: [
        [a.lon, a.lat],
        [b.lon, b.lat],
    ] as [number, number][],
});
const withoutTimings = (r: LeadSearchReport) => ({ ...r, phaseTimings: undefined });

/**
 * A dog-leg of two leading lines in different networks: L1 runs east, a
 * 1 km hop bears ~6° onto L2, which runs north. The sea around is 3 m — real
 * water, but the engine's dearest real-water tier — so the leads pay.
 */
function dogLeg(l2Class: LeadDepthClass = 'clear') {
    const g = makeGrid(200, 180, 3);
    const A = node(g, 'A', 20, 40);
    const B = node(g, 'B', 80, 40);
    const C = node(g, 'C', 82, 60);
    const D = node(g, 'D', 82, 130);
    preferAlong(g, A, B);
    preferAlong(g, C, D);
    const graph = graphOf(
        [A, B, C, D],
        [edge('L1', 'leading-line', A, B, 'clear', 'n1'), edge('L2', 'leading-line', C, D, l2Class, 'n2')],
    );
    return { g, graph, origin: at(g, 5, 40), destination: at(g, 82, 145) };
}

describe('searchLeadGraph', () => {
    it('rides a dog-leg of two leading lines in order, joined by a short hop', () => {
        const { g, graph, origin, destination } = dogLeg();
        const report = searchLeadGraph({ grid: g, graph, origin, destination, direct: straight(origin, destination) });
        expect(report.route, report.reason).not.toBeNull();
        const route = report.route!;
        expect(route.edgesUsed).toEqual(['L1', 'L2']);
        expect(route.hops).toBe(1);
        expect(route.networksUsed).toEqual(['n1', 'n2']);
        expect(route.leadCoverage).toBeGreaterThan(0.5);
        expect(report.directCheaper).toBe(false);
        expect(route.maxLegDetour).toBeLessThanOrEqual(LEAD_DETOUR_CAP);
        expect(route.channelSegMask).toHaveLength(route.polyline.length - 1);
        expect(route.cautionSegMask.every((red) => !red)).toBe(true);
        // The lead geometry is in the line verbatim.
        for (const id of ['A', 'B', 'C', 'D']) {
            const n = graph.nodes.find((x) => x.id === id)!;
            expect(route.polyline.some(([lon, lat]) => lon === n.lon && lat === n.lat)).toBe(true);
        }
    });

    it('refuses an abeam join: the capture window wants the last 1.5 km within ±25° of the line', () => {
        const g = makeGrid(200, 120, 3);
        const A = node(g, 'A', 60, 60);
        const B = node(g, 'B', 140, 60);
        preferAlong(g, A, B);
        const graph = graphOf([A, B], [edge('L', 'leading-line', A, B, 'clear', 'n1')]);
        // From the south-east of A: the connector arrives heading north-west.
        const origin = at(g, 90, 10);
        const destination = at(g, 180, 60);
        const report = searchLeadGraph({ grid: g, graph, origin, destination, direct: straight(origin, destination) });
        expect(report.captureRejected).toBeGreaterThanOrEqual(1);
        expect(report.route).toBeNull();
        expect(report.reason).toBe('no-lead-path');
        // The same lead approached from astern is joined.
        const astern = at(g, 20, 60);
        const ok = searchLeadGraph({
            grid: g,
            graph,
            origin: astern,
            destination,
            direct: straight(astern, destination),
        });
        expect(ok.route?.edgesUsed).toEqual(['L']);
        expect(ok.captureRejected).toBe(0);
    });

    it("never uses a 'blocked' lead (owner decision 5)", () => {
        const { g, graph, origin, destination } = dogLeg('blocked');
        const report = searchLeadGraph({ grid: g, graph, origin, destination, direct: straight(origin, destination) });
        expect(report.edgesUsable).toBe(1);
        expect(report.route?.edgesUsed ?? []).not.toContain('L2');
    });

    it('lets a deep way round beat a needs-tide lead: the tide never changes preference (decision 10)', () => {
        const g = makeGrid(200, 60, 12);
        const A = node(g, 'A', 40, 30);
        const B = node(g, 'B', 160, 30);
        preferAlong(g, A, B);
        const origin = at(g, 10, 30);
        const destination = at(g, 190, 30);
        const direct = straight(origin, destination);
        const control = searchLeadGraph({
            grid: g,
            graph: graphOf([A, B], [edge('L', 'leading-line', A, B, 'clear', 'n1')]),
            origin,
            destination,
            direct,
        });
        expect(control.directCheaper).toBe(false);
        const tide = searchLeadGraph({
            grid: g,
            graph: graphOf([A, B], [edge('L', 'leading-line', A, B, 'needs-tide', 'n1')]),
            origin,
            destination,
            direct,
        });
        // Priced at the caution tier, the needs-tide lead loses to deep water.
        expect(tide.route!.costM).toBeGreaterThanOrEqual(metres(A, B) * cellCostMultiplier(-1, false));
        expect(tide.directCheaper).toBe(true);
    });

    it('drops a lead over water no tide clears (a blocked cell, decision 11), and counts it', () => {
        const { g, graph, origin, destination } = dogLeg();
        // A band across L2 the grid made impassable.
        for (let x = 70; x <= 95; x++) g.cells[100 * g.width + x] = Number.NaN;
        const report = searchLeadGraph({ grid: g, graph, origin, destination, direct: straight(origin, destination) });
        expect(report.edgesDropped).toBeGreaterThanOrEqual(1);
        expect(report.route?.edgesUsed ?? []).not.toContain('L2');
    });

    it('is byte-identical on a repeat', () => {
        const one = dogLeg();
        const two = dogLeg();
        const a = searchLeadGraph({
            grid: one.g,
            graph: one.graph,
            origin: one.origin,
            destination: one.destination,
            direct: straight(one.origin, one.destination),
        });
        const b = searchLeadGraph({
            grid: two.g,
            graph: two.graph,
            origin: two.origin,
            destination: two.destination,
            direct: straight(two.origin, two.destination),
        });
        expect(JSON.stringify(withoutTimings(b))).toBe(JSON.stringify(withoutTimings(a)));
    });

    it('says why when there is nothing to search', () => {
        const { g, graph, origin, destination } = dogLeg();
        expect(
            searchLeadGraph({ grid: null, graph, origin, destination, direct: straight(origin, destination) }).reason,
        ).toBe('no-grid');
        const none = graphOf([], []);
        expect(
            searchLeadGraph({ grid: g, graph: none, origin, destination, direct: straight(origin, destination) })
                .reason,
        ).toBe('no-usable-leads');
    });
});

describe('connector additions', () => {
    it("joins a lead node as a 'lead-end' target", () => {
        expect(targetFromLeadNode({ id: 'n', lat: -31.4, lon: 161.6 })).toEqual({
            id: 'n',
            kind: 'lead-end',
            lat: -31.4,
            lon: 161.6,
        });
    });

    it('reads the bearing of the last ≤1.5 km of a connector path', () => {
        const g = makeGrid(100, 100, 12);
        const path = [
            ...Array.from({ length: 40 }, (_, i) => ({ x: 10, y: 10 + i })), // 2 km north…
            ...Array.from({ length: 20 }, (_, i) => ({ x: 11 + i, y: 49 })), // …then 1 km east
        ];
        expect(arrivalBearingDeg(path, g, 900)).toBeCloseTo(90, 0);
        const whole = arrivalBearingDeg(path, g, 10_000)!;
        expect(whole).toBeGreaterThan(0);
        expect(whole).toBeLessThan(90);
        expect(arrivalBearingDeg([{ x: 1, y: 1 }], g)).toBeNull();
    });
});

describe('leadPromotionVerdict', () => {
    const { g, graph, origin, destination } = dogLeg();
    const report = searchLeadGraph({ grid: g, graph, origin, destination, direct: straight(origin, destination) });
    const engine = { polyline: straight(origin, destination).polyline };
    const checks: {
        blockReason: (r: unknown) => string | null;
        safetyFault: (...args: unknown[]) => string | null;
    } = { blockReason: () => null, safetyFault: () => null };
    const verdict = (r: LeadSearchReport, c: typeof checks = checks, gates: GateNode[] = []) =>
        leadPromotionVerdict(r, engine, {} as never, { checks: c, needM: 2.9, gates });

    it('would promote a clean, cheaper lead route', () => {
        expect(verdict(report)).toBeNull();
        expect(leadShadowSummary(report, null)).toMatch(/^coverage \d+%, .* — would promote/);
    });

    it('declines in plain reasons', () => {
        expect(verdict({ ...report, route: null, reason: 'no-entry' })).toBe('no lead route (no-entry)');
        expect(verdict({ ...report, directCheaper: true })).toBe('the engine route is cheaper');
        expect(verdict(report, { ...checks, blockReason: () => 'tier-1 canal/marina mask present' })).toBe(
            'tier-1 canal/marina mask present',
        );
        expect(verdict({ ...report, route: { ...report.route!, leadCoverage: 0 } })).toBe('rides no lead');
        expect(verdict({ ...report, route: { ...report.route!, maxLegDetour: 1.5 } })).toBe(
            'a leg detours 1.50× (cap 1.35)',
        );
        expect(verdict(report, { ...checks, safetyFault: () => 'passes under a BRIDGE this mast cannot clear' })).toBe(
            'it passes under a BRIDGE this mast cannot clear',
        );
        expect(leadShadowSummary(report, 'the engine route is cheaper')).toMatch(
            /— declined: the engine route is cheaper/,
        );
    });

    it('declines a wrong-side pass of a full gate the route crosses', () => {
        // Both marks north of L1, the starboard one 50 m off it: L1 crosses
        // the gate's line beyond its starboard mark, inside the wing.
        const p = at(g, 50, 44);
        const s = at(g, 50, 41);
        const gate: GateNode = {
            id: 'G1',
            channelKey: 'SYN',
            station: 1,
            portMark: { ...p, side: 'port', source: 'chart' },
            stbdMark: { ...s, side: 'stbd', source: 'chart' },
            mid: { lat: (p.lat + s.lat) / 2, lon: p.lon },
            buoyageBearingDeg: 90,
            confidence: 0.95,
        };
        expect(verdict(report, checks, [gate])).toMatch(/wrong-side gate pass/);
    });
});
