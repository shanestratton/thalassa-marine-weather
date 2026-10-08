/**
 * Background route re-checks — one route at a time, while the Log page is
 * open (build 124, B4).
 *
 * Shane, 2026-10-08: "punters just aren't going to use it." A lost or aged
 * check used to mean opening Route Tracer and nearly starting again; now the
 * amber rows re-check themselves. Each run is recheckTrace EXACTLY as written
 * — cold (no held windows, no verdict cache), unable to clear an
 * unacknowledged danger leg, refusing on degraded data — and the outcome is
 * classified by its CONTENTS (needsTracer is also true when status is
 * 'ready', so it cannot tell a finding from a refusal):
 *
 *   ok → bank (green) · danger legs nobody acknowledged → red finding ·
 *   no report → unavailable (retryable) · tide unresolved → tide · no chart
 *   → nochart.
 *
 * Lazy by design. A cold check of Newport → Airlie is minutes of 20 km chart
 * windows (each ~200 MB transient, serialised behind the tracer's own
 * contextBuildQueue and heap gates), so this runs only while the page is
 * visible, the Log page is mounted and Route Tracer is NOT open — the two
 * share that queue and must never compete. It never repeats an attempt whose
 * inputs (pins, draft, chart library) have not changed, except an
 * unavailable one after 30 minutes or a reconnect, or a skipper's Check now.
 *
 * 125-07: the held chart memory (the hidden tracer's windows, the parsed ENC
 * cells) is freed before each check and when the queue runs dry; a red row's
 * Review reuses its report only while the attempt memoKey still matches; and
 * a boot-time idle pass exists but is DARK (BOOT_IDLE_RECHECK_ENABLED).
 */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from './authIdentityScope';
import { bankTraceVerification, loadSavedTraces, type TracePoint } from './routeTracer';
import { traceFollowStatus, traceGeometryKey, traceRegistryScope } from './traceVerification';
import { getTraceCheckOutcome, recordTraceCheckOutcome, type TraceCheckOutcomeRecord } from './traceCheckOutcomes';
import type { RecheckReport } from './traceRecheck';
import { useSettingsStore } from '../stores/settingsStore';
import { vesselDraftIsAssumed, vesselDraftMetres } from './units';
import { createLogger } from '../utils/createLogger';
import { awaitHeapHeadroom, heapHeadroomOk, heapTag } from '../utils/heapGauge';

const log = createLogger('traceBackgroundCheck');
const RETRY_UNAVAILABLE_MS = 30 * 60_000;
const REPORTS_KEPT = 8;

/**
 * The boot-time idle re-check — DARK. It reverses the 124 call ("Log page
 * only, no boot trigger"), so it stays off until the 125-11 memory census
 * shows headroom with it running on the phone, and Shane switches it on.
 * Not a Preference: a punter cannot turn it on either.
 */
export const BOOT_IDLE_RECHECK_ENABLED = false;
/** After boot, before the first check: out of the cold-start window. */
const BOOT_IDLE_DELAY_MS = 30_000;

export type TraceCheckWhy = 'sheet' | 'idle' | 'heal' | 'manual' | 'review' | 'online' | 'boot';
export type TraceCheckResult =
    | 'banked'
    | TraceCheckOutcomeRecord['kind']
    | 'nodraft'
    | 'checked'
    | 'memo'
    | 'stopped'
    | 'cancelled'
    | 'gone'
    | 'moved'
    | 'storage'
    | 'scope'
    | 'error';
export type TraceCheckState =
    | { phase: 'queued' }
    | { phase: 'checking'; done: number; total: number }
    | { phase: 'done'; result: TraceCheckResult };
export interface TraceCheckSnapshot {
    version: number;
    states: ReadonlyMap<string, TraceCheckState>;
}

type Pause = 'tracer' | 'hidden' | 'away';
interface Job {
    id: string;
    force: boolean;
    /** A boot job may run without the Log page (the dark boot pass). */
    boot: boolean;
    controller: AbortController;
    abortedBy?: Pause | 'stop' | 'cancel';
    /** It reached the grader (and so built chart windows). */
    graded?: boolean;
}

