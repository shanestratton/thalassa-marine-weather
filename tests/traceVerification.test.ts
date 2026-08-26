import { describe, expect, it } from 'vitest';
import type { TraceLegVerdict, TracePoint } from '../services/routeTracer';
import { TRACE_LAND_CROSSING_MESSAGE } from '../services/routeTracer';
import {
    evaluateTraceRelease,
    normaliseTraceVerification,
    parseTraceVerificationNote,
    serialiseTraceVerificationNote,
    traceCastOffBlockReason,
    traceFollowBlockReason,
    traceGeometryKey,
} from '../services/traceVerification';

const points: TracePoint[] = [
    { lat: -27.471, lon: 153.024 },
    { lat: -27.57, lon: 153.1 },
];

const verdict = (grade: TraceLegVerdict['grade'], needsTide = false): TraceLegVerdict => ({
    grade,
    issues: grade === 'clear' ? [] : [{ severity: grade, message: grade }],
    minDepthM: needsTide ? 1.2 : 8,
    minAt: points[1],
    needsTide,
    nudge: null,
    nudgeTo: null,
});

const context = {
    draftM: 1.8,
    draftAssumed: false,
    encRegistryVersion: 4,
    encRegistryFingerprint: 'AU5@1@2026-01-01@100',
    departureMs: Date.parse('2026-08-05T01:00:00.000Z'),
    tideWindowLabel: '',
};

describe('Route Tracer durable verification', () => {
    it.each([
        ['loading', 'Wait for every leg check'],
        ['nochart', 'ENC chart coverage is unavailable'],
        ['toolarge', 'too large to check'],
        ['marksonly', 'Depth was not checked'],
    ] as const)('fails closed while status is %s', (status, message) => {
        const gate = evaluateTraceRelease(points, status, [verdict('clear')], new Set(), context);
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toContain(message);
    });

    it('binds a completed check to the exact ordered geometry and context', () => {
        const gate = evaluateTraceRelease(
            points,
            'ready',
            [verdict('caution')],
            new Set(),
            context,
            '2026-08-05T00:00:00.000Z',
        );
        expect(gate.allowed).toBe(true);
        expect(gate.verification).toMatchObject({
            result: 'verified',
            legGrades: ['caution'],
            geometryKey: traceGeometryKey(points),
            draftM: 1.8,
            encRegistryFingerprint: context.encRegistryFingerprint,
        });
        expect(normaliseTraceVerification(gate.verification, points)).not.toBeNull();
        expect(
            normaliseTraceVerification(gate.verification, [points[0], { ...points[1], lon: points[1].lon + 0.001 }]),
        ).toBeNull();
    });

    it('requires every no-go leg to be explicitly acknowledged', () => {
        const blocked = evaluateTraceRelease(points, 'ready', [verdict('danger')], new Set(), context);
        expect(blocked.allowed).toBe(false);
        expect(blocked.reason).toContain('Acknowledge the no-go leg');

        const allowed = evaluateTraceRelease(
            points,
            'ready',
            [verdict('danger')],
            new Set([0]),
            context,
            '2026-08-05T00:00:00.000Z',
        );
        expect(allowed.verification).toMatchObject({
            result: 'danger-acknowledged',
            acknowledgedDangerLegs: [0],
        });
    });

    it('never releases a tide-gated leg without a completed tide result', () => {
        expect(
            evaluateTraceRelease(points, 'ready', [verdict('danger', true)], new Set([0]), {
                ...context,
                tideWindowLabel: null,
            }).reason,
        ).toContain('tide-window check');
        expect(
            evaluateTraceRelease(points, 'ready', [verdict('danger', true)], new Set([0]), {
                ...context,
                tideWindowLabel: '',
            }).reason,
        ).toContain('Tide data is unavailable');
    });

    it('round-trips the namespaced voyage note and rejects stale Cast Off context', () => {
        const verification = evaluateTraceRelease(
            points,
            'ready',
            [verdict('clear')],
            new Set(),
            context,
            '2026-08-05T00:00:00.000Z',
        ).verification!;
        const parsed = parseTraceVerificationNote(
            `${serialiseTraceVerificationNote(verification)}\nskipper note`,
            points,
        );
        expect(parsed).toEqual(verification);

        const castOffContext = {
            draftM: context.draftM,
            draftAssumed: false,
            encRegistryFingerprint: context.encRegistryFingerprint,
            voyageDepartureMs: context.departureMs,
            nowMs: Date.parse('2026-08-05T02:00:00.000Z'),
        };
        expect(traceCastOffBlockReason(parsed, points, castOffContext)).toBeNull();
        expect(
            traceCastOffBlockReason(parsed, points, { ...castOffContext, encRegistryFingerprint: 'different' }),
        ).toContain('chart library has changed');
        expect(traceCastOffBlockReason(parsed, points, { ...castOffContext, draftM: 2.2 })).toContain(
            'draft has changed',
        );
        // This check carries no tide window, so departure drift is irrelevant to it.
        expect(
            traceCastOffBlockReason(parsed, points, {
                ...castOffContext,
                voyageDepartureMs: context.departureMs + 3_600_000,
            }),
        ).toBeNull();

        // A tide-gated check DID verify a specific departure — drift past the
        // 30-minute tolerance invalidates it; drift inside it does not.
        const tideGated = evaluateTraceRelease(
            points,
            'ready',
            [verdict('clear')],
            new Set(),
            { ...context, tideWindowLabel: 'HW 03:12 · window 01:40–04:45' },
            '2026-08-05T00:00:00.000Z',
        ).verification!;
        expect(
            traceCastOffBlockReason(tideGated, points, {
                ...castOffContext,
                voyageDepartureMs: context.departureMs + 3_600_000,
            }),
        ).toContain('planned departure changed');
        expect(
            traceCastOffBlockReason(tideGated, points, {
                ...castOffContext,
                voyageDepartureMs: context.departureMs + 10 * 60_000,
            }),
        ).toBeNull();
    });
});

