/**
 * planMergeEviction — which cached merges survive when a new one lands.
 *
 * WHY THIS EXISTS. A cached merge holds feature geometry BY REFERENCE
 * (mergeFold), so it PINS its source cells' parsed GeoJSON — retention the
 * blob LRU's byte budget cannot see, because it only counts cells still in
 * its own map.
 *
 * Device measurement (Shane, 2026-07-22, Moreton Bay):
 *   [perf] merge 14 cells (43.8 MB reg) ... blobCache=14 cells/43.8MBtext
 * ONE viewport merge pinned 43.8 MB of cell text — the entire 48 MB LRU cap,
 * ~3× that once parsed. Under a plain count cap of 4, panning up the coast
 * holds FOUR such merges over disjoint cells: ~175 MB of text, ~½ GB of heap,
 * and the WebView is jetsammed.
 *
 * A count cap cannot tell the two cases apart. Overlap can:
 *   - zoom excursion over the same water → keys share nearly all cells →
 *     pinning is shared → keeping them is almost free (and is exactly why
 *     the cap was raised from 2 to 4 in the first place — preserve that)
 *   - pan to new coast → keys share nothing → each pins a whole extra
 *     viewport → drop them
 */
import { describe, expect, it } from 'vitest';

import { planMergeEviction } from '../../services/enc/mergedDataCache';

/** Keys in insertion order (oldest first), with their pinned cell sets. */
function harness(entries: [string, string[]][]) {
    const map = new Map(entries.map(([k, ids]) => [k, new Set(ids)]));
    return {
        keys: entries.map(([k]) => k),
        cellsOf: (k: string) => map.get(k),
    };
}

describe('planMergeEviction', () => {
    it('keeps a zoom excursion over the same water — the case the 4-slot cap exists for', () => {
        // z11 / z12 / z13 over one bay: same cells, different zoom buckets.
        const h = harness([
            ['z11', ['A', 'B', 'C']],
            ['z12', ['A', 'B', 'C']],
            ['z13', ['A', 'B']],
        ]);
        expect(planMergeEviction(h.keys, h.cellsOf, 'z13')).toEqual([]);
    });

    it('DROPS merges that share no cell with the newest — the pan case that pins ½ GB', () => {
        const h = harness([
            ['moreton', ['M1', 'M2']],
            ['fraser', ['F1', 'F2']],
            ['whitsundays', ['W1', 'W2']],
            ['cairns', ['C1', 'C2']],
        ]);
        // Landing on Cairns, nothing else shares a cell: all three go.
        expect(planMergeEviction(h.keys, h.cellsOf, 'cairns').sort()).toEqual(['fraser', 'moreton', 'whitsundays']);
    });

    it('keeps the overlapping neighbour while dropping the far ones', () => {
        // Panning along a coast: consecutive windows share edge cells.
        const h = harness([
            ['far', ['X1', 'X2']],
            ['prev', ['A', 'B']],
            ['now', ['B', 'C']],
        ]);
        expect(planMergeEviction(h.keys, h.cellsOf, 'now')).toEqual(['far']);
    });

    it('never evicts the newest merge itself', () => {
        const h = harness([['solo', ['A']]]);
        expect(planMergeEviction(h.keys, h.cellsOf, 'solo')).toEqual([]);
    });

    it('still honours the count cap when everything overlaps', () => {
        const h = harness([
            ['a', ['S']],
            ['b', ['S']],
            ['c', ['S']],
            ['d', ['S']],
            ['e', ['S']],
        ]);
        // All share cell S, but the cap is 4 — the oldest falls out.
        const dropped = planMergeEviction(h.keys, h.cellsOf, 'e');
        expect(dropped).toEqual(['a']);
    });

    it('KEEPS entries with an unknown cell set — degrades to the old age cap', () => {
        // A caller that does not pass cellIds must be no worse off than
        // before this policy existed, not silently evicted harder.
        const map = new Map([['known', new Set(['A'])]]);
        const keys = ['legacy', 'known'];
        expect(planMergeEviction(keys, (k) => map.get(k), 'known')).toEqual([]);
    });

    it('handles an unknown NEWEST set without evicting anything it cannot judge', () => {
        const map = new Map([['old', new Set(['A'])]]);
        const keys = ['old', 'mystery'];
        const dropped = planMergeEviction(keys, (k) => map.get(k), 'mystery');
        expect(dropped).toEqual([]);
    });

    it('worked example: the measured 14-cell viewport is not held four times over', () => {
        // Four disjoint 14-cell viewports at 43.8 MB text each. Only the
        // newest survives, so pinned text is 43.8 MB, not 175 MB.
        const viewports: [string, string[]][] = ['moreton', 'fraser', 'whit', 'cairns'].map((name) => [
            name,
            Array.from({ length: 14 }, (_, i) => `${name}-${i}`),
        ]);
        const h = harness(viewports);
        const dropped = planMergeEviction(h.keys, h.cellsOf, 'cairns');
        expect(dropped).toHaveLength(3);
        expect(h.keys.length - dropped.length).toBe(1);
    });
});
