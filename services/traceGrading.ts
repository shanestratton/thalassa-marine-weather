/**
 * traceGrading — the one loop that decides whether a line is safe to sail.
 *
 * WHY THIS FILE EXISTS. This orchestration used to live inside a React effect
 * in components/map/useTracerGrading.ts, reachable only while the Route Tracer
 * screen was open. Everything it calls is already headless — validateTraceLeg
 * is pure and sync, buildTracerContext is an async service — but the loop that
 * turns points into (status, verdicts) was not, and `status` has no other
 * producer. So a route could only ever be checked with the tracer on screen and
 * a skipper watching it, and a blocked route in the Log page had no way to
 * clear itself.
 *
 * The obvious fix — a second, simpler grading loop for the recheck — is the
 * one thing that must not happen. Two implementations of "is this leg safe"
 * WILL drift, and the direction that kills is the quiet one: the simpler copy
 * grades a route clear that the real one would have flagged. So the loop moved
 * here whole, and both callers drive the same code.
 *
 * WHAT STAYED WITH THE CALLER. Everything that is policy rather than grading:
 * the verdict cache, the volatile-failure backoff ledger, incremental publish
 * to the UI, persistence, and how supersession is detected. Those differ
 * legitimately between an interactive tracer (fast, incremental, cached) and a
 * recheck (cold, once, no cache — see traceRecheck for why a cache here would
 * turn a recheck into a rubber stamp). They arrive as callbacks.
 */
import {
    buildTracerContext,
    validateTraceLeg,
    traceBbox,
    traceBboxPadded,
    bboxMaxSpanM,
    clusterKeepsDepthGrid,
    splitLegForDepthGrid,
    mergeSubLegVerdicts,
    type TracerContext,
    type TraceLegVerdict,
} from './routeTracer';
import { heapTag } from '../utils/heapGauge';
import { crumb } from '../utils/flightRecorder';
import { createLogger } from '../utils/createLogger';
import type { TraceCheckStatus } from './traceVerification';

const log = createLogger('traceGrading');

export interface GradePoint {
    lat: number;
    lon: number;
}

export interface GradeLeg {
    a: GradePoint;
    b: GradePoint;
    /** Caller's identity for this leg. A '|last' suffix marks the final leg. */
    key: string;
}

export interface GradeLegsOptions {
    draftM: number;
    draftAssumed: boolean;
    /** Build-cost ceiling for one window, in metres of tight-bbox span. */
    clusterSpanM: number;
    /** Reuse a held window that already covers these points. */
    ctxFromLru?: (pts: ReadonlyArray<GradePoint>) => TracerContext | null;
    /** Offer a freshly built grid-bearing window for reuse. */
    holdCtx?: (ctx: TracerContext) => void;
    /** True once this pass is obsolete — a newer edit, or an aborted recheck. */
    superseded?: () => boolean;
    /** A leg already has a verdict from the caller's cache; skip folding it. */
    isDecided?: (key: string) => boolean;
    onStatus?: (status: 'loading') => void;
    /**
     * A leg's verdict is final for this pass. `volatile` means the failure was
     * transient (a chart that has not hydrated, a window whose marker fetch
     * threw) and the verdict must NOT be banked — banking it would durably
     * record an unchecked leg as checked.
     */
    onLeg: (key: string, verdict: TraceLegVerdict, volatile: boolean) => void;
    /** After each cluster, for incremental publish/persist. */
    onClusterDone?: () => void;
}

export interface GradeLegsResult {
    status: TraceCheckStatus;
    /** True if the pass bailed early; `status` is then meaningless. */
    superseded: boolean;
}

const cautionVerdict = (message: string): TraceLegVerdict => ({
    grade: 'caution',
    issues: [{ severity: 'caution', message }],
    minDepthM: null,
    minAt: null,
    needsTide: false,
    nudge: null,
    nudgeTo: null,
});

/**
 * Grade every pending leg and roll the outcome up into one status.
 *
 * `pending` must already exclude legs the caller considers decided.
 */
