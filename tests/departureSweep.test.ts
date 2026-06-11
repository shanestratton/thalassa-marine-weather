/**
 * DepartureSweepInshore v1 tests — synthetic sinusoid tide + a one-spot
 * route with hand-computable expectations.
 *
 * Geometry/physics of the fixture (worked by hand):
 *   tide(t)   = 1 − cos(2π·h/12)  → LW 0 m at T0, HW 2 m at +6 h; ≥1.0 m
 *               exactly on [+3 h, +9 h] (and [+15 h, +21 h]).
 *   spot      legIndex 0, minDepth 1.9 m; draft 2.4 m; default safety
 *               0.5 m → requiredRise = 1.0 m, so the padded window over a
 *               full query range is [+3.5 h, +8.5 h].
 *   passage   one 1,111.95 m leg at LEG_M/(1.75·3600) m/s → spot ETA is
 *               depart + 1.75 h (deliberately OFF the 30-min sweep grid so
 *               no classification sits on a razor-edge window boundary).
 *   ⇒ clear  iff  3.5 h ≤ depart + 1.75 h ≤ 8.5 h  ⇔  1.75 ≤ d ≤ 6.75 h
 *     ⇔ grid departures 2.0 h … 6.5 h = sweep indices 4…13 (15-min margin).
 */

import { describe, expect, it } from 'vitest';
import { tideFieldFromCurve, type TideField } from '../services/routing/env/EnvFields';
import type { LonLat } from '../services/routing/TideAwareAnnotator';
import {
    sweepDepartures,
    DEFAULT_SWEEP_COUNT,
    DEFAULT_SWEEP_STEP_MS,
    ARRIVAL_SLACK_MS,
} from '../services/routing/DepartureSweepInshore';
import { DEFAULT_TIDE_SAFETY_M, EDGE_PAD_MS } from '../services/routing/tidalWindow';
import type { TideCurve } from '../services/TideHeightService';

const T0 = Date.UTC(2026, 5, 12, 0, 0, 0);
const HOUR = 3_600_000;

/** tide height h hours after T0 — the test-side oracle for UKC maths. */
const tideAt = (hours: number) => 1.0 - Math.cos((2 * Math.PI * hours) / 12);

function sineCurve(provenance: TideCurve['provenance'], hours = 24): TideCurve {
    const rangeMs: [number, number] = [T0, T0 + hours * HOUR];
    return {
        heights: [],
        provenance,
        rangeMs,
        heightAt(timeMs: number) {
            if (timeMs < rangeMs[0] || timeMs > rangeMs[1]) return null;
            return tideAt((timeMs - T0) / HOUR);
        },
    } as TideCurve;
}

// One leg due north, 0.01° lat ≈ 1,111.95 m; speed tuned for a 1.75 h leg.
const route: LonLat[] = [
    [153, -27.2],
    [153, -27.19],
];
const LEG_M = 1111.95;
const speed = { stwMs: () => LEG_M / (1.75 * 3600) };
const SPOT = [{ legIndex: 0, minDepthM: 1.9 }];
const DRAFT_M = 2.4;

const station: TideField = tideFieldFromCurve(sineCurve('STATION_HEIGHTS'));

function defaultSweep() {
    return sweepDepartures({
        polyline: route,
        speed,
        tide: station,
        shallowSpots: SPOT,
        draftM: DRAFT_M,
        startMs: T0,
    });
}

