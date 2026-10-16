// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
    native: true,
    platform: 'ios',
    satellite: false,
    read: vi.fn(),
    cancel: vi.fn(async () => {}),
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => state.native, getPlatform: () => state.platform },
    registerPlugin: () => ({ read: state.read, cancel: state.cancel }),
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => state.satellite }));
import { allowedObservationUrl, readObservation } from '../services/weather/observations/transport';
import { metarRequest, ndbcLatestRequest } from '../services/weather/observations/requests';
import {
    airportCatalogueRequest,
    nearbyAirportIds,
    parseAirportCatalogue,
} from '../services/weather/observations/catalogue';

beforeEach(() => {
    state.native = true;
    state.platform = 'ios';
    state.satellite = false;
    state.read.mockReset();
    state.cancel.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
describe('native observation transport', () => {
    it('never falls back to browser HTTP or WAN in Satellite Mode', async () => {
        const web = vi.fn();
        vi.stubGlobal('fetch', web);
        state.native = false;
        await expect(readObservation(ndbcLatestRequest())).rejects.toMatchObject({ reason: 'native' });
        state.native = true;
        state.satellite = true;
        await expect(readObservation(ndbcLatestRequest())).rejects.toMatchObject({ reason: 'policy' });
        expect(state.read).not.toHaveBeenCalled();
        expect(web).not.toHaveBeenCalled();
    });
    it.each([
        'http://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt',
        'https://www.ndbc.noaa.gov.evil.test/data/latest_obs/latest_obs.txt',
        'https://secret@www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt',
        'https://aviationweather.gov/api/data/metar?ids=ZZ01&format=json&hours=3&url=https://evil.test',
        'https://aviationweather.gov/api/data/metar?ids=ZZ01&ids=ZZ02&hours=3',
        'https://aviationweather.gov/api/data/metar?ids=ZZ01&format=json&hours=3#fragment',
    ])('refuses non-contract URL %s before native networking', async (url) => {
        expect(allowedObservationUrl(url)).toBe(false);
        await expect(readObservation({ ...ndbcLatestRequest(), url })).rejects.toMatchObject({ reason: 'invalid' });
        expect(state.read).not.toHaveBeenCalled();
    });
    it('returns204 empty, surfaces429 and rejects MIME/byte overflow', async () => {
        const plan = metarRequest(['ZZ01']);
        state.read.mockResolvedValueOnce({ status: 204, mime: '', data: '' });
        expect(await readObservation(plan)).toBe('');
        state.read.mockResolvedValueOnce({ status: 429, mime: 'application/json', data: 'rate limited' });
        await expect(readObservation(plan)).rejects.toMatchObject({ status: 429 });
        state.read.mockResolvedValueOnce({ status: 200, mime: 'text/html', data: '[]' });
        await expect(readObservation(plan)).rejects.toMatchObject({ reason: 'invalid' });
        state.read.mockResolvedValueOnce({ status: 200, mime: 'application/json', data: 'x'.repeat(101) });
        await expect(readObservation({ ...plan, maxBytes: 100 })).rejects.toMatchObject({ reason: 'invalid' });
    });
    it('cancels the matching native request and suppresses its late reply', async () => {
        let finish!: (value: unknown) => void;
        state.read.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const controller = new AbortController();
        const pending = readObservation(ndbcLatestRequest(), controller.signal);
        controller.abort();
        expect(state.cancel).toHaveBeenCalledWith({ requestId: state.read.mock.calls[0][0].requestId });
        finish({ status: 200, mime: 'text/plain', data: 'late' });
        await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
    });
    it('decompresses the official-format catalogue under an independent expanded-byte cap', async () => {
        const raw = JSON.stringify([
            { icaoId: 'ZZ01', site: 'Fictional field', lat: 30, lon: -150, siteType: ['METAR'] },
        ]);
        state.read.mockResolvedValueOnce({
            status: 200,
            mime: 'application/octet-stream',
            data: gzipSync(raw).toString('base64'),
        });
        expect(parseAirportCatalogue(await readObservation(airportCatalogueRequest()))).toHaveLength(1);
        state.read.mockResolvedValueOnce({
            status: 200,
            mime: 'application/octet-stream',
            data: gzipSync('x'.repeat(3 * 1024 * 1024 + 1)).toString('base64'),
        });
        await expect(readObservation(airportCatalogueRequest())).rejects.toMatchObject({ reason: 'invalid' });
    });
});
describe('public station discovery', () => {
    it('locally selects only valid METAR station IDs, including across the dateline', () => {
        const rows = parseAirportCatalogue(
            JSON.stringify([
                { icaoId: 'ZZ01', site: 'Fictional near field', lat: 0.1, lon: 179.9, siteType: ['METAR'] },
                { icaoId: 'ZZ02', site: 'Fictional far field', lat: 50, lon: 10, siteType: ['METAR'] },
                { icaoId: 'ZZ03', lat: 0.1, lon: 179.9, siteType: ['TAF'] },
                { icaoId: 'BAD+', lat: 0.1, lon: 179.9, siteType: ['METAR'] },
            ]),
        );
        expect(nearbyAirportIds(rows, { lat: 0.1, lon: -179.9 })).toEqual(['ZZ01']);
        expect(() => parseAirportCatalogue('[]')).toThrow();
    });
});
