/**
 * MinHeap invariant — the A* open set's priority queue.
 *
 * Pins the 2026-06-11 sinkDown bug (found via the seamanship fixtures'
 * calibration: the engine returned a 289,493 m-eq path on a grid whose
 * Dijkstra optimum was 73,048 m-eq): after the first hoist iteration,
 * sinkDown compared children against the HOISTED CHILD at the hole
 * position instead of the saved sinking item, so the loop terminated
 * early and the item landed above smaller children. A broken open set
 * makes A* pop non-minimal nodes and silently return suboptimal routes.
 *
 * Deterministic LCG (no Math.random — reproducible failures).
 */
import { describe, it, expect } from 'vitest';
import { MinHeap } from '../services/inshoreRouterEngine';

const lcg = (seed: number) => (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
};

describe('MinHeap (A* open set)', () => {
    it('every pop returns the true minimum under random interleaved push/pop (shadow oracle)', () => {
        const rand = lcg(0xc0ffee);
        const h = new MinHeap();
        const shadow: number[] = []; // reference multiset of live priorities
        for (let round = 0; round < 2000; round++) {
            // Bias toward pushes so the heap grows deep enough to sink.
            if (rand() < 0.65 || h.size === 0) {
                const f = Math.floor(rand() * 10_000);
                h.push({ f, idx: round });
                shadow.push(f);
            } else {
                const got = h.pop()!.f;
                const want = Math.min(...shadow);
                expect(got, `pop at round ${round}`).toBe(want);
                shadow.splice(shadow.indexOf(want), 1);
            }
        }
        while (h.size > 0) {
            const got = h.pop()!.f;
            const want = Math.min(...shadow);
            expect(got, 'drain pop').toBe(want);
            shadow.splice(shadow.indexOf(want), 1);
        }
        expect(shadow).toHaveLength(0);
    });

    it('pure drain: push N descending-ish values, pop all strictly sorted', () => {
        const rand = lcg(0xbeef);
        const h = new MinHeap();
        const n = 500;
        for (let i = 0; i < n; i++) h.push({ f: Math.floor(rand() * 1000), idx: i });
        const out: number[] = [];
        while (h.size > 0) out.push(h.pop()!.f);
        expect(out).toHaveLength(n);
        for (let i = 1; i < n; i++) {
            expect(out[i], `pop ${i}`).toBeGreaterThanOrEqual(out[i - 1]);
        }
    });
});