export async function gradeLegs(
    pending: ReadonlyArray<GradeLeg>,
    opts: GradeLegsOptions,
): Promise<GradeLegsResult> {
    const superseded = () => opts.superseded?.() === true;
    const isDecided = (key: string) => opts.isDecided?.(key) === true;

    if (pending.length === 0) return { status: 'ready', superseded: false };

    // ── Subdivide the legs that cannot fit a depth grid whole ────────────
    // A leg longer than the grid budget used to be graded marks-only and told
    // the skipper "drop a pin midway" — the app asking the user to do work it
    // could do itself. Instead cut it into pieces that DO fit, grade each, and
    // fold them back into the one verdict its row renders. The pieces lie on
    // the leg's own line, so nothing about the route changes; only whether it
    // gets checked.
    interface Unit {
        a: GradePoint;
        b: GradePoint;
        key: string;
        parentKey: string;
        lastLeg: boolean;
    }
    const units: Unit[] = [];
    /** parent leg key → how many pieces it was cut into (1 = whole). */
    const pieceCount = new Map<string, number>();
    for (const leg of pending) {
        const isLast = leg.key.endsWith('|last');
        const mids = splitLegForDepthGrid(leg.a, leg.b);
        if (mids.length === 0) {
            units.push({ a: leg.a, b: leg.b, key: leg.key, parentKey: leg.key, lastLeg: isLast });
            pieceCount.set(leg.key, 1);
            continue;
        }
        const pts = [leg.a, ...mids, leg.b];
        for (let i = 0; i + 1 < pts.length; i++) {
            units.push({
                a: pts[i],
                b: pts[i + 1],
                key: `${leg.key}#${i}`,
                parentKey: leg.key,
                // Only the FINAL piece of the FINAL leg is the last leg.
                // ownsSoloApproach hands a mark to the next leg unless lastLeg
                // is set, so marking every piece last would make each one claim
                // marks its successor owns.
                lastLeg: isLast && i === pts.length - 2,
            });
        }
        pieceCount.set(leg.key, pts.length - 1);
    }

    // Cluster the ungraded pieces (in trace order) into span-bounded build
    // windows. The common interactive cases — appended pin, nudged pin,
    // inserted pin — are ONE tiny cluster around the touched legs; a loaded
    // 60 km trace grades window-by-window with real depth everywhere instead
    // of a whole-trace marks-only bail.
    const clusters: Unit[][] = [];
    let cur: Unit[] = [];
    for (const leg of units) {
        const probe = [...cur, leg];
        const pts = probe.flatMap((l) => [l.a, l.b]);
        // TWO bounds, and the second is the one that was once missing.
        //
        // clusterSpanM caps BUILD COST and is measured on the tight bbox. But
        // the window that actually gets built is the PADDED one, and
        // buildTracerContext tests THAT against MAX_DEPTH_GRID_SPAN_M before
        // deciding whether to build a depth grid at all. Since traceBboxPadded
        // pads by 25% of the larger DEGREE span, and a degree of longitude
        // shrinks with cos(lat), a cluster that passes the tight test can still
        // pad past the grid ceiling — measured at ~40.1 km at Tasmania and
        // ~48.1 km at 60°N on ordinary corner geometry reading only ~23 km
        // tight. The window then returns marks-only and every leg in it is
        // stamped "depth unchecked" and cached that way.
        const tooCostly = bboxMaxSpanM(traceBbox(pts, 0)) > opts.clusterSpanM;
        if (cur.length > 0 && (tooCostly || !clusterKeepsDepthGrid(pts))) {
            clusters.push(cur);
            cur = [leg];
        } else {
            cur = probe;
        }
    }
    if (cur.length > 0) clusters.push(cur);

    let failStatus: 'toolarge' | 'nochart' | null = null;
    let sawMarksOnly = false;

    // Piece verdicts live here until every piece of their leg is in. A
    // half-graded leg must stay ungraded rather than fold early — folding with
    // a missing piece would emit "part of this leg could not be checked" for a
    // piece that is merely not done yet, which is a lie in the alarming
    // direction.
    const pieceVerdicts = new Map<string, TraceLegVerdict>();
    /** Pieces whose verdict must not be banked. */
    const volatilePieces = new Set<string>();
    const folded = new Set<string>();

    const recordPiece = (key: string, verdict: TraceLegVerdict, isVolatile: boolean): void => {
        pieceVerdicts.set(key, verdict);
        if (isVolatile) volatilePieces.add(key);
    };

    /**
     * Fold every leg whose pieces are all graded into its single verdict. A leg
     * is reported VOLATILE if ANY of its pieces was volatile — one unbankable
     * piece makes the whole leg unbankable, or a reload would show a leg as
     * fully checked when part of it was a retryable failure.
     */
    const foldReadyLegs = (): void => {
        for (const leg of pending) {
            if (folded.has(leg.key) || isDecided(leg.key)) continue;
            const n = pieceCount.get(leg.key) ?? 1;
            const keys = n === 1 ? [leg.key] : Array.from({ length: n }, (_, i) => `${leg.key}#${i}`);
            if (!keys.every((k) => pieceVerdicts.has(k))) continue; // still grading

            const merged =
                n === 1
                    ? (pieceVerdicts.get(leg.key) ?? null)
                    : mergeSubLegVerdicts(keys.map((k) => pieceVerdicts.get(k) ?? null));
            if (!merged) continue;
            folded.add(leg.key);
            opts.onLeg(leg.key, merged, keys.some((k) => volatilePieces.has(k)));
        }
    };

    for (const cluster of clusters) {
        if (superseded()) return { status: 'ready', superseded: true };
        const pts = cluster.flatMap((l) => [l.a, l.b]);
        // Reuse a held window only when it has a DEPTH GRID and the cluster
        // sits well inside it. A grid-less (marks-only) ctx is NEVER reused:
        // its huge bbox would stamp every short leg inside it "depth
        // unchecked".
        let ctx = opts.ctxFromLru?.(pts) ?? null;
        if (ctx) crumb('tracer:ctx-reuse', `${cluster.length}legs`);
        if (!ctx) {
            opts.onStatus?.('loading');
            try {
                const built = await buildTracerContext(traceBboxPadded(pts), opts.draftM, {
                    draftAssumed: opts.draftAssumed,
                });
                if (superseded()) return { status: 'ready', superseded: true };
                if (built.status === 'ready') {
                    ctx = built.ctx;
                    // Hold every grid-bearing window unless gate marks are
                    // missing — holding a gate-less window would let one
                    // network blip strip gate checking from every later
                    // cluster that reuses it.
                    if (!built.ctx.gateChecksUnavailable) opts.holdCtx?.(built.ctx);
                } else if (built.status === 'marksonly') {
                    // One genuinely long leg — grade marks with this ctx but
                    // DON'T hold it: a grid-less window must never shadow
                    // later clusters.
                    ctx = built.ctx;
                    sawMarksOnly = true;
                } else if (built.status === 'toolarge') {
                    // A piece is built to fit, so reaching here means
                    // splitLegForDepthGrid declined — the leg really is beyond
                    // what MAX_LEG_SUBDIVISIONS can cover. Pure geometry, so
                    // durable.
                    failStatus = 'toolarge';
                    for (const l of cluster)
                        recordPiece(l.key, cautionVerdict('too long to check — add a waypoint'), false);
                    foldReadyLegs();
                    opts.onClusterDone?.();
                    continue;
                } else {
                    // nochart can be a NETWORK BLIP (cloud cells not yet
                    // hydrated) — volatile, so charts appearing later heal it.
                    failStatus = 'nochart';
                    for (const l of cluster)
                        recordPiece(l.key, cautionVerdict('no ENC chart here — depth unchecked'), true);
                    foldReadyLegs();
                    opts.onClusterDone?.();
                    continue;
                }
            } catch (err) {
                if (superseded()) return { status: 'ready', superseded: true };
                log.warn(`tracer context build failed: ${err instanceof Error ? err.message : String(err)}`);
                failStatus = 'nochart';
                for (const l of cluster)
                    recordPiece(l.key, cautionVerdict('chart load failed — depth unchecked, will retry'), true);
                foldReadyLegs();
                opts.onClusterDone?.();
                continue;
            }
        }
        for (const l of cluster) {
            const verdict = validateTraceLeg(l.a, l.b, ctx, { lastLeg: l.lastLeg });
            // A window whose marker fetch threw was never gate-checked, so its
            // verdict is provisional in exactly the way a 'nochart' one is —
            // VOLATILE, so the next pass retries and a transient blip cannot
            // poison the session.
            recordPiece(l.key, verdict, ctx.gateChecksUnavailable);
        }
        foldReadyLegs();
        opts.onClusterDone?.();
        crumb('tracer:grade-done', `${cluster.length}legs${heapTag()}`);
    }

    if (superseded()) return { status: 'ready', superseded: true };
    // Failures outrank a held ctx — a half-graded trace must not read "ready"
    // while legs say "load failed". Reaching the end with no explicit failure
    // means every pending piece produced a real verdict.
    return { status: failStatus ?? (sawMarksOnly ? 'marksonly' : 'ready'), superseded: false };
}
