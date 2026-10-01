/**
 * leadGraphSearch — routing over the Phase 1 lead graph (Phase 3, 2026-10-01).
 *
 * SHADOW ONLY. InshoreRouter logs one line per local route ('LEAD SHADOW')
 * and changes nothing: promotion is Phase 3b, a one-line change after the
 * corpus table (tests/repro/leadShadow.corpus.local.test.ts) shows zero
 * land, decision-11 and wrong-side regressions with every leg within the
 * 1.35 detour cap.
 *
 * Until now nothing routed over services/routing/leadCompiler's typed,
 * directed lead edges; the engine follows recommended tracks and leading
 * lines only through cost bands and post-hoc splices. This composes
 *
 *   origin ──connector──▶ lead node ══lead edges══▶ … ══▶ lead node ──connector── destination
 *                         (hops of ≤1.8 km between lead networks)
 *
 * on the engine's own cached grid (READ-ONLY; the search never builds one),
 * at the engine's own economics (cellCostMultiplier per 25 m sample).
 *
 *   • Usable edges: recommended tracks and CATNAV-3 leading lines the chart
 *     itself carries (trust 'chart'), of class clear, needs-review or
 *     needs-tide. Never 'blocked' (owner decision 5: the mast cannot pass),
 *     never 'unknown' (unknown depth is not a lead), never 'channel' (gate
 *     chains stay with seawayRouter and its cross-line checks).
 *   • Every usable edge is sampled every 25 m against the grid: a blocked
 *     cell — land, a decision-11 band no tide clears, a mast bar — drops the
 *     edge, and the drop is counted. A needs-tide lead is priced at least at
 *     the caution tier, so the tide never changes preference (decision 10).
 *   • Connectors are the L3 goal-set search (connector.connectToTargets) to
 *     the nearest 64 lead nodes, budgeted at the portal tier ('lead-end'):
 *     a lead is never joined through caution-only water.
 *   • Capture window (masterplan §4): a leading line is entered from a
 *     connector or a hop only when that leg's last ≤1.5 km arrives within
 *     ±25° of the line's bearing. Recommended tracks join at their nodes.
 *   • Hops: straight, ≤1.8 km, between nodes of DIFFERENT networks (the
 *     approach chains, e.g. the Tangalooma dog-leg), rejected on any blocked
 *     cell and priced the same way.
 *   • Dijkstra over {origin, lead nodes, destination}, ties broken by node
 *     id; the engine's own route, priced the same way, is the baseline a
 *     lead route must beat.
 *
 * Pure: no I/O, deterministic for its inputs.
 */
import { cellCostMultiplier, type InshoreLayers, type NavGrid, type TideCeiling } from '../inshoreRouterEngine';
import type { LeadEdge, LeadGraph, LeadNode } from '../routing/leadCompiler';
import { arrivalBearingDeg, connectToTargets, targetFromLeadNode, type ConnectorResult } from './connector';
import { validateAgainstCrossLines } from './crossLine';
import { gateDistM } from './gateExtractor';
import { gridCautionSegMask } from './seawayRouter';
import type { GateNode, SeawayLatLon } from './types';

/** Along-lead sampling step, metres (the Seaway hop sampler's). */
export const LEAD_SAMPLE_M = 25;
/** Longest straight hop between two lead networks (masterplan approach chains). */
export const LEAD_HOP_MAX_M = 1800;
/** Capture window for joining a leading line: ± this many degrees… */
export const LEAD_CAPTURE_DEG = 25;
/** …over the joining leg's last this-many metres. */
export const LEAD_CAPTURE_SPAN_M = 1500;
/** Per-endpoint cap on connector candidates (seawayRouter's). */
const MAX_LEAD_TARGETS = 64;
/** The PER-LEG detour cap a promoted route must keep (InshoreRouter SEAWAY_DETOUR_CAP). */
export const LEAD_DETOUR_CAP = 1.35;
/** The engine's caution tier, read off its own ladder (40× today). */
const CAUTION_TIER = cellCostMultiplier(-1, false);

