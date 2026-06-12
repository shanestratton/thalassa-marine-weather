/**
 * connector — Phase 11: connector mode + portals (masterplan §3).
 *
 * Two deliverables, both pure over inputs:
 *
 *  1. `connectToTargets` — ONE multi-target search from an origin cell to
 *     K target cells on the EXISTING engine grid, with the engine's exact
 *     cost function (imported, not copied: cellCostMultiplier +
 *     EXIT_PENALTY_M + the same per-direction metre steps). Implemented
 *     as goal-set A* — Dijkstra reweighted by an admissible potential
 *     h(n) = min over targets of euclidean distance (each per-target
 *     euclid is a lower bound on that target's remaining cost because
 *     every multiplier ≥ 1, so the min is a lower bound for EVERY
 *     target; min of consistent heuristics is consistent) — settled
 *     targets therefore pop with their OPTIMAL cost, identical to an
 *     independent A* run. The parity fixture pins that within 1%.
 *     Termination: all targets settled, or the popped f-score exceeds
 *     every unsettled target's budget (CONNECTOR_BUDGET_FACTOR × its
 *     direct cost — see budgetForTarget). f is monotone under a
 *     consistent heuristic, so nothing cheaper can settle after the
 *     stop; unsettled targets return reached:false rather than flooding
 *     the grid chasing an unreachable portal.
 *
 *  2. `synthesizePortals` — portal nodes one MEDIAN GATE-SPACING outward
 *     of each channel's terminal gates (the low-station end is seaward
 *     by the IALA ascending-from-seaward numbering convention), snapped
 *     to vessel-deep water when a grid is supplied; junction portals
 *     where two channels' gates meet. Connectors attach ONLY at
 *     portal / junction / marina-entrance / gate-midpoint nodes — never
 *     mid-edge (§4); the ConnectorTarget kind union is that rule's
 *     type-level form.
 *
 * Zero routing change: nothing in the live engine calls this yet. The
 * Phase 12 shadow router composes graph edges + these connectors and
 * arbitrates against the legacy engine on the scorecard.
 */

import {
    EXIT_PENALTY_M,
    MinHeap,
    cellCostMultiplier,
    chainCostM,
    type NavGrid,
} from '../inshoreRouterEngine';
import { GATE_DEDUP_M, gateDistM } from './gateExtractor';
import type { GateNode, SeawayGraph, SeawayLatLon } from './types';

// Engine-grid metre conventions (MUST match inshoreRouterEngine — the
// connector prices steps on the engine's grid, in the engine's frame).
const M_PER_DEG_LAT = 111_320;
const mPerDegLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Stop chasing a target once the search frontier costs more than this
 *  factor × the target's direct cost (masterplan: "terminating when all
 *  settled or cost >1.5× direct"). */
export const CONNECTOR_BUDGET_FACTOR = 1.5;
/** Worst REAL-water tier of the engine's cost ladder, read from the
 *  ladder itself so a retune can't desynchronise this module (depth in
 *  (0,5) non-preferred — 6.4× today). Used to budget targets whose
 *  direct line is blocked: "up to a 1.5× geometric detour through the
 *  worst honest water"; anything dearer is caution/uncharted territory a
 *  connector has no business crossing. */
const WORST_REAL_WATER_TIER = cellCostMultiplier(0.1, false);

/** The §4 attachment rule, type-level: connectors never join mid-edge. */
export type ConnectorNodeKind = 'portal' | 'junction' | 'marina-entrance' | 'gate-mid';

export interface ConnectorTarget extends SeawayLatLon {
    id: string;
    kind: ConnectorNodeKind;
}

export interface ConnectorResult {
    targetId: string;
    kind: ConnectorNodeKind;
    /** Settled with an optimal-cost path before termination. */
    reached: boolean;
    /** Engine cost-equivalent metres (A* gScore units). Infinity when
     *  unreached. */
    costM: number;
    /** Geometric path length in metres (no multipliers). 0 when unreached. */
    lengthM: number;
    /** This target's termination budget (CONNECTOR_BUDGET_FACTOR × direct). */
    budgetM: number;
    /** reached AND costM ≤ budgetM — Phase 12's accept filter. */
    withinBudget: boolean;
    /** Grid-cell chain origin→target inclusive; [] when unreached. */
    path: Array<{ x: number; y: number }>;
}

export interface ConnectorSearch {
    results: ConnectorResult[];
    /** Heap pops — the deterministic latency proxy (the parity fixture
     *  asserts pops ≤ 1.3× the largest single-target A* run). */
    popped: number;
}

