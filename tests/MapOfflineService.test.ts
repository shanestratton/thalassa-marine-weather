import { beforeEach, describe, expect, it, vi } from 'vitest';

const piCache = vi.hoisted(() => ({
    isAvailable: vi.fn(),
    passthroughTileUrl: vi.fn(),
    getStatus: vi.fn(),
}));

vi.mock('../services/PiCacheService', () => ({ piCache }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import {
    autoDownloadAroundUser,
    boundsAroundPoint,
    distanceNm,
    downloadArea,
    enumerateTiles,
    estimateSizeMB,
    estimateTileCount,
} from '../services/MapOfflineService';

beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    piCache.isAvailable.mockReturnValue(false);
    piCache.passthroughTileUrl.mockImplementation(
        (url: string) => `http://pi.test/tile?url=${encodeURIComponent(url)}`,
    );
    piCache.getStatus.mockReturnValue({ cacheStats: { dbSizeMB: 0 } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
});

describe('offline map geometry', () => {
    it('enumerates inclusive zoom ranges and accounts for both raster sources', () => {
        const bounds = { north: 0.1, south: -0.1, west: -0.1, east: 0.1 };
        const tiles = enumerateTiles(bounds, 1, 2);
        expect(tiles).toContainEqual({ z: 1, x: 0, y: 0 });
        expect(tiles).toContainEqual({ z: 2, x: 2, y: 2 });
        expect(estimateTileCount(bounds, 1, 2)).toBe(tiles.length * 2);
        expect(estimateSizeMB(51)).toBe(1);
    });

    it('uses the narrow seam for antimeridian-crossing bounds', () => {
        const tiles = enumerateTiles({ north: 1, south: -1, west: 179, east: -179 }, 3, 3);
        expect(new Set(tiles.map((tile) => tile.x))).toEqual(new Set([0, 7]));
        expect(tiles.length).toBeLessThanOrEqual(4);
    });

    it('clamps pole-adjacent input to valid Web Mercator tile coordinates', () => {
        const tiles = enumerateTiles({ north: 90, south: 89, west: 0, east: 1 }, 4, 4);
        expect(tiles.length).toBeGreaterThan(0);
        expect(tiles.every(({ x, y }) => Number.isInteger(x) && Number.isInteger(y))).toBe(true);
        expect(tiles.every(({ x, y }) => x >= 0 && x < 16 && y >= 0 && y < 16)).toBe(true);
    });

    it('builds latitude-aware bounds and calculates great-circle distance', () => {
        expect(boundsAroundPoint(0, 10, 60)).toEqual({ north: 1, south: -1, east: 11, west: 9 });
        const polar = boundsAroundPoint(84.9, 0, 60);
        expect(polar.north).toBe(85);
        expect(polar.south).toBeCloseTo(83.9);
        expect(distanceNm(0, 0, 0, 1)).toBeCloseTo(60.04, 1);
        expect(distanceNm(-27, 153, -27, 153)).toBe(0);
    });
});

describe('downloadArea', () => {
    const oneTile = { north: 1, south: -1, west: -1, east: 1 };

    it('downloads both sources directly and reports failed HTTP responses', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce({ ok: true } as Response)
            .mockResolvedValueOnce({ ok: false } as Response);
        const progress = vi.fn();

        const result = await downloadArea({ bounds: oneTile, minZoom: 0, maxZoom: 0, concurrency: 0 }, progress);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ phase: 'done', current: 2, total: 2, failed: 1, route: 'direct' });
        expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'done', failed: 1 }));
    });

    it('routes through the Pi with the long offline TTL', async () => {
        piCache.isAvailable.mockReturnValue(true);
        const result = await downloadArea({ bounds: oneTile, minZoom: 0, maxZoom: 0, concurrency: 2 }, vi.fn());

        expect(result.route).toBe('pi');
        expect(piCache.passthroughTileUrl).toHaveBeenCalledTimes(2);
        expect(piCache.passthroughTileUrl).toHaveBeenCalledWith(
            expect.stringContaining('openstreetmap'),
            2_592_000_000,
        );
        expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/pi\.test/), {
            signal: undefined,
            cache: 'reload',
        });
    });

    it('counts network failures and returns a cancelled outcome', async () => {
        vi.mocked(fetch)
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue({ ok: true } as Response);
        const failed = await downloadArea({ bounds: oneTile, minZoom: 0, maxZoom: 0 }, vi.fn());
        expect(failed.failed).toBe(1);

        const controller = new AbortController();
        controller.abort();
        const cancelled = await downloadArea(
            { bounds: oneTile, minZoom: 0, maxZoom: 0, signal: controller.signal },
            vi.fn(),
        );
        expect(cancelled).toMatchObject({ phase: 'cancelled', current: 0, total: 2 });
    });
});

describe('autoDownloadAroundUser', () => {
    it('rejects invalid centres and skips automatic phone downloads', async () => {
        await expect(autoDownloadAroundUser({ centerLat: 0, centerLon: 0 })).resolves.toEqual({
            status: 'skipped',
            reason: 'invalid centre',
        });
        await expect(autoDownloadAroundUser({ centerLat: -27, centerLon: 153 })).resolves.toEqual({
            status: 'skipped',
            reason: 'no Pi — auto-cache is Pi-only',
        });
    });

    it('protects a Pi whose cache is already over the disk ceiling', async () => {
        piCache.isAvailable.mockReturnValue(true);
        piCache.getStatus.mockReturnValue({ cacheStats: { dbSizeMB: 10_241 } });
        await expect(autoDownloadAroundUser({ centerLat: -27, centerLon: 153 })).resolves.toEqual({
            status: 'skipped',
            reason: 'Pi cache already 10.0 GB',
        });
    });

    it('downloads tiers, aggregates progress, and skips a nearby repeat', async () => {
        piCache.isAvailable.mockReturnValue(true);
        const onProgress = vi.fn();
        const options = {
            centerLat: -27,
            centerLon: 153,
            tiers: [{ radiusNm: 1, minZoom: 0, maxZoom: 0 }],
            onProgress,
        };

        await expect(autoDownloadAroundUser(options)).resolves.toEqual({
            status: 'done',
            tilesCached: 2,
            failed: 0,
        });
        expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ current: 2, total: 2 }));

        const repeat = await autoDownloadAroundUser(options);
        expect(repeat.status).toBe('skipped');
        expect(repeat).toHaveProperty('reason', 'only moved 0 NM since last auto-cache');
    });
});