export interface LeadSearchRoute {
    /** [lon, lat]: connector cells, lead geometry verbatim, connector cells. */
    polyline: [number, number][];
    lengthM: number;
    /** Engine cost-equivalent metres. */
    costM: number;
    edgesUsed: string[];
    networksUsed: string[];
    hops: number;
    /** Fraction of the route's length on lead geometry. */
    leadCoverage: number;
    /** Max over every leg (connectors, each lead edge, each hop) of length / chord. */
    maxLegDetour: number;
    /** Per segment: true on lead geometry. */
    channelSegMask: boolean[];
    /** Per segment: the grid reads land, a blocked cell or sub-keel water. */
    cautionSegMask: boolean[];
}

export type LeadSearchFailReason = 'no-grid' | 'no-usable-leads' | 'no-entry' | 'no-exit' | 'no-lead-path';

export interface LeadSearchReport {
    /** The cheapest route that rides at least one lead, or null (reason). */
    route: LeadSearchRoute | null;
    reason?: LeadSearchFailReason;
    /** The engine route's cost on the same grid and economics. */
    directCostM: number;
    /** True when the engine route costs no more than the lead route. */
    directCheaper: boolean;
    edgesConsidered: number;
    edgesUsable: number;
    /** Usable-class edges dropped for a blocked sample: land, a decision-11
     *  band no tide clears, a mast bar. */
    edgesDropped: number;
    /** Usable-class edges that leave the route's grid (cannot be checked). */
    edgesOffGrid: number;
    /** Connector / hop joins onto a leading line refused by the capture window. */
    captureRejected: number;
    hopsConsidered: number;
    phaseTimings: Record<string, number>;
}

export interface LeadSearchInput {
    grid: NavGrid | null;
    graph: LeadGraph | null;
    origin: SeawayLatLon;
    destination: SeawayLatLon;
    /** The engine's route on this grid. */
    direct: { polyline: readonly (readonly [number, number])[] };
    opts?: { maxHopM?: number; captureDeg?: number; captureSpanM?: number; maxTargets?: number };
}

const USABLE_CLASSES = new Set(['clear', 'needs-review', 'needs-tide']);

const angleDiff = (a: number, b: number): number => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

const cellIdx = (grid: NavGrid, lon: number, lat: number): number => {
    const x = Math.floor((lon - grid.minLon) / grid.dLon);
    const y = Math.floor((lat - grid.minLat) / grid.dLat);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return -1;
    return y * grid.width + x;
};

/**
 * The engine-economics cost of a line on the grid, sampled every 25 m (each
 * step priced at its midpoint's cell), or 'blocked' / 'off-grid' when any
 * sample is (`strict`). Not strict — the engine route's baseline — a blocked
 * cell prices at the engine's own blocked multiplier and off-grid steps are
 * skipped.
 */
function lineCost(
    grid: NavGrid,
    coords: readonly (readonly [number, number])[],
    strict = true,
): number | 'blocked' | 'off-grid' {
    let cost = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
        const a = { lon: coords[i][0], lat: coords[i][1] };
        const b = { lon: coords[i + 1][0], lat: coords[i + 1][1] };
        const len = gateDistM(a, b);
        const n = Math.max(1, Math.ceil(len / LEAD_SAMPLE_M));
        for (let k = 0; k <= n; k++) {
            const t = k / n;
            const idx = cellIdx(grid, a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t);
            if (idx < 0) {
                if (strict) return 'off-grid';
                continue;
            }
            if (Number.isNaN(grid.cells[idx]) && strict) return 'blocked';
            if (k === 0) continue;
            const tm = (k - 0.5) / n;
            const mid = cellIdx(grid, a.lon + (b.lon - a.lon) * tm, a.lat + (b.lat - a.lat) * tm);
            if (mid < 0) {
                if (strict) return 'off-grid';
                continue;
            }
            const depth = grid.cells[mid];
            if (Number.isNaN(depth) && strict) return 'blocked';
            cost += (len / n) * cellCostMultiplier(depth, grid.preferred[mid] === 1);
        }
    }
    return cost;
}

