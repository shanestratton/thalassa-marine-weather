/**
 * No merge may exceed the size class that kills renderers.
 *
 * Two weeks of "the planning page crashes", ten fixes, and the conviction
 * finally came from a desktop crash at the same spot as the iPhone — just
 * north of Fraser Island — because a crash that follows a PLACE across two
 * platforms is caused by data. The flight trail named the instrument of
 * death precisely:
 *
 *   enc:merge-start(14cells) → enc:merge-start(20cells)
 *   → enc:merge-fail(14cells) → PROCESS-DIED (foreground, "Aw, Snap")
 *
 * Every merge that has ever COMPLETED in any recorded trail, on either
 * platform, was ≤15 cells. The 15-cell merge in the fatal session carried a
 * 43.1 MB register. The 20-cell merge killed a desktop Chrome with ten times
 * an iPhone's memory. North of Fraser the AU chart series overlap densely
 * enough that a passage-zoom window admits 20+ cells even after the
 * zoom-graded selection floors — which bound what is LEGIBLE, while nothing
 * bounded what enters the merge.
 *
 * These tests pin the cap and, as importantly, WHAT survives it: the cells
 * covering the most of the window, because they carry the picture at any
 * zoom. Trimming by anything else quietly blanks the chart under the cursor.
 */
import { describe, expect, it } from 'vitest';
import { capCellsForMerge } from '../services/enc/EncHazardService';

type Cell = { id: string; bbox: [number, number, number, number]; sizeBytes?: number };
const cell = (id: string, bbox: [number, number, number, number], sizeBytes?: number): Cell => ({
    id,
    bbox,
    ...(sizeBytes != null ? { sizeBytes } : {}),
});

const MB = 1024 * 1024;

/** A window over 1°×1° of coast. */
const WINDOW: [number, number, number, number] = [153.0, -25.0, 154.0, -24.0];

describe('capCellsForMerge', () => {
    it('refuses the size class that has only ever killed', () => {
        // 20 cells is the recorded fatal input. 14 is the largest size with
        // an unblemished record.
        const cells = Array.from({ length: 20 }, (_, i) =>
            cell(`AU${i}`, [153.0 + i * 0.01, -25.0, 153.5 + i * 0.01, -24.5]),
        );
        expect(capCellsForMerge(cells, WINDOW).length).toBe(14);
    });

    it('keeps the cells that cover the window, not the ones that merely touch it', () => {
        const covering = cell('COVER', [153.0, -25.0, 154.0, -24.0]); // the whole window
        const sliver = cell('SLIVER', [153.99, -24.01, 155.0, -23.0]); // a corner clip
        const fillers = Array.from({ length: 14 }, (_, i) =>
            cell(`FILL${String(i).padStart(2, '0')}`, [153.1, -24.9, 153.6, -24.4]),
        );
        const kept = capCellsForMerge([sliver, ...fillers, covering], WINDOW);
        expect(kept.map((c) => c.id)).toContain('COVER');
        expect(kept.map((c) => c.id)).not.toContain('SLIVER');
    });

    it('is deterministic, so identical viewports produce identical merge cache keys', () => {
        // Equal-coverage cells tie-break by id. A nondeterministic trim would
        // give the same viewport different cache keys on different visits and
        // quietly rebuild merges the cache already holds.
        const cells = Array.from({ length: 18 }, (_, i) =>
            cell(`AU${String(17 - i).padStart(2, '0')}`, [153.2, -24.8, 153.8, -24.2]),
        );
        const a = capCellsForMerge(cells, WINDOW).map((c) => c.id);
        const b = capCellsForMerge([...cells].reverse(), WINDOW).map((c) => c.id);
        expect(a).toEqual(b);
    });

    it('touches nothing at or under the cap — every historically good merge is unchanged', () => {
        const cells = Array.from({ length: 14 }, (_, i) => cell(`AU${i}`, [153.1, -24.9, 153.6, -24.4]));
        expect(capCellsForMerge(cells, WINDOW)).toBe(cells);
    });

    it('never caps a full (windowless) merge — seaway builds are bounded elsewhere', () => {
        const cells = Array.from({ length: 30 }, (_, i) => cell(`AU${i}`, [150 + i, -30, 151 + i, -29]));
        expect(capCellsForMerge(cells, null)).toBe(cells);
        expect(capCellsForMerge(cells, undefined)).toBe(cells);
    });

    it('does not mutate the caller’s array', () => {
        const cells = Array.from({ length: 20 }, (_, i) => cell(`AU${i}`, [153.1, -24.9, 153.6, -24.4]));
        const order = cells.map((c) => c.id);
        capCellsForMerge(cells, WINDOW);
        expect(cells.map((c) => c.id)).toEqual(order);
    });
});