let queue: Job[] = [];
let running: Job | null = null;
let states = new Map<string, TraceCheckState>();
let snapshot: TraceCheckSnapshot = { version: 0, states };
/** A red finding's report as graded: the pins it was graded on and the
 *  attempt memoKey (pins | draft | charts) it holds for. */
export interface HeldTraceCheckReport {
    report: RecheckReport;
    points: TracePoint[];
    memoKey: string;
}
const reports = new Map<string, HeldTraceCheckReport>();
/** Ways to drop memory held outside this queue (MapHub's hidden tracer windows). */
const releasers = new Set<() => void>();
const stopped = new Set<string>();
const unavailable = new Set<string>();
/** Passed checks this phone's storage refused to keep, by attempt memo key —
 *  in-session only, so a full phone is not re-graded on every Log visit. */
const storageRefused = new Map<string, string>();
const listeners = new Set<() => void>();
let lastOnlineAt = 0;
let tracerActive = false;
let logPageActive = false;
let unwire: (() => void) | null = null;

function emit(): void {
    snapshot = { version: snapshot.version + 1, states: new Map(states) };
    for (const listener of [...listeners]) listener();
}

function setState(id: string, state: TraceCheckState): void {
    states.set(id, state);
    emit();
}

function finish(id: string, result: TraceCheckResult, detail: string): void {
    log.warn(`background check ${result} for ${id}: ${detail}`);
    setState(id, { phase: 'done', result });
}

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

function wire(): void {
    if (unwire || typeof window === 'undefined') return;
    const onVisibility = () => (visible() ? pump() : pause('hidden'));
    const onOnline = () => {
        lastOnlineAt = Date.now();
        enqueueTraceChecks([...unavailable], 'online');
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    const unsubscribe = subscribeAuthIdentityScope(() => {
        cancelTraceChecks('account changed');
        states = new Map();
        reports.clear();
        stopped.clear();
        unavailable.clear();
        storageRefused.clear();
        emit();
    });
    unwire = () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('online', onOnline);
        unsubscribe();
    };
}

function abort(job: Job, by: NonNullable<Job['abortedBy']>): void {
    // A Stop or cancel overrides a pause still settling (it must not requeue).
    if (job.abortedBy && by !== 'stop' && by !== 'cancel') return;
    job.abortedBy = by;
    job.controller.abort();
}

function pause(why: Pause): void {
    // A boot job never needed the Log page, so leaving it does not stop one.
    if (running && !(why === 'away' && running.boot)) abort(running, why);
}

const runnable = (job: Job) => logPageActive || job.boot;

function pump(): void {
    if (running || tracerActive || !visible()) return;
    const at = queue.findIndex(runnable);
    if (at < 0) return;
    const [next] = queue.splice(at, 1);
    const job: Job = { ...next, controller: new AbortController(), abortedBy: undefined, graded: false };
    running = job;
    void run(job).finally(() => {
        if (running === job) running = null;
        // Only when the queue has really drained — a job paused because the
        // skipper left (requeued, not runnable now) is not an end, and freeing
        // then lands on whatever page is on screen (the chart's parsed cells).
        const paused = job.abortedBy === 'tracer' || job.abortedBy === 'hidden' || job.abortedBy === 'away';
        if (job.graded && !paused && !queue.some(runnable)) releaseHeldMemory('end');
        pump();
    });
}

/**
 * Free the chart memory a check leaves behind or finds held — before each
 * check and when the queue runs dry (125-07). A cold window is ~200 MB of
 * transient; landing one on 48 MB of a hidden tracer's held grids and a full
 * ENC blob LRU is the 2 GB WebContent jetsam pattern. Never while Route
 * Tracer holds the queue: those windows are the ones it is drawing with.
 */
function releaseHeldMemory(when: 'between' | 'end'): void {
    if (tracerActive) return;
    for (const release of [...releasers]) {
        try {
            release();
        } catch (error) {
            log.warn('a memory release failed:', error);
        }
    }
    void import('./enc/EncCellStore').then(({ releaseBlobCache }) => releaseBlobCache()).catch(() => undefined);
    log.warn(`background check freed held chart memory (${when})${heapTag()}`);
}

