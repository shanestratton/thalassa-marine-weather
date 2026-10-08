/**
 * Route checks are a warning, not a wall (build 124, Shane 2026-10-08: "maybe
 * just a warning rather than having to almost start again"). traceFollowStatus
 * is the one pure verdict behind every follow surface: green when a check
 * proves this line for this keel within a month, amber for everything that
 * merely lacks a check, and red ONLY when a real check of this very line at
 * this draft found something nobody has acknowledged.
 *
 * Fictional routes, two hemispheres: the Solent (UK) and Nouméa (New
 * Caledonia). The app is global.
 */
import { describe, expect, it } from 'vitest';
import type { TraceLegVerdict, TracePoint } from '../services/routeTracer';
import {
    evaluateTraceRelease,
    traceAutoBankSignature,
    traceFollowBlockReason,
    traceFollowStatus,
    traceGeometryKey,
} from '../services/traceVerification';
import type { TraceCheckOutcomeRecord } from '../services/traceCheckOutcomes';

const solent: TracePoint[] = [
    { lat: 50.766, lon: -1.297 },
    { lat: 50.742, lon: -1.42 },
    { lat: 50.754, lon: -1.533 },
];
const noumea: TracePoint[] = [
    { lat: -22.276, lon: 166.437 },
    { lat: -22.32, lon: 166.41 },
];

const verdict = (grade: TraceLegVerdict['grade']): TraceLegVerdict => ({
    grade,
    issues: grade === 'clear' ? [] : [{ severity: grade, message: grade === 'danger' ? 'charted wreck' : 'shoal' }],
    minDepthM: 8,
    minAt: solent[1],
    needsTide: false,
    nudge: null,
    nudgeTo: null,
});

const release = {
    draftM: 1.8,
    draftAssumed: false,
    encRegistryVersion: 1,
    encRegistryFingerprint: 'GB4X0001@1',
    departureMs: Date.parse('2026-09-30T06:00:00Z'),
    tideWindowLabel: '',
};
const NOW = Date.parse('2026-10-08T09:00:00Z');
const ctx = { draftM: 1.8, draftAssumed: false, nowMs: NOW };

const checkedOn = (
    iso: string,
    legs: TraceLegVerdict[] = [verdict('clear'), verdict('caution')],
    acks: ReadonlySet<number> = new Set(),
    points: TracePoint[] = solent,
) => evaluateTraceRelease(points, 'ready', legs, acks, release, iso).verification!;

const outcome = (
    kind: TraceCheckOutcomeRecord['kind'],
    extra: Partial<TraceCheckOutcomeRecord> = {},
): TraceCheckOutcomeRecord => ({
    geometryKey: traceGeometryKey(solent),
    draftM: 1.8,
    draftAssumed: false,
    encFingerprint: 'GB4X0001@1',
    at: '2026-10-07T09:00:00.000Z',
    kind,
    reason: kind,
    ...extra,
});

