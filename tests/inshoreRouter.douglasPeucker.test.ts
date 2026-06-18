/**
 * Douglas-Peucker termination regression (2026-06-18, Shane field bug:
 * "route too short for passage planning").
 *
 * The land-aware DP (commit 5e4088bd) added a `chordCrossesLand` guard so a
 * canal bend is never collapsed into a chord that slices the bank. The first
 * cut wired the guard into the RECURSION condition:
 *
 *     if (maxD > tol || cutsLand) { recurse on slice(0,idx+1) and slice(idx) }
 *
 * That is fatal. The original DP only recursed when `maxD > tol`, which
 * GUARANTEES the split point idx ≥ 1 (some interior point deviates from the
 * chord). The `|| cutsLand` term lets it recurse when the run is near-straight
 * (maxD ≈ 0, idx stays 0) but the chord merely nicks a land cell — exactly what
 * happens along a canal. Then `points.slice(idx)` === `points.slice(0)` is the
 * SAME array, the right branch recurses on itself forever → stack overflow →
 * the engine throws → the passage planner's catch falls through to the
 * "route too short" bail. The user sees no route at all.
 *
 * The fix: the land guard must only change the BASE CASE (keep every vertex
 * instead of collapsing to the 2-point chord), never gate the recursion. These
 * tests pin that: a straight, land-nicking run must TERMINATE and keep its
 * vertices.
 */
import { describe, expect, it } from 'vitest';
import { douglasPeucker } from '../services/inshoreRouterEngine';

describe('douglasPeucker — land-aware termination', () => {
    it('terminates (no stack overflow) on a straight run whose chord nicks land', () => {
        // A perfectly collinear run: every interior point sits ON the endpoint
        // chord, so maxD === 0 and idx never moves off 0 — the exact shape that
        // sent the buggy recursion into slice(0) self-recursion.
        const straight: [number, number][] = [];
        for (let i = 0; i < 12; i++) straight.push([153.1 + i * 0.001, -27.2]);

        // Chord crosses land for ANY span — the worst case for the old guard.
        const alwaysLand = () => true;

        // The bug manifested as a thrown RangeError (Maximum call stack
        // exceeded). With the fix this returns synchronously.
        expect(() => douglasPeucker(straight, 1e-9, alwaysLand)).not.toThrow();
    });

    it('keeps every vertex when a near-straight chord cuts across land', () => {
        const straight: [number, number][] = [];
        for (let i = 0; i < 12; i++) straight.push([153.1 + i * 0.001, -27.2]);
        const out = douglasPeucker(straight, 1e-9, () => true);
        // Land-crossing → no collapse: all 12 vertices survive (the bend hugs
        // the bank instead of being cut to a 2-point chord).
        expect(out.length).toBe(straight.length);
        expect(out[0]).toEqual(straight[0]);
        expect(out[out.length - 1]).toEqual(straight[straight.length - 1]);
    });

    it('still collapses a straight run when the chord is clear of land', () => {
        const straight: [number, number][] = [];
        for (let i = 0; i < 12; i++) straight.push([153.1 + i * 0.001, -27.2]);
        const out = douglasPeucker(straight, 1e-9, () => false);
        // Clear water → original behaviour: collapse to the 2-point chord.
        expect(out.length).toBe(2);
        expect(out[0]).toEqual(straight[0]);
        expect(out[1]).toEqual(straight[straight.length - 1]);
    });

    it('keeps a genuine bend (geometry split) regardless of the land guard', () => {
        // An L-shaped path: the middle vertex deviates hard from the A→B chord,
        // so maxD > tol drives a normal geometric split (idx ≥ 1).
        const bend: [number, number][] = [
            [153.1, -27.2],
            [153.105, -27.2],
            [153.105, -27.21], // the corner
        ];
        const out = douglasPeucker(bend, 1e-6, () => false);
        expect(out.length).toBe(3); // the corner is preserved
    });

    it('matches plain DP when no guard is supplied (open-water byte-identity)', () => {
        const straight: [number, number][] = [];
        for (let i = 0; i < 8; i++) straight.push([153.1 + i * 0.001, -27.2]);
        const out = douglasPeucker(straight, 1e-9);
        expect(out.length).toBe(2);
    });
});