function settleAborted(job: Job): void {
    const by = job.abortedBy;
    if (by === 'tracer' || by === 'hidden' || by === 'away') {
        // A pause, not a decision: back to the front for when it may run.
        if (!queue.some((queued) => queued.id === job.id)) queue.unshift(job);
        log.warn(`background check paused for ${job.id} (${by})`);
        setState(job.id, { phase: 'queued' });
        return;
    }
    finish(job.id, by === 'stop' ? 'stopped' : 'cancelled', 'aborted before it finished; nothing written');
}

async function run(job: Job): Promise<void> {
    const { id } = job;
    const signal = job.controller.signal;
    const scope = getAuthIdentityScope();
    try {
        const trace = loadSavedTraces(scope).find((candidate) => candidate.id === id);
        if (!trace) return finish(id, 'gone', 'route no longer saved on this device');
        const vessel = useSettingsStore.getState().settings?.vessel;
        const draftM = vesselDraftMetres(vessel);
        const draftAssumed = vesselDraftIsAssumed(vessel);
        const prior = getTraceCheckOutcome(id, scope);
        const status = traceFollowStatus(
            trace.verification,
            trace.points,
            { draftM, draftAssumed, nowMs: Date.now() },
            prior,
        );
        if (status.tone === 'checked') return finish(id, 'checked', 'already checked');
        if (draftAssumed) return finish(id, 'nodraft', 'no draft set; a guessed keel is never graded');

        const [{ recheckTrace, inheritableAcks }, { getRegistryFingerprint }] = await Promise.all([
            import('./traceRecheck'),
            import('./enc/EncCellMetadata'),
        ]);
        if (signal.aborted) return settleAborted(job);
        const geometryKey = traceGeometryKey(trace.points);
        const encFingerprint = getRegistryFingerprint(traceRegistryScope(trace.points));
        const memoKey = attemptMemoKey(id, trace.points, draftM, draftAssumed, encFingerprint);
        if (!job.force && prior?.memoKey === memoKey) {
            const at = Date.parse(prior.at);
            const retry =
                prior.kind === 'unavailable' && (Date.now() - at >= RETRY_UNAVAILABLE_MS || lastOnlineAt > at);
            if (!retry) return finish(id, 'memo', `same pins, draft and charts already gave ${prior.kind}`);
        }
        if (!job.force && storageRefused.get(id) === memoKey) {
            return finish(id, 'memo', 'same pins, draft and charts passed earlier but storage refused the result');
        }

        setState(id, { phase: 'checking', done: 0, total: trace.points.length - 1 });
        releaseHeldMemory('between');
        job.graded = true;
        const outcome = await recheckTrace(trace.points, {
            priorVerification: trace.verification ?? null,
            signal,
            onProgress: (done, total) => {
                if (!signal.aborted) setState(id, { phase: 'checking', done, total });
            },
        });
        if (signal.aborted) return settleAborted(job);
        if (!isAuthIdentityScopeCurrent(scope))
            return finish(id, 'scope', 'account changed mid-check; nothing written');
        const now = loadSavedTraces(scope).find((candidate) => candidate.id === id);
        if (!now || traceGeometryKey(now.points) !== geometryKey) {
            return finish(id, 'moved', 'pins changed mid-check; nothing written');
        }

        if (outcome.ok) {
            const bank = bankTraceVerification(id, outcome.verification, scope);
            if (bank.banked) {
                storageRefused.delete(id);
                return finish(id, 'banked', 'route checked and banked');
            }
            if (bank.reason === 'storage') storageRefused.set(id, memoKey);
            return finish(
                id,
                bank.reason === 'older' ? 'checked' : (bank.reason ?? 'error'),
                `not banked (${bank.reason})`,
            );
        }

        const report = outcome.report;
        // Red is ONLY danger nobody accepted. recheckTrace carries the skipper's
        // earlier acknowledgements forward under its strict rule (same charts,
        // same keel, every danger leg already acked); a refusal for another
        // reason — a tide lookup that failed — must not turn those accepted
        // legs into a finding. Same rule, same inputs, so the answers agree.
        const accepted = report
            ? inheritableAcks(
                  trace.verification,
                  report.verdicts,
                  getRegistryFingerprint(traceRegistryScope(trace.points)),
                  draftM,
                  draftAssumed,
              )
            : new Set<number>();
        const legs = (report?.verdicts ?? []).flatMap((verdict, index) =>
            verdict?.grade === 'danger' && !accepted.has(index)
                ? [
                      {
                          from: index + 1,
                          to: index + 2,
                          message: verdict.issues.find((issue) => issue.severity === 'danger')?.message ?? 'no-go leg',
                      },
                  ]
                : [],
        );
        const kind: TraceCheckOutcomeRecord['kind'] =
            report && legs.length > 0
                ? 'finding'
                : !report
                  ? 'unavailable'
                  : report.verdicts.some((verdict) => verdict?.needsTide) && !report.tideWindowLabel
                    ? 'tide'
                    : ['nochart', 'marksonly', 'toolarge'].includes(report.status)
                      ? 'nochart'
                      : 'unavailable';
        recordTraceCheckOutcome(
            id,
            {
                geometryKey,
                draftM,
                draftAssumed,
                encFingerprint,
                at: new Date().toISOString(),
                kind,
                reason: outcome.reason,
                memoKey,
                ...(kind === 'finding' && report
                    ? { legs, ackable: legs.every((leg) => report.ackableDangerLegs.includes(leg.from - 1)) }
                    : {}),
            },
            scope,
        );
        if (kind === 'finding' && report) {
            reports.delete(id);
            reports.set(id, { report, points: trace.points.map((p) => ({ lat: p.lat, lon: p.lon })), memoKey });
            if (reports.size > REPORTS_KEPT) reports.delete(reports.keys().next().value as string);
        }
        if (kind === 'unavailable') unavailable.add(id);
        else unavailable.delete(id);
        return finish(id, kind, outcome.reason);
    } catch (error) {
        return finish(id, 'error', error instanceof Error ? error.message : String(error));
    }
}

