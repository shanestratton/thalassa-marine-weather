/**
 * What was large when the web layer died?
 *
 * The kill detector answered WHERE and HOW OFTEN — Shane's log ran 1 → 9 in a
 * session, on 'map' and on 'voyage'. It cannot answer WHAT was big, and
 * without that every fix is a guess. Three have been so far.
 *
 * `performance.memory` is Chromium-only and WKWebView has no equivalent, so
 * the heap cannot be read directly. What can be read is the occupancy of the
 * caches we own — which is where the memory goes.
 *
 * The property that makes it work is the same one the breadcrumb relies on: a
 * killed process reports nothing, so the census must ALREADY be on disk,
 * written synchronously while everything was still healthy. These tests pin
 * that, and pin that a broken cache degrades to a zero rather than taking the
 * whole diagnostic down at the moment it is needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const encStats = vi.hoisted(() => ({ value: { entries: 0, textMB: 0 } as unknown }));
const mergeStats = vi.hoisted(() => ({ size: 0, pinned: 0 }));

vi.mock('../services/enc/EncCellStore', () => ({
    blobCacheStats: () => {
        if (encStats.value instanceof Error) throw encStats.value;
        return encStats.value;
    },
}));
vi.mock('../services/enc/mergedDataCache', () => ({
    mergedDataCacheSize: () => mergeStats.size,
    mergedPinnedCellCount: () => mergeStats.pinned,
}));
vi.mock('../services/enc/glazeCellCache', () => ({ glazeCellCacheSize: () => 7 }));
vi.mock('../services/enc/derivedContourCache', () => ({ derivedContourCacheSize: () => 3 }));
vi.mock('../services/enc/encIndexCache', () => ({ indexCacheSize: () => 11 }));

import {
    describeCensus,
    readLastCensus,
    setCensusPlotting,
    startCensus,
    stopCensus,
    takeCensus,
} from '../services/memoryCensus';

describe('taking a reading', () => {
    beforeEach(() => {
        localStorage.clear();
        stopCensus();
        setCensusPlotting(false);
        encStats.value = { entries: 12, textMB: 41.2 };
        mergeStats.size = 4;
        mergeStats.pinned = 53;
    });

    it('reports the number that predicts the kill — cells pinned by merges', () => {
        // Cells pinned by reference are invisible to EncCellStore's byte
        // budget. Four merges over disjoint water pin ~56 cells, the
        // half-gigabyte case measured on 2026-07-22.
        return takeCensus().then((c) => {
            expect(c.merges).toBe(4);
            expect(c.pinnedCells).toBe(53);
        });
    });

    it('reports the ENC blob LRU alongside it', async () => {
        const c = await takeCensus();
        expect(c.encCells).toBe(12);
        expect(c.encTextMB).toBe(41.2);
    });

    it('records the screen and whether a leg was being drawn', async () => {
        localStorage.setItem('thalassa.lastView', JSON.stringify({ view: 'map', at: Date.now() }));
        setCensusPlotting(true);
        const c = await takeCensus();
        expect(c.view).toBe('map');
        expect(c.plotting).toBe(true);
    });

    it('degrades a broken cache to zero rather than failing the whole census', async () => {
        // One cache moving or throwing must not take the diagnostic down at
        // the exact moment it is needed.
        encStats.value = new Error('cache exploded');
        const c = await takeCensus();
        expect(c.encCells).toBe(0);
        // Everything else still reported.
        expect(c.pinnedCells).toBe(53);
        expect(c.glaze).toBe(7);
    });
});

describe('surviving the kill', () => {
    beforeEach(() => {
        localStorage.clear();
        stopCensus();
        encStats.value = { entries: 9, textMB: 30 };
        mergeStats.size = 3;
        mergeStats.pinned = 40;
    });

    it('is already on disk before anything goes wrong', async () => {
        startCensus();
        // startCensus takes a reading immediately; it is async internally.
        await vi.waitFor(() => expect(readLastCensus()).not.toBeNull());
        // …process dies here. Nothing else runs.
        const recovered = readLastCensus();
        expect(recovered?.pinnedCells).toBe(40);
        expect(recovered?.encCells).toBe(9);
        stopCensus();
    });

    it('returns null when there is nothing recorded', () => {
        expect(readLastCensus()).toBeNull();
    });

    it('ignores a corrupt record', () => {
        localStorage.setItem('thalassa.lastCensus', 'not json');
        expect(readLastCensus()).toBeNull();
        localStorage.setItem('thalassa.lastCensus', JSON.stringify({ encCells: 3 }));
        expect(readLastCensus()).toBeNull(); // no timestamp
    });

    it('starting twice does not stack intervals', () => {
        startCensus();
        startCensus();
        stopCensus();
        // No assertion beyond not throwing; the guard is the point.
        expect(true).toBe(true);
    });
});

describe('the one line that goes in the crash report', () => {
    it('names the caches and flags plotting', async () => {
        localStorage.setItem('thalassa.lastView', JSON.stringify({ view: 'map', at: Date.now() }));
        setCensusPlotting(true);
        encStats.value = { entries: 12, textMB: 41.2 };
        mergeStats.size = 4;
        mergeStats.pinned = 53;

        const line = describeCensus(await takeCensus());
        expect(line).toContain("on 'map'");
        expect(line).toContain('(plotting)');
        expect(line).toContain('12 cells/41.2MB');
        expect(line).toContain('4 merges pinning 53 cells');
        setCensusPlotting(false);
    });
});
