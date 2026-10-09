/**
 * The tracer's auto-bank (build 124, B5) driven beside the REAL grading hook,
 * composed the way MapHub composes them: a release gate memoised on the pins
 * and the vessel that reads legVerdicts, which the grading pass replaces one
 * render LATER.
 *
 * Review, 2026-10-08: that render paired the NEW pins (or the NEW keel) with
 * the OLD verdicts, the gate said "allowed", and the auto-bank wrote "checked
 * today" over legs nobody had graded — a red reef leg turned green on a route
 * switch, and a 2.6 m keel was "checked" over a 2.2 m shoal on a draft edit.
 * Only the chart builder and the leg grader are stubbed here; the grading
 * hook, the gate, the auto-bank rule and the bank are all the real code.
 */
import { act, render, waitFor } from '@testing-library/react';
import React, { useMemo, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    /** The grade the stub grader hands out, per route (keyed by first pin lat). */
    gradeByLat: new Map<number, 'clear' | 'caution' | 'danger'>(),
    needsTide: false,
    events: [] as string[],
    banks: [] as Array<{ id: string; draftM: number }>,
}));

vi.mock('../services/routeTracer', async (importOriginal) => {
    const real = await importOriginal<typeof import('../services/routeTracer')>();
    return {
        ...real,
        buildTracerContext: vi.fn(async () => ({ status: 'ready' as const, ctx: { gateChecksUnavailable: false } })),
        validateTraceLeg: vi.fn((a: { lat: number; lon: number }) => {
            const grade = h.gradeByLat.get(a.lat) ?? 'clear';
            h.events.push(`grade:${grade}`);
            return {
                grade,
                issues: grade === 'clear' ? [] : [{ severity: grade, message: 'charted reef' }],
                minDepthM: 2.2,
                minAt: a,
                needsTide: h.needsTide,
                nudge: null,
                nudgeTo: null,
            };
        }),
        hydrateLegVerdicts: vi.fn(() => null),
        persistLegVerdicts: vi.fn(),
        tideWindowLabelFor: vi.fn(async () => null),
        bankTraceVerification: vi.fn((...args: Parameters<typeof real.bankTraceVerification>) => {
            h.events.push('bank');
            h.banks.push({ id: args[0], draftM: args[1].draftM });
            return real.bankTraceVerification(...args);
        }),
    };
});

vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => 1,
    getRegistryFingerprint: () => 'FR5TEST@1',
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import {
    loadSavedTraces,
    saveTrace,
    type SavedTrace,
    type TraceLegVerdict,
    type TracePoint,
} from '../services/routeTracer';
import { evaluateTraceRelease } from '../services/traceVerification';
import { vesselDraftIsAssumed, vesselDraftMetres } from '../services/units';
import { useTracerGrading, type TracerStatus } from '../components/map/useTracerGrading';
import { useTracerAutoBank, type TideLabelFor } from '../components/map/useTracerAutoBank';

const FT = 3.28084;
const DEPART = Date.parse('2026-10-10T07:00:00Z');
const NO_OFFSETS: number[] = [];
const noop = () => {};
const fromLru = () => null;

// Fictional routes, none Australian: Antibes → Îles de Lérins (France) and a
// Nouméa lagoon leg (New Caledonia).
const antibes: TracePoint[] = [
    { lat: 43.585, lon: 7.13 },
    { lat: 43.53, lon: 7.06 },
];
const noumea: TracePoint[] = [
    { lat: -22.276, lon: 166.437 },
    { lat: -22.32, lon: 166.41 },
];

type Vessel = { draft: number; estimatedFields: string[] };
const keel = (m: number): Vessel => ({ draft: m * FT, estimatedFields: [] });