describe('land crossings can never be acknowledged (Shane 2026-08-10)', () => {
    const landVerdict = (): TraceLegVerdict => ({
        grade: 'danger',
        issues: [{ severity: 'danger', message: TRACE_LAND_CROSSING_MESSAGE, at: points[1] }],
        minDepthM: null,
        minAt: null,
        needsTide: false,
        nudge: null,
        nudgeTo: null,
    });

    it('refuses release even when the land leg is acknowledged', () => {
        const gate = evaluateTraceRelease(points, 'ready', [landVerdict()], new Set([0]), context);
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toMatch(/land legs cannot be acknowledged/i);
    });

    it('still allows acknowledging a NON-land danger (hazard crossings are a judgement call)', () => {
        const hazard: TraceLegVerdict = {
            ...landVerdict(),
            issues: [{ severity: 'danger', message: 'crosses a charted hazard', at: points[1] }],
        };
        const gate = evaluateTraceRelease(points, 'ready', [hazard], new Set([0]), context);
        expect(gate.allowed).toBe(true);
        expect(gate.verification?.result).toBe('danger-acknowledged');
    });
});

describe('traceFollowBlockReason — following an accepted route stays gentle', () => {
    const followCtx = { draftM: 1.8, draftAssumed: false, nowMs: Date.parse('2026-08-10T00:00:00.000Z') };
    const freshVerification = () =>
        evaluateTraceRelease(points, 'ready', [verdict('caution')], new Set(), context, '2026-08-09T00:00:00.000Z')
            .verification;

    it('passes an accepted check without tide-window or departure nagging', () => {
        // Cast Off would demand a departure match and a 48 h-fresh tide check;
        // re-sailing an accepted line from the Log must not.
        expect(traceFollowBlockReason(freshVerification(), points, followCtx)).toBeNull();
    });

    it('still refuses when there is no valid check for the steered geometry', () => {
        const moved = [points[0], { lat: -27.6, lon: 153.2 }];
        expect(traceFollowBlockReason(freshVerification(), moved, followCtx)).toMatch(/no valid check/i);
    });

    it('still refuses when the keel changed since the check', () => {
        expect(traceFollowBlockReason(freshVerification(), points, { ...followCtx, draftM: 2.6 })).toMatch(
            /draft has changed/i,
        );
    });

    it('still refuses a check older than 30 days', () => {
        const old = evaluateTraceRelease(
            points,
            'ready',
            [verdict('caution')],
            new Set(),
            context,
            '2026-06-01T00:00:00.000Z',
        ).verification;
        expect(traceFollowBlockReason(old, points, followCtx)).toMatch(/over a month old/i);
    });
});
