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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
    tideWindowLabelFor,
    persistLegVerdicts,
    hydrateLegVerdicts,
    type TracerContext,
    type TraceLegVerdict,
} from '../../services/routeTracer';
import { gradeLegs } from '../../services/traceGrading';
import { legCacheKey, TRACE_CLUSTER_SPAN_M } from './mapHubHelpers';
import { vesselAirDraftMetres, vesselDraftMetres, vesselDraftIsAssumed } from '../../services/units';
import { getVersion as getEncRegistryVersion, getRegistryFingerprint } from '../../services/enc/EncCellMetadata';
import { traceGeometryKey, type TraceCheckStatus } from '../../services/traceVerification';
import {
    boatHasLicensedCharts,
    boatRegistryState,
    boatRegistryWhy,
    ensureBoatRegistry,
    subscribeBoatRegistry,
} from '../../services/enc/piCellSync';

/** What the tracer card says while her licensed charts are not open here (decision 7a). */
export type TracerChartsWait = 'opening' | 'away' | 'tailnet' | 'slow';
/** How long a pass waits for the boat registry before grading as away ('slow'). */
const BOAT_WAIT_CAP_MS = 20_000;

/**
 * Volatile-failure retry ledger — MODULE scope on purpose (a ref dies with
 * the hook instance; the session-guard lesson). Keyed by leg key. Attempts
 * back off exponentially, and each entry remembers the ENC registry version
 * it failed under so a chart arriving mid-session retries immediately.
 */
const volatileRetrySchedule = new Map<string, { attempts: number; nextRetryAt: number; encVersion: number }>();
const VOLATILE_RETRY_BASE_MS = 60_000;
const VOLATILE_RETRY_MAX_MS = 30 * 60_000;

/** Mirrors MapHub's own tracerStatus union. */
export type TracerStatus = TraceCheckStatus;

/** What a published verdict array was graded FOR: these pins, this keel. */
export interface TracerGradedFor {
    geometryKey: string;
    draftM: number;
    draftAssumed: boolean;
    airDraftM: number | null;
}

/**
 * Every verdict array the grading pass publishes is tagged with the pins and
 * keel it was graded for (build 124). legVerdicts is MapHub state that lands a
 * render AFTER the pins or the vessel change, so anything that pairs it with
 * the line on screen — the tracer's auto-bank above all — must ask whether
 * the pairing is real. Keyed by array identity, so an untagged array (the
 * empty reset, or anything not from a pass) answers "not graded for this".
 */
const gradedFor = new WeakMap<ReadonlyArray<TraceLegVerdict | null>, TracerGradedFor>();

/** The grading identity of `verdicts` when it is exactly these pins at this
 *  vessel's keel and mast — otherwise null. */
export function tracerGradingMatches(
    verdicts: ReadonlyArray<TraceLegVerdict | null>,
    points: ReadonlyArray<{ lat: number; lon: number }>,
    vessel: TracerGradingDeps['vessel'],
): TracerGradedFor | null {
    const tag = gradedFor.get(verdicts);
    if (!tag || !tag.geometryKey || tag.geometryKey !== traceGeometryKey(points)) return null;
    if (tag.draftM !== vesselDraftMetres(vessel) || tag.draftAssumed !== vesselDraftIsAssumed(vessel)) return null;
    if ((tag.airDraftM ?? null) !== (vesselAirDraftMetres(vessel) ?? null)) return null;
    return tag;
}

/** FLAT on purpose. The hook destructures this immediately and every dep array
 *  names the individual members, never the object — the call site passes a
 *  fresh literal each render, so depping on the wrapper would turn the two
 *  most expensive effects in the tracer into per-render effects. */
export interface TracerGradingDeps {
    capturedCoords: { lat: number; lon: number }[];
    coordCaptureMode: boolean;
    /** settings.vessel — the object identity is the dep, as it is today. */
    vessel: { draft?: number; airDraft?: number; estimatedFields?: string[] } | null | undefined;
    legVerdicts: Array<TraceLegVerdict | null>;
    departureMs: number | null;
    legEtaOffsetsMs: number[];
    tracerCtxRef: { current: TracerContext | null };
    tracerCtxLruRef: { current: TracerContext[] };
    /** Shared with useTracerLegFixes, which reads it at fire time — so it is
     *  owned by MapHub, not by this hook. */
    gradedDraftRef: { current: { d: number; assumed: boolean; air?: number | null } | null };
    tracerCtxFromLru: (pts: ReadonlyArray<{ lat: number; lon: number }>) => TracerContext | null;
    tracerCtxHold: (ctx: TracerContext) => void;
    setLegVerdicts: Dispatch<SetStateAction<Array<TraceLegVerdict | null>>>;
    setTracerStatus: Dispatch<SetStateAction<TracerStatus>>;
    setTideLabels: Dispatch<SetStateAction<Record<number, string>>>;
    setAckedLegs: Dispatch<SetStateAction<Set<number>>>;
    setSailArmed: (v: boolean) => void;
    setShareArmed: (v: boolean) => void;
    /** MapHub's loading/no-chart lines and the release refusal read it (127-C-c 7a). */
    setTracerChartsWait?: (wait: TracerChartsWait | null) => void;
}

