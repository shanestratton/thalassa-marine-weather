/**
 * The tracer waits for the boat registry (127-C-c decision 7a, critic HIGH,
 * passes 2 and 3).
 *
 * Licensed cells are memory-only from 127, so after a launch (or an iOS
 * reload) the boat's charts are not in the registry until the phone has read
 * the Pi's index. A grading pass run before that would grade her route on the
 * open charts alone and — worse — overwrite the aboard bank with a fingerprint
 * that has no licensed cells in it. So:
 *
 *  - 'pending': no hydrate, no grade, no persist; rows say "checking…" and the
 *    card says "Opening Serene Summer's charts from the Pi…";
 *  - 'loaded': the bank hydrates (keyed by fingerprint, not one-shot) and only
 *    legs still missing are graded;
 *  - 'away' with licensed charts: legs are graded on the open charts but held
 *    PROVISIONAL — never persisted, never releasable;
 *  - the wait is capped at 20 s ('slow'), then grades as away.
 *
 * The real grading hook, the real bank and the real release gate run; the
 * chart builder, the leg grader, the registry and the Pi are stubbed, as
 * tests/tracerAutoBank.test.tsx does. Fictional Mediterranean legs.
 */
import { act, render, waitFor } from '@testing-library/react';
import React, { useMemo, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    boat: 'pending' as 'none' | 'pending' | 'loaded' | 'away',
    why: null as string | null,
    licensed: true,
    subs: new Set<() => void>(),
    ensure: vi.fn(async () => 'pending'),
    fingerprint: '',
    version: 1,
    registered: [] as unknown[],
    builds: 0,
    graded: [] as number[],
    gradeByLat: new Map<number, 'clear' | 'caution' | 'danger'>(),
}));

vi.mock('../services/enc/piCellSync', () => ({
    boatRegistryState: () => h.boat,
    boatRegistryWhy: () => h.why,
    subscribeBoatRegistry: (fn: () => void) => {
        h.subs.add(fn);
        return () => h.subs.delete(fn);
    },
    ensureBoatRegistry: h.ensure,
    boatHasLicensedCharts: () => h.licensed,
    boatName: () => 'Serene Summer',
}));
vi.mock('../services/routeTracer', async (importOriginal) => {
    const real = await importOriginal<typeof import('../services/routeTracer')>();
    return {
        ...real,
        buildTracerContext: vi.fn(async () => {
            h.builds += 1;
            return { status: 'ready' as const, ctx: { gateChecksUnavailable: false } };
        }),
        validateTraceLeg: vi.fn((a: { lat: number; lon: number }) => {
            h.graded.push(a.lat);
            const grade = h.gradeByLat.get(a.lat) ?? 'clear';
            return {
                grade,
                issues: grade === 'clear' ? [] : [{ severity: grade, message: 'charted rock' }],
                minDepthM: 6,
                minAt: a,
                needsTide: false,
                nudge: null,
                nudgeTo: null,
            };
        }),
        tideWindowLabelFor: vi.fn(async () => null),
    };
});
vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => h.version,
    getRegistryFingerprint: () => h.fingerprint,
    listRegisteredCells: () => h.registered,
    getRegisteredCell: (id: string) =>
        (h.registered as Array<{ id: string }>).find((c) => c.id === id.trim().toUpperCase()) ?? null,
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { LEG_VERDICTS_KEY, type TraceLegVerdict, type TracePoint } from '../services/routeTracer';
import { evaluateTraceRelease, type TraceReleaseGate } from '../services/traceVerification';
import { boatChartsRefusal } from '../services/enc/boatChartsWords';
import type { TracerStatus, TracerChartsWait } from '../components/map/useTracerGrading';

const FT = 3.28084;
const cellRec = (id: string, sourceHO: string, bbox: [number, number, number, number]) => ({
    id,
    sourceHO,
    edition: 1,
    issued: '2026-01-01',
    importedAt: '2026-01-02T00:00:00.000Z',
    bbox,
    geojsonPath: 'vault',
    hazardCount: 1,
    usage: 'navigation',
});
// Open (NOAA-shaped) water off the cape; her licensed chart over the islands.
const OPEN = cellRec('US5ZZ01M', 'US', [7.2, 43.6, 7.3, 43.7]);
const PROT = cellRec('OC-99-ZZ0901', 'ZZ', [7.0, 43.5, 7.1, 43.56]);
const F_OPEN = 'US5ZZ01M@1@2026-01-01@1000';
const F_LOADED = `OC-99-ZZ0901@1@2026-01-01@2000|${F_OPEN}`;

// Leg 1 lies wholly in open water; leg 2 crosses her licensed chart.
const route: TracePoint[] = [
    { lat: 43.65, lon: 7.25 },
    { lat: 43.66, lon: 7.27 },
    { lat: 43.54, lon: 7.05 },
];
const vessel = { draft: 1.8 * FT, estimatedFields: [] as string[] };

