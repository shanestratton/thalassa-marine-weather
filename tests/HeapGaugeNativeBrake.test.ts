/**
 * The merge brake on WKWebView — where it was a documented no-op while the
 * platform's own process killer did the enforcing (Lady Musgrave, 2026-08-21).
 * Chrome semantics must be untouched; the new branch only wakes where
 * performance.memory is absent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    reading: null as { availableMB: number; warning: boolean } | null,
    calls: 0,
}));

vi.mock('../services/native/memoryGauge', () => ({
    refreshAvailableMemory: vi.fn(async () => {
        native.calls += 1;
        return native.reading;
    }),
    recentAvailableMemory: vi.fn(() => native.reading),
}));

import { awaitHeapHeadroom, heapHeadroomOk, heapTag, NATIVE_AVAILABLE_FLOOR_MB } from '../utils/heapGauge';

beforeEach(() => {
    native.reading = null;
    native.calls = 0;
    // jsdom has no performance.memory — exactly the WKWebView shape.
});

afterEach(() => {
    vi.useRealTimers();
});

describe('awaitHeapHeadroom on WKWebView', () => {
    it('no gauge at all → historical no-op, returns immediately', async () => {
        await awaitHeapHeadroom();
        expect(native.calls).toBe(1); // asked once, got nothing, moved on
    });

    it('plenty of allocatable memory → proceeds without waiting', async () => {
        native.reading = { availableMB: NATIVE_AVAILABLE_FLOOR_MB + 200, warning: false };
        const t0 = Date.now();
        await awaitHeapHeadroom();
        expect(Date.now() - t0).toBeLessThan(200);
    });

    it('under the floor → parks, then releases when memory recovers', async () => {
        native.reading = { availableMB: 80, warning: false };
        const done = vi.fn();
        const wait = awaitHeapHeadroom(undefined, 4000).then(done);
        await new Promise((r) => setTimeout(r, 300));
        expect(done).not.toHaveBeenCalled(); // still parked under the floor
        native.reading = { availableMB: NATIVE_AVAILABLE_FLOOR_MB + 100, warning: false };
        await wait;
        expect(done).toHaveBeenCalled();
    });

    it('a system memory warning parks the build even with a healthy number', async () => {
        native.reading = { availableMB: NATIVE_AVAILABLE_FLOOR_MB + 300, warning: true };
        const done = vi.fn();
        const wait = awaitHeapHeadroom(undefined, 700).then(done);
        await new Promise((r) => setTimeout(r, 300));
        expect(done).not.toHaveBeenCalled();
        await wait; // releases at the wait budget — a brake, never a deadlock
        expect(done).toHaveBeenCalled();
    });
});

describe('heapTag on WKWebView', () => {
    it('carries the available-memory reading where the heap tag is blind', () => {
        native.reading = { availableMB: 212, warning: false };
        expect(heapTag()).toBe(',a212');
    });

    it('flags a live warning', () => {
        native.reading = { availableMB: 90, warning: true };
        expect(heapTag()).toBe(',a90,warn');
    });

    it('stays empty with no reading — existing crumb formats unchanged', () => {
        expect(heapTag()).toBe('');
    });
});

describe('heapHeadroomOk — the line a dark boot re-check is skipped below (125-07)', () => {
    it('no gauge anywhere is not headroom: unknown, so a boot pass stays off', async () => {
        await expect(heapHeadroomOk()).resolves.toBeNull();
    });

    it('reads the same native floor the brake uses, and a warning is never headroom', async () => {
        native.reading = { availableMB: NATIVE_AVAILABLE_FLOOR_MB + 50, warning: false };
        await expect(heapHeadroomOk()).resolves.toBe(true);
        native.reading = { availableMB: NATIVE_AVAILABLE_FLOOR_MB - 1, warning: false };
        await expect(heapHeadroomOk()).resolves.toBe(false);
        native.reading = { availableMB: NATIVE_AVAILABLE_FLOOR_MB + 500, warning: true };
        await expect(heapHeadroomOk()).resolves.toBe(false);
    });

    it('on Chrome the JS heap gauge decides, against the soft ceiling', async () => {
        const perf = performance as unknown as { memory?: unknown };
        perf.memory = { usedJSHeapSize: 400 * 1048576, jsHeapSizeLimit: 4096 * 1048576 };
        try {
            await expect(heapHeadroomOk()).resolves.toBe(true);
            perf.memory = { usedJSHeapSize: 1200 * 1048576, jsHeapSizeLimit: 4096 * 1048576 };
            await expect(heapHeadroomOk()).resolves.toBe(false);
        } finally {
            delete perf.memory;
        }
    });
});
