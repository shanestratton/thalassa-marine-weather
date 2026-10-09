/**
 * The sounding's data path (build 125, SND): ECMWF IFS 0.25° upper air through
 * the app's one weather backend, the Supabase proxy. Always the named model,
 * never a silent default; split so neither call carries ~40 fields; all-null
 * means "not available" (a model that is not synced answers 200 with nulls);
 * a proxy that does not know the pressure-level names yet (400) means "needs
 * the next server update", and is remembered for the hour so refused taps do
 * not spend quota; a tap past the antimeridian is wrapped before it is sent,
 * so that 400 cannot come from anything else; and a second tap in the same
 * 0.25° cell within the same hour costs nothing. Fictional numbers only, at
 * points round the world.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: vi.fn() }));

import { fetchOpenMeteoProxy } from '../services/weather/openMeteoProxy';
import {
    SOUNDING_LEVELS,
    SOUNDING_MODEL,
    clearSoundingCache,
    fetchSounding,
    parseSounding,
    soundingRequestParams,
} from '../services/weather/sounding/soundingData';
import { validateRequest } from '../supabase/functions/proxy-openmeteo/validation';

const proxy = vi.mocked(fetchOpenMeteoProxy);
const HOUR_MS = 3_600_000;
/** 2026-10-09 06:20 UTC, fixed so cache keys are deterministic. */
const NOW = Date.UTC(2026, 9, 9, 6, 20);

type Params = Record<string, string | number>;

/** A fictional, plausible answer for whichever variables were asked for. */
function answer(params: Params, opts: { nullUpper?: boolean; nullWind?: boolean; nullSurface?: boolean } = {}) {
    const hours = Number(params.forecast_hours);
    const t0 = Math.floor(NOW / HOUR_MS) * 3600;
    const time = Array.from({ length: hours }, (_, i) => t0 + i * 3600);
    const hourly: Record<string, unknown> = { time };
    for (const name of String(params.hourly).split(',')) {
        const m = /^(\w+?)_(\d+)hPa$/.exec(name);
        const upper = !!m;
        const isWind = name.startsWith('wind_');
        const value = (i: number): number | null => {
            if (upper && opts.nullUpper) return null;
            if (!upper && opts.nullSurface) return null;
            if (upper && isWind && opts.nullWind) return null;
            const p = m ? Number(m[2]) : 1013;
            if (name.startsWith('temperature')) return upper ? 26 - (1013 - p) * 0.09 : 26 + Math.sin(i / 4);
            if (name.startsWith('relative_humidity')) return 70 - (1013 - p) * 0.08;
            if (name.startsWith('geopotential_height')) return Math.round(44330 * (1 - (p / 1013) ** 0.19)) - i;
            if (name.startsWith('dew_point')) return 20;
            if (name === 'pressure_msl') return 1013;
            if (name === 'cape') return 300;
            if (name.startsWith('wind_speed')) return 20 + (1013 - p) * 0.1;
            if (name.startsWith('wind_direction')) return 100;
            return 0;
        };
        hourly[name] = time.map((_, i) => value(i));
    }
    return {
        latitude: Number(params.latitude),
        longitude: Number(params.longitude),
        elevation: 0,
        utc_offset_seconds: -10 * 3600,
        timezone: 'Pacific/Honolulu',
        hourly,
    };
}

beforeEach(() => {
    clearSoundingCache();
    proxy.mockReset();
    proxy.mockImplementation(async (_operation, params) => answer(params as Params) as never);
});

afterEach(() => vi.restoreAllMocks());