interface Probe {
    verdicts: ReadonlyArray<TraceLegVerdict | null>;
    status: TracerStatus;
    wait: TracerChartsWait | null;
    release: TraceReleaseGate | null;
    waitCalls: number;
}
const probe: Probe = { verdicts: [], status: 'idle', wait: null, release: null, waitCalls: 0 };

type Hook = typeof import('../components/map/useTracerGrading').useTracerGrading;

function makeHarness(useTracerGrading: Hook) {
    return function Harness() {
        const [legVerdicts, setLegVerdicts] = useState<Array<TraceLegVerdict | null>>([]);
        const [tracerStatus, setTracerStatus] = useState<TracerStatus>('idle');
        const [wait, setWait] = useState<TracerChartsWait | null>(null);
        const [, setTideLabels] = useState<Record<number, string>>({});
        const [acks, setAckedLegs] = useState<Set<number>>(() => new Set());
        const tracerCtxRef = useRef(null);
        const tracerCtxLruRef = useRef([]);
        const gradedDraftRef = useRef(null);
        const setTracerChartsWait = useRef((w: TracerChartsWait | null) => {
            probe.waitCalls += 1;
            setWait(w);
        }).current;
        const release = useMemo(
            () =>
                evaluateTraceRelease(route, tracerStatus, legVerdicts, acks, {
                    draftM: 1.8,
                    draftAssumed: false,
                    encRegistryVersion: 1,
                    encRegistryFingerprint: h.fingerprint,
                    departureMs: Date.parse('2026-10-11T07:00:00Z'),
                    tideWindowLabel: '',
                    boatChartsMissing: wait && wait !== 'opening' ? boatChartsRefusal(wait, 'Serene Summer') : null,
                }),
            [tracerStatus, legVerdicts, acks, wait],
        );
        useTracerGrading({
            capturedCoords: route,
            coordCaptureMode: true,
            vessel,
            legVerdicts,
            departureMs: null,
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
            setTracerChartsWait,
        });
        probe.verdicts = legVerdicts;
        probe.status = tracerStatus;
        probe.wait = wait;
        probe.release = release;
        return null;
    };
}
const NO_OFFSETS: number[] = [];
const noop = () => {};
const fromLru = () => null;

async function mountHook() {
    const { useTracerGrading } = await import('../components/map/useTracerGrading');
    const Harness = makeHarness(useTracerGrading);
    return render(<Harness />);
}

function setBoat(state: typeof h.boat, why: string | null = null): void {
    h.boat = state;
    h.why = why;
    if (state === 'loaded') {
        h.registered = [OPEN, PROT];
        h.fingerprint = F_LOADED;
    } else {
        h.registered = [OPEN];
        h.fingerprint = F_OPEN;
    }
    act(() => {
        for (const fn of [...h.subs]) fn();
    });
}

const bankKey = () => Object.keys(localStorage).find((k) => k.includes(LEG_VERDICTS_KEY)) ?? null;
const bankString = () => {
    const key = bankKey();
    return key ? localStorage.getItem(key) : null;
};
const graded = () => h.graded.length;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

/** Grade the route once aboard and bank it, as yesterday's check did. */
async function bankAboard(): Promise<string> {
    h.boat = 'loaded';
    h.registered = [OPEN, PROT];
    h.fingerprint = F_LOADED;
    const view = await mountHook();
    await waitFor(() => expect(probe.status).toBe('ready'));
    await settle();
    view.unmount();
    const bank = bankString();
    expect(bank).toBeTruthy();
    h.builds = 0;
    h.graded = [];
    return bank!;
}

