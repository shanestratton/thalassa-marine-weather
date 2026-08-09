/**
 * Give the chart cache back while the skipper is drawing.
 *
 * From Shane's log on 2026-08-09, once the detector existed:
 *
 *     [WebContentKill] the web layer died in the foreground 3x on this
 *     install; most recently on 'map'
 *
 * 'map' with the tracer running IS the planning screen — the Plan tab stays
 * lit while the chart does the drawing. So the foreground kills land on chart
 * + ENC + tracer, the combination 0a607bd3 already tried to relieve by
 * deferring the Pi sync. It helped and was not enough, and that commit named
 * this cache as the next suspect: 48 MB of JSON text is ~150 MB parsed, on top
 * of Mapbox GL and whatever the stroke allocates.
 *
 * The property that matters most here is that shrinking the budget EVICTS
 * IMMEDIATELY. A smaller cap that only takes effect the next time a cell
 * happens to be cached gives nothing back, and on a stationary chart that
 * might be never — precisely when the skipper has stopped panning and started
 * drawing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        readFile: vi.fn(),
        writeFile: vi.fn(),
        deleteFile: vi.fn(),
        stat: vi.fn(),
        mkdir: vi.fn(),
    },
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
}));

import {
    blobCacheBudgetBytes,
    blobCacheStats,
    parseAndCacheCellText,
    setBlobCachePlottingMode,
    shouldEvictBlob,
} from '../services/enc/EncCellStore';

/**
 * A valid EncConversionResult of roughly `mb` megabytes of JSON text.
 *
 * The shape matters: normalizeBlobForCell rejects anything whose cellId does
 * not match the key, or that is missing layers/bbox/sourceHO/edition/issued.
 * A fixture that fails that gate caches nothing and every budget assertion
 * passes vacuously against an empty cache.
 */
function cellText(cellId: string, mb: number): string {
    const skeleton = JSON.stringify({
        cellId,
        layers: { DEPARE: { type: 'FeatureCollection', features: [] } },
        bbox: [153.0, -27.5, 153.5, -27.0],
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-01-01',
    });
    const padBytes = Math.max(0, Math.round(mb * 1024 * 1024) - skeleton.length - 32);
    return JSON.stringify({
        cellId,
        layers: { DEPARE: { type: 'FeatureCollection', features: [] } },
        bbox: [153.0, -27.5, 153.5, -27.0],
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-01-01',
        pad: 'x'.repeat(padBytes),
    });
}

const cellId = (i: number) => `AU5PTL${String(i).padStart(2, '0')}`;
const fill = (count: number, mb: number) => {
    for (let i = 0; i < count; i++) parseAndCacheCellText(cellId(i), cellText(cellId(i), mb));
};

