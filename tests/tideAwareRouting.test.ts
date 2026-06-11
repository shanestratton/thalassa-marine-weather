/**
 * Phase 7 scaffolding tests: EnvFields contracts, the TideAwareAnnotator
 * ETA walk, and the tidal-window maths — all on synthetic curves with
 * hand-computable expectations.
 */

import { describe, expect, it } from 'vitest';
import {
    tideFieldFromCurve,
    motoringSpeedModel,
    DEFAULT_CRUISING_KTS,
    type TideField,
} from '../services/routing/env/EnvFields';
import { annotateRoute, type LonLat } from '../services/routing/TideAwareAnnotator';
import {
    computeTidalWindows,
    DEFAULT_TIDE_SAFETY_M,
    EXTREMES_CONSERVATISM_M,
    EDGE_PAD_MS,
} from '../services/routing/tidalWindow';
import type { TideCurve } from '../services/TideHeightService';

// ── Synthetic tide: sinusoid, 12 h period, midtide 1.0 m, amplitude 1.0 m ──
// height(t) = 1.0 − cos(2π · hours/12)  → 0 m at t=0 (LW), 2.0 m at t=6 h (HW).
const T0 = Date.UTC(2026, 5, 12, 0, 0, 0);
const HOUR = 3_600_000;

function sineCurve(provenance: TideCurve['provenance'], hours = 24): TideCurve {
    const rangeMs: [number, number] = [T0, T0 + hours * HOUR];
    return {
        heights: [],
        provenance,
        rangeMs,
        heightAt(timeMs: number) {
            if (timeMs < rangeMs[0] || timeMs > rangeMs[1]) return null;
            const h = (timeMs - T0) / HOUR;
            return 1.0 - Math.cos((2 * Math.PI * h) / 12);
        },
    } as TideCurve;
}

describe('EnvFields — tideFieldFromCurve', () => {
    const field = tideFieldFromCurve(sineCurve('STATION_HEIGHTS'));

    it('passes heightAt through (LW 0 m at t0, HW 2 m at +6 h)', () => {
        expect(field.heightAt(T0)).toBeCloseTo(0, 5);
        expect(field.heightAt(T0 + 6 * HOUR)).toBeCloseTo(2.0, 5);
        expect(field.heightAt(T0 - 1)).toBeNull(); // outside coverage
    });

    it('nextTimeAtOrAbove finds the first crossing within 5 min', () => {
        // height ≥ 1.0 first at t = +3 h exactly (cos = 0).
        const t = field.nextTimeAtOrAbove(1.0, T0, T0 + 24 * HOUR);
        expect(t).not.toBeNull();
        expect(Math.abs((t as number) - (T0 + 3 * HOUR))).toBeLessThanOrEqual(5 * 60_000);
    });

    it('returns null when the height is never reached in the window', () => {
        expect(field.nextTimeAtOrAbove(2.5, T0, T0 + 24 * HOUR)).toBeNull();
    });

    it('carries provenance', () => {
        expect(field.provenance).toBe('STATION_HEIGHTS');
        expect(tideFieldFromCurve(sineCurve('EXTREMES_INTERP')).provenance).toBe('EXTREMES_INTERP');
    });
});

describe('EnvFields — motoringSpeedModel', () => {
    it('converts knots to m/s', () => {
        expect(motoringSpeedModel(6).stwMs()).toBeCloseTo(3.087, 2);
    });
    it('falls back to the default on junk', () => {
        const def = motoringSpeedModel(DEFAULT_CRUISING_KTS).stwMs();
        expect(motoringSpeedModel(undefined).stwMs()).toBeCloseTo(def, 6);
        expect(motoringSpeedModel(0).stwMs()).toBeCloseTo(def, 6);
        expect(motoringSpeedModel(-3).stwMs()).toBeCloseTo(def, 6);
        expect(motoringSpeedModel(NaN).stwMs()).toBeCloseTo(def, 6);
    });
});

