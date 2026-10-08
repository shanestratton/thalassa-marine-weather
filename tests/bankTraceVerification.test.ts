/**
 * bankTraceVerification — the ONE safe way a finished check lands in storage
 * (build 124, B1). Checks kept getting lost: a check banked against pins that
 * moved while it ran, an older result overwriting a newer one, a full phone
 * reporting success. Every caller (the Log's ack report, the tracer's
 * auto-bank, the background re-check, server recovery) goes through here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    refresh: vi.fn(async (..._args: unknown[]) => ({ voyage: null as unknown })),
    push: vi.fn(async (..._args: unknown[]) => 'ok' as const),
}));

vi.mock('../services/VoyageService', () => ({
    refreshSavedRouteVoyageVerification: (...args: unknown[]) => mocks.refresh(...args),
}));
vi.mock('../services/savedRoutesSync', () => ({
    pushSavedRoute: (...args: unknown[]) => mocks.push(...args),
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { bankTraceVerification, loadSavedTraces, saveTrace, type TraceLegVerdict } from '../services/routeTracer';
import { evaluateTraceRelease, serialiseTraceVerificationNote, traceGeometryKey } from '../services/traceVerification';
import { getTraceCheckOutcome, recordTraceCheckOutcome } from '../services/traceCheckOutcomes';

// Fictional: Chesapeake Bay, Annapolis to St Michaels (US).
const points = [
    { lat: 38.977, lon: -76.483 },
    { lat: 38.87, lon: -76.38 },
    { lat: 38.785, lon: -76.222 },
];
const PASSAGE_VOYAGE = '7b6f0c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b';

const clear: TraceLegVerdict = {
    grade: 'clear',
    issues: [],
    minDepthM: 9,
    minAt: null,
    needsTide: false,
    nudge: null,
    nudgeTo: null,
};
const checkedAt = (iso: string, onPoints = points) =>
    evaluateTraceRelease(
        onPoints,
        'ready',
        onPoints.slice(1).map(() => clear),
        new Set(),
        {
            draftM: 1.8,
            draftAssumed: false,
            encRegistryVersion: 1,
            encRegistryFingerprint: 'US5MD1@3',
            departureMs: Date.parse('2026-10-10T12:00:00Z'),
            tideWindowLabel: '',
        },
        iso,
    ).verification!;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('bankTraceVerification', () => {
    beforeEach(() => {
        localStorage.clear();
        mocks.refresh.mockClear();
        setAuthIdentityScope(null);
        setAuthIdentityScope('bank-owner');
    });
    afterEach(() => {
        vi.restoreAllMocks();
        setAuthIdentityScope(null);
    });

    it('banks a check for the current pins and refreshes the passage mirror WITHOUT timing', async () => {
        const { trace } = saveTrace('Annapolis → St Michaels', points, { passageVoyageId: PASSAGE_VOYAGE });
        const verification = checkedAt('2026-10-08T01:00:00.000Z');

        expect(bankTraceVerification(trace.id, verification)).toEqual({ banked: true });
        expect(loadSavedTraces().find((t) => t.id === trace.id)?.verification?.checkedAt).toBe(
            '2026-10-08T01:00:00.000Z',
        );

        await flush();
        expect(mocks.refresh).toHaveBeenCalledTimes(1);
        // No fourth (timing) argument: the planned departure on the mirror
        // must survive a background bank (VoyageService.ts updates it only
        // when timing is passed).
        expect(mocks.refresh.mock.calls[0]).toEqual([
            PASSAGE_VOYAGE,
            trace.id,
            serialiseTraceVerificationNote(verification),
        ]);
    });

    it('is a LOCAL write that keeps the route’s own updatedAt — it never pushes this device’s pins', async () => {
        // An automatic bank is not an edit. Through saveTrace it bumped
        // updatedAt and upserted these pins, so a phone that had not synced
        // since the iPad moved (or deleted) the route won last-writer-wins and
        // reverted it on the server.
        const { trace } = saveTrace('Annapolis → St Michaels', points);
        const other = saveTrace('Oxford → Tilghman', [points[2], points[1]]).trace;
        await flush();
        const before = loadSavedTraces();
        const stamp = before.find((t) => t.id === trace.id)!;
        mocks.push.mockClear();

        expect(bankTraceVerification(trace.id, checkedAt('2026-10-08T01:00:00.000Z')).banked).toBe(true);
        await flush();

        expect(mocks.push).not.toHaveBeenCalled();
        const after = loadSavedTraces();
        const banked = after.find((t) => t.id === trace.id)!;
        expect(banked.updatedAt).toBe(stamp.updatedAt);
        expect(banked.createdAt).toBe(stamp.createdAt);
        expect(banked.points).toEqual(stamp.points);
        // Library order unchanged (a save moves the route to the top).
        expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
        expect(after.find((t) => t.id === other.id)).toEqual(before.find((t) => t.id === other.id));
    });

    it('refuses when the pins moved while the check ran', () => {
        const { trace } = saveTrace('Annapolis → St Michaels', points);
        const verification = checkedAt('2026-10-08T01:00:00.000Z');
        // The skipper edits the route mid-check.
        saveTrace(trace.name, [points[0], { lat: 38.9, lon: -76.4 }, points[2]], { overwriteId: trace.id });

        expect(bankTraceVerification(trace.id, verification)).toEqual({ banked: false, reason: 'moved' });
        expect(loadSavedTraces().find((t) => t.id === trace.id)?.verification).toBeUndefined();
    });

    it('refuses to replace a newer check with an older one', () => {
        const { trace } = saveTrace('Annapolis → St Michaels', points);
        expect(bankTraceVerification(trace.id, checkedAt('2026-10-05T00:00:00.000Z')).banked).toBe(true);
        expect(bankTraceVerification(trace.id, checkedAt('2026-10-01T00:00:00.000Z'))).toEqual({
            banked: false,
            reason: 'older',
        });
        expect(loadSavedTraces().find((t) => t.id === trace.id)?.verification?.checkedAt).toBe(
            '2026-10-05T00:00:00.000Z',
        );
    });

    it('reports a full phone instead of pretending the check was saved', () => {
        const { trace } = saveTrace('Annapolis → St Michaels', points);
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        });
        expect(bankTraceVerification(trace.id, checkedAt('2026-10-08T01:00:00.000Z'))).toEqual({
            banked: false,
            reason: 'storage',
        });
    });

    it('refuses a trace that is gone, or an account that changed', () => {
        expect(bankTraceVerification('trace-nowhere', checkedAt('2026-10-08T01:00:00.000Z'))).toEqual({
            banked: false,
            reason: 'gone',
        });
        const { trace } = saveTrace('Annapolis → St Michaels', points);
        const scope = { userId: 'bank-owner', generation: -1, key: 'stale' } as never;
        expect(bankTraceVerification(trace.id, checkedAt('2026-10-08T01:00:00.000Z'), scope)).toEqual({
            banked: false,
            reason: 'scope',
        });
    });

    it('server recovery does not echo the proof back to the mirror it came from', async () => {
        const { trace } = saveTrace('Annapolis → St Michaels', points, { passageVoyageId: PASSAGE_VOYAGE });
        expect(
            bankTraceVerification(trace.id, checkedAt('2026-10-08T01:00:00.000Z'), undefined, {
                refreshMirror: false,
            }).banked,
        ).toBe(true);
        await flush();
        expect(mocks.refresh).not.toHaveBeenCalled();
    });

    it('clears an older could-not-check record, but not a newer finding', () => {
        const { trace } = saveTrace('Annapolis → St Michaels', points);
        const base = {
            geometryKey: traceGeometryKey(points),
            draftM: 1.8,
            draftAssumed: false,
            encFingerprint: 'US5MD1@3',
            reason: 'x',
        };
        recordTraceCheckOutcome(trace.id, { ...base, kind: 'unavailable', at: '2026-10-07T00:00:00.000Z' });
        expect(bankTraceVerification(trace.id, checkedAt('2026-10-08T01:00:00.000Z')).banked).toBe(true);
        expect(getTraceCheckOutcome(trace.id)).toBeNull();

        recordTraceCheckOutcome(trace.id, {
            ...base,
            kind: 'finding',
            at: '2026-10-09T00:00:00.000Z',
            legs: [{ from: 1, to: 2, message: 'charted wreck' }],
        });
        // An older proof recovered from the server must not erase a newer finding.
        expect(bankTraceVerification(trace.id, checkedAt('2026-10-08T12:00:00.000Z')).banked).toBe(true);
        expect(getTraceCheckOutcome(trace.id)?.kind).toBe('finding');
    });
});