/**
 * Queue routes for a background check. Automatic triggers ('sheet', 'idle',
 * 'heal', 'online') append, skip duplicates and respect a Stop; 'manual'
 * (Check now) and 'review' jump the queue and ignore the attempt memo.
 */
export function enqueueTraceChecks(ids: readonly string[], why: TraceCheckWhy): void {
    const boot = why === 'boot';
    wire();
    const manual = why === 'manual' || why === 'review';
    const seen = new Set<string>();
    const fresh: Job[] = [];
    for (const id of ids) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (manual) stopped.delete(id);
        else if (stopped.has(id)) continue;
        // A boot pass that finds its route already queued or running for the
        // Log page adopts that job: it then runs (and keeps running) without
        // the Log page, or the boot pass would wait on it forever.
        if (running?.id === id) {
            if (boot) running.boot = true;
            continue;
        }
        const at = queue.findIndex((job) => job.id === id);
        if (at >= 0) {
            if (!manual) {
                if (boot && !queue[at].boot) {
                    queue[at] = { ...queue[at], boot: true };
                    pump();
                }
                continue;
            }
            queue.splice(at, 1);
        }
        fresh.push({ id, force: manual, boot, controller: new AbortController() });
    }
    if (fresh.length === 0) return;
    queue = manual ? [...fresh, ...queue] : [...queue, ...fresh];
    for (const job of fresh) states.set(job.id, { phase: 'queued' });
    emit();
    pump();
}

/** Cancel queued and running checks — all, or just `ids`. why 'stop' is the
 *  skipper's Stop: automatic triggers then leave those routes alone. */
