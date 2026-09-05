/**
 * The voyage total grows only when the boat has moved.
 *
 * A yacht on the hard, "following a route" overnight, logged 0.1 NM of GNSS
 * jitter (Shane, 2026-09-06) — enough to keep the "went nowhere" sweep from
 * deleting a track that went nowhere. These tests drive the pure accrual with
 * the shapes that matter: a jitter cloud, a boatyard multipath spike, a real
 * departure, and a stop mid-voyage.
 */
import { describe, expect, it } from 'vitest';
import {
    accrualFields,
    accrueDistance,
    carryAccrual,
    DEFAULT_ACCRUAL_GATE_M,
    distanceAccrualGateM,
    freshAccrual,
    type AccrualResult,
} from '../services/shiplog/distanceAccrual';

const ORIGIN = { latitude: -27.2, longitude: 153.1 };
const M_PER_DEG_LAT = 111_320;
/** A point `north` metres north and `east` metres east of ORIGIN (flat-earth at this scale). */
function at(north: number, east: number) {
    return {
        latitude: ORIGIN.latitude + north / M_PER_DEG_LAT,
        longitude: ORIGIN.longitude + east / (M_PER_DEG_LAT * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
    };
}
/** Feed a sequence of fixes through the accrual, returning the final state. */
function run(fixes: Array<{ latitude: number; longitude: number }>, gateM = 15): AccrualResult {
    let state: AccrualResult = freshAccrual(fixes[0]);
    let prev = fixes[0];
    for (const fix of fixes.slice(1)) {
        state = accrueDistance(
            { ...prev, ...accrualFields(state), cumulativeDistanceNM: state.cumulativeDistanceNM },
            fix,
            gateM,
        );
        prev = fix;
    }
    return state;
}
/** Deterministic pseudo-random jitter so the test never flakes. */
function jitterCloud(points: number, radiusM: number) {
    const out = [ORIGIN];
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let i = 0; i < points; i++) out.push(at(rnd() * radiusM, rnd() * radiusM));
    return out;
}

describe('distance accrual', () => {
    it('a night of jitter on the hard accrues NOTHING — the yacht went nowhere', () => {
        // 120 five-minute fixes (~10 h) wobbling up to 6 m: the old running
        // sum made ~0.1 NM of this; the anchor makes 0.
        const s = run(jitterCloud(120, 6));
        expect(s.cumulativeDistanceNM).toBe(0);
        expect(s.moving).toBe(false);
        expect(s.accrualAnchor).toEqual(ORIGIN);
    });

    it('the old running sum would have kept this track — the anchor deletes it', () => {
        // The same cloud, summed leg by leg the old way, reads well above the
        // 0.05 NM "went nowhere" line. That is the bug in one number.
        const fixes = jitterCloud(120, 6);
        let oldSum = 0;
        for (let i = 1; i < fixes.length; i++) {
            const a = fixes[i - 1];
            const b = fixes[i];
            const dLat = (b.latitude - a.latitude) * M_PER_DEG_LAT;
            const dLon = (b.longitude - a.longitude) * M_PER_DEG_LAT * Math.cos((ORIGIN.latitude * Math.PI) / 180);
            oldSum += Math.hypot(dLat, dLon) / 1852;
        }
        expect(oldSum).toBeGreaterThan(0.05);
        expect(run(fixes).cumulativeDistanceNM).toBe(0);
    });

    it('a single boatyard multipath spike is a candidate the next fix cancels', () => {
        const s = run([ORIGIN, at(0, 0), at(80, 0), at(2, -1), at(-1, 3)]);
        expect(s.cumulativeDistanceNM).toBe(0);
        expect(s.moveCandidate).toBeUndefined();
        expect(s.accrualAnchor).toEqual(ORIGIN);
    });

    it('the spike itself is held as a candidate, not distance', () => {
        const s = run([ORIGIN, at(80, 0)]);
        expect(s.cumulativeDistanceNM).toBe(0);
        expect(s.moveCandidate).toEqual(at(80, 0));
        expect(s.moving).toBe(false);
    });

    it('a real departure confirms on the second fix and then accrues every fix', () => {
        // 200 m legs due north: 10 legs = 2000 m. The first two legs land as
        // one straightened leg (same length on a straight course).
        const fixes = [ORIGIN];
        for (let i = 1; i <= 10; i++) fixes.push(at(200 * i, 0));
        const s = run(fixes);
        expect(s.cumulativeDistanceNM * 1852).toBeCloseTo(2000, -1);
        expect(s.moving).toBe(true);
        expect(s.accrualAnchor).toEqual(at(2000, 0));
    });

    it('stopping mid-voyage freezes the total until movement is confirmed again', () => {
        const fixes = [ORIGIN, at(200, 0), at(400, 0), at(600, 0)];
        // Anchored: an hour of 4 m wobble.
        for (let i = 0; i < 12; i++) fixes.push(at(600 + (i % 2 ? 3 : -3), i % 3 ? 2 : -2));
        const anchored = run(fixes);
        expect(anchored.cumulativeDistanceNM * 1852).toBeCloseTo(600, -1);
        expect(anchored.moving).toBe(false);
        // Under way again: two fixes beyond the gate, then it accrues.
        const moved = run([...fixes, at(800, 0), at(1000, 0), at(1200, 0)]);
        expect(moved.cumulativeDistanceNM * 1852).toBeCloseTo(1200, -1);
    });

    it('a legacy stored position with no anchor anchors on itself', () => {
        const legacy = { ...ORIGIN, cumulativeDistanceNM: 12.5 };
        const jitter = accrueDistance(legacy, at(3, 2), 15);
        expect(jitter.cumulativeDistanceNM).toBe(12.5);
        expect(jitter.accrualAnchor).toEqual(ORIGIN);
        const far = accrueDistance({ ...legacy, moving: true }, at(500, 0), 15);
        expect(far.cumulativeDistanceNM * 1852).toBeCloseTo(12.5 * 1852 + 500, -1);
    });

    it('a turn pin carries everything forward and adds nothing', () => {
        const prev = { ...at(300, 0), cumulativeDistanceNM: 4, accrualAnchor: at(300, 0), moving: true };
        expect(carryAccrual(prev)).toEqual({
            cumulativeDistanceNM: 4,
            accruedNM: 0,
            accrualAnchor: at(300, 0),
            moveCandidate: undefined,
            moving: true,
        });
    });

    it('the gate follows GPS quality and defaults to the standard tier', () => {
        expect(distanceAccrualGateM({ distanceAccrualMinMovementM: 8 })).toBe(8);
        expect(distanceAccrualGateM({ distanceAccrualMinMovementM: 30 })).toBe(30);
        expect(distanceAccrualGateM({})).toBe(DEFAULT_ACCRUAL_GATE_M);
        expect(distanceAccrualGateM(null)).toBe(DEFAULT_ACCRUAL_GATE_M);
        expect(distanceAccrualGateM({ distanceAccrualMinMovementM: 0 })).toBe(DEFAULT_ACCRUAL_GATE_M);
        expect(DEFAULT_ACCRUAL_GATE_M).toBe(15);
    });

    it('the tracker publishes the tier the pipeline reads', async () => {
        const { GpsPrecision } = await import('../services/shiplog/GpsPrecisionTracker');
        const t = GpsPrecision.getAdaptedThresholds();
        expect([8, 15, 30]).toContain(t.distanceAccrualMinMovementM);
    });
});
