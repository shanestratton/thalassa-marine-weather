/**
 * Route checks that stick (125-07), the queue's half:
 *
 *  - a red row's Review reopens the stored report only while its attempt
 *    memoKey (pins | draft | charts) still matches; otherwise it re-runs, so a
 *    changed route, keel or chart set never shows a stale red report;
 *  - the hidden tracer's held chart windows and the parsed ENC cells are freed
 *    between background jobs and when the queue runs dry (the 2 GB WebContent
 *    jetsam cap is the risk);
 *  - a boot-time idle re-check exists but ships DARK: off by default, and when
 *    switched on it is skipped below the heap headroom line. Switching it on
 *    reverses the 124 call ("Log page only, no boot trigger") and waits for
 *    the 125-11 memory census.
 *
 * Fictional routes only: Antibes → Îles de Lérins → Cannes (France).
 */
import { act, renderHook } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecheckOutcome, RecheckReport } from '../services/traceRecheck';

const hoisted = vi.hoisted(() => ({
    recheck: vi.fn(),
    fingerprint: 'FR5LER01@1',
    vessel: { draft: 1.8 * 3.28084, estimatedFields: [] as string[] },
    visibility: 'visible' as DocumentVisibilityState,
    headroom: true as boolean | null,
    awaitHeadroom: vi.fn(async () => undefined),
    headroomOk: vi.fn(async (): Promise<boolean | null> => true),
    heapTag: vi.fn(() => ',h512'),
    releaseBlobs: vi.fn(() => 0),
}));

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
// heapGauge mocked: jsdom has no gauge, and the boot pass's line is the point.
vi.mock('../utils/heapGauge', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/heapGauge')>()),
    awaitHeapHeadroom: hoisted.awaitHeadroom,
    heapHeadroomOk: hoisted.headroomOk,
    heapTag: hoisted.heapTag,
}));
vi.mock('../services/enc/EncCellStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/enc/EncCellStore')>()),
    releaseBlobCache: hoisted.releaseBlobs,
}));

import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { loadSavedTraces, saveTrace, type TraceLegVerdict, type TracePoint } from '../services/routeTracer';
import { evaluateTraceRelease } from '../services/traceVerification';
import * as queue from '../services/traceBackgroundCheck';
import { useTraceBackgroundChecks } from '../pages/log/useTraceBackgroundChecks';

const routeA: TracePoint[] = [
    { lat: 43.585, lon: 7.13 },
    { lat: 43.53, lon: 7.06 },
    { lat: 43.545, lon: 7.015 },
];
const routeB: TracePoint[] = [
    { lat: 43.545, lon: 7.015 },
    { lat: 43.5, lon: 6.95 },
];
const PASSAGE_A = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
const PASSAGE_B = '4d3c2b1a-9f8e-4e7d-8c6b-5a4f3e2d1c0b';

