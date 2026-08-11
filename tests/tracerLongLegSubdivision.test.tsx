import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A leg longer than the depth-grid budget used to be graded marks-only and told
 * the skipper "drop a pin midway" — the app asking the user to do work it could
 * do itself. useTracerGrading now cuts such a leg into grid-sized pieces, grades
 * each in its own window, and folds them into the ONE verdict the leg row shows.
 *
 * These are the first tests for this hook. It had none, which is how the
 * cluster-bound defect (tight bbox bounded, padded bbox not) survived.
 *
 * They drive the real hook with a stubbed context builder, so the subdivision,
 * clustering, folding and cache/failMap routing are all the real code paths.
 */

const h = vi.hoisted(() => {
    /** Padded bboxes buildTracerContext was asked for — one per window. */
    const builtFor: Array<[number, number, number, number]> = [];
    /** Legs validateTraceLeg was asked to grade — one per PIECE. */
    const graded: Array<{ a: { lat: number; lon: number }; b: { lat: number; lon: number }; lastLeg: boolean }> = [];
    return { builtFor, graded };
});

vi.mock('../services/routeTracer', async (importOriginal) => {
    const real = await importOriginal<typeof import('../services/routeTracer')>();
    return {
        ...real,
        // Every window builds cleanly with a grid — so any "unchecked" verdict
        // in these tests came from the hook's own logic, not from a stub.
        buildTracerContext: vi.fn(async (bbox: [number, number, number, number]) => {
            h.builtFor.push(bbox);
            return { status: 'ready' as const, ctx: { gateChecksUnavailable: false } as never };
        }),
        validateTraceLeg: vi.fn(
            (
                a: { lat: number; lon: number },
                b: { lat: number; lon: number },
                _ctx: unknown,
                opts?: { lastLeg?: boolean },
            ) => {
                h.graded.push({ a, b, lastLeg: opts?.lastLeg === true });
                return {
                    grade: 'clear' as const,
                    issues: [],
                    minDepthM: 9,
                    minAt: a,
                    needsTide: false,
                    nudge: null,
                    nudgeTo: null,
                };
            },
        ),
        hydrateLegVerdicts: vi.fn(() => null),
        persistLegVerdicts: vi.fn(),
        tideWindowLabelFor: vi.fn(async () => null),
    };
});

vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => 'test-enc-v1',
    // Needed since the 2026-08-11 regrade-loop fix (5188d360) fingerprints
    // the chart library inside useTracerGrading's grading effect.
    getRegistryFingerprint: () => 'test-enc-fingerprint',
}));

import { useTracerGrading, type TracerStatus } from '../components/map/useTracerGrading';
import { splitLegForDepthGrid, type TraceLegVerdict } from '../services/routeTracer';

/** Minimal but REAL dep bag — only the setters are captured. */
function makeDeps(capturedCoords: { lat: number; lon: number }[]) {
    const verdicts: Array<Array<TraceLegVerdict | null>> = [];
    let status: TracerStatus = 'idle';
    const deps = {
        capturedCoords,
        coordCaptureMode: true,
        vessel: { draft: 8 }, // feet — a real draft, so nothing is "assumed"
        legVerdicts: [] as Array<TraceLegVerdict | null>,
        departureMs: null,
        legEtaOffsetsMs: [],
        tracerCtxRef: { current: null },
        tracerCtxLruRef: { current: [] },
        gradedDraftRef: { current: null },
        tracerCtxFromLru: () => null, // force a real build per window
        tracerCtxHold: () => {},
        setLegVerdicts: (v: unknown) => {
            const next = typeof v === 'function' ? (v as (p: unknown) => never)([]) : v;
            verdicts.push(next as Array<TraceLegVerdict | null>);
        },
        setTracerStatus: (v: unknown) => {
            status = (typeof v === 'function' ? (v as (p: unknown) => TracerStatus)(status) : v) as TracerStatus;
        },
        setTideLabels: () => {},
        setAckedLegs: () => {},
        setSailArmed: () => {},
        setShareArmed: () => {},
    };
    return { deps, verdicts, latest: () => verdicts[verdicts.length - 1], statusNow: () => status };
}

