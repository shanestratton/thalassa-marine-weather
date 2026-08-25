import { Capacitor } from '@capacitor/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The CMEMS primary is unit-tested in CmemsPassageCurrents.test.ts; here it
// declines so every NOAA-chain contract below stays exact.
const { sampleCmemsPassageCurrents } = vi.hoisted(() => ({ sampleCmemsPassageCurrents: vi.fn() }));
vi.mock('../services/weather/api/cmemsPassageCurrents', () => ({ sampleCmemsPassageCurrents }));

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
        sampleCmemsPassageCurrents.mockResolvedValue(null);
        vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    });

    afterEach(() => {
        vi.mocked(Capacitor.getPlatform).mockReturnValue('web');
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
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
        // One call per dataset descriptor in the fallback chain.
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const urls = fetchMock.mock.calls.map((call) => String(call[0]));
        expect(urls[0]).toContain('coastwatch.noaa.gov/erddap/griddap/noaacwBLENDEDNRTcurrentsDaily.json');
        expect(urls[0]).toContain('u_current[(last)]');
        expect(urls[1]).toContain('coastwatch.pfeg.noaa.gov/erddap/griddap/nesdisSSH1day.json');
        expect(urls[1]).toContain('ugos[(last)]');
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

    it('keeps live current fetches available on iOS without reading or writing a plaintext route cache', async () => {
        vi.mocked(Capacitor.getPlatform).mockReturnValue('ios');
        vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
        localStorage.setItem(`${CACHE_PREFIX}legacy-route`, JSON.stringify({ private: 'old-corridor' }));
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => currentResponse([]));

        const first = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);
        const second = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);

        expect(first).toMatchObject({ availability: 'available', retrieval: 'live' });
        expect(second).toMatchObject({ availability: 'available', retrieval: 'live' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(currentCacheKeys()).toEqual([]);
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
            // Fresh relative to the wall clock — a fixed date would age past
            // the freshness guard and turn this into an unavailability test.
            .mockImplementation(async () =>
                currentResponse([[new Date(Date.now() - 86_400_000).toISOString(), -20, 148, 0.5, 0.1]]),
            );

        await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);
        await OceanCurrentService.fetchCurrents(BBOX, 91, 120, 6);
        await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 7);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(currentCacheKeys()).toHaveLength(3);
    });

    it('rejects a stale field — [(last)] on a frozen dataset is a failure, not a briefing', async () => {
        // NOAA retired the whole 2025 dataset chain on 2026-08-25 and the
        // survivors freeze in place (jplOscar died at 2014, nesdisSSH1day at
        // 2026-03). A months-old row must fall through to the next dataset
        // and, with none fresh, come back unavailable.
        const staleRow = ['2026-03-25T00:00:00Z', -20, 148, 0.3, 0.1];
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(currentResponse([staleRow]));

        const result = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);

        expect(result.availability).toBe('unavailable');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(currentCacheKeys()).toEqual([]);
    });

    it('accepts a fresh field and records its dataset id and data time', async () => {
        const freshIso = new Date(Date.now() - 2 * 86_400_000).toISOString();
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(currentResponse([[freshIso, -20, 148, 0.3, 0.1]]));

        const result = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);

        expect(result.availability).toBe('available');
        if (result.availability === 'available') {
            expect(result.providerDataset).toBe('noaacwBLENDEDNRTcurrentsDaily');
            expect(result.dataTime).toBe(freshIso);
            expect(result.vectors).toHaveLength(1);
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('CMEMS answers first — the briefing carries its provider and the ERDDAP chain never runs', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch');
        sampleCmemsPassageCurrents.mockResolvedValue({
            vectors: [
                { lat: -20, lon: 148, u: 0.3, v: -0.1 },
                { lat: -20.25, lon: 148.25, u: 0.4, v: 0.0 },
            ],
            dataTime: '2026-08-25T12:00:00Z',
            datasetId: 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i',
            generation: 'g-test',
        });

        const live = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);

        expect(live).toMatchObject({
            availability: 'available',
            provider: 'E.U. Copernicus Marine Service',
            providerDataset: 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i',
            dataTime: '2026-08-25T12:00:00Z',
            retrieval: 'live',
        });
        if (live.availability === 'available') {
            expect(live.vectors).toHaveLength(2);
            expect(live.avgSpeedKts).toBeGreaterThan(0);
        }
        expect(fetchMock).not.toHaveBeenCalled();

        const cached = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);
        expect(cached).toMatchObject({ retrieval: 'cached', provider: 'E.U. Copernicus Marine Service' });
    });

    it('a declined CMEMS primary falls through to the NOAA chain', async () => {
        sampleCmemsPassageCurrents.mockResolvedValue(null);
        const freshIso = new Date(Date.now() - 2 * 86_400_000).toISOString();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(currentResponse([[freshIso, -20, 148, 0.3, 0.1]]));

        const result = await OceanCurrentService.fetchCurrents(BBOX, 90, 120, 6);

        expect(result).toMatchObject({ availability: 'available', provider: 'NOAA CoastWatch ERDDAP' });
    });
});
