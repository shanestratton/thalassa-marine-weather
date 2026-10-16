import { describe, expect, it } from 'vitest';
import { evaluateTraceRelease, traceCastOffBlockReason, traceFollowStatus } from '../services/traceVerification';
import { savedDryRuns, pinDryRunCaveat } from '../services/routing/dryRunWords';
import type { TraceLegVerdict } from '../services/routeTracer';
const now = Date.parse('2026-10-16T00:00:00Z');
const points = [
    { lat: 30, lon: -150 },
    { lat: 30.01, lon: -150 },
];
const context = {
    draftM: 2,
    draftAssumed: false,
    encRegistryVersion: 1,
    encRegistryFingerprint: 'ZZSYNTH@1',
    departureMs: now,
    tideWindowLabel: '',
};
const clear: TraceLegVerdict = {
    grade: 'clear',
    issues: [],
    minDepthM: 10,
    minAt: points[0],
    needsTide: false,
    nudge: null,
    nudgeTo: null,
};
describe('saved tide data cannot confer current clearance permission', () => {
    it('keeps chart-only checks usable but makes historical tide-window checks unchecked', () => {
        const checked = evaluateTraceRelease(
            points,
            'ready',
            [clear],
            new Set(),
            context,
            new Date(now).toISOString(),
        ).verification!;
        const current = { ...context, nowMs: now, voyageDepartureMs: now };
        expect(traceCastOffBlockReason(checked, points, current)).toBeNull();
        expect(traceFollowStatus(checked, points, current).tone).toBe('checked');
        const legacy = { ...checked, tideWindowLabel: 'leave now and every tide gate clears' };
        expect(traceCastOffBlockReason(legacy, points, current)).toContain('unverified tidal clearance');
        expect(traceFollowStatus(legacy, points, current)).toMatchObject({ tone: 'unchecked', code: 'tide' });
    });
    it.each([null, '', 'clears now until 06:00'])(
        'refuses a shallow cached verdict with tide label %s rather than banking it as verified',
        (tideWindowLabel) => {
            const gate = evaluateTraceRelease(
                points,
                'ready',
                [{ ...clear, grade: 'caution', needsTide: true, minDepthM: 1 }],
                new Set(),
                {
                    ...context,
                    tideWindowLabel,
                },
            );
            expect(gate.allowed).toBe(false);
            expect(gate.verification).toBeNull();
            expect(gate.reason).toContain('Tidal clearance is unverified');
        },
    );
    it('drops persisted tide tops and floating windows while retaining charted dry-tail facts', () => {
        const runs = savedDryRuns([
            {
                startSeg: 0,
                startT: 0,
                endSeg: 0,
                endT: 0.1,
                lengthM: 100,
                mid: [-150, 30],
                place: 'Synthetic bank',
                shallowestM: 0,
                deepestM: 0.2,
                draftM: 2,
                needM: 2.5,
                pin: { end: 'destination', at: 'on' },
                tide: { topM: 10, days: 14 },
                floats: { fromMs: now, toMs: now + 3600_000 },
                floatsWorkedMs: now,
            },
        ]);
        expect(runs).toHaveLength(1);
        expect(runs![0]).toMatchObject({ deepestM: 0.2, draftM: 2, tide: null });
        expect(runs![0].floats).toBeUndefined();
        expect(pinDryRunCaveat(runs![0], undefined, now)).not.toContain('you float');
    });
});
