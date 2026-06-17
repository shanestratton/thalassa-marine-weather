/**
 * Three-tier routing — the immutable Leg contract (PHASE 0).
 *
 * Design: docs/THREE_TIER_ROUTING.md §1.1 + §3. THE SEAM IS THE PRODUCT.
 *
 * Every recent field bug (the 175° Brisbane-bar double-back, the ±171° Newport
 * approach spike, the dense stepped centreline, the Newport-exit bead-through)
 * is the SAME bug: tier N+1 silently mutates tier N's polyline across an
 * implicit splice with no shared-boundary contract, no heading gate, and no
 * refusal path. This module makes that class structurally impossible:
 *
 *   1. No tier receives another tier's polyline — a tier sees two BoundaryNodes
 *      and emits a frozen Leg. There is no input polyline to silently pass through.
 *   2. No tier mutates another tier's Leg — only the Gluer (services/glue/gluer.ts)
 *      touches two legs, and it only CONCATENATES.
 *   3. "I can't serve this span" is a typed Refusal, never the unchanged input —
 *      a refusal renders red / refuses; it never leaks stale geometry past a seam.
 *
 * Pure types + a deep-freeze helper. Nothing here imports a router or the engine.
 */

/** [lon, lat] — the engine's GeoJSON convention. */
export type LatLon = readonly [number, number];

/** A boundary gate's port + starboard marks ([lon, lat]). Carried on
 *  channel-mouth / last-lead nodes so the Gluer can wrong-side-check the seam
 *  segment against the gate span (clause 2) — not a heading-only proxy. */
export interface CrossLine {
    readonly port: LatLon;
    readonly stbd: LatLon;
}

export interface BoundaryNode {
    /** The shared seam point. Adjacent spans receive the SAME object (identity). */
    readonly at: LatLon;
    /** Outbound heading THROUGH this node, deg true. The Gluer tests continuity
     *  against this directly, never re-deriving it from polylines. */
    readonly headingDeg: number;
    readonly kind: 'origin' | 'dest' | 'last-lead' | 'channel-mouth' | 'shelf-edge';
    /** Charted controlling depth AT the node, or null if GEBCO-only/unvouched. */
    readonly depthM: number | null;
    /** false ⇒ the boundary could NOT be deep-snapped (connector honesty flag).
     *  A tier MUST refuse rather than route to an unsnapped node. */
    readonly snapped: boolean;
    /** Boundary gate span for the wrong-side seam check (channel-mouth/last-lead). */
    readonly crossLine?: CrossLine;
}

export type TierId = 1 | 2 | 3;

export interface Leg {
    readonly tierId: TierId;
    readonly entry: BoundaryNode;
    readonly exit: BoundaryNode;
    /** Frozen; never re-smoothed/re-spliced downstream. */
    readonly polyline: readonly LatLon[];
    /** Per-vertex; true ⇒ render red. length === polyline.length. */
    readonly cautionMask: readonly boolean[];
    readonly depthSource: 'charted' | 'marks-vouched' | 'gebco' | 'none';
    /** Min charted depth along the polyline, or null. */
    readonly controllingDepthM: number | null;
    readonly provenance: string;
}

export type RefusalReason =
    | 'no-deepwater-corridor'
    | 'exit-not-deepwater'
    | 'entry-unsnapped'
    | 'uncharted-run'
    | 'disconnected-grid'
    | 'boundary-gap'
    | 'double-back'
    | 'wrong-side'
    | 'caution-discontinuity';

export interface Refusal {
    readonly refused: true;
    readonly reason: RefusalReason;
    readonly atNM?: number;
    readonly measuredTurnDeg?: number;
}

export type LegResult = Leg | Refusal;

/**
 * Discriminated-union guard. Parameter is `unknown` deliberately: a narrower
 * `{ refused?: boolean }` is a WEAK type (all-optional), so TS's weak-type rule
 * rejects any argument that shares no key with it — i.e. every Leg, every
 * `{ joined: Leg }`, every `TierSpan[]`. `unknown` accepts the whole union and
 * the `r is Refusal` predicate still narrows correctly at each call site.
 */
export const isRefusal = (r: unknown): r is Refusal =>
    typeof r === 'object' && r !== null && (r as Refusal).refused === true;

/** Deep-freeze a leg — boundary nodes, polyline, cautionMask — so no downstream
 *  code can mutate an interior (invariant 2 enforced at runtime, not just review). */
export function freezeLeg(leg: Leg): Leg {
    Object.freeze(leg.entry.at);
    Object.freeze(leg.entry);
    Object.freeze(leg.exit.at);
    Object.freeze(leg.exit);
    leg.polyline.forEach((v) => Object.freeze(v));
    Object.freeze(leg.polyline);
    Object.freeze(leg.cautionMask);
    return Object.freeze(leg);
}

/** Smallest unsigned turn between two true-bearings (deg), in [0, 180]. */
export function angularDiff(a: number, b: number): number {
    return Math.abs(((a - b + 540) % 360) - 180);
}
