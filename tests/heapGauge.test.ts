/**
 * heapGauge — the first instrument that measures the PROCESS, not our caches.
 *
 * Kill #23 (2026-08-10) died with every counted cache healthy: merges
 * serialized and ≤29 MB, 19 pinned cells under the 48 MB budget, blob text
 * at 14 MB. The gauge exists so the NEXT fatal trail shows whether real JS
 * heap was climbing (leak outside the counted caches) or flat (not a JS-heap
 * kill at all). These tests pin the two contracts callers rely on: exact MB
 * where Chrome exposes `performance.memory`, and a clean null/empty-string
 * where it doesn't (iOS WKWebView) — a missing reading must never look like
 * a zero-heap reading.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { awaitHeapHeadroom, heapMB, heapTag } from '../utils/heapGauge';
import { snapTracerBbox } from '../services/routeTracer';

type PerfWithMemory = Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
const perf = performance as PerfWithMemory;

afterEach(() => {
    delete perf.memory;
});

describe('heapMB', () => {
    it('reads Chrome performance.memory in whole MB', () => {
        perf.memory = { usedJSHeapSize: 412 * 1048576, jsHeapSizeLimit: 2048 * 1048576 };
        expect(heapMB()).toEqual({ used: 412, limit: 2048 });
    });

    it('returns null where the gauge is absent (iOS WKWebView)', () => {
        expect(heapMB()).toBeNull();
    });

    it('returns null on a malformed memory object rather than NaN', () => {
        perf.memory = { usedJSHeapSize: undefined, jsHeapSizeLimit: undefined } as unknown as {
            usedJSHeapSize: number;
            jsHeapSizeLimit: number;
        };
        expect(heapMB()).toBeNull();
    });
});

describe('heapTag', () => {
    it('formats a compact crumb suffix', () => {
        perf.memory = { usedJSHeapSize: 412 * 1048576, jsHeapSizeLimit: 2048 * 1048576 };
        expect(heapTag()).toBe(',h412');
    });

    it('is an empty string where the gauge is absent — crumb formats unchanged', () => {
        expect(heapTag()).toBe('');
    });
});

/**
 * The heap gate — kill #26's fix. Deaths happen when a ~200 MB build
 * transient lands on an already-high heap before the GC does; the gate
 * holds heavy builds until the GC (measured reclaiming h1135 → h388) has
 * had its chance. It is a brake, never a deadlock: the wait budget always
 * expires, and platforms without the gauge pass straight through.
 */
describe('awaitHeapHeadroom', () => {
    const setHeap = (usedMB: number) => {
        perf.memory = { usedJSHeapSize: usedMB * 1048576, jsHeapSizeLimit: 4096 * 1048576 };
    };

    afterEach(() => {
        vi.useRealTimers();
    });

    it('passes straight through under the ceiling', async () => {
        setHeap(400);
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        const p = awaitHeapHeadroom(900, 4000);
        await expect(p).resolves.toBeUndefined();
        // No timers pending means no wait was scheduled at all.
        expect(vi.getTimerCount()).toBe(0);
    });

    it('passes straight through where the gauge is absent (iOS)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        await expect(awaitHeapHeadroom(900, 4000)).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('waits above the ceiling and releases when the GC brings heap down', async () => {
        setHeap(1100);
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        let released = false;
        const p = awaitHeapHeadroom(900, 4000).then(() => {
            released = true;
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(released).toBe(false); // still high — still held
        setHeap(388); // the measured post-GC reading from the fatal trail
        await vi.advanceTimersByTimeAsync(250);
        await p;
        expect(released).toBe(true);
    });

    it('gives up after the wait budget and lets the build proceed', async () => {
        setHeap(1400);
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        let released = false;
        const p = awaitHeapHeadroom(900, 1000).then(() => {
            released = true;
        });
        await vi.advanceTimersByTimeAsync(2000);
        await p;
        expect(released).toBe(true); // a brake, never a deadlock
    });
});

/**
 * Window snapping — the other half of kill #26. The fatal trail built
 * 738×1338, 739×1338 and 740×1338 grids back-to-back: the same Fraser
 * window, one pixel different each time, each miss costing the full build
 * transient. Snapping makes wobbled requests share one key.
 */
describe('snapTracerBbox', () => {
    it('maps near-identical windows to the same snapped window', () => {
        const a = snapTracerBbox([153.061, -25.719, 153.349, -25.312]);
        const b = snapTracerBbox([153.0605, -25.7185, 153.3495, -25.3125]);
        expect(a).toEqual(b);
    });

    it('only ever grows the window — containment is preserved', () => {
        const bbox: [number, number, number, number] = [153.061, -25.719, 153.349, -25.312];
        const s = snapTracerBbox(bbox);
        expect(s[0]).toBeLessThanOrEqual(bbox[0]);
        expect(s[1]).toBeLessThanOrEqual(bbox[1]);
        expect(s[2]).toBeGreaterThanOrEqual(bbox[2]);
        expect(s[3]).toBeGreaterThanOrEqual(bbox[3]);
    });

    it('is idempotent — snapping a snapped window changes nothing', () => {
        const s = snapTracerBbox([153.061, -25.719, 153.349, -25.312]);
        expect(snapTracerBbox(s)).toEqual(s);
    });

    it('growth stays a few percent of a passage-scale window', () => {
        const bbox: [number, number, number, number] = [153.061, -25.719, 153.349, -25.312];
        const s = snapTracerBbox(bbox);
        const area = (b: [number, number, number, number]) => (b[2] - b[0]) * (b[3] - b[1]);
        expect(area(s) / area(bbox)).toBeLessThan(1.15);
    });
});
