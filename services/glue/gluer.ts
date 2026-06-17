/**
 * Three-tier routing — the Gluer (PHASE 0).
 *
 * Design: docs/THREE_TIER_ROUTING.md §3. The Gluer is the ONLY code that
 * touches two tiers' outputs. It concatenates legs or refuses a join — it
 * never re-smooths, re-fairs, or re-splices a leg interior. There is ONE join
 * operator and it adds nothing.
 *
 * Four clauses, each independently unit-tested (tests/glue/seam.test.ts):
 *   1. SHARED BOUNDARY POINT  — legA.exit and legB.entry are the same node
 *      (referential identity), guarded by a 1 m epsilon for float round-trip.
 *      Kills the marina-disconnect class (no fuzzy bridge over a gap).
 *   2. HEADING + CROSS-LINE    — outbound headings continuous (≤120°, the
 *      double-back killer) AND the seam segment crosses the boundary gate's
 *      span between the marks, not outside it (the wrong-side killer). Reuses
 *      services/seaway/crossLine.ts — NOT a heading-only proxy (red-team).
 *   3. DEPTH / CAUTION CARRY   — controllingDepthM=min, depthSource degrades to
 *      the worse, and a red leg may not meet a confident-clean leg at the seam.
 *      The Gluer never upgrades a 'none'/uncharted seam to clean. House doctrine.
 *   4. NO INTERIOR MUTATION    — joined.polyline = A ++ B[1:], pure concat.
 */

import { validateAgainstCrossLines } from '../seaway/crossLine';
import type { GateNode, SeawayLatLon } from '../seaway/types';
import {
    angularDiff,
    freezeLeg,
    isRefusal,
    type LatLon,
    type Leg,
    type LegResult,
    type Refusal,
    type RefusalReason,
} from '../routing/legContract';

/** Float round-trip guard between graph space (110 540 m/°) and grid space
 *  (111 320 m/°). NOT a fuzzy bridge — the nodes are meant to be identical. */
export const JOIN_EPS_M = 1;
/** A turn sharper than this at a seam is a double-back. The engine's proven
 *  threshold (inshoreRouterEngine.ts:3603/3789), promoted to a hard gate. */
export const SEAM_MAX_TURN_DEG = 120;

const M_PER_LAT = 110_540;
const distM = (a: LatLon, b: LatLon): number => {
    const mPerLon = 111_320 * Math.cos((a[1] * Math.PI) / 180);
    return Math.hypot((b[0] - a[0]) * mPerLon, (b[1] - a[1]) * M_PER_LAT);
};
const toSeaway = (p: LatLon): SeawayLatLon => ({ lon: p[0], lat: p[1] });
const refuse = (reason: RefusalReason, extra: Partial<Refusal> = {}): Refusal => ({
    refused: true,
    reason,
    ...extra,
});

const worseSource = (a: Leg['depthSource'], b: Leg['depthSource']): Leg['depthSource'] => {
    const rank: Record<Leg['depthSource'], number> = { charted: 3, 'marks-vouched': 2, gebco: 1, none: 0 };
    return rank[a] <= rank[b] ? a : b;
};
const minNullable = (a: number | null, b: number | null): number | null => {
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a, b);
};

/**
 * Join two adjacent legs, or refuse. The joined leg is frozen and carries
 * legA's entry + legB's exit; its tierId is legA's (a folded multi-tier route
 * is anchored to its first tier — the per-tier truth lives in the leg list
 * that stitchLegs keeps).
 */