describe('traceFollowStatus — three states, amber never a wall', () => {
    it('no check at all is amber "Not checked yet"', () => {
        expect(traceFollowStatus(undefined, solent, ctx)).toEqual({
            tone: 'unchecked',
            code: 'none',
            reason: 'Not checked yet',
        });
    });

    it('a check for different pins is the same amber "Not checked yet"', () => {
        const moved = [solent[0], { lat: 50.75, lon: -1.43 }, solent[2]];
        expect(traceFollowStatus(checkedOn('2026-10-03T09:00:00Z'), moved, ctx)).toMatchObject({
            tone: 'unchecked',
            code: 'none',
            reason: 'Not checked yet',
        });
    });

    it('a changed keel says what it was checked at and what it is now', () => {
        expect(traceFollowStatus(checkedOn('2026-10-03T09:00:00Z'), solent, { ...ctx, draftM: 2.4 })).toMatchObject({
            tone: 'unchecked',
            code: 'draft',
            reason: 'Checked at 1.80 m draft, now 2.40 m',
        });
    });

    it('a check over a month old is amber with its date', () => {
        expect(traceFollowStatus(checkedOn('2026-09-04T09:00:00Z'), solent, ctx)).toMatchObject({
            tone: 'unchecked',
            code: 'aged',
            reason: 'Last checked 4 Sep',
        });
    });

    it('an assumed draft is amber and asks for the draft', () => {
        expect(
            traceFollowStatus(checkedOn('2026-10-03T09:00:00Z'), solent, { ...ctx, draftAssumed: true }),
        ).toMatchObject({ tone: 'unchecked', code: 'nodraft', reason: 'Set your draft so this can be checked' });
        expect(traceFollowStatus(undefined, solent, { ...ctx, draftAssumed: true })).toMatchObject({
            code: 'nodraft',
        });
    });

    it('a valid, same-keel check inside a month is green with its date', () => {
        const status = traceFollowStatus(checkedOn('2026-10-03T09:00:00Z'), solent, ctx);
        expect(status).toMatchObject({ tone: 'checked', code: 'ok', reason: null });
        expect(status.checkedAt).toBe('2026-10-03T09:00:00Z');
    });

    it('a danger-acknowledged check counts as checked: the skipper already accepted it', () => {
        const accepted = checkedOn('2026-10-03T09:00:00Z', [verdict('danger'), verdict('clear')], new Set([0]));
        expect(accepted.result).toBe('danger-acknowledged');
        expect(traceFollowStatus(accepted, solent, ctx)).toMatchObject({ tone: 'checked', code: 'ok' });
    });

    it('a finding from a real check of the SAME line at the SAME draft is red, naming the pins', () => {
        const red = traceFollowStatus(
            undefined,
            solent,
            ctx,
            outcome('finding', { legs: [{ from: 2, to: 3, message: 'crosses charted land' }] }),
        );
        expect(red).toEqual({ tone: 'finding', code: 'finding', reason: 'Pins 2→3: crosses charted land' });
    });

    it('several finding legs name the first and count the rest', () => {
        const red = traceFollowStatus(
            checkedOn('2026-09-01T09:00:00Z'),
            solent,
            ctx,
            outcome('finding', {
                legs: [
                    { from: 14, to: 15, message: 'crosses charted land' },
                    { from: 20, to: 21, message: 'charted wreck' },
                    { from: 33, to: 34, message: 'too shallow' },
                ],
            }),
        );
        expect(red.tone).toBe('finding');
        expect(red.reason).toBe('Pins 14→15: crosses charted land and 2 more');
    });

    it('ignores a finding for other pins (stale key) or another keel', () => {
        const stale = outcome('finding', {
            geometryKey: traceGeometryKey(noumea),
            legs: [{ from: 1, to: 2, message: 'charted wreck' }],
        });
        expect(traceFollowStatus(undefined, solent, ctx, stale)).toMatchObject({ tone: 'unchecked', code: 'none' });
        const otherKeel = outcome('finding', { draftM: 1.2, legs: [{ from: 1, to: 2, message: 'charted wreck' }] });
        expect(traceFollowStatus(undefined, solent, ctx, otherKeel)).toMatchObject({ tone: 'unchecked' });
    });

    it('a check banked after the finding wins over it', () => {
        const red = outcome('finding', {
            at: '2026-10-01T09:00:00.000Z',
            legs: [{ from: 1, to: 2, message: 'charted wreck' }],
        });
        expect(traceFollowStatus(checkedOn('2026-10-03T09:00:00Z'), solent, ctx, red)).toMatchObject({
            tone: 'checked',
        });
    });

    it('a check that could not run is amber with the honest reason', () => {
        expect(traceFollowStatus(undefined, solent, ctx, outcome('unavailable'))).toEqual({
            tone: 'unchecked',
            code: 'unavailable',
            reason: 'Couldn’t check: no connection. Will try again.',
        });
        expect(traceFollowStatus(undefined, solent, ctx, outcome('nochart'))).toMatchObject({
            tone: 'unchecked',
            code: 'nochart',
            reason: 'Couldn’t check: no ENC chart for part of it',
        });
        expect(traceFollowStatus(checkedOn('2026-09-01T09:00:00Z'), solent, ctx, outcome('tide'))).toMatchObject({
            tone: 'unchecked',
            code: 'tide',
            reason: 'Couldn’t check: tide data unavailable. Check the tide before you go.',
        });
    });

    it('works the same south of the equator and east of 180° W', () => {
        const checked = checkedOn('2026-10-05T09:00:00Z', [verdict('clear')], new Set(), noumea);
        expect(traceFollowStatus(checked, noumea, ctx).tone).toBe('checked');
        expect(traceFollowStatus(checked, solent, ctx).tone).toBe('unchecked');
    });
});

describe('traceFollowBlockReason — a thin wrapper that blocks only on red', () => {
    it('never blocks amber: no check, a changed keel or an old check', () => {
        expect(traceFollowBlockReason(undefined, solent, ctx)).toBeNull();
        expect(traceFollowBlockReason(checkedOn('2026-10-03T09:00:00Z'), solent, { ...ctx, draftM: 2.6 })).toBeNull();
        expect(traceFollowBlockReason(checkedOn('2026-06-01T09:00:00Z'), solent, ctx)).toBeNull();
    });

    it('returns the finding when one is supplied', () => {
        expect(
            traceFollowBlockReason(
                undefined,
                solent,
                ctx,
                outcome('finding', { legs: [{ from: 2, to: 3, message: 'charted wreck' }] }),
            ),
        ).toBe('Pins 2→3: charted wreck');
    });
});

/**
 * The tracer banks an unchanged line without Save (B5) — but never re-stamps
 * a merely AGED clearance. The tracer's verdicts can be hydrated from the leg
 * cache, which has no timestamp in its key, so a re-stamp from it would launder
 * a stale clearance into a fresh one. Only the cold background re-check may
 * refresh an aged check.
 */