describe('the requests', () => {
    it('always names ecmwf_ifs025, asks in unixtime from the nearest 0.25° grid point, and splits the fields', () => {
        const calls = soundingRequestParams(-17.53, -149.57); // off Tahiti
        expect(calls).toHaveLength(2);
        const names: string[] = [];
        for (const params of calls) {
            expect(params.models).toBe(SOUNDING_MODEL);
            expect(SOUNDING_MODEL).toBe('ecmwf_ifs025');
            expect(params.timeformat).toBe('unixtime');
            expect(params.timezone).toBe('auto');
            expect(params.cell_selection).toBe('nearest');
            expect(params.latitude).toBe(-17.5);
            expect(params.longitude).toBe(-149.5);
            expect(Number(params.forecast_hours)).toBeGreaterThanOrEqual(73);
            const hourly = String(params.hourly).split(',');
            // The proxy caps an hourly list at 32 names; neither call nears it.
            expect(hourly.length).toBeLessThanOrEqual(32);
            names.push(...hourly);
        }
        // surface_pressure is not a field the wx server serves: pressure_msl is.
        expect(names).not.toContain('surface_pressure');
        expect(names).toEqual(
            expect.arrayContaining([
                'temperature_2m',
                'dew_point_2m',
                'pressure_msl',
                'wind_speed_10m',
                'wind_direction_10m',
                'cape',
            ]),
        );
        for (const p of SOUNDING_LEVELS)
            for (const v of ['temperature', 'relative_humidity', 'geopotential_height', 'wind_speed', 'wind_direction'])
                expect(names).toContain(`${v}_${p}hPa`);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toHaveLength(41);
    });

    it('asks for the seven synced levels, top at 250 hPa', () => {
        expect([...SOUNDING_LEVELS]).toEqual([1000, 925, 850, 700, 500, 300, 250]);
    });

    it('wraps a tap past the antimeridian into −180..180 before it is sent', () => {
        // Panned east of Fiji onto the next world copy, Vava'u (Tonga) arrives as 186°E.
        for (const params of soundingRequestParams(-18.65, 186)) expect(params.longitude).toBe(-174);
        for (const params of soundingRequestParams(-18.65, -534)) expect(params.longitude).toBe(-174);
        // 179.9°E snaps to the grid's 180°, which is −180°: never 180.25°.
        for (const params of soundingRequestParams(-16.5, 179.9)) expect(params.longitude).toBe(-180);
    });

    it('sends what the proxy’s own validator accepts, so a 400 can only mean the allowlist', () => {
        for (const [lat, lon] of [
            [-18.65, 186], // Tonga, from the next world copy
            [-16.5, 179.9], // the antimeridian
            [89.99, 12], // the Arctic, snapped to the pole
            [-77.8, 166.6], // McMurdo Sound
            [13.6, -61.1], // the Grenadines
        ]) {
            for (const params of soundingRequestParams(lat, lon)) {
                expect(validateRequest('forecast', params), `${lat}, ${lon}`).not.toBeNull();
            }
        }
    });
});