const cellOf = (grid: NavGrid, p: SeawayLatLon): { x: number; y: number } => ({
    x: Math.floor((p.lon - grid.minLon) / grid.dLon),
    y: Math.floor((p.lat - grid.minLat) / grid.dLat),
});

const inGrid = (grid: NavGrid, x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < grid.width && y < grid.height;

const isNavigableIdx = (grid: NavGrid, idx: number): boolean => !Number.isNaN(grid.cells[idx]);

/**
 * Nearest cell satisfying `accept`, by expanding Chebyshev rings from the
 * ideal cell out to maxRadiusCells; within a ring the metre-nearest wins
 * (deterministic; ties broken by scan order). Null when nothing accepts.
 */
function snapToCell(
    grid: NavGrid,
    ideal: { x: number; y: number },
    maxRadiusCells: number,
    accept: (idx: number) => boolean,
): { x: number; y: number } | null {
    const stepLonM = grid.dLon * mPerDegLon(grid.minLat + (grid.height * grid.dLat) / 2);
    const stepLatM = grid.dLat * M_PER_DEG_LAT;
    for (let r = 0; r <= maxRadiusCells; r++) {
        let best: { x: number; y: number } | null = null;
        let bestD = Infinity;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
                const x = ideal.x + dx;
                const y = ideal.y + dy;
                if (!inGrid(grid, x, y)) continue;
                if (!accept(y * grid.width + x)) continue;
                const d = Math.hypot(dx * stepLonM, dy * stepLatM);
                if (d < bestD) {
                    bestD = d;
                    best = { x, y };
                }
            }
        }
        if (best) return best;
    }
    return null;
}

/**
 * A target's termination budget. When the direct origin→target line is
 * fully navigable its TRUE engine cost (chainCostM over the Bresenham
 * chain) is the "direct" the masterplan caps against. When the line is
 * blocked (the normal case — a wall of land is why a detour exists), the
 * geometric detour is unknowable a priori, so the budget allows a 1.5×
 * geometric detour priced through the worst real-water tier.
 */
function budgetForTarget(
    grid: NavGrid,
    origin: { x: number; y: number },
    target: { x: number; y: number },
    euclidM: number,
): number {
    const chain: Array<{ x: number; y: number }> = [];
    let clear = true;
    for (const c of bresenhamCells(origin.x, origin.y, target.x, target.y)) {
        if (!isNavigableIdx(grid, c.y * grid.width + c.x)) {
            clear = false;
            break;
        }
        chain.push({ x: c.x, y: c.y });
    }
    const directM = clear ? chainCostM(grid, chain) : euclidM * WORST_REAL_WATER_TIER;
    return CONNECTOR_BUDGET_FACTOR * directM;
}

/** Bresenham over grid cells — local copy of the engine's generator (it
 *  is module-private there; the algorithm is the textbook one and the
 *  parity fixture pins agreement end-to-end). */
function* bresenhamCells(x0: number, y0: number, x1: number, y1: number): Generator<{ x: number; y: number }> {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    while (true) {
        yield { x, y };
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) {
            err -= dy;
            x += sx;
        }
        if (e2 < dx) {
            err += dx;
            y += sy;
        }
    }
}

/**
 * ONE search, K connectors. Origin and any target sitting on a blocked
 * cell snap to the nearest navigable cell within `snapRadiusCells`
 * (default 3 — half-cell rasterisation jitter, not a re-route; a portal
 * that needs more than that should have been deep-snapped at synthesis).
 * Results come back in input order.
 */
