/**
 * useTracerGrading — the tracer's grading pass and its tide-window labels.
 *
 * Extracted from MapHub. Builds or refreshes the windowed ENC context, grades
 * every leg against it, then labels the sub-keel legs with the tide window
 * that gets you across. Touches no map source, layer, marker or camera, so it
 * carries no paint-order constraint at all.
 *
 * THE TWO EFFECTS MUST STAY IN ONE FILE. tideSpotCacheRef and tideReqRef are
 * cleared by the grading effect and read by the tide effect. The fire-time
 * label merge can be overwritten by the next pass's whole-map replace, and it
 * survives only because the spot cache re-supplies the label synchronously.
 * Split them across two hooks and that recovery breaks silently.
 *
 * `if (!tideReqRef.current.has(spot)) return;` is NOT a dedupe guard — the
 * success path never deletes the spot. It fires only when the grading effect
 * cleared tideReqRef mid-fetch because the draft changed, dropping a label
 * that was computed against the old keel. It looks removable. It is not.
 *
 * DRAFT-CHANGE INVALIDATION KEYS ON gradedDraftRef, NOT on tracerCtxRef, and
 * that is the fix for adversarial-audit critical #1: Done nulls the ctx but
 * keeps the cache, so a draft edited between Done and reopen used to serve
 * stale-keel verdicts — edit 1.9 m to 2.6 m and a green bar crossing stayed
 * green. Do not simplify it to a ctx check.
 *
 * gradedDraftRef therefore stays declared in MapHub rather than moving in
 * here: useTracerLegFixes reads it at fire time through its own props, so it
 * is shared state, not this hook's private cache. The six refs that ARE
 * private — the sequence counter, the leg cache and its one-shot hydration
 * latch, the volatile failure map, and the two tide caches — moved in.
 *
 * legVerdicts, tracerStatus and tideLabels stay as MapHub state because a
 * dozen consumers read them, several of them above where this hook can be
 * called. Only the setters come in.
 *
 * The failure map is deliberately kept OUT of the leg cache: a "no chart
 * here" can be a transient blip while a cloud cell hydrates, so every pass
 * clears it and retries, which is what heals legs when charts arrive
 * mid-session. `toolarge` verdicts are durable because they are pure geometry.
 */

import { useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
    buildTracerContext,
    validateTraceLeg,
    traceBbox,
    traceBboxPadded,
    bboxMaxSpanM,
    clusterKeepsDepthGrid,
    splitLegForDepthGrid,
    mergeSubLegVerdicts,
    tideWindowLabelFor,
    persistLegVerdicts,
    hydrateLegVerdicts,
    type TracerContext,
    type TraceLegVerdict,
} from '../../services/routeTracer';
import { legCacheKey, TRACE_CLUSTER_SPAN_M } from './mapHubHelpers';
import { vesselDraftMetres, vesselDraftIsAssumed } from '../../services/units';
import { getVersion as getEncRegistryVersion } from '../../services/enc/EncCellMetadata';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('MapHub');

/** Mirrors MapHub's own tracerStatus union. */
export type TracerStatus = 'idle' | 'loading' | 'ready' | 'marksonly' | 'toolarge' | 'nochart';

/** FLAT on purpose. The hook destructures this immediately and every dep array
 *  names the individual members, never the object — the call site passes a
 *  fresh literal each render, so depping on the wrapper would turn the two
 *  most expensive effects in the tracer into per-render effects. */
export interface TracerGradingDeps {
    capturedCoords: { lat: number; lon: number }[];
    coordCaptureMode: boolean;
    /** settings.vessel — the object identity is the dep, as it is today. */
    vessel: { draft?: number; estimatedFields?: string[] } | null | undefined;
    legVerdicts: Array<TraceLegVerdict | null>;
    departureMs: number | null;
    legEtaOffsetsMs: number[];
    tracerCtxRef: { current: TracerContext | null };
    tracerCtxLruRef: { current: TracerContext[] };
    /** Shared with useTracerLegFixes, which reads it at fire time — so it is
     *  owned by MapHub, not by this hook. */
    gradedDraftRef: { current: { d: number; assumed: boolean } | null };
    tracerCtxFromLru: (pts: ReadonlyArray<{ lat: number; lon: number }>) => TracerContext | null;
    tracerCtxHold: (ctx: TracerContext) => void;
    setLegVerdicts: Dispatch<SetStateAction<Array<TraceLegVerdict | null>>>;
    setTracerStatus: Dispatch<SetStateAction<TracerStatus>>;
    setTideLabels: Dispatch<SetStateAction<Record<number, string>>>;
    setAckedLegs: Dispatch<SetStateAction<Set<number>>>;
    setSailArmed: (v: boolean) => void;
    setShareArmed: (v: boolean) => void;
}