export interface TracerGrading {
    /**
     * Check grade stubs again on her charts (127-C-b): `keys` (legCacheKey),
     * else every stub on the line. Called only from her own taps — a stub row,
     * the Route report, Save — so a re-check that dies is never a launch loop.
     * A stub the charts cannot check right now stays banked as it was.
     */
    regradeStubLegs: (keys?: readonly string[]) => void;
}

export function useTracerGrading(deps: TracerGradingDeps): TracerGrading {
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
        setTracerChartsWait,
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
    /** The registry fingerprint the persisted verdict cache was last hydrated
     *  against (Shane 2026-07-17: "checks the entire route again, even though
     *  nothing changed" — the cache used to die with every remount/reload/
     *  tab-bounce). Keyed, not one-shot, since 127-C-c: the boat's licensed
     *  cells register after launch, and the bank must be read again then. An
     *  open-cell change mid-session costs one more localStorage read. */
    const hydratedForRef = useRef<string | null>(null);
    /** Legs graded away from her licensed charts: memory only, dropped when they open. */
    const provisionalKeysRef = useRef<Set<string>>(new Set());
    const pendingSinceRef = useRef<number | null>(null);
    const [capTick, setCapTick] = useState(0);
    // Transitions only (never per cell): at most two or three re-runs a launch.
    const boatState = useSyncExternalStore(subscribeBoatRegistry, boatRegistryState);
    // The tracer asks for the registry itself: it never waits for the auto-sync's
    // boot or plotting deferral (metadata only, no blobs).
    useEffect(() => {
        if (coordCaptureMode) void ensureBoatRegistry();
    }, [coordCaptureMode]);
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
    /** Stubs taken out for a re-check (127-C-b), banked as they were until a
     *  durable verdict replaces them. */
    const stubHoldRef = useRef<Map<string, TraceLegVerdict>>(new Map());
    const legKeysRef = useRef<string[]>([]);
    /** The line the last pass was run for: a re-check alone keeps her acks. */
    const lastLineRef = useRef<readonly unknown[]>([]);
    const [regradeTick, setRegradeTick] = useState(0);
    const regradeStubLegs = useCallback((keys?: readonly string[]) => {
        const cache = legCacheRef.current;
        let hit = false;
        for (const key of keys ?? legKeysRef.current) {
            const v = cache.get(key);
            if (!v?.stub) continue;
            stubHoldRef.current.set(key, v);
            cache.delete(key);
            hit = true;
        }
        if (hit) setRegradeTick((n) => n + 1);
    }, []);
    // ── Route Tracer validation ──
    // Build/refresh the tracer context, then grade every leg. Rebuilds when a
    // pin lands outside the current grid's padded bbox OR the vessel draft
    // changed (a ctx keeps grading against the keel it was BUILT with —
    // adversarial-audit critical #1: edit draft 1.9→2.6 m and a green bar
    // crossing stayed green).
    useEffect(() => {
        const line = [capturedCoords, coordCaptureMode, vessel];
        const recheckOnly = line.every((part, i) => part === lastLineRef.current[i]);
        lastLineRef.current = line;
        if (!recheckOnly) {
            setSailArmed(false); // a changed line always re-earns its "Sail anyway"
            // Ack indices die with the old leg list — but IDENTITY-PRESERVING:
            // an unconditional new Set() forced a full 7k-line MapHub render on
            // EVERY pin edit even when no acks existed (jank audit #4).
            setAckedLegs((s) => (s.size === 0 ? s : new Set()));
            setShareArmed(false); // consent never outlives the line it was given for
        }
        if (!coordCaptureMode || capturedCoords.length === 0) {
            // Kill any in-flight grading pass — un-superseded, it would
            // resurrect the old trace's verdicts/status over Clear/Done.
            tracerSeqRef.current++;
            if (capturedCoords.length === 0) {
                setLegVerdicts([]);
                legCacheRef.current.clear();
                failVerdictsRef.current.clear();
                stubHoldRef.current.clear();
            }
            return;
        }
        const seq = ++tracerSeqRef.current;
        // ── The boat registry gate (127-C-c decision 7a) ──
        let wait: TracerChartsWait | null = null;
        if (boatState === 'pending') {
            const since = (pendingSinceRef.current ??= Date.now());
            const left = BOAT_WAIT_CAP_MS - (Date.now() - since);
            if (left > 0) {
                // No hydrate, no grade, no persist: the rows say "checking…".
                setTracerChartsWait?.('opening');
                const n = capturedCoords.length - 1;
                setLegVerdicts((prev) =>
                    prev.length === n && prev.every((v) => v === null) ? prev : new Array(n).fill(null),
                );
                setTracerStatus('loading');
                const timer = setTimeout(() => setCapTick((t) => t + 1), left);
                return () => clearTimeout(timer);
            }
            wait = 'slow';
        } else pendingSinceRef.current = null;
        // Away from her licensed charts (or the wait capped): legs graded now
        // are provisional. Unknown counts as licensed while paired.
        const provisional = (wait === 'slow' || boatState === 'away') && boatHasLicensedCharts();
        if (provisional) wait ??= boatRegistryWhy() === 'tailnet' ? 'tailnet' : 'away';
        setTracerChartsWait?.(provisional ? wait : null);
        if (!provisional && provisionalKeysRef.current.size) {
            // Her charts opened: what was graded without them goes, so the bank wins.
            for (const key of provisionalKeysRef.current) {
                legCacheRef.current.delete(key);
                failVerdictsRef.current.delete(key);
            }
            provisionalKeysRef.current.clear();
        }
        const draftNow = vesselDraftMetres(vessel);
        const draftAssumed = vesselDraftIsAssumed(vessel);
        // The mast: legs are graded against bridges and overhead lines for
        // THIS air draft (TracerContext.clearanceBars), so it keys the caches
        // exactly as the keel does.
        const airNow = vesselAirDraftMetres(vessel);

        // Draft change invalidates EVERY cached verdict and tide label —
        // they were graded against the old keel (adversarial-audit critical
        // #1); keyed on the draft the CACHE saw, not on the ctx (Done nulls
        // the ctx but keeps the cache). Area growth does NOT invalidate:
        // chart data is static for the session, so a verdict graded in an
        // earlier window stays true forever.
        const prevDraft = gradedDraftRef.current;
        if (
            prevDraft &&
            (prevDraft.d !== draftNow || prevDraft.assumed !== draftAssumed || (prevDraft.air ?? null) !== airNow)
        ) {
            tracerCtxRef.current = null;
            tracerCtxLruRef.current = []; // grids were built FOR the old keel
            legCacheRef.current.clear();
            stubHoldRef.current.clear();
            tideSpotCacheRef.current.clear();
            setTideLabels({});
            tideReqRef.current.clear();
        }
        gradedDraftRef.current = { d: draftNow, assumed: draftAssumed, air: airNow };
        const cache = legCacheRef.current;
        const fingerprint = getRegistryFingerprint();
        if (hydratedForRef.current !== fingerprint) {
            hydratedForRef.current = fingerprint;
            // Same keel + same chart library ⇒ yesterday's verdicts are
            // today's verdicts; anything else returns null and we re-grade.
            // Library identity is the FINGERPRINT (stable across reloads),
            // never the in-memory version counter (boot-scoped — using it
            // meant hydration never matched and every mount cold-regraded).
            const persisted = hydrateLegVerdicts(draftNow, draftAssumed, fingerprint, airNow);
            if (persisted) for (const [k, v] of persisted) if (!cache.has(k)) cache.set(k, v);
        }
        // Failure verdicts retry with BACKOFF, not on every pass. Retrying
        // unconditionally meant a window that persistently degrades (marker
        // fetch failing, genuinely uncharted water, a build that keeps
        // throwing) re-paid its 14-39s context build + cloud overlay fetch
        // on every effect re-run, forever — the 2026-08-04 dockside regrade
        // loop. A leg keeps its caution row while it waits; it retries when
        // its backoff elapses OR the ENC registry changes (a chart appearing
        // mid-session still heals the legs immediately).
        const failMap = failVerdictsRef.current;
        const nowMs = Date.now();
        const registryNow = getEncRegistryVersion();
        for (const key of Array.from(failMap.keys())) {
            const sched = volatileRetrySchedule.get(key);
            if (!sched || nowMs >= sched.nextRetryAt || sched.encVersion !== registryNow) {
                failMap.delete(key);
            }
        }

        const legs: Array<{ a: { lat: number; lon: number }; b: { lat: number; lon: number }; key: string }> = [];
        for (let i = 1; i < capturedCoords.length; i++) {
            legs.push({
                a: capturedCoords[i - 1],
                b: capturedCoords[i],
                key: legCacheKey(capturedCoords[i - 1], capturedCoords[i], i === capturedCoords.length - 1),
            });
        }
        legKeysRef.current = legs.map((l) => l.key);
        // Held stubs off this line are dropped; those on it are graded below,
        // and banked as they were until a durable verdict replaces them.
        const hold = stubHoldRef.current;
        for (const key of Array.from(hold.keys())) if (!legKeysRef.current.includes(key)) hold.delete(key);
        for (const key of hold.keys()) cache.delete(key);
        // The persist rule (7a): never from a provisional pass, so an ashore
        // launch leaves the aboard bank as it was.
        const bank = (): void => {
            if (provisional) return;
            persistLegVerdicts(
                hold.size ? new Map([...hold, ...cache]) : cache,
                draftNow,
                draftAssumed,
                getRegistryFingerprint(),
                airNow,
            );
        };
        const passFor: TracerGradedFor = {
            geometryKey: traceGeometryKey(capturedCoords),
            draftM: draftNow,
            draftAssumed,
            airDraftM: airNow ?? null,
        };
        const publish = (): void => {
            if (seq !== tracerSeqRef.current) return;
            // Identity-preserving: cache entries are stable objects, so an
            // element-wise match means NOTHING changed — return prev and no
            // re-render happens. Without this every publish minted a fresh
            // array, and each one cascaded into a full trace-line re-sync
            // (4× setData + chevron re-layout) + tide-label pass + panel
            // render — 3-5 wasted cycles per pin add (perf hunt 2026-07-15).
            const next = legs.map((l) => cache.get(l.key) ?? failMap.get(l.key) ?? null);
            setLegVerdicts((prev) => {
                const out = prev.length === next.length && next.every((v, i) => v === prev[i]) ? prev : next;
                gradedFor.set(out, passFor);
                return out;
            });
        };
        publish(); // cached legs render NOW; only truly new legs show "checking…"

        // A leg still sitting in failMap is a volatile failure inside its
        // backoff window: keep showing its caution row, don't rebuild.
        const pending = legs.filter((l) => !cache.has(l.key) && !failMap.has(l.key));
        if (pending.length === 0) {
            setTracerStatus('ready');
            return;
        }

        void (async () => {
            // The grading loop itself now lives in services/traceGrading so the
            // headless recheck drives the SAME code. Everything this hook cares
            // about that the loop does not — the verdict cache, the volatile
            // backoff ledger, incremental publish, persistence, supersession by
            // a newer pin — stays here and arrives as policy.
            const result = await gradeLegs(pending, {
                draftM: draftNow,
                draftAssumed,
                airDraftM: airNow,
                clusterSpanM: TRACE_CLUSTER_SPAN_M,
                ctxFromLru: tracerCtxFromLru,
                holdCtx: tracerCtxHold,
                superseded: () => seq !== tracerSeqRef.current,
                isDecided: (key) => cache.has(key) || failMap.has(key),
                onStatus: (status) => setTracerStatus(status),
                onLeg: (key, verdict, isVolatile) => {
                    const held = hold.get(key);
                    hold.delete(key);
                    if (isVolatile && held) {
                        // The charts could not check it now: keep the stub.
                        cache.set(key, held);
                    } else if (isVolatile) {
                        failMap.set(key, verdict);
                        const prev = volatileRetrySchedule.get(key);
                        const attempts = (prev?.attempts ?? 0) + 1;
                        volatileRetrySchedule.set(key, {
                            attempts,
                            nextRetryAt:
                                Date.now() +
                                Math.min(VOLATILE_RETRY_BASE_MS * 2 ** (attempts - 1), VOLATILE_RETRY_MAX_MS),
                            encVersion: getEncRegistryVersion(),
                        });
                    } else {
                        cache.set(key, verdict);
                        if (provisional) provisionalKeysRef.current.add(key);
                        volatileRetrySchedule.delete(key);
                    }
                },
                onClusterDone: () => {
                    publish();
                    // Bank after EVERY cluster, not only at the end of the pass.
                    // The 2026-08-10 desktop trail died at the final ctx-ready
                    // of a ~20-window cold pass — before the end-of-pass
                    // persist — so the next boot cold-graded all 20 windows
                    // again and died again: a crash loop whose every lap does
                    // the exact work that kills. Banking incrementally means
                    // each attempt KEEPS its progress.
                    bank();
                },
            });
            if (result.superseded || seq !== tracerSeqRef.current) return;
            // Prune verdicts for legs no longer in the trace (bounded memory).
            const keep = new Set(legs.map((l) => l.key));
            for (const k of Array.from(cache.keys())) if (!keep.has(k)) cache.delete(k);
            for (const k of Array.from(volatileRetrySchedule.keys())) if (!keep.has(k)) volatileRetrySchedule.delete(k);
            setTracerStatus(result.status);
            // The pass is the unit of new knowledge — bank it so the NEXT mount
            // (reload, deploy, tab-bounce) re-grades nothing.
            bank();
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
        regradeTick,
        boatState,
        capTick,
        setTracerChartsWait,
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
    return { regradeStubLegs };
}
