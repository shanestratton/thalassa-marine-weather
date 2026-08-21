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

import { awaitHeapHeadroom, heapTag, NATIVE_AVAILABLE_FLOOR_MB } from '../utils/heapGauge';

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
