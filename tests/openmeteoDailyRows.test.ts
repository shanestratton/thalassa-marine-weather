/**
 * Open-Meteo forecast rows: the location's own date and sun (build 123, W1-06).
 *
 * `daily.time` is the location's calendar date ('2026-10-07'). Two phone-clock
 * bugs read it on the phone's clock instead:
 *  - the day and date labels parsed it as UTC midnight and formatted it in
 *    the phone's zone, so a phone west of Greenwich named every row a day
 *    early ('Tuesday, Oct 6' on the 7 Oct row);
 *  - sunrise/sunset were computed from the phone's "date + T12:00:00" noon,
 *    which on a Brisbane phone is 6 Oct in Juneau (07:14 / 18:19 instead of
 *    the 7th's USNO 07:16 / 18:14).
 * CI runs in UTC, where neither shows, so the phone zone is switched here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import SunCalc from 'suncalc';

const payload = {
    timezone: 'America/Juneau',
    utc_offset_seconds: -8 * 3600,
    current: {
        temperature_2m: 9,
        relative_humidity_2m: 80,
        apparent_temperature: 7,
        is_day: 1,
        precipitation: 0,
        rain: 0,
        showers: 0,
        snowfall: 0,
        weather_code: 3,
        cloud_cover: 90,
        pressure_msl: 1012,
        surface_pressure: 1011,
        wind_speed_10m: 20,
        wind_direction_10m: 140,
        wind_gusts_10m: 30,
    },
    hourly: { time: [] as string[] },
    daily: {
        time: ['2026-10-07', '2026-10-08'],
        weather_code: [3, 61],
        temperature_2m_max: [11, 10],
        temperature_2m_min: [6, 5],
        sunrise: [],
        sunset: [],
        uv_index_max: [1, 1],
        precipitation_sum: [0, 4],
        precipitation_hours: [0, 6],
        wind_speed_10m_max: [25, 30],
        wind_gusts_10m_max: [40, 45],
        wind_direction_10m_dominant: [140, 150],
    },
};

vi.mock('@capacitor/core', () => ({ CapacitorHttp: {}, Capacitor: { isNativePlatform: () => false } }));
vi.mock('../services/PiCacheService', () => ({ piCache: { fetch: vi.fn(async () => ({ data: payload })) } }));
vi.mock('../services/weather/wxPublished', () => ({ fetchPublishedForecast: vi.fn(async () => null) }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: vi.fn(async () => payload) }));
vi.mock('../services/weather/marineProximity', () => ({ checkMarineProximity: vi.fn(async () => null) }));
vi.mock('../services/weather/api/tides', () => ({ fetchRealTides: vi.fn(async () => null) }));
vi.mock('../services/weather/api/geocoding', () => ({ reverseGeocodeContext: vi.fn(async () => null) }));

import { fetchOpenMeteo } from '../services/weather/api/openmeteo';

/** Node re-reads process.env.TZ when it is assigned. */
const restore = process.env.TZ;
afterEach(() => {
    if (restore === undefined) delete process.env.TZ;
    else process.env.TZ = restore;
    vi.useRealTimers();
});

const clockIn = (d: Date) =>
    d.toLocaleTimeString('en-GB', { timeZone: 'America/Juneau', hour: '2-digit', minute: '2-digit', hour12: false });

describe('Open-Meteo forecast rows on the location’s own date', () => {
    // A distinct lat/lon per phone zone: fetchOpenMeteo memoises by position.
    const phones = [
        { tz: 'America/Los_Angeles', lon: -134.42 },
        { tz: 'Australia/Brisbane', lon: -134.421 },
        { tz: 'UTC', lon: -134.422 },
    ];
    for (const phone of phones) {
        it(`Juneau’s 7 Oct row is Wednesday 7 Oct with the 7th’s sun, on a ${phone.tz} phone`, async () => {
            process.env.TZ = phone.tz;
            vi.useFakeTimers({ now: new Date('2026-10-07T20:00:00Z'), toFake: ['Date'] });
            const report = await fetchOpenMeteo(58.3, phone.lon, 'Juneau', false, 'best_match');
            const [first, second] = report.forecast;
            expect(first.isoDate).toBe('2026-10-07');
            expect(first.day).toBe('Wednesday');
            expect(first.date).toBe('Oct 7');
            expect(second.day).toBe('Thursday');
            expect(second.date).toBe('Oct 8');
            // SunCalc anchored at Juneau's own noon on the 7th (USNO 7 Oct,
            // tz=-8: rise 07:16, set 18:14).
            const direct = SunCalc.getTimes(new Date('2026-10-07T12:00:00-08:00'), 58.3, phone.lon);
            expect(first.sunrise).toBe(clockIn(direct.sunrise));
            expect(first.sunset).toBe(clockIn(direct.sunset));
        });
    }
});
