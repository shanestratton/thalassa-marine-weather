/**
 * The background re-check queue (build 124, B4): amber routes are re-checked
 * by themselves, one at a time, while the Log page is open — cold, exactly as
 * traceRecheck runs (no verdict cache, never clearing an unacknowledged danger
 * leg, refusing on degraded data). Lazy by design: a check costs minutes of
 * cold chart windows on a long passage, so it never competes with Route
 * Tracer, never runs hidden, and never repeats an attempt that cannot change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecheckOutcome } from '../services/traceRecheck';

const hoisted = vi.hoisted(() => ({
    recheck: vi.fn(),
    fingerprint: 'GB4X0001@1',
    vessel: { draft: 1.8 * 3.28084, estimatedFields: [] as string[] },
    visibility: 'visible' as DocumentVisibilityState,
}));

// The real inheritableAcks (the queue classifies with the SAME ack rule the
// re-check applies); only the grading run itself is stubbed.
vi.mock('../services/traceRecheck', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/traceRecheck')>()),
    recheckTrace: hoisted.recheck,
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => 1,
    getRegistryFingerprint: () => hoisted.fingerprint,
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: hoisted.vessel } }) },
}));
vi.mock('../services/VoyageService', () => ({ refreshSavedRouteVoyageVerification: vi.fn(async () => ({})) }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { loadSavedTraces, saveTrace, type TraceLegVerdict, type TracePoint } from '../services/routeTracer';
import { evaluateTraceRelease, traceFollowStatus } from '../services/traceVerification';
import { getTraceCheckOutcome } from '../services/traceCheckOutcomes';
import {
    __resetTraceBackgroundCheckForTest,
    cancelTraceChecks,
    enqueueTraceChecks,
    getTraceCheckSnapshot,
    setLogPageActive,
    setTracerActive,
    tracerBlocksBackgroundChecks,
} from '../services/traceBackgroundCheck';

// Fictional: Mediterranean, Antibes → Îles de Lérins → Cannes (France).
const routeA: TracePoint[] = [
    { lat: 43.585, lon: 7.13 },
    { lat: 43.53, lon: 7.06 },
    { lat: 43.545, lon: 7.015 },
];
const routeB: TracePoint[] = [
    { lat: 43.545, lon: 7.015 },
    { lat: 43.5, lon: 6.95 },
];

const verdict = (grade: TraceLegVerdict['grade'], message: string = grade, needsTide = false): TraceLegVerdict => ({
    grade,
    issues: grade === 'clear' ? [] : [{ severity: grade, message }],
    minDepthM: 6,
    minAt: null,
    needsTide,
    nudge: null,
    nudgeTo: null,
});

const okFor = (points: TracePoint[]): RecheckOutcome => ({
    ok: true,
    verification: evaluateTraceRelease(
        points,
        'ready',
        points.slice(1).map(() => verdict('clear')),
        new Set(),
        {
            draftM: 1.8,
            draftAssumed: false,
            encRegistryVersion: 1,
            encRegistryFingerprint: hoisted.fingerprint,
            departureMs: Date.now(),
            tideWindowLabel: '',
        },
    ).verification!,
});

type Call = {
    points: readonly TracePoint[];
    opts: { signal?: AbortSignal; onProgress?: (d: number, t: number) => void };
};
let calls: Array<Call & { resolve: (outcome: RecheckOutcome) => void }> = [];

const ctx = () => ({ draftM: 1.8, draftAssumed: false, nowMs: Date.now() });
const statusOf = (id: string) => {
    const trace = loadSavedTraces().find((t) => t.id === id)!;
    return traceFollowStatus(trace.verification, trace.points, ctx(), getTraceCheckOutcome(id));
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('traceBackgroundCheck', () => {
    let A: string;
    let B: string;

    beforeEach(() => {
        localStorage.clear();
        calls = [];
        hoisted.fingerprint = 'GB4X0001@1';
        hoisted.vessel = { draft: 1.8 * 3.28084, estimatedFields: [] };
        hoisted.visibility = 'visible';
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hoisted.visibility });
        hoisted.recheck.mockReset().mockImplementation(
            (points: readonly TracePoint[], opts: Call['opts']) =>
                new Promise<RecheckOutcome>((resolve) => {
                    calls.push({ points, opts, resolve });
                }),
        );
        setAuthIdentityScope(null);
        setAuthIdentityScope('queue-owner');
        __resetTraceBackgroundCheckForTest();
        A = saveTrace('Antibes → Lérins', routeA).trace.id;
        B = saveTrace('Lérins → Cannes', routeB).trace.id;
    });

    afterEach(() => {
        __resetTraceBackgroundCheckForTest();
        setAuthIdentityScope(null);
        vi.useRealTimers();
    });

    it('waits for the Log page, then runs ONE route at a time, in order, without duplicates', async () => {
        enqueueTraceChecks([A, B, A], 'sheet');
        await settle();
        expect(calls).toHaveLength(0);

        setLogPageActive(true);
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        expect(calls[0].points).toEqual(routeA);
        // Cold, exactly as written: the prior envelope and an abort signal.
        expect(calls[0].opts.signal).toBeInstanceOf(AbortSignal);
        calls[0].opts.onProgress?.(1, 2);
        expect(getTraceCheckSnapshot().states.get(A)).toEqual({ phase: 'checking', done: 1, total: 2 });
        expect(getTraceCheckSnapshot().states.get(B)).toEqual({ phase: 'queued' });

        calls[0].resolve(okFor(routeA));
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(calls[1].points).toEqual(routeB);
        calls[1].resolve(okFor(routeB));
        await vi.waitFor(() => expect(getTraceCheckSnapshot().states.get(B)).toMatchObject({ phase: 'done' }));
        expect(calls).toHaveLength(2);
        expect(statusOf(A).tone).toBe('checked');
        expect(statusOf(B).tone).toBe('checked');
    });

    it('stops for Route Tracer, writes nothing, and resumes when the tracer closes', async () => {
        setLogPageActive(true);
        enqueueTraceChecks([A], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        setTracerActive(true);
        expect(calls[0].opts.signal?.aborted).toBe(true);
        // Even a late "ok" from the aborted run must not be banked.
        calls[0].resolve(okFor(routeA));
        await settle();
        expect(statusOf(A).tone).toBe('unchecked');
        expect(calls).toHaveLength(1);

        setTracerActive(false);
        await vi.waitFor(() => expect(calls).toHaveLength(2));
    });

    it('aborts when the app is hidden or the Log page closes', async () => {
        setLogPageActive(true);
        enqueueTraceChecks([A], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        hoisted.visibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
        expect(calls[0].opts.signal?.aborted).toBe(true);
        calls[0].resolve({ ok: false, reason: 'Check cancelled.', needsTracer: false });
        await settle();
        hoisted.visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.waitFor(() => expect(calls).toHaveLength(2));

        setLogPageActive(false);
        expect(calls[1].opts.signal?.aborted).toBe(true);
    });

    it('a danger leg is a red finding even though needsTracer is set, naming the pins', async () => {
        setLogPageActive(true);
        enqueueTraceChecks([A], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0].resolve({
            ok: false,
            reason: 'Legs 2 cross charted land.',
            needsTracer: true,
            report: {
                verdicts: [verdict('clear'), verdict('danger', 'crosses charted land')],
                tideWindowLabel: '',
                status: 'ready',
                ackableDangerLegs: [],
            },
        });
        await vi.waitFor(() => expect(getTraceCheckOutcome(A)?.kind).toBe('finding'));
        expect(getTraceCheckOutcome(A)?.legs).toEqual([{ from: 2, to: 3, message: 'crosses charted land' }]);
        expect(getTraceCheckOutcome(A)?.ackable).toBe(false);
        expect(statusOf(A)).toMatchObject({ tone: 'finding', reason: 'Pins 2→3: crosses charted land' });
        expect(loadSavedTraces().find((t) => t.id === A)?.verification).toBeUndefined();
    });

    it('over licensed charts a danger leg is stored as "no-go leg", never its charted depth (127-C-b)', async () => {
        setLogPageActive(true);
        enqueueTraceChecks([A], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0].resolve({
            ok: false,
            reason: 'Acknowledge the no-go leg in Route report before saving, exporting or sailing.',
            needsTracer: true,
            report: {
                verdicts: [verdict('clear'), verdict('danger', 'thin water — 1.6 m charted at low tide (LAT)')],
                tideWindowLabel: '',
                status: 'ready',
                ackableDangerLegs: [1],
            },
        });
        await vi.waitFor(() => expect(getTraceCheckOutcome(A)?.kind).toBe('finding'));
        expect(getTraceCheckOutcome(A)?.legs).toEqual([{ from: 2, to: 3, message: 'no-go leg' }]);
        const stored = Array.from({ length: localStorage.length }, (_, i) =>
            localStorage.getItem(localStorage.key(i)!),
        );
        expect(stored.join('\n')).not.toContain('1.6 m');
    });

    it('an ACKNOWLEDGED danger leg is not a finding: a failed tide lookup stays amber "tide", not red', async () => {
        // Fictional Hauraki Gulf passage (NZ): Westhaven → Rangitoto Channel →
        // Waiheke. Leg 1 (pins 1→2) has a charted wreck the skipper accepted
        // 40 days ago at this keel against these charts; leg 2 is tide-gated.
        const hauraki: TracePoint[] = [
            { lat: -36.84, lon: 174.75 },
            { lat: -36.8, lon: 174.85 },
            { lat: -36.78, lon: 175.0 },
        ];
        const accepted = evaluateTraceRelease(
            hauraki,
            'ready',
            [verdict('danger', 'charted wreck'), verdict('caution', 'shoal', true)],
            new Set([0]),
            {
                draftM: 1.8,
                draftAssumed: false,
                encRegistryVersion: 1,
                encRegistryFingerprint: hoisted.fingerprint,
                departureMs: Date.now() - 40 * 86_400_000,
                tideWindowLabel: 'Leave 09:10–13:30',
            },
            new Date(Date.now() - 40 * 86_400_000).toISOString(),
        ).verification!;
        expect(accepted.acknowledgedDangerLegs).toEqual([0]);
        const H = saveTrace('Westhaven → Waiheke', hauraki, { verification: accepted }).trace.id;
        expect(statusOf(H)).toMatchObject({ tone: 'unchecked', code: 'aged' });

        setLogPageActive(true);
        enqueueTraceChecks([H], 'idle');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        // recheckTrace inherits the ack (same charts, same keel, nothing new),
        // then refuses because the tide lookup threw and left the label null.
        calls[0].resolve({
            ok: false,
            reason: 'Wait for the tide-window check to finish.',
            needsTracer: true,
            report: {
                verdicts: [verdict('danger', 'charted wreck'), verdict('caution', 'shoal', true)],
                tideWindowLabel: null,
                status: 'ready',
                ackableDangerLegs: [0],
            },
        });
        await vi.waitFor(() => expect(getTraceCheckOutcome(H)?.kind).toBe('tide'));
        expect(statusOf(H)).toMatchObject({ tone: 'unchecked', code: 'tide' });
        expect(statusOf(H).reason).not.toContain('charted wreck');
    });

    it('a NEW danger leg beside an acknowledged one is still red, naming only the new one', async () => {
        const accepted = evaluateTraceRelease(
            routeA,
            'ready',
            [verdict('danger', 'charted wreck'), verdict('clear')],
            new Set([0]),
            {
                draftM: 1.8,
                draftAssumed: false,
                encRegistryVersion: 1,
                encRegistryFingerprint: hoisted.fingerprint,
                departureMs: Date.now(),
                tideWindowLabel: '',
            },
            new Date(Date.now() - 40 * 86_400_000).toISOString(),
        ).verification!;
        saveTrace('Antibes → Lérins', routeA, { overwriteId: A, verification: accepted });
        setLogPageActive(true);
        enqueueTraceChecks([A], 'idle');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        // Leg 2 is new danger, so nothing is inherited (recheckTrace's rule):
        // BOTH are unacknowledged in this check.
        calls[0].resolve({
            ok: false,
            reason: 'Acknowledge the no-go legs.',
            needsTracer: true,
            report: {
                verdicts: [verdict('danger', 'charted wreck'), verdict('danger', 'new obstruction')],
                tideWindowLabel: '',
                status: 'ready',
                ackableDangerLegs: [0, 1],
            },
        });
        await vi.waitFor(() => expect(getTraceCheckOutcome(A)?.kind).toBe('finding'));
        expect(getTraceCheckOutcome(A)?.legs).toHaveLength(2);
        expect(getTraceCheckOutcome(A)?.ackable).toBe(true);
        expect(statusOf(A).tone).toBe('finding');
    });

    it('a check the full phone could not store is not re-run by every automatic trigger', async () => {
        setLogPageActive(true);
        enqueueTraceChecks([A], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        });
        calls[0].resolve(okFor(routeA));
        await vi.waitFor(() =>
            expect(getTraceCheckSnapshot().states.get(A)).toEqual({ phase: 'done', result: 'storage' }),
        );
        quota.mockRestore();

        enqueueTraceChecks([A], 'idle');
        await vi.waitFor(() =>
            expect(getTraceCheckSnapshot().states.get(A)).toEqual({ phase: 'done', result: 'memo' }),
        );
        expect(calls).toHaveLength(1);
        // A skipper's Check now still runs it.
        enqueueTraceChecks([A], 'manual');
        await vi.waitFor(() => expect(calls).toHaveLength(2));
    });

    it('Route Tracer holds the queue only while ON SCREEN or grading — not a hidden tracer still in capture mode', async () => {
        expect(tracerBlocksBackgroundChecks({ captureMode: true, onScreen: true, grading: false })).toBe(true);
        expect(tracerBlocksBackgroundChecks({ captureMode: true, onScreen: false, grading: true })).toBe(true);
        expect(tracerBlocksBackgroundChecks({ captureMode: true, onScreen: false, grading: false })).toBe(false);
        expect(tracerBlocksBackgroundChecks({ captureMode: false, onScreen: true, grading: true })).toBe(false);

        // Shane's flow: Fix in tracer, then the Log tab (not Obs). MapHub is
        // kept alive hidden with capture mode still on; the queue must run.
        setTracerActive(tracerBlocksBackgroundChecks({ captureMode: true, onScreen: true, grading: false }));
        setLogPageActive(true);
        enqueueTraceChecks([A], 'sheet');
        await settle();
        expect(calls).toHaveLength(0);
        setTracerActive(tracerBlocksBackgroundChecks({ captureMode: true, onScreen: false, grading: false }));
        await vi.waitFor(() => expect(calls).toHaveLength(1));
    });

    it('classifies a volatile refusal as unavailable, tide as tide, missing charts as nochart', async () => {
        setLogPageActive(true);
        enqueueTraceChecks([A, B], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0].resolve({
            ok: false,
            reason: 'Part of this route could not be checked against the charts. Reconnect and try again.',
            needsTracer: false,
        });
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(getTraceCheckOutcome(A)?.kind).toBe('unavailable');
        expect(statusOf(A).code).toBe('unavailable');
        calls[1].resolve({
            ok: false,
            reason: 'Wait for the tide-window check to finish.',
            needsTracer: true,
            report: {
                verdicts: [verdict('caution', 'shoal', true)],
                tideWindowLabel: null,
                status: 'ready',
                ackableDangerLegs: [],
            },
        });
        await vi.waitFor(() => expect(getTraceCheckOutcome(B)?.kind).toBe('tide'));

        // Charts: a new key (new chart library) earns a fresh attempt.
        hoisted.fingerprint = 'GB4X0001@2';
        enqueueTraceChecks([B], 'idle');
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        calls[2].resolve({
            ok: false,
            reason: 'ENC chart coverage is unavailable here.',
            needsTracer: false,
            report: { verdicts: [null], tideWindowLabel: null, status: 'nochart', ackableDangerLegs: [] },
        });
        await vi.waitFor(() => expect(getTraceCheckOutcome(B)?.kind).toBe('nochart'));
    });

    it('never repeats the same attempt, except an unavailable one after "online" or 30 minutes, or Check now', async () => {
        setLogPageActive(true);
        enqueueTraceChecks([A], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0].resolve({
            ok: false,
            reason: 'Acknowledge the no-go leg in Route report before saving, exporting or sailing.',
            needsTracer: true,
            report: {
                verdicts: [verdict('danger', 'charted wreck'), verdict('clear')],
                tideWindowLabel: '',
                status: 'ready',
                ackableDangerLegs: [0],
            },
        });
        await vi.waitFor(() => expect(getTraceCheckOutcome(A)?.kind).toBe('finding'));
        enqueueTraceChecks([A], 'idle');
        await settle();
        expect(calls).toHaveLength(1);
        expect(getTraceCheckSnapshot().states.get(A)).toEqual({ phase: 'done', result: 'memo' });

        enqueueTraceChecks([A], 'manual');
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        calls[1].resolve({ ok: false, reason: 'Part of this route could not be checked.', needsTracer: false });
        await vi.waitFor(() => expect(getTraceCheckOutcome(A)?.kind).toBe('unavailable'));

        enqueueTraceChecks([A], 'idle');
        await settle();
        expect(calls).toHaveLength(2);
        window.dispatchEvent(new Event('online'));
        await vi.waitFor(() => expect(calls).toHaveLength(3));
        calls[2].resolve({ ok: false, reason: 'Part of this route could not be checked.', needsTracer: false });
        await settle();

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 31 * 60_000);
        enqueueTraceChecks([A], 'idle');
        await vi.waitFor(() => expect(calls).toHaveLength(4));
    });

    it('an account change mid-check writes nothing', async () => {
        setLogPageActive(true);
        enqueueTraceChecks([A], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        setAuthIdentityScope('someone-else');
        calls[0].resolve(okFor(routeA));
        await settle();
        setAuthIdentityScope('queue-owner');
        expect(loadSavedTraces().find((t) => t.id === A)?.verification).toBeUndefined();
        expect(getTraceCheckOutcome(A)).toBeNull();
    });

    it('does not grade against an assumed draft, or a route that is already green', async () => {
        setLogPageActive(true);
        hoisted.vessel = { draft: 0, estimatedFields: [] };
        enqueueTraceChecks([A], 'sheet');
        await vi.waitFor(() =>
            expect(getTraceCheckSnapshot().states.get(A)).toEqual({ phase: 'done', result: 'nodraft' }),
        );
        hoisted.vessel = { draft: 1.8 * 3.28084, estimatedFields: [] };
        enqueueTraceChecks([B], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        calls[0].resolve(okFor(routeB));
        await vi.waitFor(() => expect(statusOf(B).tone).toBe('checked'));
        enqueueTraceChecks([B], 'manual');
        await vi.waitFor(() =>
            expect(getTraceCheckSnapshot().states.get(B)).toEqual({ phase: 'done', result: 'checked' }),
        );
        expect(calls).toHaveLength(1);
    });

    it('Stop cancels one route and keeps the automatic triggers off it; Check now overrides', async () => {
        setLogPageActive(true);
        enqueueTraceChecks([A, B], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        cancelTraceChecks('stop', [A]);
        expect(calls[0].opts.signal?.aborted).toBe(true);
        calls[0].resolve({ ok: false, reason: 'Check cancelled.', needsTracer: false });
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(calls[1].points).toEqual(routeB);
        calls[1].resolve(okFor(routeB));
        await settle();

        enqueueTraceChecks([A], 'idle');
        await settle();
        expect(calls).toHaveLength(2);
        enqueueTraceChecks([A], 'manual');
        await vi.waitFor(() => expect(calls).toHaveLength(3));
    });

    it('Check now jumps the queue', async () => {
        const C = saveTrace(
            'Cannes → Théoule',
            routeB.map((p) => ({ lat: p.lat - 0.01, lon: p.lon })),
        ).trace.id;
        setLogPageActive(true);
        enqueueTraceChecks([A, B, C], 'sheet');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        enqueueTraceChecks([C], 'manual');
        calls[0].resolve(okFor(routeA));
        await vi.waitFor(() => expect(calls).toHaveLength(2));
        expect(calls[1].points).toEqual(loadSavedTraces().find((t) => t.id === C)!.points);
    });
});