export function cancelTraceChecks(why: string, ids?: readonly string[]): void {
    const match = (id: string) => !ids || ids.includes(id);
    const userStop = why === 'stop';
    if (userStop) for (const id of ids ?? []) stopped.add(id);
    queue = queue.filter((job) => {
        if (!match(job.id)) return true;
        states.set(job.id, { phase: 'done', result: userStop ? 'stopped' : 'cancelled' });
        return false;
    });
    if (running && match(running.id)) abort(running, userStop ? 'stop' : 'cancel');
    log.warn(`background checks cancelled (${why})`);
    emit();
}

/**
 * Does Route Tracer hold the chart-build queue right now? Only while it is ON
 * SCREEN or still grading — never on capture mode alone, because MapHub stays
 * alive hidden after the tracer and only the Obs tab ends capture: keyed on
 * that, every Log visit after any tracer visit sat at "Waiting to check…".
 */
export function tracerBlocksBackgroundChecks(tracer: {
    captureMode: boolean;
    onScreen: boolean;
    grading: boolean;
}): boolean {
    return tracer.captureMode && (tracer.onScreen || tracer.grading);
}

/** Route Tracer holds the queue: stop now, and run nothing until it lets go. */
export function setTracerActive(active: boolean): void {
    if (tracerActive === active) return;
    tracerActive = active;
    if (active) pause('tracer');
    else pump();
}

/** The Log page mounts (true) and unmounts (false). */
export function setLogPageActive(active: boolean): void {
    if (logPageActive === active) return;
    logPageActive = active;
    if (active) {
        wire();
        pump();
    } else pause('away');
}