function lineLengthM(coords: readonly (readonly [number, number])[]): number {
    let m = 0;
    for (let i = 1; i < coords.length; i++)
        m += gateDistM({ lon: coords[i - 1][0], lat: coords[i - 1][1] }, { lon: coords[i][0], lat: coords[i][1] });
    return m;
}

const legDetour = (coords: readonly (readonly [number, number])[]): number => {
    if (coords.length < 2) return 0;
    const first = coords[0];
    const last = coords[coords.length - 1];
    const chord = gateDistM({ lon: first[0], lat: first[1] }, { lon: last[0], lat: last[1] });
    const len = lineLengthM(coords);
    return chord > 1 ? len / chord : len > 1 ? Infinity : 0;
};

const straightBearing = (a: LeadNode, b: LeadNode): number => {
    const mPerLon = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    const dx = (b.lon - a.lon) * mPerLon;
    const dy = (b.lat - a.lat) * 110_540;
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
};

/** How a node was reached (for reconstruction). */
type Arrival =
    | { kind: 'origin'; entry: ConnectorResult; edge: LeadEdge }
    | { kind: 'edge'; from: number; edge: LeadEdge }
    | { kind: 'hop'; from: number; hopTo: number; edge: LeadEdge };

export function searchLeadGraph(input: LeadSearchInput): LeadSearchReport {
    const timings: Record<string, number> = {};
    let t = Date.now();
    const mark = (label: string): void => {
        const now = Date.now();
        timings[label] = (timings[label] ?? 0) + (now - t);
        t = now;
    };
    const maxHopM = input.opts?.maxHopM ?? LEAD_HOP_MAX_M;
    const captureDeg = input.opts?.captureDeg ?? LEAD_CAPTURE_DEG;
    const captureSpanM = input.opts?.captureSpanM ?? LEAD_CAPTURE_SPAN_M;
    const maxTargets = input.opts?.maxTargets ?? MAX_LEAD_TARGETS;
    const { grid, graph } = input;
    const empty = (reason: LeadSearchFailReason, extra: Partial<LeadSearchReport> = {}): LeadSearchReport => ({
        route: null,
        reason,
        directCostM: Infinity,
        directCheaper: true,
        edgesConsidered: 0,
        edgesUsable: 0,
        edgesDropped: 0,
        edgesOffGrid: 0,
        captureRejected: 0,
        hopsConsidered: 0,
        phaseTimings: timings,
        ...extra,
    });
    if (!grid) return empty('no-grid');
    const directCost = lineCost(grid, input.direct.polyline, false);
    const directCostM = typeof directCost === 'number' ? directCost : Infinity;

    // ── Usable edges, sampled against the grid ──────────────────────
    const considered = (graph?.edges ?? []).filter((e) => e.kind === 'recommended-track' || e.kind === 'leading-line');
    let edgesDropped = 0;
    let edgesOffGrid = 0;
    const edgeCost = new Map<string, number>();
    const usable: LeadEdge[] = [];
    for (const e of [...considered].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        if (e.trust !== 'chart' || !USABLE_CLASSES.has(e.depth.class)) continue;
        const cost = lineCost(grid, e.coordinates);
        if (cost === 'off-grid') {
            edgesOffGrid++;
            continue;
        }
        if (cost === 'blocked') {
            edgesDropped++;
            continue;
        }
        // Decision 10: the tide never changes preference — a needs-tide lead
        // costs at least the caution tier the grid gives water a tide must lift.
        edgeCost.set(e.id, e.depth.class === 'needs-tide' ? Math.max(cost, e.lengthM * CAUTION_TIER) : cost);
        usable.push(e);
    }
    mark('edges');
    const base = {
        directCostM,
        edgesConsidered: considered.length,
        edgesUsable: usable.length,
        edgesDropped,
        edgesOffGrid,
    };
    if (usable.length === 0) return empty('no-usable-leads', base);

    // ── Nodes (sorted by id: the deterministic tie-break) ───────────
    const nodeById = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    const ids = [...new Set(usable.flatMap((e) => [e.from, e.to]))].filter((id) => nodeById.has(id)).sort();
    const nodes = ids.map((id) => nodeById.get(id)!);
    const indexOf = new Map(ids.map((id, i) => [id, i]));
    const outgoing: LeadEdge[][] = nodes.map(() => []);
    const hasIncoming = new Uint8Array(nodes.length);
    for (const e of usable) {
        const a = indexOf.get(e.from);
        const b = indexOf.get(e.to);
        if (a === undefined || b === undefined) continue;
        outgoing[a].push(e);
        hasIncoming[b] = 1;
    }
    const networkOf = new Map<string, string>();
    for (const e of usable) {
        networkOf.set(e.from, e.networkId);
        networkOf.set(e.to, e.networkId);
    }
    const pos = (n: LeadNode): SeawayLatLon => ({ lat: n.lat, lon: n.lon });

    // ── Connectors (portal-tier budgets: 'lead-end') ────────────────
    const nearest = (anchor: SeawayLatLon, keep: (i: number) => boolean): LeadNode[] =>
        nodes
            .map((n, i) => ({ n, i, d: gateDistM(anchor, pos(n)) }))
            .filter(({ i }) => keep(i))
            .sort((a, b) => a.d - b.d || (a.n.id < b.n.id ? -1 : 1))
            .slice(0, maxTargets)
            .map(({ n }) => n);
    const entryNodes = nearest(input.origin, (i) => outgoing[i].length > 0);
    const exitNodes = nearest(input.destination, (i) => hasIncoming[i] === 1);
    const fromOrigin = connectToTargets(grid, input.origin, entryNodes.map(targetFromLeadNode));
    const fromDest = connectToTargets(grid, input.destination, exitNodes.map(targetFromLeadNode));
    mark('connectors');
    const accepted = (rs: ConnectorResult[]): Map<number, ConnectorResult> => {
        const m = new Map<number, ConnectorResult>();
        for (const r of rs) {
            const i = indexOf.get(r.targetId);
            if (i !== undefined && r.reached && r.withinBudget) m.set(i, r);
        }
        return m;
    };
    const entries = accepted(fromOrigin.results);
    const exits = accepted(fromDest.results);
    if (entries.size === 0) return empty('no-entry', base);
    if (exits.size === 0) return empty('no-exit', base);

    // ── Hops between networks (≤1.8 km, straight, never blocked) ────
    let hopsConsidered = 0;
    const hopsFrom: Array<Array<{ to: number; costM: number; bearingDeg: number }>> = nodes.map(() => []);
    for (let a = 0; a < nodes.length; a++) {
        if (!hasIncoming[a]) continue;
        for (let b = 0; b < nodes.length; b++) {
            if (a === b || outgoing[b].length === 0) continue;
            if (networkOf.get(nodes[a].id) === networkOf.get(nodes[b].id)) continue;
            const d = gateDistM(pos(nodes[a]), pos(nodes[b]));
            if (d > maxHopM || d < 1) continue;
            hopsConsidered++;
            const cost = lineCost(grid, [
                [nodes[a].lon, nodes[a].lat],
                [nodes[b].lon, nodes[b].lat],
            ]);
            if (typeof cost !== 'number') continue;
            hopsFrom[a].push({ to: b, costM: cost, bearingDeg: straightBearing(nodes[a], nodes[b]) });
        }
    }
    mark('hops');

    // ── Dijkstra (O(V²), ties by node id) ───────────────────────────
    let captureRejected = 0;
    const captured = (edge: LeadEdge, arrivingDeg: number | null): boolean => {
        if (edge.kind !== 'leading-line' || arrivingDeg === null) return true;
        if (angleDiff(arrivingDeg, edge.bearingDeg) <= captureDeg) return true;
        captureRejected++;
        return false;
    };
    const N = nodes.length;
    const dist = new Float64Array(N).fill(Infinity);
    const arrival: Array<Arrival | null> = new Array(N).fill(null);
    const done = new Uint8Array(N);
    const relax = (to: number, cost: number, how: Arrival): void => {
        if (cost < dist[to]) {
            dist[to] = cost;
            arrival[to] = how;
        }
    };
    for (const [i, entry] of [...entries].sort((x, y) => x[0] - y[0])) {
        const arriving = arrivalBearingDeg(entry.path, grid, captureSpanM);
        for (const e of outgoing[i]) {
            if (!captured(e, arriving)) continue;
            relax(indexOf.get(e.to)!, entry.costM + edgeCost.get(e.id)!, { kind: 'origin', entry, edge: e });
        }
    }
    let best = Infinity;
    let bestExit = -1;
    for (;;) {
        let u = -1;
        for (let i = 0; i < N; i++) if (!done[i] && dist[i] < Infinity && (u === -1 || dist[i] < dist[u])) u = i;
        if (u === -1 || dist[u] >= best) break;
        done[u] = 1;
        const exit = exits.get(u);
        if (exit && dist[u] + exit.costM < best) {
            best = dist[u] + exit.costM;
            bestExit = u;
        }
        for (const e of outgoing[u])
            relax(indexOf.get(e.to)!, dist[u] + edgeCost.get(e.id)!, { kind: 'edge', from: u, edge: e });
        for (const hop of hopsFrom[u]) {
            for (const e of outgoing[hop.to]) {
                if (!captured(e, hop.bearingDeg)) continue;
                relax(indexOf.get(e.to)!, dist[u] + hop.costM + edgeCost.get(e.id)!, {
                    kind: 'hop',
                    from: u,
                    hopTo: hop.to,
                    edge: e,
                });
            }
        }
    }
    mark('search');
    const report = { ...base, captureRejected, hopsConsidered, phaseTimings: timings };
    if (bestExit < 0) return { route: null, reason: 'no-lead-path', directCheaper: true, ...report };

    // ── Compose ──────────────────────────────────────────────────────
    const cellLonLat = (c: { x: number; y: number }): [number, number] => [
        grid.minLon + (c.x + 0.5) * grid.dLon,
        grid.minLat + (c.y + 0.5) * grid.dLat,
    ];
    const chain: Arrival[] = [];
    for (let cur = bestExit; ; ) {
        const how = arrival[cur]!;
        chain.push(how);
        if (how.kind === 'origin') break;
        cur = how.from;
    }
    chain.reverse();
    const line: [number, number][] = [];
    const segLead: boolean[] = [];
    const push = (pts: readonly (readonly [number, number])[], onLead: boolean): void => {
        for (const p of pts) {
            const last = line[line.length - 1];
            if (!last || gateDistM({ lon: last[0], lat: last[1] }, { lon: p[0], lat: p[1] }) > 1) {
                if (line.length > 0) segLead.push(onLead);
                line.push([p[0], p[1]]);
            }
        }
    };
    const edgesUsed: string[] = [];
    const networks = new Set<string>();
    let leadM = 0;
    let maxLegDetour = 0;
    let hops = 0;
    for (const how of chain) {
        if (how.kind === 'origin') {
            const pts = how.entry.path.map(cellLonLat);
            maxLegDetour = Math.max(maxLegDetour, legDetour(pts));
            push(pts, false);
        } else if (how.kind === 'hop') {
            const a = nodes[how.from];
            const b = nodes[how.hopTo];
            const pts: [number, number][] = [
                [a.lon, a.lat],
                [b.lon, b.lat],
            ];
            maxLegDetour = Math.max(maxLegDetour, legDetour(pts));
            push(pts, false);
            hops++;
        }
        maxLegDetour = Math.max(maxLegDetour, legDetour(how.edge.coordinates));
        push(how.edge.coordinates, true);
        edgesUsed.push(how.edge.id);
        networks.add(how.edge.networkId);
        leadM += how.edge.lengthM;
    }
    const exitPts = [...exits.get(bestExit)!.path.map(cellLonLat)].reverse();
    maxLegDetour = Math.max(maxLegDetour, legDetour(exitPts));
    push(exitPts, false);
    while (segLead.length < line.length - 1) segLead.push(false);
    const lengthM = lineLengthM(line);
    mark('assemble');
    return {
        route: {
            polyline: line,
            lengthM,
            costM: best,
            edgesUsed,
            networksUsed: [...networks].sort(),
            hops,
            leadCoverage: lengthM > 0 ? Math.min(1, leadM / lengthM) : 0,
            maxLegDetour,
            channelSegMask: segLead.slice(0, Math.max(0, line.length - 1)),
            cautionSegMask: gridCautionSegMask(
                grid,
                line.map(([lon, lat]) => ({ lon, lat })),
            ),
        },
        directCheaper: directCostM <= best,
        ...report,
    };
}

