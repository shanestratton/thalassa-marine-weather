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
 * There is no app-boot trigger until the cost is measured on the phone.
 */
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from './authIdentityScope';
import { bankTraceVerification, loadSavedTraces } from './routeTracer';
import { traceFollowStatus, traceGeometryKey, traceRegistryScope } from './traceVerification';
import { getTraceCheckOutcome, recordTraceCheckOutcome, type TraceCheckOutcomeRecord } from './traceCheckOutcomes';
import type { RecheckReport } from './traceRecheck';
import { useSettingsStore } from '../stores/settingsStore';
import { vesselDraftIsAssumed, vesselDraftMetres } from './units';
import { createLogger } from '../utils/createLogger';

const log = createLogger('traceBackgroundCheck');
const RETRY_UNAVAILABLE_MS = 30 * 60_000;
const REPORTS_KEPT = 8;

export type TraceCheckWhy = 'sheet' | 'idle' | 'heal' | 'manual' | 'review' | 'online';
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
    controller: AbortController;
    abortedBy?: Pause | 'stop' | 'cancel';
}

let queue: Job[] = [];
let running: Job | null = null;
let states = new Map<string, TraceCheckState>();
let snapshot: TraceCheckSnapshot = { version: 0, states };
const reports = new Map<string, RecheckReport>();
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
    if (running) abort(running, why);
}

function pump(): void {
    if (running || !logPageActive || tracerActive || !visible()) return;
    const next = queue.shift();
    if (!next) return;
    const job: Job = { ...next, controller: new AbortController(), abortedBy: undefined };
    running = job;
    void run(job).finally(() => {
        if (running === job) running = null;
        pump();
    });
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
        const memoKey = `${id}|${geometryKey}|${draftM}|${draftAssumed}|${encFingerprint}`;
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
            reports.set(id, report);
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
    wire();
    const manual = why === 'manual' || why === 'review';
    const seen = new Set<string>();
    const fresh: Job[] = [];
    for (const id of ids) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (manual) stopped.delete(id);
        else if (stopped.has(id)) continue;
        if (running?.id === id) continue;
        const at = queue.findIndex((job) => job.id === id);
        if (at >= 0) {
            if (!manual) continue;
            queue.splice(at, 1);
        }
        fresh.push({ id, force: manual, controller: new AbortController() });
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

/** The last red finding's full report (this session only) — what the Log's
 *  in-place acknowledgement needs without grading the route again. */
export function getTraceCheckReport(id: string): RecheckReport | undefined {
    return reports.get(id);
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
    lastOnlineAt = 0;
    tracerActive = false;
    logPageActive = false;
    unwire?.();
    unwire = null;
}
