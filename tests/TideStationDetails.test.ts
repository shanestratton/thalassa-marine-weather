import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: vi.fn(async () => ({
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-session',
        apikey: 'test-public-key',
    })),
}));
const weather = vi.hoisted(() => vi.fn());
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: weather }));
import {
    __resetTideStationDetailsForTests,
    fetchNearbyTideStations,
    fetchTideStationDetails,
    fetchStationForecastWind,
    normaliseTideStationDetails,
    type TideStation,
} from '../services/tides/stationDetails';

const NOW = Date.parse('2026-09-20T02:00:00Z');
const station: TideStation = {
    id: 'mackay',
    name: 'Mackay',
    lat: -21.1,
    lon: 149.2,
    distance: 0,
    timezone: 'Australia/Brisbane',
};
const point = (timeMs: number, height: number) => ({ dt: timeMs / 1000, date: new Date(timeMs).toISOString(), height });
const raw = () => ({
    status: 200,
    station: 'Mackay Harbour',
    responseLat: -21.11,
    responseLon: 149.21,
    requestDatum: 'LAT',
    responseDatum: 'LAT',
    timezone: 'Australia/Brisbane',
    copyright: 'WorldTides — example authority',
    heights: [point(NOW - 1_800_000, 1.2), point(NOW, 1.3), point(NOW + 1_800_000, 1.4)],
    extremes: [
        { ...point(NOW + 3_600_000, 2), type: 'High' },
        { ...point(NOW + 7 * 3_600_000, 0.5), type: 'Low' },
    ],
});
const fetchMock = vi.fn();
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-public-key');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    weather.mockReset();
    setAuthIdentityScope('one');
    __resetTideStationDetailsForTests();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setAuthIdentityScope(null);
});