const verdict = (grade: TraceLegVerdict['grade'], message: string = grade): TraceLegVerdict => ({
    grade,
    issues: grade === 'clear' ? [] : [{ severity: grade, message }],
    minDepthM: 6,
    minAt: null,
    needsTide: false,
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
const findingReport = (message: string): RecheckReport => ({
    verdicts: [verdict('danger', message), verdict('clear')],
    tideWindowLabel: '',
    status: 'ready',
    ackableDangerLegs: [0],
});
const finding = (report: RecheckReport): RecheckOutcome => ({
    ok: false,
    reason: 'Acknowledge the no-go leg.',
    needsTracer: true,
    report,
});

type Call = { points: readonly TracePoint[]; resolve: (outcome: RecheckOutcome) => void };
let calls: Call[] = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the background queue, 125-07', () => {
    let A: string;
    let B: string;

    beforeEach(() => {
        localStorage.clear();
        calls = [];
        hoisted.fingerprint = 'FR5LER01@1';
        hoisted.vessel = { draft: 1.8 * 3.28084, estimatedFields: [] };
        hoisted.visibility = 'visible';
        hoisted.awaitHeadroom.mockClear();
        hoisted.headroomOk.mockReset().mockImplementation(async () => true);
        hoisted.heapTag.mockClear();
        hoisted.releaseBlobs.mockClear();
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hoisted.visibility });
        hoisted.recheck.mockReset().mockImplementation(
            (points: readonly TracePoint[]) =>
                new Promise<RecheckOutcome>((resolve) => {
                    calls.push({ points, resolve });
                }),
        );
        setAuthIdentityScope(null);
        setAuthIdentityScope('queue-owner');
        queue.__resetTraceBackgroundCheckForTest();
        A = saveTrace('Antibes → Lérins', routeA, { passageVoyageId: PASSAGE_A }).trace.id;
        B = saveTrace('Lérins → Cannes', routeB, { passageVoyageId: PASSAGE_B }).trace.id;
    });

    afterEach(() => {
        queue.__resetTraceBackgroundCheckForTest();
        setAuthIdentityScope(null);
    });

    describe('Review and the attempt memoKey', () => {
        it('reopens the stored report while pins, draft and charts are unchanged, and drops it when any moves', async () => {
            queue.setLogPageActive(true);
            queue.enqueueTraceChecks([A], 'sheet');
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            const report = findingReport('charted wreck');
            calls[0].resolve(finding(report));
            await vi.waitFor(() =>
                expect(queue.getTraceCheckSnapshot().states.get(A)).toEqual({ phase: 'done', result: 'finding' }),
            );

            // It comes with the pins it was graded on, so the sheet never pairs
            // these verdicts with pins re-read later.
            await expect(queue.getCurrentTraceCheckReport(A)).resolves.toMatchObject({ report, points: routeA });
            // A new chart library: the stored red report no longer describes this route.
            hoisted.fingerprint = 'FR5LER01@2';
            await expect(queue.getCurrentTraceCheckReport(A)).resolves.toBeUndefined();
        });

        it('an acknowledgement re-checks the memoKey at the moment it banks: a keel or chart change while the sheet was open never banks', async () => {
            queue.setLogPageActive(true);
            queue.enqueueTraceChecks([A], 'sheet');
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            const report = findingReport('charted wreck');
            calls[0].resolve(finding(report));
            await vi.waitFor(() =>
                expect(queue.getTraceCheckSnapshot().states.get(A)).toEqual({ phase: 'done', result: 'finding' }),
            );
            const held = await queue.getCurrentTraceCheckReport(A);
            expect(held?.report).toBe(report);

            // Unchanged: the act runs, synchronously with the comparison.
            const act = vi.fn(() => 'banked');
            await expect(queue.actOnCurrentTraceCheckReport(A, report, act)).resolves.toBe('banked');
            expect(act).toHaveBeenCalledWith(expect.objectContaining({ report, points: routeA }));

            // The other phone's settings sync moved the draft while the sheet was open.
            act.mockClear();
            hoisted.vessel = { draft: 2.4 * 3.28084, estimatedFields: [] };
            await expect(queue.actOnCurrentTraceCheckReport(A, report, act)).resolves.toBeUndefined();
            expect(act).not.toHaveBeenCalled();

            // Back to 1.8 m, but a held report that is not the one on the sheet never banks either.
            hoisted.vessel = { draft: 1.8 * 3.28084, estimatedFields: [] };
            await expect(queue.actOnCurrentTraceCheckReport(A, findingReport('other'), act)).resolves.toBeUndefined();
            expect(act).not.toHaveBeenCalled();
        });

        it('a Review with a stale memoKey re-runs the check and opens the NEW report, never the old one', async () => {
            const onReport = vi.fn();
            const { result } = renderHook(() =>
                useTraceBackgroundChecks({
                    identityScope: getAuthIdentityScope(),
                    sheetTraceIds: null,
                    plannedTraceIds: [],
                    onStatusesChanged: () => undefined,
                    onReport,
                }),
            );
            queue.enqueueTraceChecks([A], 'sheet');
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            const stale = findingReport('charted wreck');
            await act(async () => {
                calls[0].resolve(finding(stale));
                await settle();
            });

            // Same inputs: Review opens what this session already holds.
            await act(async () => {
                result.current.review(A);
                await settle();
            });
            expect(onReport).toHaveBeenLastCalledWith(A, expect.objectContaining({ report: stale, points: routeA }));
            expect(calls).toHaveLength(1);

            // The keel changed: Review re-runs instead of showing the stale red.
            onReport.mockClear();
            hoisted.vessel = { draft: 2.4 * 3.28084, estimatedFields: [] };
            await act(async () => {
                result.current.review(A);
                await settle();
            });
            await vi.waitFor(() => expect(calls).toHaveLength(2));
            expect(onReport).not.toHaveBeenCalled();
            const fresh = findingReport('rock awash at 2.4 m');
            await act(async () => {
                calls[1].resolve(finding(fresh));
                await settle();
            });
            await vi.waitFor(() =>
                expect(onReport).toHaveBeenCalledWith(A, expect.objectContaining({ report: fresh })),
            );
            expect(onReport).not.toHaveBeenCalledWith(A, expect.objectContaining({ report: stale }));
        });
    });

    describe('freeing held memory between background jobs (heapGauge mocked)', () => {
        it('releases the hidden tracer windows and the ENC cells before each check and when the queue runs dry', async () => {
            const release = vi.fn();
            const unregister = queue.registerTraceCheckMemoryRelease(release);
            queue.setLogPageActive(true);
            queue.enqueueTraceChecks([A, B], 'sheet');
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            expect(release).toHaveBeenCalledTimes(1);
            calls[0].resolve(okFor(routeA));
            await vi.waitFor(() => expect(calls).toHaveLength(2));
            expect(release).toHaveBeenCalledTimes(2);
            calls[1].resolve(okFor(routeB));
            await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(3));
            await settle();
            expect(hoisted.releaseBlobs).toHaveBeenCalledTimes(3);
            // Each release is measured with the heap gauge, for the device trail.
            expect(hoisted.heapTag).toHaveBeenCalled();
            unregister();
        });

        it('leaving the Log page mid-check frees nothing: a pause is not the queue running dry', async () => {
            const release = vi.fn();
            queue.registerTraceCheckMemoryRelease(release);
            queue.setLogPageActive(true);
            queue.enqueueTraceChecks([A, B], 'sheet');
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            expect(release).toHaveBeenCalledTimes(1); // 'between', before A
            const graded = calls[0].points;
            queue.setLogPageActive(false);
            // The aborted grade comes back after the skipper has gone to the chart.
            calls[0].resolve(okFor(graded as TracePoint[]));
            await vi.waitFor(() =>
                expect(queue.getTraceCheckSnapshot().states.get(graded === routeA ? A : B)).toEqual({
                    phase: 'queued',
                }),
            );
            await settle();
            expect(release).toHaveBeenCalledTimes(1);
            expect(hoisted.releaseBlobs).toHaveBeenCalledTimes(1);
        });

        it('MapHub keeps the window a hidden trace is still using; everything else goes', () => {
            const current = { id: 'window-now' };
            const older = { id: 'window-before' };
            expect(queue.tracerWindowsAfterRelease(current, [older, current], true)).toEqual({
                current,
                lru: [current],
            });
            expect(queue.tracerWindowsAfterRelease(current, [older, current], false)).toEqual({
                current: null,
                lru: [],
            });
            expect(queue.tracerWindowsAfterRelease(null, [older], true)).toEqual({ current: null, lru: [] });
        });

        it('never frees the windows Route Tracer is using', async () => {
            const release = vi.fn();
            queue.registerTraceCheckMemoryRelease(release);
            queue.setLogPageActive(true);
            queue.enqueueTraceChecks([A], 'sheet');
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            release.mockClear();
            hoisted.releaseBlobs.mockClear();
            queue.setTracerActive(true);
            calls[0].resolve(okFor(routeA));
            await settle();
            await settle();
            expect(release).not.toHaveBeenCalled();
            expect(hoisted.releaseBlobs).not.toHaveBeenCalled();
        });

        it('a route that needs no check frees nothing', async () => {
            const release = vi.fn();
            queue.registerTraceCheckMemoryRelease(release);
            queue.setLogPageActive(true);
            hoisted.vessel = { draft: 0, estimatedFields: [] };
            queue.enqueueTraceChecks([A], 'sheet');
            await vi.waitFor(() =>
                expect(queue.getTraceCheckSnapshot().states.get(A)).toEqual({ phase: 'done', result: 'nodraft' }),
            );
            await settle();
            expect(release).not.toHaveBeenCalled();
        });
    });

    describe('the boot-time idle re-check (DARK)', () => {
        it('is OFF by default: no heap probe, no check, nothing queued', async () => {
            expect(queue.BOOT_IDLE_RECHECK_ENABLED).toBe(false);
            await expect(queue.runBootIdleRecheck({ delayMs: 0 })).resolves.toBe('off');
            expect(hoisted.awaitHeadroom).not.toHaveBeenCalled();
            expect(hoisted.headroomOk).not.toHaveBeenCalled();
            expect(calls).toHaveLength(0);
            expect(queue.getTraceCheckSnapshot().states.size).toBe(0);
        });

        it('switched on, it waits for headroom and is skipped below the line (or with no gauge at all)', async () => {
            hoisted.headroomOk.mockImplementation(async () => false);
            await expect(queue.runBootIdleRecheck({ enabled: true, delayMs: 0 })).resolves.toBe('low-headroom');
            expect(hoisted.awaitHeadroom).toHaveBeenCalled();
            hoisted.headroomOk.mockImplementation(async () => null);
            await expect(queue.runBootIdleRecheck({ enabled: true, delayMs: 0 })).resolves.toBe('low-headroom');
            await settle();
            expect(calls).toHaveLength(0);
        });

        it('switched on, a route already queued by the Log page becomes a boot job instead of waiting forever', async () => {
            // The Log's idle trigger queued both legs, then the skipper left the Log.
            queue.setLogPageActive(true);
            queue.setLogPageActive(false);
            queue.enqueueTraceChecks([A, B], 'idle');
            await settle();
            expect(calls).toHaveLength(0);
            const done = queue.runBootIdleRecheck({ enabled: true, delayMs: 0 });
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            calls[0].resolve(okFor(calls[0].points as TracePoint[]));
            await vi.waitFor(() => expect(calls).toHaveLength(2));
            calls[1].resolve(okFor(calls[1].points as TracePoint[]));
            await expect(done).resolves.toBe('done');
            expect(loadSavedTraces().every((t) => t.verification)).toBe(true);
        });

        it('switched on with headroom, it checks one route at a time without the Log page, re-reading headroom each time', async () => {
            const done = queue.runBootIdleRecheck({ enabled: true, delayMs: 0 });
            await vi.waitFor(() => expect(calls).toHaveLength(1));
            expect(hoisted.headroomOk).toHaveBeenCalledTimes(1);
            // Leaving the Log page does not stop a boot job (it never needed it).
            queue.setLogPageActive(true);
            queue.setLogPageActive(false);
            calls[0].resolve(okFor(calls[0].points as TracePoint[]));
            await vi.waitFor(() => expect(calls).toHaveLength(2));
            expect(hoisted.headroomOk).toHaveBeenCalledTimes(2);
            calls[1].resolve(okFor(calls[1].points as TracePoint[]));
            await expect(done).resolves.toBe('done');
            expect(loadSavedTraces().every((t) => t.verification)).toBe(true);
        });
    });
});