/**
 * The byte budget — added 2026-08-10, the day the cell cap was disproven
 * by its own instruments. A capped session died in the foreground with
 * every merge ≤14 cells, because north of Fraser Island 14 cells carry a
 * 44.5 MB register — MORE than the 43.1 MB @ 15 cells logged before the
 * original desktop kill. Count does not bound bytes; the budget does.
 */
describe('capCellsForMerge byte budget', () => {
    it('trims a merge that fits the cell cap but not the byte budget', () => {
        // 10 cells at 4 MB each = 40 MB — under 14 cells, over 32 MB.
        const cells = Array.from({ length: 10 }, (_, i) =>
            cell(`AU${i}`, [153.0 + i * 0.01, -25.0, 153.5 + i * 0.01, -24.5], 4 * MB),
        );
        const kept = capCellsForMerge(cells, WINDOW);
        expect(kept.length).toBe(8); // 8 × 4 MB = 32 MB, at the budget
        expect(kept.reduce((s, c) => s + (c.sizeBytes ?? 0), 0)).toBeLessThanOrEqual(32 * MB);
    });

    it('drops the low-coverage cells first, same ranking as the cell cap', () => {
        const covering = cell('COVER', [153.0, -25.0, 154.0, -24.0], 20 * MB);
        const slivers = Array.from({ length: 4 }, (_, i) =>
            cell(`SLIVER${i}`, [153.99, -24.01 - i * 0.001, 155.0, -23.0], 20 * MB),
        );
        const kept = capCellsForMerge([...slivers, covering], WINDOW);
        expect(kept.map((c) => c.id)).toContain('COVER');
        expect(kept.length).toBeLessThan(5);
    });

    it('never trims below one cell — a lone oversized cell still paints', () => {
        const kept = capCellsForMerge([cell('HUGE', [153.0, -25.0, 154.0, -24.0], 40 * MB)], WINDOW);
        expect(kept.map((c) => c.id)).toEqual(['HUGE']);
    });

    it('counts unknown sizeBytes as zero — an unmeasured cell cannot evict a measured one', () => {
        const cells = [
            cell('KNOWN', [153.0, -25.0, 154.0, -24.0], 10 * MB),
            ...Array.from({ length: 13 }, (_, i) => cell(`UNKNOWN${i}`, [153.1, -24.9, 153.6, -24.4])),
        ];
        expect(capCellsForMerge(cells, WINDOW)).toBe(cells);
    });

    it('windowless merges stay exempt from the byte budget too', () => {
        const cells = Array.from({ length: 5 }, (_, i) => cell(`AU${i}`, [150 + i, -30, 151 + i, -29], 20 * MB));
        expect(capCellsForMerge(cells, null)).toBe(cells);
    });

    it('is deterministic under the byte trim', () => {
        const cells = Array.from({ length: 12 }, (_, i) =>
            cell(`AU${String(11 - i).padStart(2, '0')}`, [153.2, -24.8, 153.8, -24.2], 5 * MB),
        );
        const a = capCellsForMerge(cells, WINDOW).map((c) => c.id);
        const b = capCellsForMerge([...cells].reverse(), WINDOW).map((c) => c.id);
        expect(a).toEqual(b);
    });
});
