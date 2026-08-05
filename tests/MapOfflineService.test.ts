import { beforeEach, describe, expect, it, vi } from 'vitest';

const piCache = vi.hoisted(() => ({
    isAvailable: vi.fn(),
    passthroughTileUrl: vi.fn(),
    getStatus: vi.fn(),
}));
const nativeRuntime = vi.hoisted(() => ({
    enabled: false,
    convertFileSrc: vi.fn((uri: string) => uri.replace('file://', 'capacitor://localhost/_capacitor_file_/')),
}));
const filesystem = vi.hoisted(() => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    getUri: vi
        .fn()
        .mockImplementation(({ path }: { path: string }) => Promise.resolve({ uri: `file:///documents/${path}` })),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => nativeRuntime.enabled,
        convertFileSrc: nativeRuntime.convertFileSrc,
    },
}));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA' },
    Filesystem: filesystem,
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
    BULK_OFFLINE_PREFETCH_CAPABILITY,
    autoDownloadAroundUser,
    boundsAroundPoint,
    distanceNm,
    downloadArea,
    enumerateTiles,
    estimateSizeMB,
    estimateTileCount,
    getOfflineTileTemplates,
} from '../services/MapOfflineService';

beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    nativeRuntime.enabled = false;
    piCache.isAvailable.mockReturnValue(false);
    piCache.passthroughTileUrl.mockImplementation(
        (url: string) => `http://pi.test/tile?url=${encodeURIComponent(url)}`,
    );
    piCache.getStatus.mockReturnValue({ cacheStats: { dbSizeMB: 0 } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('tile', { status: 200 })));
    vi.stubGlobal('caches', {
        open: vi.fn().mockResolvedValue({ put: vi.fn().mockResolvedValue(undefined) }),
    });
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

    it('fails closed before enumerating or fetching public OSM/OpenSeaMap tiles', async () => {
        const progress = vi.fn();

        const result = await downloadArea({ bounds: oneTile, minZoom: 0, maxZoom: 0, concurrency: 0 }, progress);

        expect(BULK_OFFLINE_PREFETCH_CAPABILITY).toMatchObject({
            enabled: false,
            providerId: 'public-osm-openseamap',
        });
        expect(result).toMatchObject({
            phase: 'error',
            current: 0,
            total: 0,
            failed: 0,
            route: 'direct',
            message: expect.stringMatching(/not licensed for bulk prefetch/i),
        });
        expect(progress).toHaveBeenCalledOnce();
        expect(progress).toHaveBeenCalledWith(result);
        expect(fetch).not.toHaveBeenCalled();
        expect(caches.open).not.toHaveBeenCalled();
        expect(filesystem.writeFile).not.toHaveBeenCalled();
    });

    it('does not use a Pi proxy to bypass the upstream provider licence', async () => {
        piCache.isAvailable.mockReturnValue(true);
        const result = await downloadArea({ bounds: oneTile, minZoom: 0, maxZoom: 0, concurrency: 2 }, vi.fn());

        expect(result).toMatchObject({ phase: 'error', route: 'pi', current: 0, total: 0 });
        expect(piCache.passthroughTileUrl).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('preserves native local templates for already imported/licensed offline data', async () => {
        nativeRuntime.enabled = true;

        const templates = await getOfflineTileTemplates();
        expect(templates).toEqual({
            osm: 'capacitor://localhost/_capacitor_file_//documents/offline_map_v1/osm/{z}/{x}/{y}.png',
            openseamap: 'capacitor://localhost/_capacitor_file_//documents/offline_map_v1/openseamap/{z}/{x}/{y}.png',
            storage: 'native-files',
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(filesystem.writeFile).not.toHaveBeenCalled();
    });
});

describe('autoDownloadAroundUser', () => {
    it('rejects invalid centres before applying the provider capability policy', async () => {
        await expect(autoDownloadAroundUser({ centerLat: 0, centerLon: 0 })).resolves.toEqual({
            status: 'skipped',
            reason: 'invalid centre',
        });
    });

    it('skips valid automatic downloads before phone or Pi network work', async () => {
        await expect(autoDownloadAroundUser({ centerLat: -27, centerLon: 153 })).resolves.toEqual({
            status: 'skipped',
            reason: BULK_OFFLINE_PREFETCH_CAPABILITY.reason,
        });
        piCache.isAvailable.mockReturnValue(true);
        await expect(autoDownloadAroundUser({ centerLat: -27, centerLon: 153 })).resolves.toEqual({
            status: 'skipped',
            reason: BULK_OFFLINE_PREFETCH_CAPABILITY.reason,
        });
        expect(piCache.getStatus).not.toHaveBeenCalled();
        expect(piCache.passthroughTileUrl).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});