describe('the Route tracer waits for the boat registry', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.useRealTimers();
        h.subs.clear();
        h.ensure.mockClear();
        h.licensed = true;
        h.builds = 0;
        h.graded = [];
        h.gradeByLat.clear();
        h.version = 1;
        h.boat = 'pending';
        h.why = null;
        h.registered = [OPEN];
        h.fingerprint = F_OPEN;
        Object.assign(probe, { verdicts: [], status: 'idle', wait: null, release: null, waitCalls: 0 });
        setAuthIdentityScope(null);
        setAuthIdentityScope('gate-owner');
    });
    afterEach(() => {
        vi.useRealTimers();
        setAuthIdentityScope(null);
    });

    it('paired + pending: nothing built, graded or persisted; rows wait, the card says it is opening, release refuses', async () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        await mountHook();
        await settle();
        expect(h.ensure).toHaveBeenCalled();
        expect(h.builds).toBe(0);
        expect(graded()).toBe(0);
        expect(setItem.mock.calls.filter(([k]) => String(k).includes(LEG_VERDICTS_KEY))).toEqual([]);
        expect(probe.verdicts).toEqual([null, null]);
        expect(probe.status).toBe('loading');
        expect(probe.wait).toBe('opening');
        expect(probe.release?.allowed).toBe(false);
        setItem.mockRestore();
    });

    it('pending → loaded: the bank fills every leg (open and stub), nothing is graded, the bank is unchanged', async () => {
        const bank = await bankAboard();
        h.boat = 'pending';
        h.registered = [OPEN];
        h.fingerprint = F_OPEN;
        await mountHook();
        await settle();
        expect(graded()).toBe(0);
        setBoat('loaded');
        await waitFor(() => expect(probe.verdicts.every((v) => v !== null)).toBe(true));
        await settle();
        expect(graded()).toBe(0);
        expect(h.builds).toBe(0);
        expect(probe.verdicts[0]?.stub).toBeFalsy();
        expect(probe.verdicts[1]?.stub).toBe(true);
        expect(probe.wait).toBeNull();
        expect(bankString()).toBe(bank);
    });

    it('a jetsam reload (modules gone) goes pending → loaded and grades nothing', async () => {
        const bank = await bankAboard();
        vi.resetModules();
        h.boat = 'pending';
        h.registered = [OPEN];
        h.fingerprint = F_OPEN;
        await mountHook();
        await settle();
        expect(graded()).toBe(0);
        setBoat('loaded');
        await waitFor(() => expect(probe.verdicts.every((v) => v !== null)).toBe(true));
        await settle();
        expect(graded()).toBe(0);
        expect(bankString()).toBe(bank);
    });

    it('away with licensed charts: grades once on the open charts, persists nothing, release names the boat', async () => {
        const bank = await bankAboard();
        h.boat = 'away';
        h.why = 'away';
        h.registered = [OPEN];
        h.fingerprint = F_OPEN;
        await mountHook();
        await waitFor(() => expect(probe.status).toBe('ready'));
        await settle();
        expect(graded()).toBe(2);
        expect(bankString()).toBe(bank);
        expect(probe.wait).toBe('away');
        expect(probe.release?.allowed).toBe(false);
        expect(probe.release?.reason).toBe(
            "Serene Summer's licensed charts open on the boat's Wi-Fi. Check it on the boat's Wi-Fi.",
        );
    });

    it('a durable clear graded away is held provisional, never releasable, and dropped once the charts open', async () => {
        h.boat = 'away';
        h.why = 'tailnet';
        await mountHook();
        await waitFor(() => expect(probe.status).toBe('ready'));
        expect(probe.verdicts.map((v) => v?.grade)).toEqual(['clear', 'clear']);
        expect(probe.release?.allowed).toBe(false);
        expect(bankString()).toBeNull();

        // Her licensed chart shows a rock on leg 2 that the open chart could not.
        h.gradeByLat.set(route[1].lat, 'danger');
        setBoat('loaded');
        await waitFor(() => expect(probe.verdicts[1]?.grade).toBe('danger'));
        expect(graded()).toBe(4);
        expect(probe.wait).toBeNull();
    });

    it('the cap: 20 s pending grades as away-slow; registration at 30 s drops it, hydrates, grades only the rest', async () => {
        await bankAboard();
        // The bank holds leg 1 only.
        const key = bankKey()!;
        const p = JSON.parse(localStorage.getItem(key)!);
        p.entries = p.entries.slice(0, 1);
        localStorage.setItem(key, JSON.stringify(p));

        vi.useFakeTimers();
        h.boat = 'pending';
        h.registered = [OPEN];
        h.fingerprint = F_OPEN;
        const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
        await mountHook();
        await tick(19_000);
        expect(graded()).toBe(0);
        expect(probe.wait).toBe('opening');
        await tick(1_500);
        await tick(500);
        expect(probe.wait).toBe('slow');
        expect(graded()).toBe(2);
        expect(probe.release?.allowed).toBe(false);
        await tick(9_000);

        h.graded = [];
        setBoat('loaded');
        await tick(500);
        await tick(500);
        expect(h.graded).toEqual([route[1].lat]);
        expect(probe.wait).toBeNull();
    });

    it('not paired (or Pi integration off): state none, graded and banked as today', async () => {
        h.boat = 'none';
        await mountHook();
        await waitFor(() => expect(probe.status).toBe('ready'));
        await settle();
        expect(graded()).toBe(2);
        expect(bankString()).not.toBeNull();
        expect(probe.wait).toBeNull();
        expect(probe.release?.allowed).toBe(true);
    });

    it('a Pi holding only NOAA cells (boatCharts.licensed false): an away pass persists and releases as today', async () => {
        h.licensed = false;
        h.boat = 'away';
        h.why = 'away';
        await mountHook();
        await waitFor(() => expect(probe.status).toBe('ready'));
        await settle();
        expect(bankString()).not.toBeNull();
        expect(probe.wait).toBeNull();
        expect(probe.release?.allowed).toBe(true);
    });

    it('50 open-cell registry changes re-run the grading effect zero times; each boat transition once', async () => {
        h.boat = 'pending';
        await mountHook();
        await settle();
        const runs = probe.waitCalls;
        for (let i = 0; i < 50; i++) {
            h.version += 1;
            h.fingerprint = `${F_OPEN}|US4ZZ${String(i).padStart(2, '0')}M@1`;
        }
        await settle();
        expect(probe.waitCalls).toBe(runs);
        setBoat('loaded');
        await waitFor(() => expect(probe.status).toBe('ready'));
        await settle();
        expect(probe.waitCalls).toBe(runs + 1);
    });
});
