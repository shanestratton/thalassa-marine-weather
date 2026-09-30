/**
 * A lateral-mark gate crossing is an anchor vertex (round 5, 2026-10-01).
 *
 * The route line must visibly thread every gate it passes through, so the
 * vertex a gate follower puts on a gate's centre is one no simplifier may
 * remove. Round 4's scaffold collapse (engine/geometry collapseStateRuns,
 * Douglas-Peucker at 2.5 m per run of one state) merged Newport's exit
 * channel 7/8 → 3/4 into one chord: gate 5/6's centre sits 1.2 m off that
 * chord, inside the tolerance, so its vertex went and the route no longer
 * drew a point in the gate (the newportPinkenba repro, VARIANT C). These pin
 * the mechanism: the gate-anchor mask, and the collapse keeping every pinned
 * vertex while still merging the scaffold around it.
 *
 * Coordinates are the real Newport exit-gate centres (7/8, 5/6, 3/4).
 */
import { describe, expect, it } from 'vitest';
import { collapseStateRuns, mPerDegLon, perpendicularDistanceDeg } from '../../services/engine/geometry';
import { gateAnchorMask } from '../../services/engine/tierPipeline';

const TOL_DEG = 2.5 / 110_000; // the engine's SCAFFOLD_TOLERANCE_DEG
const G78: [number, number] = [***REMOVED***, -***REMOVED***];
const G56: [number, number] = [153.0934, -***REMOVED***];
const G34: [number, number] = [***REMOVED***, -27.19034];

/** Evenly spaced scaffold points strictly between a and b, on the chord. */
function scaffold(a: [number, number], b: [number, number], n: number): [number, number][] {
    return Array.from({ length: n }, (_, k) => {
        const t = (k + 1) / (n + 1);
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as [number, number];
    });
}

/** Metres from p to the chord a→b, in a local planar frame at p. */
function offChordM(p: [number, number], a: [number, number], b: [number, number]): number {
    const kx = mPerDegLon(p[1]);
    const ky = 111_320;
    const toM = (q: [number, number]): [number, number] => [(q[0] - p[0]) * kx, (q[1] - p[1]) * ky];
    return perpendicularDistanceDeg([0, 0], toM(a), toM(b));
}

describe('gate anchors survive the scaffold collapse', () => {
    // The Newport channel: 7/8 → scaffold → 5/6 → scaffold → 3/4, one state.
    const poly: [number, number][] = [G78, ...scaffold(G78, G56, 3), G56, ...scaffold(G56, G34, 3), G34];
    const keys = poly.slice(1).map(() => 'Y#c||0.00||');
    const pinIdx = 4; // G56
    const fits = (): boolean => true;

    it('the fixture is the failure: gate 5/6 lies inside the tolerance of the 7/8 → 3/4 chord', () => {
        const off = offChordM(G56, G78, G34);
        expect(off).toBeGreaterThan(0.5);
        expect(off).toBeLessThan(2.5);
        // Unpinned, the collapse merges the whole run to one chord — the gate goes.
        const bare = collapseStateRuns(poly, keys, TOL_DEG, fits);
        expect(bare.polyline).toEqual([G78, G34]);
    });

    it('keeps a pinned gate vertex 1 m off the chord, and still merges the scaffold around it', () => {
        const pinned = poly.map((_, i) => i === pinIdx);
        const out = collapseStateRuns(poly, keys, TOL_DEG, fits, pinned);
        expect(out.polyline).toEqual([G78, G56, G34]);
        // Every new segment carries an original segment of its own run.
        expect(out.fromSeg).toHaveLength(2);
        expect(out.fromSeg[0]).toBeLessThan(pinIdx);
        expect(out.fromSeg[1]).toBeGreaterThanOrEqual(pinIdx);
        for (const s of out.fromSeg) expect(keys[s]).toBe('Y#c||0.00||');
    });

    it('a pin never merges across a change of state, and pinned endpoints change nothing', () => {
        // Two runs meeting at the pinned gate: the state boundary already splits.
        const twoKeys = keys.map((k, i) => (i < pinIdx ? 'K#a' : 'Y#b'));
        const allPinnedEnds = poly.map((_, i) => i === 0 || i === poly.length - 1 || i === pinIdx);
        const out = collapseStateRuns(poly, twoKeys, TOL_DEG, fits, allPinnedEnds);
        expect(out.polyline).toEqual([G78, G56, G34]);
        expect(twoKeys[out.fromSeg[0]]).toBe('K#a');
        expect(twoKeys[out.fromSeg[1]]).toBe('Y#b');
    });

    it('several pinned gates in one run each keep their vertex', () => {
        const pinned = poly.map((_, i) => i === 1 || i === pinIdx || i === 6);
        const out = collapseStateRuns(poly, keys, TOL_DEG, fits, pinned);
        expect(out.polyline).toEqual([G78, poly[1], G56, poly[6], G34]);
        expect(out.fromSeg).toHaveLength(4);
    });
});

describe('gateAnchorMask — the vertices a gate follower put on a gate centre', () => {
    it('marks a vertex on a gate centre, and not the scaffold beside it', () => {
        const poly: [number, number][] = [G78, ...scaffold(G78, G56, 3), G56, G34];
        const centres = [G78, G56, G34].map(([lon, lat]) => ({ lat, lon }));
        const mask = gateAnchorMask(poly, centres);
        expect(mask).toEqual([true, false, false, false, true, true]);
    });

    it('allows the follower a metre or two of float, not a scaffold point 30 m off', () => {
        const nearby: [number, number] = [G56[0] + 1.5 / 99_000, G56[1]]; // ~1.5 m east
        const off30: [number, number] = [G56[0], G56[1] + 30 / 111_320]; // ~30 m north
        const mask = gateAnchorMask([G78, nearby, off30, G34], [{ lat: G56[1], lon: G56[0] }]);
        expect(mask).toEqual([false, true, false, false]);
    });

    it('no gates, no anchors', () => {
        expect(gateAnchorMask([G78, G56, G34], [])).toEqual([false, false, false]);
    });
});
