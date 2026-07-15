/**
 * EncCellStore blob-LRU eviction — the pure decision behind the parsed-cell
 * cache the merge reads. The mission audit flagged JSON.parse re-parse
 * churn; the real fix was recognising the byte budget (not the count) is
 * the memory bound, and raising the count cap so it stops evicting
 * small-cell history the 48 MB budget has room for. These lock in the caps'
 * interplay and the fail-safe min-keep floor.
 */
import { describe, it, expect } from 'vitest';

import { shouldEvictBlob } from '../../services/enc/EncCellStore';

const MB = 1024 * 1024;

describe('shouldEvictBlob', () => {
    it('keeps when under BOTH caps', () => {
        expect(shouldEvictBlob(20, 10 * MB, 128, 48 * MB, 4)).toBe(false);
    });

    it('evicts when over the COUNT cap', () => {
        expect(shouldEvictBlob(129, 10 * MB, 128, 48 * MB, 4)).toBe(true);
    });

    it('evicts when over the BYTE cap (the memory bound)', () => {
        expect(shouldEvictBlob(10, 49 * MB, 128, 48 * MB, 4)).toBe(true);
    });

    it('NEVER evicts below the min-keep floor, even far over the byte cap', () => {
        // A few oversized cells can pin > budget briefly rather than thrash
        // out of their own render loop — the deliberate MIN_KEEP escape hatch.
        expect(shouldEvictBlob(4, 200 * MB, 128, 48 * MB, 4)).toBe(false);
        expect(shouldEvictBlob(3, 200 * MB, 128, 48 * MB, 4)).toBe(false);
    });

    it('the BYTE budget, not the count, is the real bound', () => {
        // ~96 median (0.5 MB) cells = 48 MB: byte cap binds, count (128) does not.
        expect(shouldEvictBlob(96, 48 * MB, 128, 48 * MB, 4)).toBe(false);
        expect(shouldEvictBlob(97, 48.5 * MB, 128, 48 * MB, 4)).toBe(true);
    });

    it('the raised count cap keeps small-cell history the OLD cap (32) thrashed — memory-neutral', () => {
        // 40 small cells = 20 MB: fits the 48 MB budget, but exceeded the old
        // count cap of 32. Same peak memory, fewer re-parses on a wide pan.
        expect(shouldEvictBlob(40, 20 * MB, 32, 48 * MB, 4)).toBe(true); // old cap: evicted
        expect(shouldEvictBlob(40, 20 * MB, 128, 48 * MB, 4)).toBe(false); // new cap: kept
    });
});