/** The engine's promotion checks, handed in so this module stays free of
 *  InshoreRouter (which imports it): seawayPromotionBlockReason and
 *  seawayGraphSafetyFault there. */
export interface LeadPromotionChecks<R> {
    blockReason: (result: R) => string | null;
    safetyFault: (
        polyline: readonly [number, number][],
        layers: InshoreLayers,
        engine: R,
        strict: { grid: NavGrid | undefined } | undefined,
        noTide: { tideCeilings?: readonly TideCeiling[]; needM: number },
    ) => string | null;
}

/**
 * Would Phase 3b promote this lead route? Null = yes; else the reason it
 * declines (pure; NOT acted on in Phase 3). In order: no route; the engine
 * route is cheaper; the engine's own promotion block (canal tier, a
 * needs-tide tail, a pin off the water); no lead ridden; a leg over the
 * 1.35 detour cap; a wrong-side pass of any full gate it crosses; the
 * engine's final safety checks on this geometry (mast bars, water no tide
 * clears, hard land, unvouched water under the strict policy).
 */
export function leadPromotionVerdict<R>(
    report: LeadSearchReport,
    result: R,
    merged: InshoreLayers,
    opts: {
        checks: LeadPromotionChecks<R>;
        needM: number;
        tideCeilings?: readonly TideCeiling[];
        grid?: NavGrid;
        strict?: boolean;
        gates?: readonly GateNode[];
    },
): string | null {
    const route = report.route;
    if (!route) return `no lead route (${report.reason ?? 'unknown'})`;
    if (report.directCheaper) return 'the engine route is cheaper';
    const block = opts.checks.blockReason(result);
    if (block) return block;
    if (!(route.leadCoverage > 0)) return 'rides no lead';
    if (!(route.maxLegDetour <= LEAD_DETOUR_CAP))
        return `a leg detours ${route.maxLegDetour.toFixed(2)}× (cap ${LEAD_DETOUR_CAP})`;
    const full = (opts.gates ?? []).filter((g) => g.portMark && g.stbdMark);
    if (full.length > 0) {
        const cl = validateAgainstCrossLines(
            route.polyline.map(([lon, lat]) => ({ lon, lat })),
            full,
        );
        if (cl.violations.length > 0) return `${cl.violations.length} wrong-side gate pass(es)`;
    }
    const fault = opts.checks.safetyFault(
        route.polyline,
        merged,
        result,
        opts.strict ? { grid: opts.grid } : undefined,
        { tideCeilings: opts.tideCeilings, needM: opts.needM },
    );
    return fault ? `it ${fault}` : null;
}

/** The one telemetry line (InshoreRouter 'LEAD SHADOW'). */
export function leadShadowSummary(report: LeadSearchReport, verdict: string | null): string {
    const r = report.route;
    const head = r
        ? `coverage ${Math.round(r.leadCoverage * 100)}%, ${(r.lengthM / 1852).toFixed(2)} NM, maxLegDetour ${r.maxLegDetour.toFixed(2)}, ${r.edgesUsed.length} edges / ${r.hops} hops`
        : `no lead route (${report.reason})`;
    const counts = `usable ${report.edgesUsable}/${report.edgesConsidered}, dropped ${report.edgesDropped}, off-grid ${report.edgesOffGrid}, capture-rejected ${report.captureRejected}`;
    const timing = Object.entries(report.phaseTimings)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(' ');
    return `${head} — ${verdict === null ? 'would promote' : `declined: ${verdict}`} (${counts}; ${timing})`;
}
