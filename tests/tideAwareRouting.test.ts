/**
 * Phase 7 scaffolding tests: EnvFields contracts, the TideAwareAnnotator
 * ETA walk, and the tidal-window maths — all on synthetic curves with
 * hand-computable expectations. Phase 8 adds the vector-triangle drift
 * suite (following/cross/infeasible set, leeway cap, no-env byte-parity).
 */

import { describe, expect, it } from 'vitest';
import {
    tideFieldFromCurve,
    motoringSpeedModel,
    DEFAULT_CRUISING_KTS,
    type CurrentField2D,
    type TideField,
    type WindField2D,
} from '../services/routing/env/EnvFields';
import {
    annotateRoute,
    DEFAULT_LEEWAY_CAP_FRACTION,
    DEFAULT_LEEWAY_COEFFICIENT,
    STEERING_WARNING_FRACTION,
    type LonLat,
} from '../services/routing/TideAwareAnnotator';
import { computeTidalWindows, DEFAULT_TIDE_SAFETY_M, EDGE_PAD_MS } from '../services/routing/tidalWindow';
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

describe('TideAwareAnnotator — Phase 8 vector-triangle drift', () => {
    // Same two due-north legs as above: courseDeg is exactly 0, so the
    // along/across decomposition is exact (d̂ = north, n̂ = east).
    const route: LonLat[] = [
        [153, -27.2],
        [153, -27.19],
        [153, -27.18],
    ];
    const STW = 3;
    const speed = { stwMs: () => STW };

    const constCurrent = (u: number, v: number): CurrentField2D => ({
        currentAt: () => ({ u, v }),
        provenance: 'CMEMS_HOURLY',
    });
    const constWind = (u: number, v: number): WindField2D => ({
        windAt: () => ({ u, v }),
        provenance: 'GFS',
    });

    it('pure-following current: 1 m/s behind at STW 3 → SOG exactly 4, ETA shortens 4:3', () => {
        const base = annotateRoute({ polyline: route, departMs: T0, speed });
        const r = annotateRoute({ polyline: route, departMs: T0, speed, currents: constCurrent(0, 1) });
        expect(r!.legs[0].sogMs).toBeCloseTo(4, 10);
        expect(r!.legs[0].currentMs).toBeCloseTo(1, 10);
        expect(r!.legs[0].driftAcrossTrackMs).toBeCloseTo(0, 10);
        expect(r!.legs[0].infeasibleUnderDrift).toBeUndefined();
        // ETA from SOG 4, not STW 3 — passage time scales by 3/4. Tolerance is
        // float ULP at Unix-ms magnitude (~2.4e-4 ms), not physics slack.
        expect(r!.legs[0].etaMs - T0).toBeCloseTo((r!.legs[0].lengthM / 4) * 1000, 2);
        expect(r!.arriveMs - T0).toBeCloseTo((base!.arriveMs - T0) * (3 / 4), 2);
        expect(r!.currentProvenance).toBe('CMEMS_HOURLY');
        expect(r!.steeringWarnings).toBe(0);
    });

    it('pure-cross current: 1 m/s across at STW 3 → SOG = sqrt(9 − 1), warnings counted', () => {
        const r = annotateRoute({ polyline: route, departMs: T0, speed, currents: constCurrent(1, 0) });
        expect(r!.legs[0].sogMs).toBeCloseTo(Math.sqrt(8), 10);
        expect(r!.legs[0].driftAcrossTrackMs).toBeCloseTo(1, 10);
        // 1 m/s across > 0.25 × 3 = 0.75 m/s → advisory on both legs.
        expect(STEERING_WARNING_FRACTION).toBe(0.25);
        expect(r!.steeringWarnings).toBe(2);
    });

    it('headingToSteer crabs upstream: easterly set on a northbound leg → steer west of north', () => {
        const r = annotateRoute({ polyline: route, departMs: T0, speed, currents: constCurrent(1, 0) });
        const expected = 360 - (Math.asin(1 / STW) * 180) / Math.PI; // ≈ 340.53°
        expect(r!.legs[0].headingToSteerDeg).toBeCloseTo(expected, 6);
        expect(r!.legs[0].headingToSteerDeg!).toBeGreaterThan(180); // west of north = upstream
    });

    it('infeasible under drift (cross 4 > STW 3): flagged, ETA falls back to STW', () => {
        const r = annotateRoute({ polyline: route, departMs: T0, speed, currents: constCurrent(4, 0) });
        const leg = r!.legs[0];
        expect(leg.infeasibleUnderDrift).toBe(true);
        expect(leg.sogMs).toBeNull();
        expect(leg.headingToSteerDeg).toBeNull();
        expect(leg.driftAcrossTrackMs).toBeCloseTo(4, 10);
        // Degradation ladder: the walk still completes, on plain STW (ULP-level tolerance).
        expect(leg.etaMs - T0).toBeCloseTo((leg.lengthM / STW) * 1000, 2);
        expect(r!.steeringWarnings).toBe(2);
    });

    it('leeway = 0.035 × wind10m, |leeway| capped at 0.3 × STW', () => {
        expect(DEFAULT_LEEWAY_COEFFICIENT).toBe(0.035);
        expect(DEFAULT_LEEWAY_CAP_FRACTION).toBe(0.3);
        // Uncapped: 10 m/s following wind → leeway 0.35 m/s → SOG 3.35.
        const gentle = annotateRoute({ polyline: route, departMs: T0, speed, wind: constWind(0, 10) });
        expect(gentle!.legs[0].sogMs).toBeCloseTo(3.35, 6);
        // Capped: 40 m/s would give 1.4 m/s, cap is 0.3 × 3 = 0.9 → SOG 3.9.
        const gale = annotateRoute({ polyline: route, departMs: T0, speed, wind: constWind(0, 40) });
        expect(gale!.legs[0].sogMs).toBeCloseTo(3.9, 6);
        // Wind-only run has no current sample → currentMs null, provenance NONE.
        expect(gale!.legs[0].currentMs).toBeNull();
        expect(gale!.currentProvenance).toBe('NONE');
    });

    it('out-of-coverage env fields degrade per leg: null drift fields, STW ETAs', () => {
        const nullCurrent: CurrentField2D = { currentAt: () => null, provenance: 'CMEMS_HOURLY' };
        const nullWind: WindField2D = { windAt: () => null, provenance: 'GFS' };
        const base = annotateRoute({ polyline: route, departMs: T0, speed });
        const r = annotateRoute({ polyline: route, departMs: T0, speed, currents: nullCurrent, wind: nullWind });
        for (const leg of r!.legs) {
            expect(leg.sogMs).toBeNull();
            expect(leg.currentMs).toBeNull();
            expect(leg.driftAcrossTrackMs).toBeNull();
            expect(leg.headingToSteerDeg).toBeNull();
            expect(leg.infeasibleUnderDrift).toBeUndefined();
        }
        expect(r!.arriveMs).toBe(base!.arriveMs);
        expect(r!.steeringWarnings).toBe(0);
    });

    it('no-env run is byte-identical to v1: no drift keys on legs, NONE provenance, zero warnings', () => {
        const r = annotateRoute({ polyline: route, departMs: T0, speed });
        for (const leg of r!.legs) {
            expect(Object.keys(leg).sort()).toEqual([
                'courseDeg',
                'etaMs',
                'index',
                'lengthM',
                'startMs',
                'tideAtEtaM',
            ]);
        }
        expect(r!.currentProvenance).toBe('NONE');
        expect(r!.steeringWarnings).toBe(0);
        // Explicit nulls take the same path as absent opts.
        const rNull = annotateRoute({ polyline: route, departMs: T0, speed, currents: null, wind: null });
        expect(JSON.stringify(rNull)).toBe(JSON.stringify(r));
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

    it('extremes curves share station maths but flag approx (conservatism band retired 2026-07-12)', () => {
        // The +0.3 m EXTREMES band made the window maths contradict the
        // live-depth banner built from the SAME curve ("+1.0 m right now"
        // beside "wait for 17:34"). The owner margin is the buffer; the
        // "(approx)" label carries the curve honesty instead.
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
        expect(rs.windows[0].approx).toBe(false);
        expect(re.windows[0].openMs).toBe(rs.windows[0].openMs);
        expect(re.windows[0].closeMs).toBe(rs.windows[0].closeMs);
    });

    it('a window already open at fromMs starts AT fromMs — horizon edges are not crossings (the 17:34 bug)', () => {
        // Start the sweep at +4 h: the tide (≥1.0 m from +3 h to +9 h) is
        // ALREADY over the line. The window must open at fromMs exactly —
        // no inward pad — and close padded at the real crossing (+9 h).
        const fromMs = T0 + 4 * HOUR;
        const r = computeTidalWindows({
            minDepthM: 1.9,
            draftM: 2.4,
            tide: station,
            fromMs,
            untilMs: fromMs + 24 * HOUR,
        });
        expect(r.windows.length).toBeGreaterThan(0);
        expect(r.windows[0].openMs).toBe(fromMs);
        expect(Math.abs(r.windows[0].closeMs - (T0 + 9 * HOUR - EDGE_PAD_MS))).toBeLessThanOrEqual(5 * 60_000);
    });

    it('a window still open at untilMs closes AT untilMs — no inward pad at the far horizon', () => {
        // Sweep ends at +5 h, mid-window (tide over the line +3 h→+9 h):
        // the close edge is the horizon, not a crossing.
        const r = computeTidalWindows({
            minDepthM: 1.9,
            draftM: 2.4,
            tide: station,
            fromMs: T0,
            untilMs: T0 + 5 * HOUR,
        });
        expect(r.windows.length).toBe(1);
        expect(r.windows[0].closeMs).toBe(T0 + 5 * HOUR);
        // The open edge (+3 h) IS a crossing — still padded.
        expect(Math.abs(r.windows[0].openMs - (T0 + 3 * HOUR + EDGE_PAD_MS))).toBeLessThanOrEqual(5 * 60_000);
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
