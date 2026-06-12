/**
 * seawayRouter — Phase 12: the SHADOW router (masterplan §3).
 *
 * Runs alongside the live engine on every successful local route and
 * answers one question with numbers: would the Seaway Graph have routed
 * this passage better? It composes
 *
 *   origin ──connector──▶ entry node ──channel edges──▶ exit node
 *          ◀──connector── destination
 *
 * over the SAME cached NavGrid the live route just used — READ-ONLY
 * lookup (getCachedNavGrid) with the RouteResult's own bbox + params,
 * INCLUDING the relax-zone/relaxedLndare params the accepted pass was
 * built with (RouteDebug carries them; looking up the strict grid for a
 * relax-zone route made canal-estate berth starts read as phantom
 * 'no-entry' — adversarial review, 2026-06-12). The shadow NEVER builds
 * a grid: a cache miss (e.g. a fine-pass result, whose fine bbox at
 * 50 m is a key no live path builds) returns a reasoned
 * 'grid-not-cached' report instead of paying a synchronous build on the
 * main thread and polluting the 5-slot LRU. It reports gate-compliance,
 * % length on graph edges, detour ratio and per-phase timings. THE USER
 * STILL GETS THE ENGINE ROUTE — this module returns telemetry, nothing
 * else consumes it yet. Promotion (§3 Phase 12 verify): over the
 * fixture corpus, graph routes must beat the hardened Stage II baseline
 * on gate-compliance with detour ratio ≤ 1.35 and zero land/caution
 * regressions — if the graph can't beat wings+exit-penalty, Stage IV
 * pauses and the owner gets the data.
 *
 * Honesty measures (review-driven):
 *  - the graph compiles WITH land validation (isHardBlocked from the
 *    grid) — a centreline that clips land between two gates drops that
 *    edge, visible in edgesTotal, instead of feeding arbitration a
 *    land-crossing "good" route;
 *  - portal/junction hop links are 25 m-sampled against the grid and
 *    dropped if blocked; portals flagged snapped:false are never
 *    targeted (the Phase 11 contract);
 *  - gateCompliance is MEASURED (crossLine.ts): span crossings vs
 *    wing crossings of the traversed channels' full gates, with
 *    crossLineViolations as the §3 wrong-side headline (target 0);
 *    channelGatesTotal gives arbitration the skipped-gates context (a
 *    mid-channel entry crosses fewer gates than the channel has);
 *  - inner terminal portals YIELD to a junction serving the same
 *    channel (applyInnerPortalYield) — an inner portal can deep-snap
 *    inside a basin the junction properly owns;
 *
 * v1 simplifications, all deliberate and visible:
 *  - channel edges are bidirectional (directed transit edges are Phase
 *    14; §4's one-way kind doesn't exist in the Phase 10 graph);
 *  - edge cost = lengthM × 1.0 (a marked channel is preferred-tier
 *    water by definition — §4; tide/stream time-costs are Phase 15);
 *  - entry/exit nodes = portals + gate mids of ANY confidence (the
 *    compiler already refuses sub-0.6 EDGES; Phase 13 adds cross-line
 *    side-validation before anything is promoted);
 *  - connector candidate sets are capped at the 64 nearest nodes per
 *    endpoint (the goal-set heuristic costs O(K) per expansion — a
 *    region-wide mark soup must not turn telemetry into a stall).
 */

import {
    getCachedNavGrid,
    type InshoreLayers,
    type NavGrid,
    type RouteRequest,
    type RouteResult,
} from '../inshoreRouterEngine';
import {
    connectToTargets,
    synthesizePortals,
    targetFromGate,
    targetFromPortal,
    type ConnectorResult,
    type ConnectorTarget,
    type SeawayPortal,
} from './connector';
import { flattenLandVertices, halfGateKeepOuts, validateAgainstCrossLines, validateAgainstKeepOuts } from './crossLine';
import { splitMarkFeatures, type PointFeatureLike } from './markSplit';
import { compileSeawayGraph } from './graphCompiler';
import { gateDistM } from './gateExtractor';
import type { GateNode, SeawayEdge, SeawayLatLon } from './types';