describe('wiring', () => {
    const strip = (file: string) =>
        readFileSync(file, 'utf8')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');

    it('App.tsx asks for the boot re-check only after the sync and the recovery, lazily', () => {
        const app = strip('App.tsx');
        const recover = app.indexOf("import('./services/traceCheckRecovery')");
        const boot = app.indexOf('runBootIdleRecheck(');
        expect(recover).toBeGreaterThan(-1);
        expect(boot).toBeGreaterThan(recover);
        expect(app).toContain("import('./services/traceBackgroundCheck')");
    });

    it('the flag is a constant that stays false in this build', () => {
        expect(strip('services/traceBackgroundCheck.ts')).toContain('export const BOOT_IDLE_RECHECK_ENABLED = false;');
    });

    it('MapHub hands the queue a way to drop its hidden tracer windows, sparing the one a held trace uses', () => {
        const map = strip('components/map/MapHub.tsx');
        const at = map.indexOf('registerTraceCheckMemoryRelease(');
        expect(at).toBeGreaterThan(-1);
        const body = map.slice(at, at + 500);
        expect(body).toContain('tracerWindowsAfterRelease(');
        expect(body).toContain('tracingPinsRef.current');
        expect(body).toContain('tracerCtxRef.current = ');
        expect(body).toContain('tracerCtxLruRef.current = ');
        expect(map).toMatch(/tracingPinsRef\.current = coordCaptureMode && capturedCoords\.length > 0/);
    });

    it('the Log banks an acknowledgement only through the memoKey re-check', () => {
        const log = strip('pages/LogPage.tsx');
        const at = log.indexOf('const acknowledgeLeg = React.useCallback(');
        expect(at).toBeGreaterThan(-1);
        const body = log.slice(at, log.indexOf('bankTraceVerification(', at) + 200);
        expect(body).toContain('actOnCurrentTraceCheckReport(');
        expect(body.indexOf('actOnCurrentTraceCheckReport(')).toBeLessThan(body.indexOf('releaseWithAcks('));
    });
});