export function useTracerGrading(deps: TracerGradingDeps): void {
    const {
        capturedCoords,
        coordCaptureMode,
        vessel,
        legVerdicts,
        departureMs,
        legEtaOffsetsMs,
        tracerCtxRef,
        tracerCtxLruRef,
        gradedDraftRef,
        tracerCtxFromLru,
        tracerCtxHold,
        setLegVerdicts,
        setTracerStatus,
        setTideLabels,
        setAckedLegs,
        setSailArmed,
        setShareArmed,
    } = deps;

    const tracerSeqRef = useRef(0);
    const tideReqRef = useRef<Set<string>>(new Set());
    /** Incremental grading (Shane 2026-07-09: "each new waypoint rechecks
     *  all of the previous waypoints — not necessary unless we nudged").
     *  Verdicts cache per LEG, keyed by its endpoints: a fresh pin only
     *  misses on its own leg, a nudged pin on its two adjacent legs, and
     *  every untouched leg is a hit. Cleared when the CONTEXT rebuilds
     *  (new area / draft change) — those invalidate every cached verdict. */
    const legCacheRef = useRef<Map<string, TraceLegVerdict>>(new Map());
    /** One-shot hydration of the persisted verdict cache (Shane 2026-07-17:
     *  "checks the entire route again, even though nothing changed" — the
     *  cache used to die with every remount/reload/tab-bounce). Runs inside
     *  the grading effect where the real draft is known. */
    const legCacheHydratedRef = useRef(false);
    /** VOLATILE failure verdicts ("no ENC chart here", build exception) —
     *  kept OUT of legCacheRef because a nochart can be a transient network
     *  blip (cloud cell hydration offline): every grading pass clears this
     *  map and retries, so charts appearing mid-session heal the legs.
     *  toolarge verdicts ARE durable (pure geometry — the leg really is
     *  that long until a pin splits it, which changes its cache key). */
    const failVerdictsRef = useRef<Map<string, TraceLegVerdict>>(new Map());
    /** Tide-window labels cached by SPOT (leg indices shift on insert/
     *  delete; the shallow patch itself doesn't move). */
    const tideSpotCacheRef = useRef<Map<string, string>>(new Map());
    // ── Route Tracer validation ──
    // Build/refresh the tracer context, then grade every leg. Rebuilds when a
    // pin lands outside the current grid's padded bbox OR the vessel draft
    // changed (a ctx keeps grading against the keel it was BUILT with —
    // adversarial-audit critical #1: edit draft 1.9→2.6 m and a green bar
    // crossing stayed green).
    useEffect(() => {
        setSailArmed(false); // a changed line always re-earns its "Sail anyway"
        // Ack indices die with the old leg list — but IDENTITY-PRESERVING:
        // an unconditional new Set() forced a full 7k-line MapHub render on
        // EVERY pin edit even when no acks existed (jank audit #4).
        setAckedLegs((s) => (s.size === 0 ? s : new Set()));
        setShareArmed(false); // consent never outlives the line it was given for
        if (!coordCaptureMode || capturedCoords.length === 0) {
            // Kill any in-flight grading pass — un-superseded, it would
            // resurrect the old trace's verdicts/status over Clear/Done.
            tracerSeqRef.current++;
            if (capturedCoords.length === 0) {
                setLegVerdicts([]);
                legCacheRef.current.clear();
                failVerdictsRef.current.clear();
            }
            return;
        }
        const draftNow = vesselDraftMetres(vessel);
        const draftAssumed = vesselDraftIsAssumed(vessel);
        const seq = ++tracerSeqRef.current;

        // Draft change invalidates EVERY cached verdict and tide label —
        // they were graded against the old keel (adversarial-audit critical
        // #1); keyed on the draft the CACHE saw, not on the ctx (Done nulls
        // the ctx but keeps the cache). Area growth does NOT invalidate:
        // chart data is static for the session, so a verdict graded in an
        // earlier window stays true forever.
        const prevDraft = gradedDraftRef.current;
        if (prevDraft && (prevDraft.d !== draftNow || prevDraft.assumed !== draftAssumed)) {
            tracerCtxRef.current = null;
            tracerCtxLruRef.current = []; // grids were built FOR the old keel
            legCacheRef.current.clear();
            tideSpotCacheRef.current.clear();
            setTideLabels({});
            tideReqRef.current.clear();
        }
        gradedDraftRef.current = { d: draftNow, assumed: draftAssumed };
        const cache = legCacheRef.current;
        if (!legCacheHydratedRef.current) {
            legCacheHydratedRef.current = true;
            // Same keel + same chart library ⇒ yesterday's verdicts are
            // today's verdicts; anything else returns null and we re-grade.
            const persisted = hydrateLegVerdicts(draftNow, draftAssumed, getEncRegistryVersion());
            if (persisted) for (const [k, v] of persisted) if (!cache.has(k)) cache.set(k, v);
        }
        // Failure verdicts retry every pass — a chart that appears
        // mid-session (Pi back in range, cloud sync) heals the legs.
        const failMap = failVerdictsRef.current;
        failMap.clear();

        const legs: Array<{ a: { lat: number; lon: number }; b: { lat: number; lon: number }; key: string }> = [];
        for (let i = 1; i < capturedCoords.length; i++) {
            legs.push({
                a: capturedCoords[i - 1],
                b: capturedCoords[i],
                key: legCacheKey(capturedCoords[i - 1], capturedCoords[i], i === capturedCoords.length - 1),
            });
        }
        const publish = (): void => {
            if (seq !== tracerSeqRef.current) return;
            // Identity-preserving: cache entries are stable objects, so an
            // element-wise match means NOTHING changed — return prev and no
            // re-render happens. Without this every publish minted a fresh
            // array, and each one cascaded into a full trace-line re-sync
            // (4× setData + chevron re-layout) + tide-label pass + panel
            // render — 3-5 wasted cycles per pin add (perf hunt 2026-07-15).
            const next = legs.map((l) => cache.get(l.key) ?? failMap.get(l.key) ?? null);
            setLegVerdicts((prev) =>
                prev.length === next.length && next.every((v, i) => v === prev[i]) ? prev : next,
            );
        };
        publish(); // cached legs render NOW; only truly new legs show "checking…"

        const pending = legs.filter((l) => !cache.has(l.key));
        if (pending.length === 0) {
            setTracerStatus('ready');
            return;
        }

        void (async () => {
            // ── Subdivide the legs that cannot fit a depth grid whole ────────
            // A leg longer than the grid budget used to be graded marks-only
            // and told the skipper "drop a pin midway" — the app asking the
            // user to do the work it could do itself. Instead we cut it into
            // pieces that DO fit, grade each, and fold them back into the one
            // verdict its row renders. The pieces lie on the leg's own line, so
            // nothing about the route changes; only whether it gets checked.
            const units: Array<{
                a: { lat: number; lon: number };
                b: { lat: number; lon: number };
                key: string;
                parentKey: string;
                lastLeg: boolean;
            }> = [];
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
                        // ownsSoloApproach hands a mark to the next leg unless
                        // lastLeg is set, so marking every piece last would make
                        // each one claim marks its successor owns.
                        lastLeg: isLast && i === pts.length - 2,
                    });
                }
                pieceCount.set(leg.key, pts.length - 1);
            }

            // Cluster the ungraded pieces (in trace order) into span-bounded
            // build windows. The common cases — appended pin, nudged pin,
            // inserted pin — are ONE tiny cluster around the touched legs;
            // a loaded 60 km trace grades window-by-window with real depth
            // everywhere instead of a whole-trace marks-only bail.
            const clusters: Array<typeof units> = [];
            let cur: typeof units = [];
            for (const leg of units) {
                const probe = [...cur, leg];
                const pts = probe.flatMap((l) => [l.a, l.b]);
                // TWO bounds, and the second is the one that was missing.
                //
                // TRACE_CLUSTER_SPAN_M caps BUILD COST and is measured on the
                // tight bbox. But the window that actually gets built is the
                // PADDED one, and buildTracerContext tests THAT against
                // MAX_DEPTH_GRID_SPAN_M before deciding whether to build a
                // depth grid at all. Since traceBboxPadded pads by 25% of the
                // larger DEGREE span, and a degree of longitude shrinks with
                // cos(lat), a cluster that passes the tight test can still pad
                // past the grid ceiling — measured at ~40.1 km at Tasmania and
                // ~48.1 km at 60°N on ordinary corner geometry that reads only
                // ~23 km tight. The window then returns marks-only and every
                // leg in it is stamped "depth unchecked" and CACHED that way.
                // Bounding the padded span too makes the cluster loop agree
                // with the test it is feeding.
                const tooCostly = bboxMaxSpanM(traceBbox(pts, 0)) > TRACE_CLUSTER_SPAN_M;
                if (cur.length > 0 && (tooCostly || !clusterKeepsDepthGrid(pts))) {
                    clusters.push(cur);
                    cur = [leg];
                } else {
                    cur = probe;
                }
            }
            if (cur.length > 0) clusters.push(cur);

            const cautionVerdict = (message: string): TraceLegVerdict => ({
                grade: 'caution',
                issues: [{ severity: 'caution', message }],
                minDepthM: null,
                minAt: null,
                needsTide: false,
                nudge: null,
                nudgeTo: null,
            });
            let failStatus: 'toolarge' | 'nochart' | null = null;
            let sawMarksOnly = false;

            // Piece verdicts live here until every piece of their leg is in.
            // A half-graded leg must stay `null` (renders "checking…") rather
            // than fold early — folding with a missing piece would emit
            // "part of this leg could not be checked" for a piece that is
            // merely not done yet, which is a lie in the alarming direction.
            const pieceVerdicts = new Map<string, TraceLegVerdict>();
            /** Pieces whose verdict must not be banked (see foldReadyLegs). */
            const volatilePieces = new Set<string>();

            const recordPiece = (key: string, verdict: TraceLegVerdict, isVolatile: boolean): void => {
                pieceVerdicts.set(key, verdict);
                if (isVolatile) volatilePieces.add(key);
            };

            /**
             * Fold every leg whose pieces are all graded into its single verdict.
             * A leg goes to the VOLATILE failMap if ANY of its pieces was
             * volatile — one unbankable piece makes the whole leg unbankable,
             * or a reload would show a leg as fully checked when part of it was
             * a retryable failure.
             */
            const foldReadyLegs = (): void => {
                for (const leg of pending) {
                    if (cache.has(leg.key) || failMap.has(leg.key)) continue;
                    const n = pieceCount.get(leg.key) ?? 1;
                    const keys = n === 1 ? [leg.key] : Array.from({ length: n }, (_, i) => `${leg.key}#${i}`);
                    if (!keys.every((k) => pieceVerdicts.has(k))) continue; // still grading

                    const merged =
                        n === 1
                            ? (pieceVerdicts.get(leg.key) ?? null)
                            : mergeSubLegVerdicts(keys.map((k) => pieceVerdicts.get(k) ?? null));
                    if (!merged) continue;
                    if (keys.some((k) => volatilePieces.has(k))) failMap.set(leg.key, merged);
                    else cache.set(leg.key, merged);
                }
            };
            for (const cluster of clusters) {
                if (seq !== tracerSeqRef.current) return; // a newer pin superseded this pass
                const pts = cluster.flatMap((l) => [l.a, l.b]);
                // Reuse the held window only when it has a DEPTH GRID and the
                // cluster sits well inside it (~890 m margin — a gate mark's
                // pair partner sits up to a few hundred metres across the
                // channel; a fringe reuse once split a pair at the bbox edge
                // and downgraded a wrong-side DANGER to a solo caution). A
                // grid-less (marks-only) ctx is NEVER reused: its huge bbox
                // would stamp every short leg inside it "depth unchecked".
                let ctx = tracerCtxFromLru(pts);
                if (!ctx) {
                    setTracerStatus('loading');
                    try {
                        const built = await buildTracerContext(traceBboxPadded(pts), draftNow, { draftAssumed });
                        if (seq !== tracerSeqRef.current) return;
                        if (built.status === 'ready') {
                            ctx = built.ctx;
                            // Two reasons NOT to hold this window.
                            //
                            // 1. Gate marks missing: holding it would let one
                            //    network blip strip gate checking from every
                            //    later cluster that reuses it, turning a
                            //    transient failure into a session-long one.
                            // 2. It only covers PIECES of a subdivided leg. Each
                            //    piece has its own window by construction and the
                            //    next piece is a different patch of water, so a
                            //    hold almost never hits — while a held grid is
                            //    ~20 MB at the cell cap and the LRU keeps 3.
                            //    Subdividing turned one grid-LESS window into N
                            //    grid-bearing ones, on a surface with a
                            //    documented jetsam history; there is no reason to
                            //    keep those alive past their one use.
                            const holdsAWholeLeg = cluster.some((l) => l.key === l.parentKey);
                            if (!built.ctx.gateChecksUnavailable && holdsAWholeLeg) tracerCtxHold(built.ctx);
                        } else if (built.status === 'marksonly') {
                            // One genuinely long leg — grade marks with this
                            // ctx but DON'T hold it: a grid-less window must
                            // never shadow later clusters.
                            ctx = built.ctx;
                            sawMarksOnly = true;
                        } else if (built.status === 'toolarge') {
                            // A piece is built to fit, so reaching here means
                            // splitLegForDepthGrid declined — the leg really is
                            // beyond what MAX_LEG_SUBDIVISIONS can cover. Pure
                            // geometry, so durable; adding a pin changes the
                            // leg's key and re-grades.
                            failStatus = 'toolarge';
                            for (const l of cluster)
                                recordPiece(l.key, cautionVerdict('too long to check — add a waypoint'), false);
                            foldReadyLegs();
                            publish();
                            continue;
                        } else {
                            // nochart can be a NETWORK BLIP (cloud cells not
                            // yet hydrated) — volatile verdict, retried every
                            // pass so charts appearing mid-session heal it.
                            failStatus = 'nochart';
                            for (const l of cluster)
                                recordPiece(l.key, cautionVerdict('no ENC chart here — depth unchecked'), true);
                            foldReadyLegs();
                            publish();
                            continue;
                        }
                    } catch (err) {
                        if (seq !== tracerSeqRef.current) return;
                        log.warn(`tracer context build failed: ${err instanceof Error ? err.message : String(err)}`);
                        failStatus = 'nochart';
                        for (const l of cluster)
                            recordPiece(l.key, cautionVerdict('chart load failed — depth unchecked, will retry'), true);
                        foldReadyLegs();
                        publish();
                        continue;
                    }
                }
                for (const l of cluster) {
                    const verdict = validateTraceLeg(l.a, l.b, ctx, { lastLeg: l.lastLeg });
                    // A window whose marker fetch threw was never gate-checked,
                    // so its verdict is provisional in exactly the way a
                    // 'nochart' one is — VOLATILE, so the next pass retries and
                    // a transient blip cannot poison the session. Banking it to
                    // localStorage would durably record an unchecked leg as
                    // checked, and the `pending.length === 0` short-circuit
                    // would then read 'ready' on the next mount and show a
                    // clean strip.
                    recordPiece(l.key, verdict, ctx.gateChecksUnavailable);
                }
                foldReadyLegs();
                publish();
            }
            if (seq !== tracerSeqRef.current) return;
            // Prune verdicts for legs no longer in the trace (bounded memory).
            const keep = new Set(legs.map((l) => l.key));
            for (const k of Array.from(cache.keys())) if (!keep.has(k)) cache.delete(k);
            // Failures outrank the held ctx in the strip — a half-graded
            // trace must not read "ready" while legs say "load failed".
            setTracerStatus(failStatus ?? (sawMarksOnly ? 'marksonly' : tracerCtxRef.current ? 'ready' : 'nochart'));
            // The pass is the unit of new knowledge — bank it so the NEXT
            // mount (reload, deploy, tab-bounce) re-grades nothing.
            persistLegVerdicts(cache, draftNow, draftAssumed, getEncRegistryVersion());
        })();
        // The stable identities below (five refs and the setters) are named
        // only to satisfy exhaustive-deps, which can no longer see they are
        // stable now that they arrive as parameters. Every one is stable for
        // MapHub's lifetime, so the EFFECTIVE deps are unchanged — which
        // matters here, because this is the most expensive effect in the
        // tracer and a genuinely wider dep would re-grade the whole route.
    }, [
        capturedCoords,
        coordCaptureMode,
        vessel,
        tracerCtxFromLru,
        tracerCtxHold,
        tracerCtxRef,
        tracerCtxLruRef,
        gradedDraftRef,
        setLegVerdicts,
        setTracerStatus,
        setTideLabels,
        setAckedLegs,
        setSailArmed,
        setShareArmed,
    ]);
    // Tide windows for sub-keel legs — async per shallow SPOT, cached by the
    // spot's position+depth (never by leg index: indices shift on insert/
    // delete, but the shallow patch itself doesn't move). Cached labels
    // re-attach synchronously after every re-grade, so a 30-pin trace
    // gaining pin 31 keeps its tide chips without a single WorldTides call;
    // the spot cache dies with the tracer context (draft/area change).
    useEffect(() => {
        if (!coordCaptureMode) return;
        const draftM = vesselDraftMetres(vessel);
        const next: Record<number, string> = {};
        legVerdicts.forEach((v, i) => {
            if (!v || !v.needsTide || v.minDepthM === null || !v.minAt) return;
            // Window anchored at the leg's ARRIVAL (departure + transit), not
            // "now" — the crossing question is about when you're THERE. The
            // 30-min ETA bucket in the cache key re-fetches when the departure
            // (or the route ahead of this leg) moves the arrival materially.
            const fromMs = (departureMs ?? Date.now()) + (legEtaOffsetsMs[i] ?? 0);
            const spot = `${v.minAt.lat.toFixed(5)}|${v.minAt.lon.toFixed(5)}|${v.minDepthM}|t${Math.round(fromMs / 1_800_000)}`;
            const cached = tideSpotCacheRef.current.get(spot);
            if (cached) {
                next[i] = cached;
                return;
            }
            if (tideReqRef.current.has(spot)) return;
            tideReqRef.current.add(spot);
            void tideWindowLabelFor(v.minDepthM, draftM, v.minAt, fromMs).then((label) => {
                if (!label) {
                    // Fetch failed (offline) — release the spot so a later
                    // pass retries; the old design got free retries from
                    // context rebuilds, the windowed design does not.
                    tideReqRef.current.delete(spot);
                    return;
                }
                if (!tideReqRef.current.has(spot)) return;
                tideSpotCacheRef.current.set(spot, label);
                // Index is valid for the verdicts THIS run saw; if the legs
                // shifted mid-fetch, the next re-grade re-syncs from cache.
                setTideLabels((prev) => ({ ...prev, [i]: label }));
            });
        });
        // Identity-preserving, mirroring the legVerdicts publish (audit rank 3):
        // this effect fires on every grading publish, and the common case is
        // `next === {}` (no sub-keel legs). An unconditional setState bought one
        // guaranteed extra full-tree render per pin interaction — on the exact
        // "more waypoints = slower" path. Bail when the map is unchanged.
        setTideLabels((prev) => {
            const pk = Object.keys(prev);
            const nk = Object.keys(next);
            if (pk.length === nk.length && nk.every((k) => prev[k as never] === next[k as never])) return prev;
            return next;
        });
    }, [legVerdicts, coordCaptureMode, vessel, departureMs, legEtaOffsetsMs, setTideLabels]);
}
