/**
 * A recheck that clears a route the tracer would have flagged is worse than no
 * recheck at all, because it converts a warning into a clearance. These tests
 * pin the refusals rather than the happy path.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
    draft: 2.0,
    draftAssumed: false,
    fingerprint: 'fp-A',
    gradeLegs: vi.fn(),
}));

vi.mock('../services/traceGrading', () => ({ gradeLegs: hoisted.gradeLegs }));
vi.mock('../services/units', () => ({
    vesselDraftMetres: () => hoisted.draft,
    vesselDraftIsAssumed: () => hoisted.draftAssumed,
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => 1,
    getRegistryFingerprint: () => hoisted.fingerprint,
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { vessel: { draft: 2.0 } } }) },
}));
vi.mock('../services/routeTracer', () => ({ commonDepartureWindowLabel: async () => '' }));

import { recheckTrace, inheritableAcks } from '../services/traceRecheck';
import type { TraceLegVerdict } from '../services/routeTracer';
import type { TraceVerification } from '../services/traceVerification';

const clear = (): TraceLegVerdict =>
    ({ grade: 'clear', issues: [], minDepthM: 10, minAt: null, needsTide: false, nudge: null, nudgeTo: null }) as TraceLegVerdict;
const danger = (): TraceLegVerdict =>
    ({ grade: 'danger', issues: [], minDepthM: 0.5, minAt: null, needsTide: false, nudge: null, nudgeTo: null }) as TraceLegVerdict;

const POINTS = [
    { lat: -27.2, lon: 153.1 },
    { lat: -27.3, lon: 153.2 },
];

/** Drive gradeLegs' onLeg callback with a fixed verdict per leg. */
const gradesWith = (verdict: TraceLegVerdict, isVolatile = false, status = 'ready') =>
    hoisted.gradeLegs.mockImplementation(async (legs: { key: string }[], opts: Record<string, never>) => {
        const onLeg = opts.onLeg as unknown as (k: string, v: TraceLegVerdict, vol: boolean) => void;
        for (const l of legs) onLeg(l.key, verdict, isVolatile);
        return { status, superseded: false };
    });

beforeEach(() => {
    hoisted.draft = 2.0;
    hoisted.draftAssumed = false;
    hoisted.fingerprint = 'fp-A';
    hoisted.gradeLegs.mockReset();
});

describe('refusals that keep a recheck honest', () => {
    it('will not check against a guessed keel', async () => {
        // vesselDraftMetres falls back to 2.5 m for an unset profile. Grading
        // that and stamping it "checked" aims a false clearance squarely at a
        // new user's first passage.
        hoisted.draftAssumed = true;
        const out = await recheckTrace(POINTS);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toMatch(/draft/i);
        expect(hoisted.gradeLegs).not.toHaveBeenCalled();
    });

    it('refuses when any leg graded against degraded chart data', async () => {
        // A window whose gate-mark fetch threw grades weaker than one that
        // succeeded. Offline this is the norm, and clearing on it would mean
        // "verified" against a thinner chart set than the words imply.
        gradesWith(clear(), true);
        const out = await recheckTrace(POINTS);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.reason).toMatch(/could not be checked/i);
    });

    it('cannot clear a danger leg by itself', async () => {
        // The guarantee lives in evaluateTraceRelease, which refuses while any
        // danger leg is unacknowledged — and an acknowledgement is a human tap.
        gradesWith(danger());
        const out = await recheckTrace(POINTS);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.needsTracer).toBe(true);
    });

    it('grades COLD — never reusing held windows or a verdict cache', async () => {
        // The cache keys on draft + ENC fingerprint with no timestamp, so the
        // very case a recheck is for (clean route, aged past 30 days, same
        // boat, same charts) is the case it would hit. Consulting it would
        // launder a stale clearance into a fresh one.
        gradesWith(clear());
        await recheckTrace(POINTS);
        const opts = hoisted.gradeLegs.mock.calls[0][1];
        expect(opts.ctxFromLru).toBeUndefined();
        expect(opts.holdCtx).toBeUndefined();
        expect(opts.isDecided).toBeUndefined();
    });

    it('reports cancellation rather than a failure', async () => {
        hoisted.gradeLegs.mockResolvedValue({ status: 'ready', superseded: true });
        const out = await recheckTrace(POINTS, { signal: AbortSignal.abort() });
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.needsTracer).toBe(false);
    });

    it('refuses a route that is not one', async () => {
        expect((await recheckTrace([{ lat: 1, lon: 1 }])).ok).toBe(false);
    });
});

describe('inheriting danger acknowledgements', () => {
    const prior = (acked: number[], fp = 'fp-A'): TraceVerification =>
        ({ acknowledgedDangerLegs: acked, encRegistryFingerprint: fp }) as TraceVerification;

    it('carries an ack forward when the charts are identical and the danger is the same one', () => {
        expect(inheritableAcks(prior([0]), [danger()], 'fp-A')).toEqual(new Set([0]));
    });

    it('drops every ack when the chart library has changed', () => {
        // The envelope stores bare leg INDICES with no issue identity. After a
        // chart update, index 0 may be a different hazard entirely — re-acking
        // it would clear something nobody has ever looked at.
        expect(inheritableAcks(prior([0], 'fp-OLD'), [danger()], 'fp-A').size).toBe(0);
    });

    it('drops every ack when a NEW leg has become dangerous', () => {
        // Partial inheritance is the trap: acking leg 0 and silently ignoring
        // that leg 1 is now a danger would clear the route on a hazard the
        // skipper never saw.
        expect(inheritableAcks(prior([0]), [danger(), danger()], 'fp-A').size).toBe(0);
    });

    it('inherits nothing when there is no prior check', () => {
        expect(inheritableAcks(null, [danger()], 'fp-A').size).toBe(0);
    });
});
