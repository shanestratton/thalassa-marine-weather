/**
 * EncCellMetadata notification batching — the fix for the hydration OOM.
 *
 * A cloud-hydration walk lands 15-40 cells and every arrival used to emit a
 * listener notify. The registry version is in the merge cache key, so each
 * one was a guaranteed miss → a full wide-band re-merge + 14-source Mapbox
 * re-upload, every 0.8-3 s for the whole walk. That churn OOM-killed the
 * WebView on a long pan into un-synced coast (SE QLD → GBR, 2026-07-20).
 *
 * The invariant that makes this safe, and the one worth guarding hardest:
 * suspending coalesces the LISTENER CALLBACKS only. `version` must keep
 * incrementing on every mutation, because it invalidates both the listCells
 * memo and the merge cache key — freeze it and the chart silently renders a
 * stale cell list, which is far worse than the churn we're fixing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    putCell,
    listCells,
    getVersion,
    subscribe,
    suspendNotifications,
    resumeNotifications,
    flushNotifications,
    clearAllCellMetadata,
} from '../../services/enc/EncCellMetadata';
import type { EncCell } from '../../services/enc/types';

function cell(id: string): EncCell {
    return {
        id,
        sourceHO: 'AHO',
        edition: 1,
        issued: '2026-01-01',
        importedAt: '2026-07-20T00:00:00.000Z',
        bbox: [148, -21, 149, -20],
        geojsonPath: `/enc/${id}.json`,
        hazardCount: 0,
    };
}

describe('EncCellMetadata notification batching', () => {
    beforeEach(() => {
        localStorage.clear();
        clearAllCellMetadata();
    });

    it('notifies on every put when not suspended (unchanged default)', () => {
        const listener = vi.fn();
        const unsub = subscribe(listener);

        putCell(cell('A'));
        putCell(cell('B'));

        expect(listener).toHaveBeenCalledTimes(2);
        unsub();
    });

    it('coalesces many puts into ONE notify while suspended', () => {
        const listener = vi.fn();
        const unsub = subscribe(listener);

        suspendNotifications();
        for (let i = 0; i < 8; i++) putCell(cell(`C${i}`));
        expect(listener).not.toHaveBeenCalled();

        resumeNotifications();
        expect(listener).toHaveBeenCalledTimes(1);
        unsub();
    });

    it('KEEPS BUMPING version while suspended — the merge cache must still miss', () => {
        // If this ever regresses, the merge serves a cached result that
        // predates the hydrated cells: a silently wrong chart.
        suspendNotifications();
        const before = getVersion();
        putCell(cell('D0'));
        putCell(cell('D1'));
        expect(getVersion()).toBe(before + 2);
        resumeNotifications();
    });

    it('exposes newly-put cells to listCells immediately, even suspended', () => {
        suspendNotifications();
        putCell(cell('E0'));
        // listCells is memoized on version — a frozen version would hide this.
        expect(listCells().map((c) => c.id)).toContain('E0');
        resumeNotifications();
    });

    it('flushNotifications paints a wave mid-walk without ending the batch', () => {
        const listener = vi.fn();
        const unsub = subscribe(listener);

        suspendNotifications();
        putCell(cell('F0'));
        putCell(cell('F1'));
        flushNotifications();
        expect(listener).toHaveBeenCalledTimes(1);

        // Still suspended — further puts keep coalescing.
        putCell(cell('F2'));
        expect(listener).toHaveBeenCalledTimes(1);

        resumeNotifications();
        expect(listener).toHaveBeenCalledTimes(2);
        unsub();
    });

    it('flush with nothing pending is a no-op (no spurious re-merge)', () => {
        const listener = vi.fn();
        const unsub = subscribe(listener);

        suspendNotifications();
        flushNotifications();
        flushNotifications();
        expect(listener).not.toHaveBeenCalled();

        resumeNotifications();
        // Nothing was pending at resume either.
        expect(listener).not.toHaveBeenCalled();
        unsub();
    });

    it('resume always flushes the tail so the last cells to land still paint', () => {
        const listener = vi.fn();
        const unsub = subscribe(listener);

        suspendNotifications();
        putCell(cell('G0'));
        resumeNotifications();

        expect(listener).toHaveBeenCalledTimes(1);
        unsub();
    });

    it('is re-entrant — only the outermost resume emits', () => {
        const listener = vi.fn();
        const unsub = subscribe(listener);

        suspendNotifications();
        suspendNotifications();
        putCell(cell('H0'));

        resumeNotifications();
        expect(listener).not.toHaveBeenCalled(); // inner resume: still batched

        resumeNotifications();
        expect(listener).toHaveBeenCalledTimes(1);
        unsub();
    });

    it('an unbalanced resume cannot wedge the registry into permanent silence', () => {
        const listener = vi.fn();
        const unsub = subscribe(listener);

        // A throwing walk could resume more than it suspended; depth must
        // floor at zero rather than going negative and swallowing later puts.
        resumeNotifications();
        resumeNotifications();

        putCell(cell('I0'));
        expect(listener).toHaveBeenCalledTimes(1);
        unsub();
    });
});