export function connectToTargets(
    grid: NavGrid,
    origin: SeawayLatLon,
    targets: ConnectorTarget[],
    opts: { snapRadiusCells?: number } = {},
): ConnectorSearch {
    const snapR = opts.snapRadiusCells ?? 3;
    const w = grid.width;
    const h = grid.height;
    const unreached = (t: ConnectorTarget, budgetM = Infinity): ConnectorResult => ({
        targetId: t.id,
        kind: t.kind,
        reached: false,
        costM: Infinity,
        lengthM: 0,
        budgetM,
        withinBudget: false,
        path: [],
    });

    // ── Resolve endpoints to navigable cells ─────────────────────────
    const originIdeal = cellOf(grid, origin);
    const originCell = inGrid(grid, originIdeal.x, originIdeal.y)
        ? snapToCell(grid, originIdeal, snapR, (idx) => isNavigableIdx(grid, idx))
        : null;
    if (!originCell) {
        return { results: targets.map((t) => unreached(t)), popped: 0 };
    }

    const midLat = grid.minLat + (grid.height * grid.dLat) / 2;
    const mPerLonGrid = mPerDegLon(midLat);
    const euclidCellsM = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
        Math.hypot((b.x - a.x) * grid.dLon * mPerLonGrid, (b.y - a.y) * grid.dLat * M_PER_DEG_LAT);

    interface Resolved {
        target: ConnectorTarget;
        cell: { x: number; y: number } | null;
        idx: number; // -1 when unresolvable
        budgetM: number;
        settledCostM: number; // Infinity until settled
    }
    const resolved: Resolved[] = targets.map((t) => {
        const ideal = cellOf(grid, t);
        const cell = inGrid(grid, ideal.x, ideal.y)
            ? snapToCell(grid, ideal, snapR, (idx) => isNavigableIdx(grid, idx))
            : null;
        if (!cell) return { target: t, cell: null, idx: -1, budgetM: Infinity, settledCostM: Infinity };
        const euclidM = euclidCellsM(originCell, cell);
        return {
            target: t,
            cell,
            idx: cell.y * w + cell.x,
            budgetM: budgetForTarget(grid, originCell, cell, euclidM),
            settledCostM: Infinity,
        };
    });

    // Several targets may share a snapped cell — settle them together.
    const byIdx = new Map<number, Resolved[]>();
    for (const r of resolved) {
        if (r.idx < 0) continue;
        const list = byIdx.get(r.idx);
        if (list) list.push(r);
        else byIdx.set(r.idx, [r]);
    }

    // ── Goal-set A* (the engine's expansion, verbatim economics) ─────
    const gScore = new Float64Array(w * h).fill(Infinity);
    const cameFrom = new Int32Array(w * h).fill(-1);
    const startIdx = originCell.y * w + originCell.x;
    gScore[startIdx] = 0;

    const targetCells = [...byIdx.keys()].map((idx) => ({ x: idx % w, y: Math.floor(idx / w) }));
    const heuristic = (x: number, y: number): number => {
        let min = Infinity;
        for (const t of targetCells) {
            const d = euclidCellsM({ x, y }, t);
            if (d < min) min = d;
        }
        return targetCells.length > 0 ? min : 0;
    };

    const NEIGHBORS = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
        { dx: 1, dy: 1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: 1 },
        { dx: -1, dy: -1 },
    ];
    const stepLengthsM = NEIGHBORS.map(({ dx, dy }) =>
        Math.sqrt((dx * grid.dLon * mPerLonGrid) ** 2 + (dy * grid.dLat * M_PER_DEG_LAT) ** 2),
    );

    const open = new MinHeap();
    open.push({ f: heuristic(originCell.x, originCell.y), idx: startIdx });
    const settled = new Set<number>();
    let remaining = byIdx.size;
    let popped = 0;

    const maxUnsettledBudget = (): number => {
        let max = 0;
        for (const [idx, list] of byIdx) {
            if (settled.has(idx)) continue;
            for (const r of list) if (r.budgetM > max) max = r.budgetM;
        }
        return max;
    };
    let stopAtF = maxUnsettledBudget();

    while (open.size > 0 && remaining > 0) {
        const { f, idx } = open.pop()!;
        popped++;
        // f is monotone (consistent heuristic): nothing that can still
        // settle within any unsettled budget remains once f passes it.
        if (f > stopAtF) break;
        if (byIdx.has(idx) && !settled.has(idx)) {
            settled.add(idx);
            remaining--;
            for (const r of byIdx.get(idx)!) r.settledCostM = gScore[idx];
            if (remaining === 0) break;
            stopAtF = maxUnsettledBudget();
        }
        const cx = idx % w;
        const cy = Math.floor(idx / w);
        const curG = gScore[idx];
        const curPreferred = grid.preferred[idx] === 1;
        for (let n = 0; n < NEIGHBORS.length; n++) {
            const { dx, dy } = NEIGHBORS[n];
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            const cellDepth = grid.cells[nIdx];
            if (Number.isNaN(cellDepth)) continue; // blocked
            const cellPreferred = grid.preferred[nIdx] === 1;
            const exitPenalty = curPreferred && !cellPreferred ? EXIT_PENALTY_M : 0;
            const tentativeG = curG + stepLengthsM[n] * cellCostMultiplier(cellDepth, cellPreferred) + exitPenalty;
            if (tentativeG < gScore[nIdx]) {
                cameFrom[nIdx] = idx;
                gScore[nIdx] = tentativeG;
                open.push({ f: tentativeG + heuristic(nx, ny), idx: nIdx });
            }
        }
    }

    // ── Results in input order ───────────────────────────────────────
    const results = resolved.map((r): ConnectorResult => {
        if (r.idx < 0 || !settled.has(r.idx)) return { ...unreached(r.target, r.budgetM) };
        const path: Array<{ x: number; y: number }> = [];
        let cur = r.idx;
        while (cur !== -1) {
            path.push({ x: cur % w, y: Math.floor(cur / w) });
            cur = cameFrom[cur];
        }
        path.reverse();
        let lengthM = 0;
        for (let i = 1; i < path.length; i++) {
            lengthM += euclidCellsM(path[i - 1], path[i]);
        }
        return {
            targetId: r.target.id,
            kind: r.target.kind,
            reached: true,
            costM: r.settledCostM,
            lengthM,
            budgetM: r.budgetM,
            withinBudget: r.settledCostM <= r.budgetM,
            path,
        };
    });

    return { results, popped };
}