export function glue(legA: Leg, legB: Leg): { joined: Leg } | Refusal {
    // ── Clause 1: shared boundary point (positional continuity) ──
    // Segmentation hands both spans the SAME portal, so this is normally an
    // identity match; the positional check (≤ JOIN_EPS_M) is what catches a
    // tier that re-snapped its endpoint OFF the shared node (the marina-
    // disconnect / red-team identity bug) — there is no fuzzy bridge to paper
    // a gap. Each node still carries its OWN tier's through-heading (so clause
    // 2 can see a reversal), hence we compare positions, not object identity.
    if (distM(legA.exit.at, legB.entry.at) > JOIN_EPS_M) {
        return refuse('boundary-gap');
    }
    const node = legB.entry;

    // ── Clause 2a: heading continuity (the double-back killer) ──
    const turn = angularDiff(legA.exit.headingDeg, legB.entry.headingDeg);
    if (turn > SEAM_MAX_TURN_DEG) {
        return refuse('double-back', { measuredTurnDeg: Math.round(turn) });
    }
    // ── Clause 2b: cross-line wrong-side (only at a gate boundary) ──
    if (node.crossLine) {
        const a = legA.polyline;
        const b = legB.polyline;
        // The route window THROUGH the boundary node: tail of A → head of B.
        const seam: SeawayLatLon[] = [
            ...a.slice(Math.max(0, a.length - 2)).map(toSeaway),
            ...b.slice(1, 3).map(toSeaway),
        ];
        const gate = {
            id: 'seam-boundary',
            portMark: toSeaway(node.crossLine.port),
            stbdMark: toSeaway(node.crossLine.stbd),
        } as unknown as GateNode;
        const res = validateAgainstCrossLines(seam, [gate]);
        if (res.violations.length > 0) return refuse('wrong-side');
    }

    // ── Clause 3: depth / caution carry-across (house doctrine at the seam) ──
    const aEndsRed = legA.cautionMask[legA.cautionMask.length - 1] ?? false;
    const bStartsRed = legB.cautionMask[0] ?? false;
    if (aEndsRed && !bStartsRed) return refuse('caution-discontinuity');

    // ── Clause 4: pure concat, drop the shared vertex ──
    const joined: Leg = freezeLeg({
        tierId: legA.tierId,
        entry: legA.entry,
        exit: legB.exit,
        polyline: [...legA.polyline, ...legB.polyline.slice(1)],
        cautionMask: [...legA.cautionMask, ...legB.cautionMask.slice(1)],
        depthSource: worseSource(legA.depthSource, legB.depthSource),
        controllingDepthM: minNullable(legA.controllingDepthM, legB.controllingDepthM),
        provenance: `${legA.provenance}+${legB.provenance}`,
    });
    return { joined };
}

export interface GluedRoute {
    polyline: LatLon[];
    cautionMask: boolean[];
    controllingDepthM: number | null;
    depthSource: Leg['depthSource'];
    /** The legs successfully glued, in order. */
    legs: Leg[];
    /** Present iff a tier refused its span OR a seam failed. The route is
     *  valid UP TO this point; the tail is red/refused, never silently mutated. */
    refusal?: { atIndex: number; reason: RefusalReason; measuredTurnDeg?: number };
}

/**
 * Fold glue() across an ordered span result list. A Refusal in the list (a tier
 * couldn't serve its span) or a failed seam stops the fold: the route returns
 * up to the failed seam plus an explicit refusal — never a silently-mutated
 * polyline past the seam.
 */
export function stitchLegs(results: LegResult[]): GluedRoute {
    const empty: GluedRoute = {
        polyline: [],
        cautionMask: [],
        controllingDepthM: null,
        depthSource: 'none',
        legs: [],
    };
    if (results.length === 0) return empty;

    let acc: Leg | null = null;
    const legs: Leg[] = [];
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (isRefusal(r)) {
            return finalize(acc, legs, { atIndex: i, reason: r.reason, measuredTurnDeg: r.measuredTurnDeg });
        }
        if (acc === null) {
            acc = r;
            legs.push(r);
            continue;
        }
        const g = glue(acc, r);
        if (isRefusal(g)) {
            return finalize(acc, legs, { atIndex: i, reason: g.reason, measuredTurnDeg: g.measuredTurnDeg });
        }
        acc = g.joined;
        legs.push(r);
    }
    return finalize(acc, legs);
}

function finalize(acc: Leg | null, legs: Leg[], refusal?: GluedRoute['refusal']): GluedRoute {
    if (acc === null) {
        return { polyline: [], cautionMask: [], controllingDepthM: null, depthSource: 'none', legs: [], refusal };
    }
    return {
        polyline: [...acc.polyline],
        cautionMask: [...acc.cautionMask],
        controllingDepthM: acc.controllingDepthM,
        depthSource: acc.depthSource,
        legs,
        refusal,
    };
}