describe('fetching', () => {
    it('returns the parsed sounding with times in ms and every level', async () => {
        const result = await fetchSounding(13.6, -61.1, { now: NOW }); // off St Vincent
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.data.lat).toBe(13.5);
        expect(result.data.lon).toBe(-61);
        expect(result.data.times[0]).toBe(Math.floor(NOW / HOUR_MS) * HOUR_MS);
        expect(result.data.utcOffsetSeconds).toBe(-36000);
        expect(result.data.levels.map((l) => l.p)).toEqual([1000, 925, 850, 700, 500, 300, 250]);
        expect(result.data.levels[2].t[0]).toBeCloseTo(26 - 163 * 0.09, 6);
        expect(result.data.surface.cape[0]).toBe(300);
        for (const [operation, params] of proxy.mock.calls) {
            expect(operation).toBe('forecast');
            expect((params as Params).models).toBe('ecmwf_ifs025');
        }
    });

    it('keeps the zone the answer names, so the clock can follow a change inside 72 h', async () => {
        const result = await fetchSounding(21.3, -157.9, { now: NOW });
        expect(result.status === 'ok' && result.data.timezone).toBe('Pacific/Honolulu');
    });

    it("treats a surface with no values at all as 'not available': no hour could be drawn", async () => {
        proxy.mockImplementation(
            async (_operation, params) => answer(params as Params, { nullSurface: true }) as never,
        );
        expect(await fetchSounding(-33.9, 18.4, { now: NOW })).toEqual({ status: 'unavailable' }); // off Cape Town
        // One surface field gone is enough: every hour needs T, Td and the sea-level pressure.
        const thermo = answer(soundingRequestParams(-33.9, 18.4)[0] as Params);
        const wind = answer(soundingRequestParams(-33.9, 18.4)[1] as Params);
        const hourly = thermo.hourly as Record<string, unknown[]>;
        expect(parseSounding(thermo, wind)).not.toBeNull();
        expect(
            parseSounding(
                { ...thermo, hourly: { ...hourly, pressure_msl: hourly.pressure_msl.map(() => null) } },
                wind,
            ),
        ).toBeNull();
    });

    it("treats an all-null answer as 'not available', counting values, not keys", async () => {
        proxy.mockImplementation(async (_operation, params) => answer(params as Params, { nullUpper: true }) as never);
        const result = await fetchSounding(50.1, -5.5, { now: NOW }); // western Channel
        expect(result).toEqual({ status: 'unavailable' });
    });

    it('keeps a partial sync (temperatures without winds) and leaves the winds empty', async () => {
        proxy.mockImplementation(async (_operation, params) => answer(params as Params, { nullWind: true }) as never);
        const result = await fetchSounding(43.3, 5.3, { now: NOW }); // off Marseille
        expect(result.status).toBe('ok');
        if (result.status !== 'ok') return;
        expect(result.data.levels.every((l) => l.windKmh.every((v) => v === null))).toBe(true);
        expect(result.data.levels.every((l) => l.t.every((v) => v !== null))).toBe(true);
    });

    it('says the server needs updating when the proxy rejects the pressure-level names (400)', async () => {
        proxy.mockRejectedValue(new Error('Weather service request failed (400)'));
        expect(await fetchSounding(36.8, -75.9, { now: NOW })).toEqual({ status: 'needs-update' });
    });

    it('remembers that for the hour, so refused taps spend no more quota', async () => {
        proxy.mockRejectedValue(new Error('Weather service request failed (400)'));
        await fetchSounding(36.8, -75.9, { now: NOW });
        expect(proxy).toHaveBeenCalledTimes(2);
        // Another tap, another place, the same hour: no request at all.
        expect(await fetchSounding(-8.5, 115.3, { now: NOW + 20 * 60_000 })).toEqual({ status: 'needs-update' });
        expect(proxy).toHaveBeenCalledTimes(2);
        // An hour on, it asks again (the allowlist may have been deployed meanwhile).
        proxy.mockImplementation(async (_operation, params) => answer(params as Params) as never);
        expect((await fetchSounding(-8.5, 115.3, { now: NOW + 61 * 60_000 })).status).toBe('ok');
        expect(proxy).toHaveBeenCalledTimes(4);
    });

    it('refuses a position off the globe without asking, as an error rather than a server update', async () => {
        expect((await fetchSounding(91, 10, { now: NOW })).status).toBe('error');
        expect((await fetchSounding(Number.NaN, 10, { now: NOW })).status).toBe('error');
        expect(proxy).not.toHaveBeenCalled();
    });

    it('reports any other failure as an error the sheet can retry', async () => {
        proxy.mockRejectedValue(new Error('Weather service request failed (502)'));
        const result = await fetchSounding(36.8, -75.9, { now: NOW });
        expect(result.status).toBe('error');
    });
});

describe('caching', () => {
    it('makes no request for a second tap in the same 0.25° cell within the hour', async () => {
        await fetchSounding(-33.86, 151.3, { now: NOW });
        expect(proxy).toHaveBeenCalledTimes(2);
        await fetchSounding(-33.86, 151.3, { now: NOW + 10 * 60_000 });
        await fetchSounding(-33.8, 151.24, { now: NOW + 20 * 60_000 }); // same grid point, 33.75°S 151.25°E
        expect(proxy).toHaveBeenCalledTimes(2);
    });

    it('shares one request between two taps made while it is still in flight', async () => {
        await Promise.all([fetchSounding(57.1, -2.0, { now: NOW }), fetchSounding(57.1, -2.0, { now: NOW })]);
        expect(proxy).toHaveBeenCalledTimes(2);
    });

    it('treats 186°E and 174°W as the same place', async () => {
        await fetchSounding(-18.65, 186, { now: NOW });
        await fetchSounding(-18.65, -174, { now: NOW });
        expect(proxy).toHaveBeenCalledTimes(2);
        expect((proxy.mock.calls[0][1] as Params).longitude).toBe(-174);
    });

    it('asks again for another cell, and again once the hour turns', async () => {
        await fetchSounding(25.0, -77.4, { now: NOW });
        await fetchSounding(25.5, -77.4, { now: NOW });
        expect(proxy).toHaveBeenCalledTimes(4);
        await fetchSounding(25.0, -77.4, { now: NOW + HOUR_MS });
        expect(proxy).toHaveBeenCalledTimes(6);
    });

    it('never caches a failure, so the next tap retries', async () => {
        proxy.mockRejectedValueOnce(new Error('Weather service request failed (502)'));
        await fetchSounding(1.3, 103.9, { now: NOW });
        const again = await fetchSounding(1.3, 103.9, { now: NOW });
        expect(again.status).toBe('ok');
    });
});