describe('traceAutoBankSignature — the tracer auto-bank rule', () => {
    /** The verdicts in hand were graded for these exact pins at this keel. */
    const graded = { geometryKey: traceGeometryKey(solent), draftM: 1.8, draftAssumed: false };
    const allowed = (iso = '2026-10-08T08:00:00.000Z') => {
        const gate = evaluateTraceRelease(
            solent,
            'ready',
            [verdict('clear'), verdict('clear')],
            new Set(),
            release,
            iso,
        );
        expect(gate.allowed).toBe(true);
        return gate;
    };

    it('banks an unchanged stored line that has no check, without Save', () => {
        const signature = traceAutoBankSignature({ id: 'trace-solent' }, allowed(), ctx, new Set(), graded);
        expect(signature).toBe(`trace-solent|${traceGeometryKey(solent)}|1.8|false|`);
    });

    it('banks when the stored check was made at a different draft', () => {
        const atOldKeel = evaluateTraceRelease(
            solent,
            'ready',
            [verdict('clear'), verdict('clear')],
            new Set(),
            { ...release, draftM: 1.2 },
            '2026-10-03T09:00:00.000Z',
        ).verification!;
        expect(
            traceAutoBankSignature({ id: 'trace-solent', verification: atOldKeel }, allowed(), ctx, new Set(), graded),
        ).not.toBeNull();
    });

    it('does NOT refresh an aged envelope from cache-hydrated verdicts, acks or not', () => {
        const aged = checkedOn('2026-08-20T09:00:00Z');
        expect(
            traceAutoBankSignature({ id: 'trace-solent', verification: aged }, allowed(), ctx, new Set(), graded),
        ).toBeNull();
        expect(
            traceAutoBankSignature({ id: 'trace-solent', verification: aged }, allowed(), ctx, new Set([1]), graded),
        ).toBeNull();
    });

    it('does not re-stamp a fresh same-keel check, but still banks new acknowledgements', () => {
        const fresh = checkedOn('2026-10-03T09:00:00Z');
        expect(
            traceAutoBankSignature({ id: 'trace-solent', verification: fresh }, allowed(), ctx, new Set(), graded),
        ).toBeNull();
        expect(
            traceAutoBankSignature(
                { id: 'trace-solent', verification: fresh },
                allowed(),
                ctx,
                new Set([1, 0]),
                graded,
            ),
        ).toBe(`trace-solent|${traceGeometryKey(solent)}|1.8|false|0,1`);
    });

    it('never banks verdicts graded for OTHER pins — the first render after a route switch', () => {
        // The gate on screen is for the Solent line, but the verdicts in hand
        // were graded for a fictional Nouméa leg (the previous route). MapHub
        // memoises the gate on the pins and reads verdicts that land a render
        // later; this pairing is exactly that render.
        const stale = { geometryKey: traceGeometryKey(noumea), draftM: 1.8, draftAssumed: false };
        expect(traceAutoBankSignature({ id: 'trace-solent' }, allowed(), ctx, new Set(), stale)).toBeNull();
        // No grading identity at all (the verdicts did not come from a pass).
        expect(traceAutoBankSignature({ id: 'trace-solent' }, allowed(), ctx, new Set(), null)).toBeNull();
    });

    it('never banks verdicts graded at ANOTHER keel — the first render after a draft edit', () => {
        // Verdicts graded at 1.8 m; the skipper has just set 2.4 m. The gate
        // re-memoised on the vessel and stamped 2.4 m over the 1.8 m verdicts.
        const atNewKeel = evaluateTraceRelease(
            solent,
            'ready',
            [verdict('clear'), verdict('clear')],
            new Set(),
            { ...release, draftM: 2.4 },
            '2026-10-08T08:00:00.000Z',
        );
        const ctxNow = { ...ctx, draftM: 2.4 };
        const prior = checkedOn('2026-10-03T09:00:00Z');
        expect(
            traceAutoBankSignature({ id: 'trace-solent', verification: prior }, atNewKeel, ctxNow, new Set(), graded),
        ).toBeNull();
        // Once the pass re-grades at 2.4 m, it banks.
        expect(
            traceAutoBankSignature({ id: 'trace-solent', verification: prior }, atNewKeel, ctxNow, new Set(), {
                ...graded,
                draftM: 2.4,
            }),
        ).not.toBeNull();
    });

    it('never banks what the release gate refuses, or a line that is not stored', () => {
        const refused = { allowed: false, reason: 'Wait for every leg check to finish.', verification: null };
        expect(traceAutoBankSignature({ id: 'trace-solent' }, refused, ctx, new Set(), graded)).toBeNull();
        expect(traceAutoBankSignature(undefined, allowed(), ctx, new Set(), graded)).toBeNull();
    });
});