describe('station tide predictions', () => {
    it('fetches dense predictions only for the selected station, caches them and preserves original retrieval age', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify(raw())));
        const first = await fetchTideStationDetails(station);
        expect(first?.heights).toHaveLength(3);
        expect(first?.predictionStationName).toBe('Mackay Harbour');
        expect(first?.predictionLocation).toEqual({ lat: -21.11, lon: 149.21 });
        expect(first?.kind).toBe('prediction');
        expect(first?.copyright).toContain('example authority');
        const [url, request] = fetchMock.mock.calls[0];
        expect(url).toBe('https://example.supabase.co/functions/v1/proxy-tides');
        expect(JSON.parse(request.body)).toEqual({
            lat: -21.1,
            lon: 149.2,
            days: 3,
            heights: true,
            stationDistance: 1,
        });
        vi.setSystemTime(NOW + 3_600_000);
        const cached = await fetchTideStationDetails(station);
        expect(cached?.fetchedAtMs).toBe(NOW);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(weather).not.toHaveBeenCalled();
    });

    it('uses the actual response datum, never the requested LAT label', () => {
        expect(normaliseTideStationDetails(station, { ...raw(), responseDatum: 'MSL' })?.datum).toBe('MSL');
        expect(normaliseTideStationDetails(station, { ...raw(), responseDatum: undefined })?.datum).toBeNull();
    });

    it('does not invent a tide curve when an older proxy returns only extrema', () => {
        const details = normaliseTideStationDetails(station, { ...raw(), heights: undefined });
        expect(details?.heights).toEqual([]);
        expect(details?.extremes).toHaveLength(2);
    });

    it('rejects invalid heights, mismatched times, duplicate samples and excessive responses', () => {
        for (const heights of [
            [{ ...point(NOW, 1), height: null }],
            [{ ...point(NOW, 1), date: '2026-09-19T02:00:00Z' }],
            [point(NOW, 1), point(NOW, 2)],
            Array.from({ length: 147 }, (_, i) => point(NOW + i * 1_800_000, 1)),
        ])
            expect(normaliseTideStationDetails(station, { ...raw(), heights })).toBeNull();
    });

    it('retains below-datum heights, accepts zero coordinates and gives an explicit unknown timezone', () => {
        const details = normaliseTideStationDetails(
            { ...station, timezone: undefined },
            {
                ...raw(),
                responseLat: 0,
                responseLon: 0,
                timezone: 'not/a_zone',
                heights: [point(NOW, -0.4)],
            },
        );
        expect(details?.predictionLocation).toEqual({ lat: 0, lon: 0 });
        expect(details?.timezone).toBeNull();
        expect(details?.heights[0].heightM).toBe(-0.4);
    });

    it('does not return another signed-in user’s cached prediction', async () => {
        fetchMock.mockImplementation(async () => new Response(JSON.stringify(raw())));
        await fetchTideStationDetails(station);
        setAuthIdentityScope('two');
        await fetchTideStationDetails(station);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('honours cancellation and does not cache unsuccessful or oversized responses', async () => {
        const abort = new AbortController();
        abort.abort();
        expect(await fetchTideStationDetails(station, { signal: abort.signal })).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        fetchMock.mockImplementation(async () => new Response('{}', { headers: { 'content-length': '999999' } }));
        expect(await fetchTideStationDetails(station)).toBeNull();
        fetchMock.mockImplementation(async () => new Response(JSON.stringify(raw())));
        expect(await fetchTideStationDetails(station)).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('station search', () => {
    it('distinguishes a valid empty area from service failure and preserves station timezone', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, stations: [] })));
        expect(await fetchNearbyTideStations(1, 2)).toEqual([]);
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 502 }));
        expect(await fetchNearbyTideStations(2, 3)).toBeNull();
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 200, stations: [station] })));
        expect(await fetchNearbyTideStations(3, 4)).toEqual([station]);
    });
    it('rejects malformed station coordinates and never requests heights for marker discovery', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ status: 200, stations: [{ ...station, lat: true }] })),
        );
        expect(await fetchNearbyTideStations(1, 2)).toBeNull();
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            lat: 1,
            lon: 2,
            stations: true,
            stationDistance: 100,
        });
        expect(await fetchNearbyTideStations(91, 0)).toBeNull();
        expect(fetchMock).toHaveBeenCalledOnce();
    });
});

describe('optional wind near the station', () => {
    const wind = () => ({
        current_units: { time: 'unixtime', wind_speed_10m: 'kn', wind_direction_10m: '°', wind_gusts_10m: 'kn' },
        current: { time: NOW / 1000, wind_speed_10m: 12, wind_direction_10m: 90, wind_gusts_10m: 15 },
    });
    it('labels modelled wind as forecast, requests knots explicitly and retains valid/retrieval time', async () => {
        weather.mockResolvedValue(wind());
        const result = await fetchStationForecastWind(station);
        expect(result).toMatchObject({
            speedKn: 12,
            directionDeg: 90,
            gustKn: 15,
            kind: 'forecast',
            validTimeMs: NOW,
            fetchedAtMs: NOW,
            model: 'ECMWF IFS',
        });
        expect(weather.mock.calls[0][1]).toMatchObject({
            latitude: station.lat,
            longitude: station.lon,
            wind_speed_unit: 'kn',
            models: 'ecmwf_ifs025',
            timeformat: 'unixtime',
        });
    });
    it('rejects wrong units, stale model times and null speed', async () => {
        weather.mockResolvedValueOnce({
            ...wind(),
            current_units: { ...wind().current_units, wind_speed_10m: 'km/h' },
        });
        expect(await fetchStationForecastWind(station)).toBeNull();
        weather.mockResolvedValueOnce({ ...wind(), current: { ...wind().current, time: NOW / 1000 - 86_400 } });
        expect(await fetchStationForecastWind(station)).toBeNull();
        weather.mockResolvedValueOnce({ ...wind(), current: { ...wind().current, wind_speed_10m: null } });
        expect(await fetchStationForecastWind(station)).toBeNull();
    });
});