// ── Portal synthesis ────────────────────────────────────────────────

export interface SeawayPortal extends SeawayLatLon {
    id: string;
    kind: 'portal' | 'junction';
    /** Channel(s) this portal serves. */
    channelKeys: string[];
    /** Terminal gate this portal extends (terminal portals only). */
    gateId?: string;
    /** True when grid-snapping moved (or confirmed) the point onto
     *  vessel-deep water; false = no grid given, or nothing deep within
     *  one gate-spacing — Phase 12 must not connect to an unsnapped
     *  portal without its own validation. */
    snapped: boolean;
}

// Graph-space metre conventions — match gateExtractor's (110,540 m/° lat)
// so portal offsets agree with gate distances from the same module.
const GRAPH_M_PER_LAT = 110_540;
const graphMPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

const offsetM = (p: SeawayLatLon, dxM: number, dyM: number): SeawayLatLon => ({
    lat: p.lat + dyM / GRAPH_M_PER_LAT,
    lon: p.lon + dxM / graphMPerLon(p.lat),
});

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Vessel-deep predicate for portal snapping: a cell carrying REAL
 *  charted depth that survived the draft filter (depth > 0 — not
 *  UNKNOWN_OPEN, not CAUTION, not blocked). */
const isDeepIdx = (grid: NavGrid, idx: number): boolean => grid.cells[idx] > 0;

/**
 * Terminal + junction portals for a compiled graph (§3 Phase 11).
 *
 *  • Per channel with ≥2 gates: a portal one MEDIAN gate-spacing beyond
 *    each terminal gate's midpoint, directed away from the channel
 *    interior (low-station end = seaward under IALA ascending-from-
 *    seaward numbering; the high-station portal serves departures).
 *    Single-gate channels get no portal — there is no along-channel
 *    direction to extend (they are mostly half-gate strays).
 *  • Junction portals where two channels MEET: gate mids of different
 *    channels within the smaller of the two channels' median spacings —
 *    one portal at the closest such pair's midpoint, deduped at
 *    GATE_DEDUP_M.
 *  • With opts.grid, every portal snaps to the nearest vessel-deep cell
 *    within one gate-spacing (rasterised gates land on banks; a portal
 *    the connector can't stand on is useless); failure to find deep
 *    water leaves the geometric point flagged snapped:false.
 */
