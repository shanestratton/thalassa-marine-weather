import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OceanCurrentService } from '../services/OceanCurrentService';

const BBOX = { north: -19, south: -21, east: 149, west: 147 };
const CACHE_PREFIX = 'thalassa_ocean_currents_';

function currentResponse(rows: unknown[][]): Response {
    return new Response(JSON.stringify({ table: { rows } }), { status: 200 });
}

function currentCacheKeys(): string[] {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
        (key): key is string => key?.startsWith(CACHE_PREFIX) === true,
    );
}

describe('OceanCurrentService provider authority', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('reports an outage as unavailable without caching or inventing zero current', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('down', { status: 503 }));

        const result = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);

        expect(result).toMatchObject({
            availability: 'unavailable',
            avgSpeedKts: null,
            maxSpeedKts: null,
            netEffectHours: null,
            coverage: 'unavailable',
            dataFingerprint: null,
        });
        expect(result.vectors).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(currentCacheKeys()).toEqual([]);
    });

    it('keeps a successful empty provider field distinct and caches only that authoritative response', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(currentResponse([]));

        const live = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);
        const cached = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);

        expect(live).toMatchObject({
            availability: 'available',
            coverage: 'empty',
            avgSpeedKts: 0,
            retrieval: 'live',
            provider: 'NOAA CoastWatch ERDDAP',
        });
        expect(live.dataFingerprint).toMatch(/^v1_/);
        expect(cached).toMatchObject({
            availability: 'available',
            coverage: 'empty',
            retrieval: 'cached',
            dataFingerprint: live.dataFingerprint,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(currentCacheKeys()).toHaveLength(1);
    });

    it('treats non-empty but unreadable provider rows as unavailable rather than calm', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            currentResponse([['2026-08-05T00:00:00Z', -20, 148, null, null]]),
        );

        const result = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);

        expect(result.availability).toBe('unavailable');
        expect(result.coverage).toBe('unavailable');
        expect(currentCacheKeys()).toEqual([]);
    });

    it('binds cached route-effect calculations to speed, distance and bearing inputs', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async () => currentResponse([['2026-08-05T00:00:00Z', -20, 148, 0.5, 0.1]]));

        await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);
        await OceanCurrentService.fetchCurrents(BBOX, 91, 120, 6);
        await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 7);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(currentCacheKeys()).toHaveLength(3);
    });
});
