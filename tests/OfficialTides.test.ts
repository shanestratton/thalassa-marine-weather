import { describe, expect, it, vi } from 'vitest';
import {
    createOfficialTideClient,
    validateOfficialDocument,
    validateOfficialManifest,
    validateOfficialObservation,
    type OfficialTideDocument,
} from '../services/tides/officialTides';

const NOW = Date.UTC(2026, 9, 16, 0);
const HOUR = 3_600_000;
const generatedAt = new Date(NOW).toISOString();
const expiresAt = new Date(NOW + 24 * HOUR).toISOString();
const station = {
    provider: 'MSQ' as const,
    stationId: '048002B',
    stationName: 'Scarborough Boat Harbour',
    lat: -27.18333,
    lon: 153.1,
    datumId: 'msq:048002B:source-LAT',
    datumLabel: 'Station LAT',
    rawDatum: 'LOWEST ASTRONOMICAL TIDE',
    sourceUrl: 'https://www.data.qld.gov.au/source.csv',
    licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Australian Bureau of Meteorology, supplied by Maritime Safety Queensland, CC BY 4.0',
    maxDistanceKm: 10,
};
const path = 'v1/msq/048002B/' + NOW + '.json';
const manifest = () => ({ schema: 1, generatedAt, expiresAt, stations: [{ ...station, path }] });
const document = (): OfficialTideDocument => {
    const events = Array.from({ length: 63 }, (_, i) => ({
        time: new Date(NOW - 6 * HOUR + i * 6 * HOUR).toISOString(),
        type: i % 2 ? ('High' as const) : ('Low' as const),
        heightM: i % 2 ? 2 : 0.3,
    }));
    return {
        ...station,
        schema: 1,
        generatedAt,
        expiresAt,
        coverageStart: events[0].time,
        coverageEnd: events.at(-1)!.time,
        events,
    };
};
const response = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('official high/low capability and datum contract', () => {
    it('retains station-specific source LAT rather than asserting an unproved epoch', () => {
        expect(validateOfficialManifest(manifest(), NOW)).not.toBeNull();
        expect(validateOfficialDocument(document(), station, generatedAt, NOW)?.datumId).toBe(station.datumId);
        expect(
            validateOfficialManifest({ ...manifest(), stations: [{ ...station, path, datumLabel: 'LAT' }] }, NOW),
        ).toBeNull();
    });
    it('rejects held providers, traversal, duplicate stations and stale capability', () => {
        expect(
            validateOfficialManifest({ ...manifest(), stations: [{ ...station, path, provider: 'CHS' }] }, NOW),
        ).toBeNull();
        expect(
            validateOfficialManifest({ ...manifest(), stations: [{ ...station, path: '../source.json' }] }, NOW),
        ).toBeNull();
        expect(
            validateOfficialManifest(
                { ...manifest(), stations: [manifest().stations[0], manifest().stations[0]] },
                NOW,
            ),
        ).toBeNull();
        expect(validateOfficialManifest(manifest(), NOW + 25 * HOUR)).toBeNull();
        expect(
            validateOfficialManifest({ ...manifest(), generatedAt: new Date(NOW + HOUR).toISOString() }, NOW),
        ).toBeNull();
    });
    it('requires the same generation, station metadata and a complete fourteen-day window', () => {
        expect(validateOfficialDocument({ ...document(), datumId: 'MSL' }, station, generatedAt, NOW)).toBeNull();
        expect(
            validateOfficialDocument({ ...document(), stationName: 'Another station' }, station, generatedAt, NOW),
        ).toBeNull();
        expect(validateOfficialDocument(document(), station, new Date(NOW - HOUR).toISOString(), NOW)).toBeNull();
        expect(
            validateOfficialDocument(
                { ...document(), coverageEnd: new Date(NOW + 13 * 24 * HOUR).toISOString() },
                station,
                generatedAt,
                NOW,
            ),
        ).toBeNull();
        const incomplete = document();
        incomplete.events = incomplete.events.slice(0, 5);
        expect(validateOfficialDocument(incomplete, station, generatedAt, NOW)).toBeNull();
        const duplicate = document();
        duplicate.events[1] = duplicate.events[0];
        expect(validateOfficialDocument(duplicate, station, generatedAt, NOW)).toBeNull();
    });
    it('allows an observed residual only for the identical gauge/datum and fresh exact arithmetic', () => {
        const observation = {
            stationId: station.stationId,
            datumId: station.datumId,
            time: generatedAt,
            observedM: 1.2,
            predictedM: 1,
            residualM: 0.2,
            unvalidated: true,
            sourceUrl: 'https://opendata.tmr.qld.gov.au/gauge.txt',
            predictionSourceUrl: station.sourceUrl,
        };
        expect(validateOfficialObservation(observation, station, NOW)).not.toBeNull();
        for (const changed of [
            { stationId: 'Other' },
            { datumId: 'LAT' },
            { residualM: 1 },
            { time: new Date(NOW - HOUR).toISOString() },
        ]) {
            expect(validateOfficialObservation({ ...observation, ...changed }, station, NOW)).toBeNull();
        }
        const noaa = { ...station, provider: 'NOAA' as const };
        expect(validateOfficialObservation(observation, noaa, NOW)).toBeNull();
    });
});

describe('bounded official table reads', () => {
    it('coalesces parallel callers and never fetches a server-supplied origin', async () => {
        const fetcher = vi.fn(async (url: string | URL | Request) =>
            response(String(url).endsWith('manifest.json') ? manifest() : document()),
        );
        const read = createOfficialTideClient('https://example.supabase.co', fetcher as typeof fetch, () => NOW);
        const results = await Promise.all([read(station.lat, station.lon), read(station.lat, station.lon)]);
        expect(results.every(Boolean)).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(2);
        for (const [url, options] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
            expect(url).toMatch(/^https:\/\/example\.supabase\.co\/storage\/v1\/object\/public\/weather\/tides\//);
            expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
        }
    });
    it('does not advertise a table beyond its station radius or expired generation', async () => {
        let now = NOW;
        const fetcher = vi.fn(async (url: string | URL | Request) =>
            response(String(url).endsWith('manifest.json') ? manifest() : document()),
        );
        const read = createOfficialTideClient('https://example.supabase.co', fetcher as typeof fetch, () => now);
        expect(await read(station.lat + 1, station.lon)).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(await read(station.lat, station.lon)).not.toBeNull();
        now += 25 * HOUR;
        expect(await read(station.lat, station.lon)).toBeNull();
    });
    it('backs off failures and rejects oversized or non-JSON responses', async () => {
        let now = NOW;
        const fetcher = vi.fn(async () => new Response('bad', { headers: { 'Content-Type': 'text/html' } }));
        const read = createOfficialTideClient('https://example.supabase.co', fetcher as typeof fetch, () => now);
        expect(await read(station.lat, station.lon)).toBeNull();
        expect(await read(station.lat, station.lon)).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(1);
        now += 61_000;
        fetcher.mockImplementation(
            async () => new Response('x'.repeat(512_001), { headers: { 'Content-Type': 'application/json' } }),
        );
        expect(await read(station.lat, station.lon)).toBeNull();
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    it('does no network work with unavailable configuration or invalid coordinates', async () => {
        const fetcher = vi.fn();
        expect(await createOfficialTideClient('', fetcher)(station.lat, station.lon)).toBeNull();
        expect(await createOfficialTideClient('https://example.supabase.co', fetcher)(91, 0)).toBeNull();
        expect(fetcher).not.toHaveBeenCalled();
    });
});