export interface SeawayShadowRoute {
    /** [lon, lat] — RouteResult convention. */
    polyline: [number, number][];
    lengthM: number;
    /** Engine cost-equivalent metres: connector costs (full engine
     *  economics) + graph edges at the preferred 1.0× tier. */
    costM: number;
    edgesUsed: string[];
    /** Gate nodes traversed (entry/exit/junction hops included). */
    gateCount: number;
    /** Full-gate count across the CHANNELS this route traversed — the
     *  denominator context for gateCount (a mid-channel entry legally
     *  crosses fewer gates than the channel has; arbitration needs to
     *  see that, not just a path-relative 100%). */
    channelGatesTotal: number;
    /** MEASURED side-correctness (crossLine.ts, Phase 13): of the full
     *  gates the route interacted with (span crossed or wing crossed),
     *  the fraction whose every interaction was a between-the-marks
     *  crossing. Null when the route interacted with no full gate. */
    gateCompliance: number | null;
    /** Wing crossings — wrong-side passes within ±1 gate-width of a
     *  mark. THE §3 promotion headline; target 0. The Phase 13 router
     *  re-solves these via connectToTargets' blockedIdx; the shadow
     *  reports them honestly instead. */
    crossLineViolations: number;
    /** Fraction of route length on channel-edge geometry. */
    pctOnGraph: number;
    /** lengthM / direct route's geometric length. */
    detourRatio: number;
    entryNodeId: string;
    exitNodeId: string;
}

export type ShadowFailReason = 'grid-not-cached' | 'no-graph-gates' | 'no-entry' | 'no-exit' | 'no-graph-path';

export interface SeawayShadowReport {
    graph: SeawayShadowRoute | null;
    reason?: ShadowFailReason;
    gatesTotal: number;
    edgesTotal: number;
    portalCount: number;
    phaseTimings: Record<string, number>;
}

// ── Geometry helpers ────────────────────────────────────────────────

/** Per-endpoint cap on connector candidates (the goal-set heuristic
 *  costs O(K) per expansion — see header). */
const MAX_CONNECTOR_TARGETS = 64;

/** Straight hop polyline sampled every ~25 m against hard-blocked cells.
 *  Portal/junction links are synthesized geometry, not charted corridor —
 *  a hop across a spit must be dropped, not sailed. */
function hopClear(grid: NavGrid, a: SeawayLatLon, b: SeawayLatLon): boolean {
    const lenM = gateDistM(a, b);
    const steps = Math.max(1, Math.ceil(lenM / 25));
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const lat = a.lat + (b.lat - a.lat) * t;
        const lon = a.lon + (b.lon - a.lon) * t;
        const x = Math.floor((lon - grid.minLon) / grid.dLon);
        const y = Math.floor((lat - grid.minLat) / grid.dLat);
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
        if (Number.isNaN(grid.cells[y * grid.width + x])) return false;
    }
    return true;
}

function polylineLengthM(line: SeawayLatLon[]): number {
    let len = 0;
    for (let i = 1; i < line.length; i++) len += gateDistM(line[i - 1], line[i]);
    return len;
}

/**
 * §3 inner-portal yield: an end:'inner' terminal portal can legitimately
 * deep-snap INSIDE a basin that a junction (or, when Phase 14 lands,
 * marina-entrance) node properly owns — when such a node serves the same
 * channel, the inner portal yields. Gate-mids stay candidates, so no
 * route is stranded by yielding. Exported pure for its fixture.
 */
export function applyInnerPortalYield(portals: SeawayPortal[]): SeawayPortal[] {
    const ownedChannels = new Set<string>();
    for (const p of portals) {
        if (p.kind === 'junction') for (const k of p.channelKeys) ownedChannels.add(k);
    }
    return portals.filter(
        (p) => !(p.kind === 'portal' && p.end === 'inner' && p.channelKeys.some((k) => ownedChannels.has(k))),
    );
}

// ── Graph search scaffolding ────────────────────────────────────────

interface GraphNode {
    id: string;
    pos: SeawayLatLon;
    isGate: boolean;
}

interface GraphLink {
    to: number;
    weightM: number;
    /** Oriented from→to. Channel edges carry their compiled geometry;
     *  portal/junction links are straight 2-point hops. */
    polyline: SeawayLatLon[];
    edgeId?: string; // set for channel edges only (the on-graph metric)
}

/**
 * Shadow-compare the live engine result against a Seaway Graph route.
 * Returns null when the corridor has no lateral marks at all (nothing to
 * shadow); otherwise always returns a report — a missing graph route is
 * a reasoned fact, never a silent drop.
 */