describe('DepartureSweepInshore — classification over the tidal cycle', () => {
    it('defaults to 25 options at 30-min spacing', () => {
        const sweep = defaultSweep();
        expect(DEFAULT_SWEEP_COUNT).toBe(25);
        expect(DEFAULT_SWEEP_STEP_MS).toBe(30 * 60_000);
        expect(sweep.options.length).toBe(25);
        expect(sweep.options[0].departMs).toBe(T0);
        expect(sweep.options[24].departMs).toBe(T0 + 12 * HOUR);
    });

    it('blocks departures whose spot ETA misses the window, clears the rest (indices 4…13)', () => {
        const sweep = defaultSweep();
        for (let i = 0; i < sweep.options.length; i++) {
            const expected = i >= 4 && i <= 13 ? 'clear' : 'blocked';
            expect(sweep.options[i].status, `option ${i} (depart +${i * 0.5} h)`).toBe(expected);
        }
    });

    it('picks the earliest clear option as best (+2 h, ETA at the bar +3.75 h)', () => {
        const sweep = defaultSweep();
        expect(sweep.best).not.toBeNull();
        expect(sweep.best!.departMs).toBe(T0 + 2 * HOUR);
        expect(sweep.best!.passageMs).toBeCloseTo(1.75 * HOUR, -4); // within 5 s
        expect(sweep.best!.arriveMs - sweep.best!.departMs).toBe(sweep.best!.passageMs);
    });

    it('hand-checks minUkc: tide(ETA) + minDepth − draft, safety margin NOT subtracted', () => {
        const sweep = defaultSweep();
        // Best departs +2 h ⇒ spot ETA +3.75 h.
        expect(sweep.best!.minUkcM).toBeCloseTo(tideAt(3.75) + 1.9 - DRAFT_M, 3);
        // The +0 h departure is blocked AND would touch: ETA +1.75 h,
        // tide 0.391 m ⇒ UKC = 0.391 + 1.9 − 2.4 = −0.109 m.
        expect(sweep.options[0].minUkcM).toBeCloseTo(tideAt(1.75) + 1.9 - DRAFT_M, 3);
        expect(sweep.options[0].minUkcM!).toBeLessThan(0);
    });

    it('exposes per-spot windows for the UI chips', () => {
        const sweep = defaultSweep();
        const chips = sweep.best!.windows;
        expect(chips.length).toBe(1);
        expect(chips[0].legIndex).toBe(0);
        expect(chips[0].alwaysOpen).toBe(false);
        expect(chips[0].openAtEta).toBe(true);
        expect(chips[0].etaMs).toBeCloseTo(T0 + 3.75 * HOUR, -4);
        // Raw window opens +3 h, padded inward 30 min ⇒ +3.5 h (±5-min sweep step).
        expect(Math.abs(chips[0].windows[0].openMs - (T0 + 3 * HOUR + EDGE_PAD_MS))).toBeLessThanOrEqual(5 * 60_000);
        // Blocked option still reports the window it missed.
        const missed = sweep.options[0].windows[0];
        expect(missed.openAtEta).toBe(false);
        expect(missed.windows.length).toBeGreaterThan(0);
        expect(DEFAULT_TIDE_SAFETY_M).toBe(0.5); // requiredRise = 2.4 + 0.5 − 1.9 = 1.0 m exactly
        expect(ARRIVAL_SLACK_MS).toBe(6 * HOUR);
    });
});