function Harness(props: {
    coords: TracePoint[];
    vessel: Vessel;
    capture: boolean;
    tideLabel?: string;
    labelForRef?: { current: TideLabelFor | null };
    onVerdicts?: (v: ReadonlyArray<TraceLegVerdict | null>) => void;
    legAnchor?: { tripId: string; ordinal: number } | null;
}) {
    const { coords, vessel, capture, tideLabel = '', onVerdicts } = props;
    const [legVerdicts, setLegVerdicts] = useState<Array<TraceLegVerdict | null>>([]);
    const [tracerStatus, setTracerStatus] = useState<TracerStatus>('idle');
    const [ackedLegs, setAckedLegs] = useState<Set<number>>(() => new Set());
    const [, setTideLabels] = useState<Record<number, string>>({});
    const [savedTraces, setSavedTraces] = useState<SavedTrace[]>(() => loadSavedTraces());
    const tracerCtxRef = useRef(null);
    const tracerCtxLruRef = useRef([]);
    const gradedDraftRef = useRef(null);
    const ownLabelForRef = useRef<TideLabelFor | null>(null);
    onVerdicts?.(legVerdicts);
    const release = useMemo(
        () =>
            evaluateTraceRelease(coords, tracerStatus, legVerdicts, ackedLegs, {
                draftM: vesselDraftMetres(vessel),
                draftAssumed: vesselDraftIsAssumed(vessel),
                encRegistryVersion: 1,
                encRegistryFingerprint: 'FR5TEST@1',
                departureMs: DEPART,
                tideWindowLabel: tideLabel,
            }),
        [coords, tracerStatus, legVerdicts, ackedLegs, vessel, tideLabel],
    );
    // MapHub's order: the auto-bank is declared BEFORE the grading hook.
    useTracerAutoBank({
        coordCaptureMode: capture,
        capturedCoords: coords,
        legVerdicts,
        release,
        ackedLegs,
        vessel,
        departureMs: DEPART,
        tideLabelForRef: props.labelForRef ?? ownLabelForRef,
        savedTraces,
        setSavedTraces,
        legAnchor: props.legAnchor ?? null,
    });
    useTracerGrading({
        capturedCoords: coords,
        coordCaptureMode: capture,
        vessel,
        legVerdicts,
        departureMs: DEPART,
        legEtaOffsetsMs: NO_OFFSETS,
        tracerCtxRef,
        tracerCtxLruRef,
        gradedDraftRef,
        tracerCtxFromLru: fromLru,
        tracerCtxHold: noop,
        setLegVerdicts,
        setTracerStatus,
        setTideLabels,
        setAckedLegs,
        setSailArmed: noop,
        setShareArmed: noop,
    });
    return null;
}

const stored = (id: string) => loadSavedTraces().find((t) => t.id === id);
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