describe('TideAwareAnnotator', () => {
    // Two legs heading due north, 0.01° lat each ≈ 1,111.95 m (haversine).
    const route: LonLat[] = [
        [153, -27.2],
        [153, -27.19],
        [153, -27.18],
    ];

    it('stamps sequential per-leg ETAs from the speed model', () => {
        const r = annotateRoute({ polyline: route, departMs: T0, speed: { stwMs: () => 5 } });
        expect(r).not.toBeNull();
        expect(r!.legs.length).toBe(2);
        const legSec = r!.legs[0].lengthM / 5;
        expect(r!.legs[0].startMs).toBe(T0);
        expect(r!.legs[0].etaMs).toBeCloseTo(T0 + legSec * 1000, -2);
        expect(r!.legs[1].startMs).toBe(r!.legs[0].etaMs);
        expect(r!.arriveMs).toBe(r!.legs[1].etaMs);
        expect(r!.totalLengthM).toBeCloseTo(r!.legs[0].lengthM + r!.legs[1].lengthM, 6);
    });

    it('computes course (due north ≈ 0°/360°)', () => {
        const r = annotateRoute({ polyline: route, departMs: T0, speed: { stwMs: () => 5 } });
        const c = r!.legs[0].courseDeg;
        expect(Math.min(c, 360 - c)).toBeLessThan(1);
    });

    it('attaches the tide height at each leg ETA when a field is given', () => {
        const tide = tideFieldFromCurve(sineCurve('EXTREMES_INTERP'));
        // Slow boat: 1 m/s → leg 1 ETA ≈ +18.5 min; tide there ≈ 1−cos(2π·0.309/12) ≈ 0.013 m… use a
        // 6 h ETA instead for a clean number: choose speed so leg1 takes exactly 6 h.
        const leg1Len = 1111.95;
        const speed = leg1Len / (6 * 3600); // m/s → ETA at HW
        const r = annotateRoute({ polyline: route, departMs: T0, speed: { stwMs: () => speed }, tide });
        expect(r!.legs[0].tideAtEtaM).toBeCloseTo(2.0, 1); // HW at +6 h
        expect(r!.tideProvenance).toBe('EXTREMES_INTERP');
    });

    it('degrades cleanly: no tide field → null heights, NONE provenance', () => {
        const r = annotateRoute({ polyline: route, departMs: T0, speed: { stwMs: () => 5 } });
        expect(r!.legs.every((l) => l.tideAtEtaM === null)).toBe(true);
        expect(r!.tideProvenance).toBe('NONE');
    });

    it('rejects degenerate input without throwing', () => {
        expect(annotateRoute({ polyline: [[153, -27]], departMs: T0, speed: { stwMs: () => 5 } })).toBeNull();
        expect(annotateRoute({ polyline: route, departMs: T0, speed: { stwMs: () => 0 } })).toBeNull();
    });
});

describe('tidalWindow — the "bar opens 09:40" maths', () => {
    const station: TideField = tideFieldFromCurve(sineCurve('STATION_HEIGHTS'));
    const extremes: TideField = tideFieldFromCurve(sineCurve('EXTREMES_INTERP'));

    it('alwaysOpen when charted depth already carries draft + margin', () => {
        const r = computeTidalWindows({
            minDepthM: 4.0,
            draftM: 2.4,
            tide: station,
            fromMs: T0,
            untilMs: T0 + 24 * HOUR,
        });
        expect(r.alwaysOpen).toBe(true);
        expect(r.requiredRiseM).toBeLessThanOrEqual(0);
        expect(r.windows).toEqual([]);
    });

    it('finds the two daily windows over a half-tide bar (default 0.5 m margin)', () => {
        // minDepth 1.9, draft 2.4 → requiredRise = 1.0 m exactly.
        // Sine ≥ 1.0 m from +3 h to +9 h and +15 h to +21 h.
        const r = computeTidalWindows({
            minDepthM: 1.9,
            draftM: 2.4,
            tide: station,
            fromMs: T0,
            untilMs: T0 + 24 * HOUR,
        });
        expect(r.requiredRiseM).toBeCloseTo(2.4 + DEFAULT_TIDE_SAFETY_M - 1.9, 6);
        expect(r.alwaysOpen).toBe(false);
        expect(r.windows.length).toBe(2);
        const w = r.windows[0];
        // Raw window [+3 h, +9 h], padded inward 30 min each side.
        expect(Math.abs(w.openMs - (T0 + 3 * HOUR + EDGE_PAD_MS))).toBeLessThanOrEqual(5 * 60_000);
        expect(Math.abs(w.closeMs - (T0 + 9 * HOUR - EDGE_PAD_MS))).toBeLessThanOrEqual(5 * 60_000);
        expect(w.approx).toBe(false);
    });

    it('extremes curves get the conservatism band — narrower, approx-flagged', () => {
        const rs = computeTidalWindows({
            minDepthM: 1.9,
            draftM: 2.4,
            tide: station,
            fromMs: T0,
            untilMs: T0 + 12 * HOUR,
        });
        const re = computeTidalWindows({
            minDepthM: 1.9,
            draftM: 2.4,
            tide: extremes,
            fromMs: T0,
            untilMs: T0 + 12 * HOUR,
        });
        expect(re.windows.length).toBe(1);
        expect(re.windows[0].approx).toBe(true);
        // Higher threshold (＋0.3 m) ⇒ later open, earlier close.
        expect(re.windows[0].openMs).toBeGreaterThan(rs.windows[0].openMs);
        expect(re.windows[0].closeMs).toBeLessThan(rs.windows[0].closeMs);
        expect(EXTREMES_CONSERVATISM_M).toBe(0.3);
    });

    it('errs closed: a tide that never makes the rise yields zero windows', () => {
        const r = computeTidalWindows({
            minDepthM: 0.1,
            draftM: 2.4,
            tide: station, // needs 2.8 m rise; curve peaks at 2.0
            fromMs: T0,
            untilMs: T0 + 24 * HOUR,
        });
        expect(r.alwaysOpen).toBe(false);
        expect(r.windows).toEqual([]);
    });

    it('errs closed outside curve coverage (no extrapolated guess-tides)', () => {
        const r = computeTidalWindows({
            minDepthM: 1.9,
            draftM: 2.4,
            tide: station,
            fromMs: T0 + 30 * 24 * HOUR, // a month past coverage
            untilMs: T0 + 31 * 24 * HOUR,
        });
        expect(r.windows).toEqual([]);
    });
});
