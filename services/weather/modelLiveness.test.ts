/**
 * modelLiveness — is a forecast model publishing at all, judged by VALUES.
 *
 * ACCESS-G is the case that made this necessary: BOM suspended its open-data
 * delivery in June 2025, and since then every request answers HTTP 200 with
 * the wind key present and every value null — at the Whitsundays, the Med, the
 * North Sea, the Caribbean and San Francisco alike. A check that looked at the
 * status code or the keys called it live. These lock the rules: count non-null
 * 10 m wind values, go through the app's Open-Meteo proxy, cache for a day,
 * never block the caller, and never write a network failure down as "dead".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    countNonNullValues,
    ensureModelLiveness,
    isModelLive,
    LIVENESS_CLOCK_SKEW_MS,
    LIVENESS_FAILURE_BACKOFF_MS,
    LIVENESS_PROBE_HOURS,
    LIVENESS_TTL_MS,
    modelLiveness,
    probeModelLiveness,
    resetModelLivenessForTests,
} from './modelLiveness';

const MODEL = 'bom_access_global';
const NOW = Date.parse('2026-10-07T00:00:00Z');

/** Fictional probe points — one per ocean the app is used in. */
const POINTS = {
    med: { lat: 36.0, lon: -5.3 },
    caribbean: { lat: 13.0, lon: -61.2 },
    pacific: { lat: -17.5, lon: -149.6 },
    northSea: { lat: 56.0, lon: 3.0 },
    usWest: { lat: 37.8, lon: -122.6 },
    queensland: { lat: -20.27, lon: 148.72 },
};

type ProxyBody = { operation: string; params: Record<string, string | number> };

function reply(values: (number | null)[], key = 'wind_speed_10m'): Response {
    const time = values.map((_, i) => Math.floor(NOW / 1000) + i * 3600);
    return new Response(JSON.stringify({ hourly: { time, [key]: values } }), { status: 200 });
}

const full = () => Array.from({ length: LIVENESS_PROBE_HOURS }, (_, i) => 8 + (i % 5));
const allNull = () => Array.from({ length: LIVENESS_PROBE_HOURS }, () => null);

function bodies(spy: { mock: { calls: unknown[][] } }): ProxyBody[] {
    return spy.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as ProxyBody);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    localStorage.clear();
    resetModelLivenessForTests();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('countNonNullValues', () => {
    it('counts finite numbers, never keys, nulls, NaN or strings', () => {
        expect(countNonNullValues([1, null, 2, NaN, '3', undefined, 0])).toBe(3);
        expect(countNonNullValues([null, null])).toBe(0);
        expect(countNonNullValues(undefined)).toBe(0);
        expect(countNonNullValues({ wind_speed_10m: [1, 2] })).toBe(0);
    });
});

describe('probeModelLiveness', () => {
    it('asks the Open-Meteo proxy for this model by name and the 10 m wind, nothing else', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(full()));
        await probeModelLiveness(MODEL, POINTS.med);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0][0])).toBe('https://test.supabase.co/functions/v1/proxy-openmeteo');
        const [{ operation, params }] = bodies(fetchSpy);
        expect(operation).toBe('forecast');
        expect(params.models).toBe(MODEL);
        expect(params.hourly).toBe('wind_speed_10m');
        expect(params.forecast_hours).toBe(LIVENESS_PROBE_HOURS);
        expect(params.timeformat).toBe('unixtime');
        expect(params.timezone).toBe('UTC'); // the proxy accepts 'UTC' or an Area/City name, not 'GMT'
        expect(params.latitude).toBe('36.0000');
        expect(params.longitude).toBe('-5.3000');
    });

    it('a 200 with the key present and every value null is DEAD — the ACCESS-G case', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(allNull()));
        const record = await probeModelLiveness(MODEL, POINTS.queensland);
        expect(record).toMatchObject({ model: MODEL, live: false, nonNull: 0, total: LIVENESS_PROBE_HOURS });
        expect(modelLiveness(MODEL)).toBe('dead');
        expect(isModelLive(MODEL)).toBe(false);
    });

    it('a partial sync (a few hours of wind in a day) is not live either', async () => {
        const values: (number | null)[] = allNull();
        for (let i = 0; i < 6; i++) values[i] = 10;
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(values));
        const record = await probeModelLiveness(MODEL, POINTS.northSea);
        expect(record?.nonNull).toBe(6);
        expect(record?.live).toBe(false);
        expect(isModelLive(MODEL)).toBe(false);
    });

    it('real wind for the day is LIVE', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(full()));
        const record = await probeModelLiveness(MODEL, POINTS.caribbean);
        expect(record).toMatchObject({ live: true, nonNull: LIVENESS_PROBE_HOURS, total: LIVENESS_PROBE_HOURS });
        expect(modelLiveness(MODEL)).toBe('live');
    });

    it('reads the model-suffixed key when the proxy answers in the multi-model shape', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(full(), `wind_speed_10m_${MODEL}`));
        expect((await probeModelLiveness(MODEL, POINTS.pacific))?.live).toBe(true);
    });

    it.each(Object.entries(POINTS))('probes wherever it is asked — %s', async (_name, point) => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(full()));
        const record = await probeModelLiveness(MODEL, point);
        expect(record).toMatchObject({ lat: point.lat, lon: point.lon, live: true });
        const [{ params }] = bodies(fetchSpy);
        expect(params.latitude).toBe(point.lat.toFixed(4));
        expect(params.longitude).toBe(point.lon.toFixed(4));
    });

    it('a network failure records nothing: the model stays unknown, not dead', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        expect(await probeModelLiveness(MODEL, POINTS.usWest)).toBeNull();
        expect(modelLiveness(MODEL)).toBe('unknown');
        expect(isModelLive(MODEL)).toBe(false);
    });

    it('an HTTP error records nothing either', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"x"}', { status: 502 }));
        expect(await probeModelLiveness(MODEL, POINTS.usWest)).toBeNull();
        expect(modelLiveness(MODEL)).toBe('unknown');
    });
});