describe('useTracerAutoBank — never banks verdicts graded for other pins or another keel', () => {
    beforeEach(() => {
        localStorage.clear();
        h.gradeByLat.clear();
        h.needsTide = false;
        h.events.length = 0;
        h.banks.length = 0;
        setAuthIdentityScope(null);
        setAuthIdentityScope('autobank-owner');
    });
    afterEach(() => {
        setAuthIdentityScope(null);
    });

    it('banks an unchanged stored line once its OWN grading lands (the Shane case: a lost check)', async () => {
        const id = saveTrace('Antibes → Lérins', antibes).trace.id;
        render(<Harness coords={antibes} vessel={keel(1.8)} capture />);
        await waitFor(() => expect(stored(id)?.verification?.draftM).toBeCloseTo(1.8, 2));
        expect(h.events).toEqual(['grade:clear', 'bank']);
    });

    it('a route switch never banks the next route with the last route’s verdicts', async () => {
        const a = saveTrace('Antibes → Lérins', antibes).trace.id;
        const b = saveTrace('Nouméa lagoon', noumea).trace.id;
        h.gradeByLat.set(noumea[0].lat, 'danger');
        const vessel = keel(1.8);
        const view = render(<Harness coords={antibes} vessel={vessel} capture />);
        await waitFor(() => expect(stored(a)?.verification).toBeTruthy());

        // Load the Nouméa leg. The first render pairs its pins with the clear
        // Antibes verdicts and an allowed gate; its own grading finds a reef.
        view.rerender(<Harness coords={noumea} vessel={vessel} capture />);
        await waitFor(() => expect(h.events).toContain('grade:danger'));
        await settle();

        expect(h.banks.map((bank) => bank.id)).toEqual([a]);
        expect(stored(b)?.verification).toBeUndefined();
    });

    it('a draft edit with the tracer CLOSED (pins kept) banks nothing — that tracer never re-grades', async () => {
        const id = saveTrace('Antibes → Lérins', antibes).trace.id;
        const view = render(<Harness coords={antibes} vessel={keel(1.8)} capture />);
        await waitFor(() => expect(stored(id)?.verification?.draftM).toBeCloseTo(1.8, 2));

        const closedAt18 = keel(1.8);
        view.rerender(<Harness coords={antibes} vessel={closedAt18} capture={false} />);
        await settle();
        view.rerender(<Harness coords={antibes} vessel={keel(2.6)} capture={false} />);
        await settle();

        expect(h.banks).toHaveLength(1);
        expect(stored(id)?.verification?.draftM).toBeCloseTo(1.8, 2);
    });

    it('a draft edit with the tracer OPEN banks only after the re-grade at the new keel — and never a shoal', async () => {
        const id = saveTrace('Antibes → Lérins', antibes).trace.id;
        const view = render(<Harness coords={antibes} vessel={keel(1.8)} capture />);
        await waitFor(() => expect(stored(id)?.verification?.draftM).toBeCloseTo(1.8, 2));

        // At 2.6 m the 2.2 m patch is a no-go leg.
        h.gradeByLat.set(antibes[0].lat, 'danger');
        h.events.length = 0;
        view.rerender(<Harness coords={antibes} vessel={keel(2.6)} capture />);
        await waitFor(() => expect(h.events).toContain('grade:danger'));
        await settle();
        expect(h.events).not.toContain('bank');
        expect(stored(id)?.verification?.draftM).toBeCloseTo(1.8, 2);

        // Clear at 2.0 m: banks — but only AFTER the grade, and at 2.0 m.
        h.gradeByLat.set(antibes[0].lat, 'clear');
        h.events.length = 0;
        view.rerender(<Harness coords={antibes} vessel={keel(2.0)} capture />);
        await waitFor(() => expect(stored(id)?.verification?.draftM).toBeCloseTo(2.0, 2));
        expect(h.events).toEqual(['grade:clear', 'bank']);
    });

    it('a tide-gated line waits for a tide window computed for THESE verdicts', async () => {
        h.needsTide = true;
        h.gradeByLat.set(antibes[0].lat, 'caution');
        const id = saveTrace('Antibes → Lérins', antibes).trace.id;
        const vessel = keel(1.8);
        let latest: ReadonlyArray<TraceLegVerdict | null> = [];
        const onVerdicts = (v: ReadonlyArray<TraceLegVerdict | null>) => {
            latest = v;
        };
        // The window on hand was computed for a previous line's verdicts.
        const labelForRef = { current: { verdicts: [] as TraceLegVerdict[], departureMs: DEPART } as TideLabelFor };
        const view = render(
            <Harness
                coords={antibes}
                vessel={vessel}
                capture
                tideLabel="Leave 09:10–13:30"
                labelForRef={labelForRef}
                onVerdicts={onVerdicts}
            />,
        );
        await waitFor(() => expect(h.events).toContain('grade:caution'));
        await settle();
        expect(h.events).not.toContain('bank');

        // The window for these verdicts lands (MapHub sets the ref, then the label).
        labelForRef.current = { verdicts: latest, departureMs: DEPART };
        view.rerender(
            <Harness
                coords={antibes}
                vessel={vessel}
                capture
                tideLabel="Leave 09:15–13:30"
                labelForRef={labelForRef}
                onVerdicts={onVerdicts}
            />,
        );
        await waitFor(() => expect(stored(id)?.verification?.tideWindowLabel).toBe('Leave 09:15–13:30'));
    });
});