export function subscribeTraceChecks(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getTraceCheckSnapshot(): TraceCheckSnapshot {
    return snapshot;
}

/** traceId|geometryKey|draftM|draftAssumed|encFingerprint — what an attempt
 *  depended on. The same key gives the same answer. */
function attemptMemoKey(
    id: string,
    points: readonly TracePoint[],
    draftM: number,
    draftAssumed: boolean,
    encFingerprint: string,
): string {
    return `${id}|${traceGeometryKey(points)}|${draftM}|${draftAssumed}|${encFingerprint}`;
}

/** The held report for `id` if its memoKey matches the route's pins, the
 *  boat's draft and the chart library NOW; a stale one is dropped. Sync. */
function currentHeldReport(
    id: string,
    getRegistryFingerprint: typeof import('./enc/EncCellMetadata').getRegistryFingerprint,
): HeldTraceCheckReport | undefined {
    const held = reports.get(id);
    if (!held) return undefined;
    const trace = loadSavedTraces().find((candidate) => candidate.id === id);
    const vessel = useSettingsStore.getState().settings?.vessel;
    const now = trace
        ? attemptMemoKey(
              id,
              trace.points,
              vesselDraftMetres(vessel),
              vesselDraftIsAssumed(vessel),
              getRegistryFingerprint(traceRegistryScope(trace.points)),
          )
        : null;
    if (now === held.memoKey) return held;
    reports.delete(id);
    log.warn(`stored report for ${id} no longer matches its pins, draft or charts; re-checking`);
    return undefined;
}

/**
 * The last red finding's full report (this session only) — what the Log's
 * in-place acknowledgement needs without grading the route again — with the
 * pins it was graded on, but only while its memoKey still matches the route's
 * pins, the boat's draft and the chart library NOW (125-07). Otherwise it is
 * dropped and the caller re-runs: a moved pin, a new keel or new charts never
 * reopen a stale red report.
 */
export async function getCurrentTraceCheckReport(id: string): Promise<HeldTraceCheckReport | undefined> {
    if (!reports.has(id)) return undefined;
    const { getRegistryFingerprint } = await import('./enc/EncCellMetadata');
    return currentHeldReport(id, getRegistryFingerprint);
}

/**
 * Run `act` (the acknowledgement's release gate and bank) only while the
 * report on the sheet is still THE held report and its memoKey still matches
 * — compared and acted on in one synchronous step, so a draft sync or a chart
 * install while the sheet was open can never bank verdicts graded for another
 * keel or other charts. undefined: it went stale; close the sheet and re-run.
 */
export async function actOnCurrentTraceCheckReport<T>(
    id: string,
    expected: RecheckReport,
    act: (held: HeldTraceCheckReport) => T,
): Promise<T | undefined> {
    if (reports.get(id)?.report !== expected) return undefined;
    const { getRegistryFingerprint } = await import('./enc/EncCellMetadata');
    const held = currentHeldReport(id, getRegistryFingerprint);
    return held && held.report === expected ? act(held) : undefined;
}

/**
 * What MapHub keeps of its tracer windows when a background check frees
 * memory: nothing — unless a hidden Route Tracer still holds pins, when the
 * window that trace is using stays (lead and water snapping and the
 * pin-on-land hint read it; rebuilding it is a 14–39 s cold build) and only
 * the rest of the LRU goes.
 */
export function tracerWindowsAfterRelease<T>(
    current: T | null,
    lru: readonly T[],
    tracingPins: boolean,
): { current: T | null; lru: T[] } {
    if (!tracingPins || current === null) return { current: null, lru: [] };
    return { current, lru: lru.filter((held) => held === current) };
}

/** Drop memory held outside the queue between checks (MapHub's hidden tracer
 *  windows). Returns the unregister. */
export function registerTraceCheckMemoryRelease(release: () => void): () => void {
    releasers.add(release);
    return () => releasers.delete(release);
}

export type BootRecheckResult = 'off' | 'low-headroom' | 'done' | 'scope';

/**
 * The boot-time idle re-check (125-07) — DARK: returns 'off' at once unless
 * BOOT_IDLE_RECHECK_ENABLED (or a test) switches it on. When on: wait out the
 * cold start, then re-check the amber passage-linked routes ONE at a time,
 * through the same queue (cold, never clearing a danger leg, refusing on
 * degraded data), each only after awaitHeapHeadroom and only while the heap
 * gauge reads above its line. No reading at all is not headroom: skipped.
 */
export async function runBootIdleRecheck(
    opts: { enabled?: boolean; delayMs?: number } = {},
): Promise<BootRecheckResult> {
    if (!(opts.enabled ?? BOOT_IDLE_RECHECK_ENABLED)) return 'off';
    const scope = getAuthIdentityScope();
    await new Promise((resolve) => setTimeout(resolve, opts.delayMs ?? BOOT_IDLE_DELAY_MS));
    const tried = new Set<string>();
    for (;;) {
        if (!isAuthIdentityScopeCurrent(scope)) return 'scope';
        const vessel = useSettingsStore.getState().settings?.vessel;
        const context = {
            draftM: vesselDraftMetres(vessel),
            draftAssumed: vesselDraftIsAssumed(vessel),
            nowMs: Date.now(),
        };
        if (context.draftAssumed) return 'done'; // a guessed keel is never graded
        const next = loadSavedTraces(scope).find(
            (trace) =>
                !tried.has(trace.id) &&
                !!(trace.passageVoyageId || trace.plannedRouteId) &&
                traceFollowStatus(trace.verification, trace.points, context, getTraceCheckOutcome(trace.id, scope))
                    .tone === 'unchecked',
        );
        if (!next) return 'done';
        tried.add(next.id);
        await awaitHeapHeadroom();
        if ((await heapHeadroomOk()) !== true) {
            log.warn(`boot re-check skipped: below the heap headroom line${heapTag()}`);
            return 'low-headroom';
        }
        if (!isAuthIdentityScopeCurrent(scope)) return 'scope';
        enqueueTraceChecks([next.id], 'boot');
        await new Promise<void>((resolve) => {
            const settled = () => {
                const state = states.get(next.id);
                if (state && state.phase !== 'done') return;
                listeners.delete(settled);
                resolve();
            };
            listeners.add(settled);
            settled();
        });
    }
}

export function __resetTraceBackgroundCheckForTest(): void {
    if (running) abort(running, 'cancel');
    running = null;
    queue = [];
    states = new Map();
    snapshot = { version: 0, states };
    reports.clear();
    stopped.clear();
    unavailable.clear();
    storageRefused.clear();
    listeners.clear();
    releasers.clear();
    lastOnlineAt = 0;
    tracerActive = false;
    logPageActive = false;
    unwire?.();
    unwire = null;
}
