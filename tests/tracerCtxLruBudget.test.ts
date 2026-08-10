/**
 * The tracer context LRU is bounded by MEASURED bytes, not entry count.
 *
 * The LRU was sized "3 entries (~5–13 MB of typed arrays each)" — and on
 * 2026-08-10 a session plotting north of Fraser Island built depth grids the
 * nav-grid worker itself estimated at 37–39 MB EACH (1185×829 cells at 28 m).
 * Three held entries meant ~117 MB of typed arrays on the main thread,
 * invisible to the cache census (which counts owned caches, DOM and canvases
 * — not tracer state), on the exact surface with a documented jetsam
 * history. The session died in the foreground ~29 s after its last merge,
 * mid-plot, with main-thread caches reading near zero.
 *
 * These tests pin the byte accounting and the eviction rules, because the
 * tempting simplification — back to a plain slice(0, 3) — recreates the
 * unbounded case everywhere the 5–13 MB assumption breaks.
 */
import { describe, expect, it } from 'vitest';
import { holdTracerCtx, tracerGridBytes, TRACER_LRU_BYTE_BUDGET, type TracerContext } from '../services/routeTracer';

const MB = 1024 * 1024;

/** A fake context whose grid weighs exactly `mb` megabytes of typed arrays. */
const ctxOfMB = (mb: number): TracerContext =>
    ({
        grid: {
            width: 100,
            height: 100,
            // Two views, so the measurement is proven to SUM rather than
            // take the first field it finds.
            depth: new Float32Array((mb * MB) / 8),
            flags: new Uint8Array((mb * MB) / 2),
        },
    }) as unknown as TracerContext;

describe('tracerGridBytes', () => {
    it('sums every typed-array view in the grid and ignores scalars', () => {
        expect(tracerGridBytes(ctxOfMB(10))).toBe(10 * MB);
    });

    it('reads a grid-less (marks-only) context as zero', () => {
        expect(tracerGridBytes({ grid: null } as unknown as TracerContext)).toBe(0);
    });
});

describe('holdTracerCtx', () => {
    it('keeps the three-entry working set while the old sizing assumption holds', () => {
        // 10 MB grids — the world the "~5–13 MB each" comment was written in.
        const a = ctxOfMB(10);
        const b = ctxOfMB(10);
        const c = ctxOfMB(10);
        const lru = holdTracerCtx(holdTracerCtx(holdTracerCtx([], a), b), c);
        expect(lru).toEqual([c, b, a]);
    });

    it('degrades to fewer entries where dense charts break it', () => {
        // Fraser-class grids: 39 MB each. Two of them is 78 MB — over budget.
        const a = ctxOfMB(39);
        const b = ctxOfMB(39);
        const lru = holdTracerCtx(holdTracerCtx([], a), b);
        expect(lru).toEqual([b]);
        expect(lru.reduce((s, x) => s + tracerGridBytes(x), 0)).toBeLessThanOrEqual(TRACER_LRU_BYTE_BUDGET);
    });

    it('never evicts the newest entry, even when it alone exceeds the budget', () => {
        // Refusing to hold the in-use grid would just rebuild it next edit.
        const huge = ctxOfMB(60);
        expect(holdTracerCtx([ctxOfMB(10)], huge)[0]).toBe(huge);
        expect(holdTracerCtx([], huge)).toEqual([huge]);
    });

    it('re-holding an entry moves it to the front without duplicating it', () => {
        const a = ctxOfMB(5);
        const b = ctxOfMB(5);
        const lru = holdTracerCtx(holdTracerCtx(holdTracerCtx([], a), b), a);
        expect(lru).toEqual([a, b]);
    });

    it('still caps entries at three even far under the byte budget', () => {
        // Tiny grids must not accumulate without bound either — reuse decays
        // with distance from the working area; count keeps the scan short.
        const entries = [ctxOfMB(1), ctxOfMB(1), ctxOfMB(1), ctxOfMB(1)];
        const lru = entries.reduce((acc, c) => holdTracerCtx(acc, c), [] as TracerContext[]);
        expect(lru).toHaveLength(3);
        expect(lru[0]).toBe(entries[3]);
    });

    it('does not mutate the caller’s array', () => {
        const a = ctxOfMB(1);
        const lru = [a];
        holdTracerCtx(lru, ctxOfMB(1));
        expect(lru).toEqual([a]);
    });
});
