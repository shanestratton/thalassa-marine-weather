/**
 * mergeCap — the count+byte bound every windowed cell merge must obey.
 *
 * Extracted from EncHazardService (2026-08-10, kill #32) so the tracer's
 * layer assembly can share the bound WITHOUT importing the whole hazard
 * service: EncHazardService subscribes to the cell registry at import time,
 * which is exactly the kind of side effect the tracer path (and its
 * minimally-mocked tests) must not inherit. This module is pure.
 */

/**
 * The most cells allowed into ONE merge.
 *
 * The number is from the flight trails, not taste. Across every recorded
 * session on both platforms, every merge that COMPLETED was 15 cells or
 * fewer — dozens of them, 3-15 cells, all fine. The two that went bigger:
 *
 *   · Desktop Chrome, 2026-08-09: enc:merge-start(20cells) → renderer died
 *     inside it ("Aw, Snap"), with the same session logging a 15-cell merge
 *     at a 43.1 MB register moments earlier. PROCESS-DIED, foreground,
 *     last crumb enc:merge-fail as the superseded 14-cell build aborted.
 *   · iOS, same day: merge-start(34cells) and (38cells) north of Fraser
 *     Island on a zoom-out — both superseded before completing, session
 *     reaped in the background minutes later.
 *
 * North of Fraser Island the AU chart series overlap densely enough that a
 * passage-zoom window admits 20+ cells even after the zoom-graded floors —
 * the same failure the 2026-07-13 note in EncHazardService's selection code
 * records as "47-49 cells joining a z6.7-6.9 merge — the crash that survived
 * every other cut". The floors were then loosened one grade (2026-07-14) on
 * the argument that per-feature culls made extra cells cheap. The culls
 * bound what reaches MAPBOX; nothing bounded what enters the MERGE, whose
 * register alone was 43.1 MB at 15 cells.
 *
 * 14 keeps every merge that has ever succeeded and refuses the size class
 * that has only ever killed.
 */
export const MAX_MERGE_CELLS = 14;

/**
 * The most REGISTER BYTES allowed into one windowed merge.
 *
 * The cell cap alone was disproven the day after it shipped (2026-08-10):
 * a capped session died in the foreground with every merge ≤14 cells, and
 * its own perf line showed why — north of Fraser Island 14 cells carried a
 * 44.5 MB register, MORE than the 43.1 MB @ 15 cells logged moments before
 * the original desktop kill. Count does not bound bytes: up there the AU
 * series overlap so densely that 14 cells outweigh 20 sparse ones.
 *
 * 32 MB leaves every everyday merge untouched (recorded sessions run
 * 11–25 MB) and trims only the dense-overlap monsters that have ever been
 * present in a dying session (43.1, 44.5 MB).
 */
export const MAX_MERGE_REGISTER_BYTES = 32 * 1024 * 1024;

/**
 * Cap a windowed merge's cell list — first by count, then by cumulative
 * register bytes — keeping the cells that cover the most of the window;
 * those carry the picture at any zoom. Deterministic (coverage desc, then
 * id) so identical viewports produce identical lists and the merge cache
 * key stays stable. Cells with unknown sizeBytes count 0 — an unmeasured
 * cell must not evict a measured one. Never trims below one cell. Pure,
 * exported for tests.
 */
export function capCellsForMerge<T extends { id: string; bbox: [number, number, number, number]; sizeBytes?: number }>(
    cells: T[],
    window: [number, number, number, number] | null | undefined,
    max = MAX_MERGE_CELLS,
    maxBytes = MAX_MERGE_REGISTER_BYTES,
): T[] {
    if (!window) return cells;
    const bytes = (c: T): number => c.sizeBytes ?? 0;
    const overBytes = (list: T[]): boolean => list.reduce((s, c) => s + bytes(c), 0) > maxBytes;
    if (cells.length <= max && !overBytes(cells)) return cells;
    const coverage = (b: [number, number, number, number]): number => {
        const w = Math.min(b[2], window[2]) - Math.max(b[0], window[0]);
        const h = Math.min(b[3], window[3]) - Math.max(b[1], window[1]);
        return w > 0 && h > 0 ? w * h : 0;
    };
    const ranked = [...cells].sort((a, b) => coverage(b.bbox) - coverage(a.bbox) || (a.id < b.id ? -1 : 1));
    const kept = ranked.slice(0, max);
    // Byte trim drops from the low-coverage end, same ranking, so the cache
    // key stays deterministic for identical viewports.
    while (kept.length > 1 && overBytes(kept)) kept.pop();
    return kept;
}