describe('the daily cache', () => {
    it('is unknown before any probe', () => {
        expect(modelLiveness(MODEL)).toBe('unknown');
        expect(isModelLive(MODEL)).toBe(false);
    });

    it('holds a verdict for a day, then lets it lapse to unknown', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(full()));
        await probeModelLiveness(MODEL, POINTS.med);
        vi.setSystemTime(NOW + LIVENESS_TTL_MS - 1);
        expect(modelLiveness(MODEL)).toBe('live');
        vi.setSystemTime(NOW + LIVENESS_TTL_MS + 1);
        expect(modelLiveness(MODEL)).toBe('unknown');
    });

    it('survives an app restart (device storage), and ignores a corrupt entry', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(allNull()));
        await probeModelLiveness(MODEL, POINTS.med);
        resetModelLivenessForTests({ keepStorage: true });
        expect(modelLiveness(MODEL)).toBe('dead');

        localStorage.setItem('thalassa_model_liveness_v1', '{not json');
        resetModelLivenessForTests({ keepStorage: true });
        expect(modelLiveness(MODEL)).toBe('unknown');
    });

    it('a verdict stamped while the clock ran a year fast is no verdict once the clock is right', async () => {
        const YEAR = 365 * 86_400_000;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(allNull()));
        vi.setSystemTime(NOW + YEAR); // the phone's date set a year ahead
        await probeModelLiveness(MODEL, POINTS.caribbean);
        expect(modelLiveness(MODEL)).toBe('dead');

        vi.setSystemTime(NOW); // clock corrected
        expect(modelLiveness(MODEL)).toBe('unknown');
        // ...so the next look probes again instead of trusting it for a year.
        fetchSpy.mockResolvedValue(reply(full()));
        ensureModelLiveness(MODEL, POINTS.caribbean);
        await vi.waitFor(() => expect(modelLiveness(MODEL)).toBe('live'));
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // The same from device storage after a restart.
        vi.setSystemTime(NOW + YEAR);
        fetchSpy.mockResolvedValue(reply(allNull()));
        resetModelLivenessForTests();
        await probeModelLiveness(MODEL, POINTS.med);
        vi.setSystemTime(NOW);
        resetModelLivenessForTests({ keepStorage: true });
        expect(modelLiveness(MODEL)).toBe('unknown');
    });

    it('a few minutes of clock jitter does not void a verdict', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(full()));
        await probeModelLiveness(MODEL, POINTS.northSea);
        vi.setSystemTime(NOW - LIVENESS_CLOCK_SKEW_MS + 1000);
        expect(modelLiveness(MODEL)).toBe('live');
    });

    it('keeps each model to its own verdict', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply(allNull())).mockResolvedValueOnce(reply(full()));
        await probeModelLiveness(MODEL, POINTS.med);
        await probeModelLiveness('gem_seamless', POINTS.med);
        expect(modelLiveness(MODEL)).toBe('dead');
        expect(modelLiveness('gem_seamless')).toBe('live');
    });
});

describe('ensureModelLiveness', () => {
    it('never blocks: it returns at once while the probe is still out', async () => {
        let release: (r: Response) => void = () => {};
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
        expect(ensureModelLiveness(MODEL, POINTS.pacific)).toBeUndefined();
        expect(modelLiveness(MODEL)).toBe('unknown');
        // A second caller while the first probe is out does not start another.
        ensureModelLiveness(MODEL, POINTS.pacific);
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        release(reply(full()));
        await vi.waitFor(() => expect(modelLiveness(MODEL)).toBe('live'));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('does not probe again while today’s verdict stands', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply(allNull()));
        await probeModelLiveness(MODEL, POINTS.med);
        ensureModelLiveness(MODEL, POINTS.med);
        ensureModelLiveness(MODEL, POINTS.caribbean);
        await Promise.resolve();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        vi.setSystemTime(NOW + LIVENESS_TTL_MS + 1);
        ensureModelLiveness(MODEL, POINTS.med);
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    });

    it('after a network failure, waits out the back-off before trying again', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        expect(await probeModelLiveness(MODEL, POINTS.northSea)).toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        vi.setSystemTime(NOW + LIVENESS_FAILURE_BACKOFF_MS - 1);
        ensureModelLiveness(MODEL, POINTS.northSea);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        vi.setSystemTime(NOW + LIVENESS_FAILURE_BACKOFF_MS + 1);
        ensureModelLiveness(MODEL, POINTS.northSea);
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    });
});