const SHORT_A = { lat: -27.2, lon: 153.1 };
const SHORT_B = { lat: -27.24, lon: 153.14 }; // ~5 km
const LONG_B = { lat: -26.66, lon: 153.1 }; // ~60 km due north — cannot fit one grid

beforeEach(() => {
    h.builtFor.length = 0;
    h.graded.length = 0;
    localStorage.clear();
});

describe('useTracerGrading — long-leg subdivision', () => {
    it('grades a long leg in PIECES and folds them into one verdict', async () => {
        // Guard the premise: this leg genuinely cannot be graded whole.
        expect(splitLegForDepthGrid(SHORT_A, LONG_B).length).toBeGreaterThan(0);

        const { deps, latest } = makeDeps([SHORT_A, LONG_B]);
        renderHook(() => useTracerGrading(deps as never));

        await waitFor(() => expect(latest()?.[0]).toBeTruthy());

        // ONE leg row...
        expect(latest()).toHaveLength(1);
        // ...but graded as several pieces, each in its own window.
        expect(h.graded.length).toBeGreaterThan(1);
        expect(h.builtFor.length).toBeGreaterThan(1);

        const v = latest()![0]!;
        expect(v.grade).toBe('clear');
        expect(v.issues.map((i) => i.message)).not.toContain('depth unchecked — leg too long to check');
    });

    it('the pieces cover the whole leg, end to end, without moving it', async () => {
        const { deps, latest } = makeDeps([SHORT_A, LONG_B]);
        renderHook(() => useTracerGrading(deps as never));
        await waitFor(() => expect(latest()?.[0]).toBeTruthy());

        const pieces = h.graded;
        // Without this the rest holds trivially for an unsplit leg — a check I
        // only made because two earlier versions of these tests passed with
        // subdivision switched off.
        expect(pieces.length).toBeGreaterThan(1);
        expect(pieces[0].a).toEqual(SHORT_A);
        expect(pieces[pieces.length - 1].b).toEqual(LONG_B);
        // Contiguous: each piece starts where the previous ended.
        for (let i = 1; i < pieces.length; i++) {
            expect(pieces[i].a.lat).toBeCloseTo(pieces[i - 1].b.lat, 9);
            expect(pieces[i].a.lon).toBeCloseTo(pieces[i - 1].b.lon, 9);
        }
    });

    it('only the FINAL piece of the final leg is treated as the last leg', async () => {
        // ownsSoloApproach hands a mark to the next leg unless lastLeg is set,
        // so marking every piece last would make each one claim marks that its
        // successor owns — duplicate solo-lateral advisories down a long leg.
        const { deps, latest } = makeDeps([SHORT_A, LONG_B]);
        renderHook(() => useTracerGrading(deps as never));
        await waitFor(() => expect(latest()?.[0]).toBeTruthy());

        expect(h.graded.length).toBeGreaterThan(1); // otherwise "exactly one" is trivial
        expect(h.graded.filter((g) => g.lastLeg)).toHaveLength(1);
        expect(h.graded[h.graded.length - 1].lastLeg).toBe(true);
    });

    it('leaves a short leg completely alone — one window, one grade', async () => {
        const { deps, latest } = makeDeps([SHORT_A, SHORT_B]);
        renderHook(() => useTracerGrading(deps as never));
        await waitFor(() => expect(latest()?.[0]).toBeTruthy());

        expect(h.graded).toHaveLength(1);
        expect(h.builtFor).toHaveLength(1);
        expect(h.graded[0].a).toEqual(SHORT_A);
        expect(h.graded[0].b).toEqual(SHORT_B);
    });
});