export function synthesizePortals(graph: SeawayGraph, opts: { grid?: NavGrid } = {}): SeawayPortal[] {
    const gatesById = new Map<string, GateNode>(graph.gates.map((g) => [g.id, g]));
    const portals: SeawayPortal[] = [];

    interface ChannelGeom {
        key: string;
        gates: GateNode[];
        spacingM: number;
    }
    const channels: ChannelGeom[] = [];
    for (const ch of graph.channels) {
        const gates = ch.gateIds
            .map((id) => gatesById.get(id))
            .filter((g): g is GateNode => g !== undefined)
            .sort((a, b) => a.station - b.station);
        if (gates.length < 2) continue;
        const spacings: number[] = [];
        for (let i = 1; i < gates.length; i++) spacings.push(gateDistM(gates[i - 1].mid, gates[i].mid));
        channels.push({ key: ch.key, gates, spacingM: median(spacings) });
    }

    const snapPortal = (p: SeawayLatLon, spacingM: number): { pos: SeawayLatLon; snapped: boolean } => {
        const grid = opts.grid;
        if (!grid) return { pos: p, snapped: false };
        const ideal = cellOf(grid, p);
        if (!inGrid(grid, ideal.x, ideal.y)) return { pos: p, snapped: false };
        const resM = Math.max(grid.dLat * M_PER_DEG_LAT, grid.dLon * mPerDegLon(p.lat));
        const maxR = Math.max(1, Math.round(spacingM / resM));
        const cell = snapToCell(grid, ideal, maxR, (idx) => isDeepIdx(grid, idx));
        if (!cell) return { pos: p, snapped: false };
        return {
            pos: {
                lat: grid.minLat + (cell.y + 0.5) * grid.dLat,
                lon: grid.minLon + (cell.x + 0.5) * grid.dLon,
            },
            snapped: true,
        };
    };

    // ── Terminal portals ─────────────────────────────────────────────
    for (const ch of channels) {
        const ends: Array<{ gate: GateNode; inner: GateNode; tag: string }> = [
            { gate: ch.gates[0], inner: ch.gates[1], tag: 'seaward' },
            { gate: ch.gates[ch.gates.length - 1], inner: ch.gates[ch.gates.length - 2], tag: 'inner' },
        ];
        for (const { gate, inner, tag } of ends) {
            const mPerLon = graphMPerLon(gate.mid.lat);
            const dxM = (gate.mid.lon - inner.mid.lon) * mPerLon;
            const dyM = (gate.mid.lat - inner.mid.lat) * GRAPH_M_PER_LAT;
            const len = Math.hypot(dxM, dyM);
            if (len < 1) continue; // coincident mids — no direction
            const ideal = offsetM(gate.mid, (dxM / len) * ch.spacingM, (dyM / len) * ch.spacingM);
            const { pos, snapped } = snapPortal(ideal, ch.spacingM);
            portals.push({
                id: `${ch.key}/portal-${tag}`,
                kind: 'portal',
                lat: pos.lat,
                lon: pos.lon,
                channelKeys: [ch.key],
                gateId: gate.id,
                snapped,
            });
        }
    }

    // ── Junction portals ─────────────────────────────────────────────
    // Detected STRUCTURALLY, not by gate-to-gate radius: after the
    // compiler's chart-wins dedup (GATE_DEDUP_M), a channel crossing
    // survives as ONE gate that geometrically belongs to both channels —
    // the other channel keeps a station hole there. So two channels MEET
    // exactly when some gate of one lies ON the other's corridor
    // polyline (its gate-mid chain) within that same dedup radius, and
    // the junction portal sits AT that gate's midpoint. Offset-T meets
    // whose terminal gate stands off the main corridor are out of Phase
    // 11 scope (they need centreline extension — collab reply 18).
    for (let a = 0; a < channels.length; a++) {
        for (let b = a + 1; b < channels.length; b++) {
            let best: { d: number; mid: SeawayLatLon } | null = null;
            const corridorA = channels[a].gates.map((g) => g.mid);
            const corridorB = channels[b].gates.map((g) => g.mid);
            const consider = (g: GateNode, corridor: SeawayLatLon[]): void => {
                const d = distToPolylineM(g.mid, corridor);
                if (d <= GATE_DEDUP_M && (!best || d < best.d)) best = { d, mid: g.mid };
            };
            for (const g of channels[a].gates) consider(g, corridorB);
            for (const g of channels[b].gates) consider(g, corridorA);
            if (!best) continue;
            const meet: SeawayLatLon = (best as { d: number; mid: SeawayLatLon }).mid;
            const dup = portals.some((p) => p.kind === 'junction' && gateDistM(p, meet) < GATE_DEDUP_M);
            if (dup) continue;
            const snapR = Math.min(channels[a].spacingM, channels[b].spacingM);
            const { pos, snapped } = snapPortal(meet, snapR);
            portals.push({
                id: `junction:${channels[a].key}+${channels[b].key}`,
                kind: 'junction',
                lat: pos.lat,
                lon: pos.lon,
                channelKeys: [channels[a].key, channels[b].key],
                snapped,
            });
        }
    }

    return portals;
}

/** Min distance from p to a polyline (graph metre space, point-to-
 *  segment). Single-point lines degrade to point distance. */
function distToPolylineM(p: SeawayLatLon, line: SeawayLatLon[]): number {
    if (line.length === 0) return Infinity;
    const mPerLon = graphMPerLon(p.lat);
    if (line.length === 1) return gateDistM(p, line[0]);
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
        const ax = (line[i].lon - p.lon) * mPerLon;
        const ay = (line[i].lat - p.lat) * GRAPH_M_PER_LAT;
        const bx = (line[i + 1].lon - p.lon) * mPerLon;
        const by = (line[i + 1].lat - p.lat) * GRAPH_M_PER_LAT;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const d = Math.hypot(ax + dx * t, ay + dy * t);
        if (d < best) best = d;
    }
    return best;
}