export function shadowCompare(
    layers: InshoreLayers,
    req: RouteRequest,
    direct: RouteResult,
): SeawayShadowReport | null {
    const timings: Record<string, number> = {};
    let t = Date.now();
    const mark = (label: string): void => {
        const now = Date.now();
        timings[label] = now - t;
        t = now;
    };

    // ── Nothing to shadow without lateral marks ──────────────────────
    const markFeatures = [...(layers.BOYLAT?.features ?? []), ...(layers.BCNLAT?.features ?? [])] as PointFeatureLike[];
    const { chartFeatures, unnumberedMarks } = splitMarkFeatures(markFeatures);
    if (chartFeatures.length + unnumberedMarks.length === 0) return null;

    // ── Grid: READ-ONLY lookup of the live route's own grid ──────────
    // Same bbox/params INCLUDING the relax params the accepted pass was
    // built with (RouteDebug carries them). Miss ⇒ reasoned report —
    // the shadow never builds.
    const grid = getCachedNavGrid(
        layers,
        direct.bbox,
        req.resolutionM ?? 50,
        req.draftM,
        req.safetyM ?? 1.0,
        req.obstructionBufferM ?? 30,
        direct.debug?.relaxedLndare ?? false,
        direct.debug?.relaxZones ?? [],
    );
    mark('grid');
    if (!grid) {
        return {
            graph: null,
            reason: 'grid-not-cached',
            gatesTotal: 0,
            edgesTotal: 0,
            portalCount: 0,
            phaseTimings: timings,
        };
    }

    // ── Compile WITH land validation (a centreline clipping land
    // between two gates drops that edge — visible in edgesTotal, never
    // fed to arbitration as a good route) ─────────────────────────────
    const isHardBlocked = (p: SeawayLatLon): boolean => {
        const x = Math.floor((p.lon - grid.minLon) / grid.dLon);
        const y = Math.floor((p.lat - grid.minLat) / grid.dLat);
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false; // can't validate ≠ blocked
        return Number.isNaN(grid.cells[y * grid.width + x]);
    };
    const { graph } = compileSeawayGraph({ chartFeatures, unnumberedMarks, isHardBlocked });
    mark('compile');
    const base = {
        gatesTotal: graph.gates.length,
        edgesTotal: graph.edges.length,
        phaseTimings: timings,
    };
    if (graph.gates.length === 0) {
        return { graph: null, reason: 'no-graph-gates', portalCount: 0, ...base };
    }

    const portals = synthesizePortals(graph, { grid });
    // §3 inner-portal yield (see applyInnerPortalYield). portalCount in
    // the report stays the synthesized total so yields are visible.
    const activePortals = applyInnerPortalYield(portals);
    mark('portals');

    // ── Connector searches from both endpoints ───────────────────────
    // snapped:false portals are never targeted (Phase 11 contract: "must
    // not connect to an unsnapped portal without validation"); candidate
    // sets are capped at the nearest MAX_CONNECTOR_TARGETS per endpoint
    // so a region-wide mark soup can't stall the telemetry pass.
    const allTargets: ConnectorTarget[] = [
        ...activePortals.filter((p) => p.snapped).map(targetFromPortal),
        ...graph.gates.map(targetFromGate),
    ];
    const nearestTargets = (anchor: SeawayLatLon): ConnectorTarget[] =>
        allTargets.length <= MAX_CONNECTOR_TARGETS
            ? allTargets
            : [...allTargets]
                  .sort((a, b) => gateDistM(anchor, a) - gateDistM(anchor, b))
                  .slice(0, MAX_CONNECTOR_TARGETS);
    const originAnchor = { lat: req.fromLat, lon: req.fromLon };
    const destAnchor = { lat: req.toLat, lon: req.toLon };
    const fromOrigin = connectToTargets(grid, originAnchor, nearestTargets(originAnchor));
    const fromDest = connectToTargets(grid, destAnchor, nearestTargets(destAnchor));
    mark('connectors');

    const accepted = (rs: ConnectorResult[]): Map<string, ConnectorResult> => {
        const m = new Map<string, ConnectorResult>();
        for (const r of rs) if (r.reached && r.withinBudget) m.set(r.targetId, r);
        return m;
    };
    const entries = accepted(fromOrigin.results);
    const exits = accepted(fromDest.results);
    const portalCount = portals.length;
    if (entries.size === 0) return { graph: null, reason: 'no-entry', portalCount, ...base };
    if (exits.size === 0) return { graph: null, reason: 'no-exit', portalCount, ...base };

    // ── Node/link assembly ────────────────────────────────────────────
    const nodes: GraphNode[] = [];
    const indexOf = new Map<string, number>();
    const addNode = (id: string, pos: SeawayLatLon, isGate: boolean): number => {
        const existing = indexOf.get(id);
        if (existing !== undefined) return existing;
        nodes.push({ id, pos, isGate });
        indexOf.set(id, nodes.length - 1);
        return nodes.length - 1;
    };
    const gatesById = new Map<string, GateNode>(graph.gates.map((g) => [g.id, g]));
    for (const g of graph.gates) addNode(g.id, g.mid, true);
    for (const p of activePortals) addNode(p.id, p, false);

    const links: GraphLink[][] = nodes.map(() => []);
    const addLink = (from: number, to: number, weightM: number, polyline: SeawayLatLon[], edgeId?: string): void => {
        links[from].push({ to, weightM, polyline, edgeId });
        links[to].push({ to: from, weightM, polyline: [...polyline].reverse(), edgeId });
    };
    for (const e of graph.edges as SeawayEdge[]) {
        const a = indexOf.get(e.fromGateId);
        const b = indexOf.get(e.toGateId);
        if (a === undefined || b === undefined) continue;
        addLink(a, b, e.lengthM, e.polyline, e.id);
    }
    for (const p of activePortals) {
        if (!p.snapped) continue; // never wired into the graph either
        const pIdx = indexOf.get(p.id)!;
        if (p.kind === 'portal' && p.gateId) {
            const g = gatesById.get(p.gateId);
            if (g && hopClear(grid, p, g.mid)) {
                addLink(pIdx, indexOf.get(g.id)!, gateDistM(p, g.mid), [{ lat: p.lat, lon: p.lon }, g.mid]);
            }
        } else if (p.kind === 'junction') {
            // Link to the nearest gate of EACH channel the junction serves.
            for (const key of p.channelKeys) {
                let best: GateNode | null = null;
                let bestD = Infinity;
                for (const g of graph.gates) {
                    if (g.channelKey !== key) continue;
                    const d = gateDistM(p, g.mid);
                    if (d < bestD) {
                        bestD = d;
                        best = g;
                    }
                }
                if (best && hopClear(grid, p, best.mid)) {
                    addLink(pIdx, indexOf.get(best.id)!, bestD, [{ lat: p.lat, lon: p.lon }, best.mid]);
                }
            }
        }
    }

    // ── Dijkstra: virtual origin → virtual destination ────────────────
    // Connector costs are full engine economics; edge weights are plain
    // length (preferred tier) — the sum stays in cost-equivalent metres.
    const N = nodes.length;
    const dist = new Float64Array(N + 2).fill(Infinity); // [N]=origin, [N+1]=dest
    const prev = new Int32Array(N + 2).fill(-1);
    const prevLink: Array<GraphLink | null> = new Array(N + 2).fill(null);
    const ORIGIN = N;
    const DEST = N + 1;
    dist[ORIGIN] = 0;

    // Simple O(V²) scan — node counts here are tens-to-hundreds.
    const settled = new Uint8Array(N + 2);
    const entryByIdx = new Map<number, ConnectorResult>();
    for (const [id, r] of entries) {
        const i = indexOf.get(id);
        if (i !== undefined) entryByIdx.set(i, r);
    }
    const exitByIdx = new Map<number, ConnectorResult>();
    for (const [id, r] of exits) {
        const i = indexOf.get(id);
        if (i !== undefined) exitByIdx.set(i, r);
    }
    for (;;) {
        let u = -1;
        let uD = Infinity;
        for (let i = 0; i < N + 2; i++) {
            if (!settled[i] && dist[i] < uD) {
                uD = dist[i];
                u = i;
            }
        }
        if (u === -1 || u === DEST) break;
        settled[u] = 1;
        if (u === ORIGIN) {
            for (const [i, r] of entryByIdx) {
                if (r.costM < dist[i]) {
                    dist[i] = r.costM;
                    prev[i] = ORIGIN;
                    prevLink[i] = null;
                }
            }
            continue;
        }
        // Node u: graph links + (if an accepted exit) the hop to DEST.
        for (const l of links[u]) {
            const nd = dist[u] + l.weightM;
            if (nd < dist[l.to]) {
                dist[l.to] = nd;
                prev[l.to] = u;
                prevLink[l.to] = l;
            }
        }
        const exitR = exitByIdx.get(u);
        if (exitR && dist[u] + exitR.costM < dist[DEST]) {
            dist[DEST] = dist[u] + exitR.costM;
            prev[DEST] = u;
            prevLink[DEST] = null;
        }
    }
    mark('graphSearch');
    if (!Number.isFinite(dist[DEST])) {
        return { graph: null, reason: 'no-graph-path', portalCount, ...base };
    }

    // ── Compose the polyline ──────────────────────────────────────────
    const nodePath: number[] = [];
    for (let cur = DEST; cur !== -1; cur = prev[cur]) nodePath.push(cur);
    nodePath.reverse(); // ORIGIN, n1, ..., nk, DEST
    const entryNode = nodes[nodePath[1]];
    const exitNode = nodes[nodePath[nodePath.length - 2]];

    const cellToLatLon = (c: { x: number; y: number }): SeawayLatLon => ({
        lat: grid.minLat + (c.y + 0.5) * grid.dLat,
        lon: grid.minLon + (c.x + 0.5) * grid.dLon,
    });
    const line: SeawayLatLon[] = [];
    const push = (pts: SeawayLatLon[]): void => {
        for (const p of pts) {
            const last = line[line.length - 1];
            if (!last || gateDistM(last, p) > 1) line.push(p);
        }
    };
    push(entries.get(entryNode.id)!.path.map(cellToLatLon));
    const edgesUsed: string[] = [];
    let onGraphM = 0;
    for (let i = 2; i < nodePath.length - 1; i++) {
        const link = prevLink[nodePath[i]];
        if (!link) continue;
        push(link.polyline);
        if (link.edgeId) {
            edgesUsed.push(link.edgeId);
            onGraphM += link.weightM;
        }
    }
    push([...exits.get(exitNode.id)!.path.map(cellToLatLon)].reverse());
    mark('assemble');

    const lengthM = polylineLengthM(line);
    const directLine: SeawayLatLon[] = direct.polyline.map(([lon, lat]) => ({ lat, lon }));
    const directLengthM = polylineLengthM(directLine);

    // MEASURED cross-line compliance (crossLine.ts — the Phase 13
    // primitive, replacing Phase 12's by-construction metric): the
    // composed polyline validated against every FULL gate of the
    // traversed channels. Span crossings are measured facts; wing
    // crossings are wrong-side VIOLATIONS — the §3 promotion gate's
    // headline number, target 0. A gate both crossed and violated
    // (S-shaped pass) counts as violated.
    const pathChannelKeys = new Set(
        nodePath
            .slice(1, -1)
            .map((i) => nodes[i])
            .filter((n) => n.isGate)
            .map((n) => gatesById.get(n.id)!.channelKey),
    );
    const channelGates = graph.gates.filter((g) => pathChannelKeys.has(g.channelKey));
    const channelFullGates = channelGates.filter((g) => g.portMark && g.stbdMark);
    const cl = validateAgainstCrossLines(line, channelFullGates);
    // Half-gates of the traversed channels carry §3 keep-out segments
    // (mark → shore); crossing one is a 'shore-side' violation counted
    // exactly like a wing crossing.
    const keepOuts = halfGateKeepOuts(channelGates, flattenLandVertices(layers.LNDARE?.features ?? []));
    const koViolations = validateAgainstKeepOuts(line, keepOuts);
    const allViolations = [...cl.violations, ...koViolations];
    const gatesViolated = new Set(allViolations.map((v) => v.gateId));
    const gatesCorrect = new Set(cl.crossings.map((c) => c.gateId).filter((id) => !gatesViolated.has(id)));
    const interactions = gatesCorrect.size + gatesViolated.size;

    return {
        graph: {
            polyline: line.map((p): [number, number] => [p.lon, p.lat]),
            lengthM,
            costM: dist[DEST],
            edgesUsed,
            gateCount: nodePath.slice(1, -1).filter((i) => nodes[i].isGate).length,
            channelGatesTotal: channelFullGates.length,
            gateCompliance: interactions > 0 ? gatesCorrect.size / interactions : null,
            crossLineViolations: allViolations.length,
            pctOnGraph: lengthM > 0 ? onGraphM / lengthM : 0,
            detourRatio: directLengthM > 0 ? lengthM / directLengthM : Infinity,
            entryNodeId: entryNode.id,
            exitNodeId: exitNode.id,
        },
        portalCount,
        ...base,
    };
}

/** One-line telemetry summary for the orchestrator's shadow log. */
export function shadowSummary(report: SeawayShadowReport, directNM: number): string {
    const g = report.graph;
    if (!g) {
        return `no graph route (${report.reason}) — ${report.gatesTotal} gates / ${report.edgesTotal} edges / ${report.portalCount} portals`;
    }
    const compliance = g.gateCompliance === null ? 'n/a' : `${Math.round(g.gateCompliance * 100)}%`;
    const wrongSide = g.crossLineViolations > 0 ? `, ${g.crossLineViolations} WRONG-SIDE` : '';
    return (
        `graph ${(g.lengthM / 1852).toFixed(2)} NM vs direct ${directNM.toFixed(2)} NM — ` +
        `detour ${g.detourRatio.toFixed(2)}, ${Math.round(g.pctOnGraph * 100)}% on-graph, ` +
        `${g.gateCount} gates of ${g.channelGatesTotal} charted (compliance ${compliance}${wrongSide}), ` +
        `via ${g.entryNodeId} → ${g.exitNodeId}`
    );
}
