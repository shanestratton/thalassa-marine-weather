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
import { afterEach, describe, expect, it } from 'vitest';

import { heapMB, heapTag } from '../utils/heapGauge';

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
