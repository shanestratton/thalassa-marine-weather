/**
 * Seaway Graph data model — Masterplan Stage IV, Phase 10 (§4 spec).
 *
 * The destination architecture: gates, transits and centrelines as a
 * first-class sparse graph, compiled from chart + regional + geometric
 * mark sources, validated against the navigable grid, and (in later
 * phases) routed over with side-correctness BY CONSTRUCTION. Phase 10
 * is data model + compiler + debug overlay only — ZERO routing change;
 * today's engine remains the permanent fallback path.
 */

/** Branded metres — makes a residual feet-leak a compile error inside
 *  seaway code (masterplan §3 Phase 10). */
export type Metres = number & { readonly __unit: 'metres' };
export const metres = (n: number): Metres => n as Metres;

export interface SeawayLatLon {
    lat: number;
    lon: number;
}

/** Where a mark (and hence a gate's geometry) came from, in descending
 *  trust order. Chart wins geometry on dedup. */
export type MarkSource = 'chart' | 'regional' | 'geometric';

export interface SeawayMark extends SeawayLatLon {
    side: 'port' | 'stbd';
    source: MarkSource;
    /** OBJNAM channel key + sequence for numbered chart marks. */
    key?: string;
    seq?: number;
    name?: string;
}

/**
 * A lateral-mark gate: the route must pass BETWEEN portMark and stbdMark.
 * Either mark may be absent → a HALF-GATE (one charted side; the missing
 * side is open water or carries a keep-out half-plane in later phases).
 */
export interface GateNode {
    id: string;
    channelKey: string;
    /** Order along the channel, seaward → landward by convention of the
     *  underlying mark sequence. */
    station: number;
    portMark?: SeawayMark;
    stbdMark?: SeawayMark;
    /** Gate midpoint (full gates) or the mark's centreline projection
     *  (half-gates). Edge polylines pass through this point. */
    mid: SeawayLatLon;
    /** Port↔stbd separation. Absent for half-gates. */
    gateWidthM?: Metres;
    /** Local along-channel direction at this gate (deg true). IALA-A side
     *  correctness is checked against this in Phase 13's cross-line
     *  validation. */
    buoyageBearingDeg: number;
    /** Pair-construction trust: chart sequence-adjacency 0.95, regional
     *  PCA 0.7, geometric mutual-best 0.4. Gates below 0.6 never form
     *  edges without DEPARE/DRGARE corroboration (masterplan §3). */
    confidence: number;
}

export type SeawayEdgeKind = 'channel' | 'transit' | 'marina' | 'connector';

export type DepthSource = 'charted' | 'marks-vouched';

export interface SeawayEdge {
    id: string;
    kind: SeawayEdgeKind;
    fromGateId: string;
    toGateId: string;
    /** The sailed geometry — a span of the seq-interpolated corridor
     *  centreline passing through both gate midpoints. GEOMETRY IS THE
     *  LAW: the router never re-smooths edge interiors (§4). */
    polyline: SeawayLatLon[];
    lengthM: Metres;
    /** Min charted depth sampled along the polyline, when a sampler was
     *  provided to the compiler. Marks-vouched edges without charted
     *  corroboration stay traversable-with-caution. */
    controllingDepthM?: Metres;
    depthSource: DepthSource;
}

export interface SeawayChannel {
    key: string;
    /** Gate ids in station order (seaward → landward). */
    gateIds: string[];
}

export interface SeawayGraph {
    gates: GateNode[];
    edges: SeawayEdge[];
    channels: SeawayChannel[];
}

/** A rejected edge with the reason — surfaced for the debug overlay so
 *  compile-time validation failures are visible, never silent. */
export interface RejectedEdge {
    edge: SeawayEdge;
    reason: 'crosses-hard-blocked' | 'low-confidence-uncorroborated';
    /** First offending sample point, when geometric. */
    at?: SeawayLatLon;
}