/**
 * 126-16a review: a trip leg copied from another trip that joins at 0 NM has
 * exactly its source's pins. Shane builds trip Y from last year's P; Y's leg 2
 * ends exactly where P's leg 2 does, so "Plot the 3rd leg →" with P's leg 3
 * snaps and copies it pin for pin. The copy is on screen, unsaved, locked to
 * Y's slot 3. Matched by geometry alone, the auto-bank found P's leg 3 and
 * wrote the copy's check onto it (and refreshed its Passage Planning note)
 * before Save, against "The original is unchanged".
 *
 * Fictional Caribbean trips: English Harbour → Deshaies → Portsmouth → Roseau.
 */
describe('useTracerAutoBank — a slot-locked draft banks onto its own slot only', () => {
    const englishHarbour = { lat: 17.005, lon: -61.765 };
    const deshaies = { lat: 16.307, lon: -61.797 };
    const portsmouth = { lat: 15.578, lon: -61.465 };
    const pLeg3: TracePoint[] = [portsmouth, { lat: 15.45, lon: -61.48 }, { lat: 15.29, lon: -61.39 }];

    beforeEach(() => {
        localStorage.clear();
        h.gradeByLat.clear();
        h.needsTide = false;
        h.events.length = 0;
        h.banks.length = 0;
        setAuthIdentityScope(null);
        setAuthIdentityScope('autobank-owner');
    });
    afterEach(() => {
        setAuthIdentityScope(null);
    });

    function seedTrips(): { p3: string; raw: () => string | undefined } {
        const p1 = saveTrace('English Harbour - Deshaies (1st Leg)', [englishHarbour, deshaies], {
            legOrdinal: 1,
        }).trace.id;
        saveTrace('Deshaies - Portsmouth (2nd Leg)', [deshaies, portsmouth], { tripId: p1, legOrdinal: 2 });
        const p3 = saveTrace('Portsmouth - Roseau (3rd Leg)', pLeg3, { tripId: p1, legOrdinal: 3 }).trace.id;
        // Trip Y: its leg 2 is a copy of P's leg 2, so it ends exactly at P3[0].
        const y1 = saveTrace('Falmouth - Deshaies (1st Leg)', [{ lat: 17.01, lon: -61.78 }, deshaies], {
            legOrdinal: 1,
        }).trace.id;
        saveTrace('Deshaies - Portsmouth (2nd Leg)', [deshaies, portsmouth], { tripId: y1, legOrdinal: 2 });
        const raw = () => JSON.stringify(stored(p3));
        return { p3, raw };
    }

    it('a 0 NM copy of another trip’s leg, unsaved in an empty slot, leaves the source byte-identical', async () => {
        const { raw } = seedTrips();
        const before = raw();
        const y1 = loadSavedTraces().find((t) => t.name === 'Falmouth - Deshaies (1st Leg)')!.id;
        render(<Harness coords={pLeg3} vessel={keel(1.8)} capture legAnchor={{ tripId: y1, ordinal: 3 }} />);
        await waitFor(() => expect(h.events).toContain('grade:clear'));
        await settle();
        expect(h.events).not.toContain('bank');
        expect(raw()).toBe(before);
    });

    it('the same line opened in its own slot (P leg 3) still banks onto P leg 3', async () => {
        const { p3 } = seedTrips();
        const p1 = stored(p3)!.tripId!;
        render(<Harness coords={pLeg3} vessel={keel(1.8)} capture legAnchor={{ tripId: p1, ordinal: 3 }} />);
        await waitFor(() => expect(stored(p3)?.verification?.draftM).toBeCloseTo(1.8, 2));
        expect(h.banks.map((bank) => bank.id)).toEqual([p3]);
    });
});