describe('the plotting budget', () => {
    beforeEach(() => {
        setBlobCachePlottingMode(false);
        // Evict everything by briefly shrinking to nothing, then restore.
        setBlobCachePlottingMode(true);
        setBlobCachePlottingMode(false);
    });

    it('the fixtures actually cache — otherwise every assertion below is vacuous', () => {
        fill(2, 1);
        expect(blobCacheStats().entries).toBe(2);
    });

    it('defaults to the full 48 MB budget', () => {
        expect(blobCacheBudgetBytes()).toBe(48 * 1024 * 1024);
    });

    it('drops to 16 MB while the tracer is running', () => {
        setBlobCachePlottingMode(true);
        expect(blobCacheBudgetBytes()).toBe(16 * 1024 * 1024);
    });

    it('restores the full budget when the tracer stops', () => {
        setBlobCachePlottingMode(true);
        setBlobCachePlottingMode(false);
        expect(blobCacheBudgetBytes()).toBe(48 * 1024 * 1024);
    });

    it('evicts IMMEDIATELY, not at the next cache write', () => {
        // Fill past the plotting budget while at the full one.
        fill(10, 4); // ~40 MB
        const before = blobCacheStats();
        expect(before.textMB).toBeGreaterThan(20);

        setBlobCachePlottingMode(true);

        // The memory has to be given back NOW. A stationary chart may never
        // cache another cell, so waiting for the next write gives back nothing
        // at exactly the moment the skipper starts drawing.
        const after = blobCacheStats();
        expect(after.textMB).toBeLessThanOrEqual(16);
        expect(after.entries).toBeLessThan(before.entries);
    });

    it('keeps a working set — the visible cells must not thrash out', () => {
        // BLOB_CACHE_MIN_KEEP is a floor: even one oversized cell must not be
        // able to evict itself out of its own render loop mid-stroke.
        fill(3, 9); // three cells, each over the plotting budget on its own
        setBlobCachePlottingMode(true);
        expect(blobCacheStats().entries).toBeGreaterThan(0);
    });

    it('holds the tighter cap against new cells while plotting', () => {
        setBlobCachePlottingMode(true);
        fill(10, 4);
        expect(blobCacheStats().textMB).toBeLessThanOrEqual(16);
    });

    it('lets the cache grow again once the tracer stops', () => {
        setBlobCachePlottingMode(true);
        fill(4, 4);
        const plotting = blobCacheStats().textMB;
        setBlobCachePlottingMode(false);
        fill(6, 4);
        expect(blobCacheStats().textMB).toBeGreaterThan(plotting);
    });
});

describe('shouldEvictBlob honours whichever budget is passed', () => {
    it('evicts on bytes even when the count is fine', () => {
        expect(shouldEvictBlob(10, 20 * 1024 * 1024, 128, 16 * 1024 * 1024)).toBe(true);
        expect(shouldEvictBlob(10, 10 * 1024 * 1024, 128, 16 * 1024 * 1024)).toBe(false);
    });

    it('never evicts below the min-keep floor, whatever the budget', () => {
        expect(shouldEvictBlob(4, 900 * 1024 * 1024, 128, 16 * 1024 * 1024)).toBe(false);
    });
});

describe('the merge cache already handles the pan case — no plotting mode needed', () => {
    it('collapses disjoint merges to one on its own', async () => {
        // This is why the plotting cap I was about to ship was dropped: the
        // "four merges pinning ~175 MB" scenario the comments warn about
        // cannot happen. planMergeEviction keeps the newest plus whatever
        // OVERLAPS it, so panning up the coast evicts as it goes. Capping to 1
        // while plotting would only have hurt the zoom case, where shared
        // pinning is nearly free but rebuilding is not.
        const m = await import('../services/enc/mergedDataCache');
        m.clearMergedData();
        const merged = () => ({ layers: {}, bbox: [0, 0, 1, 1] }) as never;

        m.putMergedData('k1', merged(), ['AU5A01']);
        m.putMergedData('k2', merged(), ['AU5B01']);
        m.putMergedData('k3', merged(), ['AU5C01']);
        m.putMergedData('k4', merged(), ['AU5D01']);

        expect(m.mergedDataCacheSize()).toBe(1);
        expect(m.mergedPinnedCellCount()).toBe(1);
        m.clearMergedData();
    });

    it('keeps a zoom excursion over the same water, and counts its cells once', async () => {
        const m = await import('../services/enc/mergedDataCache');
        m.clearMergedData();
        const merged = () => ({ layers: {}, bbox: [0, 0, 1, 1] }) as never;

        // Same water at two zooms: two keys, overlapping cells. Pinning is
        // shared, so holding both is nearly free — and the count must show
        // that rather than double-counting.
        m.putMergedData('z11', merged(), ['AU5A01', 'AU5A02']);
        m.putMergedData('z13', merged(), ['AU5A01', 'AU5A02']);
        expect(m.mergedDataCacheSize()).toBe(2);
        expect(m.mergedPinnedCellCount()).toBe(2);
        m.clearMergedData();
    });
});