describe('DepartureSweepInshore — degradation ladder', () => {
    it('tide null → every option unknown, no UKC, no best — never throws', () => {
        const sweep = sweepDepartures({
            polyline: route,
            speed,
            tide: null,
            shallowSpots: SPOT,
            draftM: DRAFT_M,
            startMs: T0,
        });
        expect(sweep.options.length).toBe(25);
        expect(sweep.options.every((o) => o.status === 'unknown')).toBe(true);
        expect(sweep.options.every((o) => o.minUkcM === null)).toBe(true);
        expect(sweep.options[0].windows[0].openAtEta).toBeNull();
        expect(sweep.best).toBeNull();
    });

    it('errs closed outside curve coverage: blocked, UKC unknowable', () => {
        const sweep = sweepDepartures({
            polyline: route,
            speed,
            tide: station,
            shallowSpots: SPOT,
            draftM: DRAFT_M,
            startMs: T0 + 30 * 24 * HOUR, // a month past coverage
            count: 3,
        });
        expect(sweep.options.every((o) => o.status === 'blocked')).toBe(true);
        expect(sweep.options.every((o) => o.minUkcM === null)).toBe(true);
        expect(sweep.best).toBeNull();
    });

    it('no shallow spots → nothing gates: all clear, best = earliest, UKC null', () => {
        const sweep = sweepDepartures({ polyline: route, speed, tide: station, draftM: DRAFT_M, startMs: T0 });
        expect(sweep.options.every((o) => o.status === 'clear')).toBe(true);
        expect(sweep.best!.departMs).toBe(T0);
        expect(sweep.best!.minUkcM).toBeNull();
    });

    it('a deep spot is alwaysOpen — clear even departing at LW, UKC still reported', () => {
        const sweep = sweepDepartures({
            polyline: route,
            speed,
            tide: station,
            shallowSpots: [{ legIndex: 0, minDepthM: 4.0 }], // requiredRise = −1.1 m
            draftM: DRAFT_M,
            startMs: T0,
            count: 1,
        });
        expect(sweep.options[0].status).toBe('clear');
        expect(sweep.options[0].windows[0].alwaysOpen).toBe(true);
        expect(sweep.options[0].minUkcM).toBeCloseTo(tideAt(1.75) + 4.0 - DRAFT_M, 3);
    });

    it('a spot pointing at a nonexistent leg errs closed (blocked, never silently clear)', () => {
        const sweep = sweepDepartures({
            polyline: route,
            speed,
            tide: station,
            shallowSpots: [{ legIndex: 7, minDepthM: 1.9 }], // route has one leg
            draftM: DRAFT_M,
            startMs: T0 + 2 * HOUR,
            count: 1,
        });
        expect(sweep.options[0].status).toBe('blocked');
        expect(sweep.options[0].windows[0].etaMs).toBeNull();
        expect(sweep.options[0].minUkcM).toBeNull();
        expect(sweep.best).toBeNull();
    });

    it('degenerate polyline / non-positive speed → empty sweep, no throw', () => {
        const oneVertex = sweepDepartures({
            polyline: [[153, -27]],
            speed,
            tide: station,
            shallowSpots: SPOT,
            draftM: DRAFT_M,
            startMs: T0,
        });
        expect(oneVertex).toEqual({ options: [], best: null });
        const stopped = sweepDepartures({
            polyline: route,
            speed: { stwMs: () => 0 },
            tide: station,
            shallowSpots: SPOT,
            draftM: DRAFT_M,
            startMs: T0,
        });
        expect(stopped).toEqual({ options: [], best: null });
    });
});

describe('DepartureSweepInshore — count/step controls', () => {
    it('respects explicit count and stepMs', () => {
        const sweep = sweepDepartures({
            polyline: route,
            speed,
            tide: station,
            shallowSpots: SPOT,
            draftM: DRAFT_M,
            startMs: T0,
            count: 5,
            stepMs: HOUR,
        });
        expect(sweep.options.map((o) => o.departMs)).toEqual([0, 1, 2, 3, 4].map((h) => T0 + h * HOUR));
        // Hour grid: ETAs +1.75…+5.75 h vs window [3.5, 8.5] ⇒ clear from +2 h on.
        expect(sweep.options.map((o) => o.status)).toEqual(['blocked', 'blocked', 'clear', 'clear', 'clear']);
        expect(sweep.best!.departMs).toBe(T0 + 2 * HOUR);
    });

    it('falls back to defaults on junk count/step', () => {
        const sweep = sweepDepartures({
            polyline: route,
            speed,
            tide: station,
            shallowSpots: SPOT,
            draftM: DRAFT_M,
            startMs: T0,
            count: -2,
            stepMs: NaN,
        });
        expect(sweep.options.length).toBe(DEFAULT_SWEEP_COUNT);
        expect(sweep.options[1].departMs - sweep.options[0].departMs).toBe(DEFAULT_SWEEP_STEP_MS);
    });
});
