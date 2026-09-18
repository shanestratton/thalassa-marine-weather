/**
 * routeForecastSampler — the forecast she will SAIL INTO.
 *
 * Shane 2026-09-17: "all of the wind and rain etc should alter as the yacht
 * progresses along the route." The number that matters is the wind at the
 * place she will be, at the time she will be there.
 *
 * What would mislead a skipper: a forecast from a model other than the one
 * named; the last hour of the series held as though it reached further; a gust
 * borrowed for a model that publishes none; a wind backing through north
 * averaged into a southerly; an HTTP 200 of nulls shown as calm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => ({
    calls: [] as { points: { lat: number; lon: number }[]; params: Record<string, unknown> }[],
    reply: null as null | ((points: { lat: number; lon: number }[]) => unknown[] | Promise<unknown[]>),
}));
vi.mock('../services/weather/openMeteoProxy', () => ({
    fetchOpenMeteoPoints: async (
        _op: string,
        points: { lat: number; lon: number }[],
        params: Record<string, unknown>,
    ) => {
        proxy.calls.push({ points, params });
        if (!proxy.reply) throw new Error('offline');
        return proxy.reply(points);
    },
}));

import {
    FORECAST_HOURS,
    FORECAST_TTL_MS,
    MAX_STATIONS,
    __clearRouteForecastCacheForTests,
    estimateApparentWind,
    loadRouteForecast,
    parseRouteForecast,
    peekRouteForecast,
    routeForecastKey,
    routeStations,
    sampleRouteForecast,
    type RouteForecast,
} from '../services/routeForecastSampler';
import { routeLengthNm } from '../services/routeProgress';

const T0 = Date.UTC(2026, 8, 18, 0, 0, 0);
const HOUR = 3_600_000;

/** 120 NM due north up 153°E. */
const ROUTE = [
    { lat: -28, lon: 153 },
    { lat: -26, lon: 153 },
];

type HourValues = {
    speed?: number | null;
    dir?: number | null;
    gust?: number | null;
    rain?: number | null;
    prob?: number | null;
};
const hourly = (n: number, at: (h: number) => HourValues) => {
    const out: Record<string, (number | null)[]> = {
        time: [],
        wind_speed_10m: [],
        wind_direction_10m: [],
        wind_gusts_10m: [],
        precipitation: [],
        precipitation_probability: [],
    };
    for (let h = 0; h < n; h++) {
        const v = at(h);
        out.time.push((T0 + h * HOUR) / 1000);
        out.wind_speed_10m.push(v.speed ?? null);
        out.wind_direction_10m.push(v.dir ?? null);
        out.wind_gusts_10m.push(v.gust ?? null);
        out.precipitation.push(v.rain ?? null);
        out.precipitation_probability.push(v.prob ?? null);
    }
    return { hourly: out };
};

/** Two stations, 0 and 100 NM: 10 kn at the start, 30 kn at the end, rising 1 kn an hour. */
const twoStation = (): RouteForecast =>
    parseRouteForecast(
        [
            { alongNm: 0, lat: -28, lon: 153 },
            { alongNm: 100, lat: -26.3, lon: 153 },
        ],
        [
            hourly(6, (h) => ({ speed: 10 + h, dir: 90, gust: 15 + h, rain: h, prob: 10 * h })),
            hourly(6, (h) => ({ speed: 30 + h, dir: 90, gust: 40 + h, rain: 0, prob: 0 })),
        ],
        'ecmwf_ifs025',
        100,
        T0,
    );

beforeEach(() => {
    __clearRouteForecastCacheForTests();
    proxy.calls.length = 0;
    proxy.reply = null;
});
afterEach(() => vi.useRealTimers());

describe('stations along the route', () => {
    it('cover the whole route, both ends included, no closer than a model grid cell', () => {
        const stations = routeStations(ROUTE);
        const total = routeLengthNm(ROUTE);
        expect(stations[0].alongNm).toBe(0);
        expect(stations[stations.length - 1].alongNm).toBeCloseTo(total, 6);
        expect(stations[0].lat).toBeCloseTo(-28, 6);
        expect(stations[stations.length - 1].lat).toBeCloseTo(-26, 6);
        const spacing = stations[1].alongNm - stations[0].alongNm;
        expect(spacing).toBeGreaterThanOrEqual(10);
    });

    it('never asks for more than one request can carry, however long the passage', () => {
        const long = [
            { lat: -27, lon: 153 },
            { lat: -22, lon: 166 },
        ];
        expect(routeStations(long).length).toBe(MAX_STATIONS);
        expect(MAX_STATIONS).toBeLessThanOrEqual(50);
    });

    it('a short hop still gets both ends', () => {
        const hop = [
            { lat: -27.2, lon: 153.1 },
            { lat: -27.15, lon: 153.12 },
        ];
        expect(routeStations(hop)).toHaveLength(2);
    });

    it('is no route at all when every point is the same point', () => {
        expect(
            routeStations([
                { lat: -27, lon: 153 },
                { lat: -27, lon: 153 },
            ]),
        ).toEqual([]);
    });
});

describe('the place AND the moment', () => {
    it('half way between two stations, half way between two hours', () => {
        const s = sampleRouteForecast(twoStation(), 50, T0 + 1.5 * HOUR);
        // station 0 at +1.5 h = 11.5, station 1 = 31.5 → 21.5 half way along
        expect(s.twsKts).toBeCloseTo(21.5, 6);
        expect(s.gustKts).toBeCloseTo(29, 6);
        expect(s.twdDeg).toBeCloseTo(90, 6);
        expect(s.beyond).toBe(false);
    });

    it('the wind changes as she moves along the route, at one and the same moment', () => {
        const fc = twoStation();
        const at = T0 + 2 * HOUR;
        expect(sampleRouteForecast(fc, 0, at).twsKts).toBeCloseTo(12, 6);
        expect(sampleRouteForecast(fc, 25, at).twsKts).toBeCloseTo(17, 6);
        expect(sampleRouteForecast(fc, 100, at).twsKts).toBeCloseTo(32, 6);
    });

    it('a wind backing through north is averaged round north, not through south', () => {
        const fc = parseRouteForecast(
            [
                { alongNm: 0, lat: -28, lon: 153 },
                { alongNm: 100, lat: -26.3, lon: 153 },
            ],
            [hourly(3, () => ({ speed: 20, dir: 350 })), hourly(3, () => ({ speed: 20, dir: 10 }))],
            'dwd_icon',
            100,
            T0,
        );
        const s = sampleRouteForecast(fc, 50, T0 + HOUR);
        expect(s.twdDeg === null ? NaN : Math.min(s.twdDeg, 360 - s.twdDeg)).toBeLessThan(0.001);
        // and the SPEED is 20, not the 19.7 a u/v average would hand back
        expect(s.twsKts).toBeCloseTo(20, 6);
    });

    it('rain is the hour she is IN, not two hours smeared together', () => {
        // precipitation is stamped on the hour it ENDS: 00:30 belongs to the 01:00 value
        const s = sampleRouteForecast(twoStation(), 0, T0 + 0.5 * HOUR);
        expect(s.precipMm).toBe(1);
        expect(s.precipProb).toBe(10);
    });
});

describe('it does not pretend past the end of the forecast', () => {
    it('beyond the last hour is NULLS and says so — never the last hour held', () => {
        const s = sampleRouteForecast(twoStation(), 50, T0 + 9 * HOUR);
        expect(s).toEqual({
            twsKts: null,
            twdDeg: null,
            gustKts: null,
            precipMm: null,
            precipProb: null,
            beyond: true,
        });
    });

    it('does not hold the last hour for an hour and a half either: half an hour is "the nearest hour", no more', () => {
        // the series ends at T0 + 5 h
        expect(sampleRouteForecast(twoStation(), 50, T0 + 5 * HOUR + 29 * 60_000).twsKts).not.toBeNull();
        const past = sampleRouteForecast(twoStation(), 50, T0 + 5 * HOUR + 31 * 60_000);
        expect(past.twsKts).toBeNull();
        expect(past.beyond).toBe(true);
    });

    it('a model that RUNS OUT before the axis does is past its forecast — the service pads with nulls, it does not shorten', () => {
        // What Open-Meteo really sends for a model whose run ends early: every
        // timestamp that was asked for, and nulls after the model's last hour.
        const fc = parseRouteForecast(
            [
                { alongNm: 0, lat: -28, lon: 153 },
                { alongNm: 100, lat: -26.3, lon: 153 },
            ],
            [
                hourly(12, (h) => (h <= 6 ? { speed: 15, dir: 100, gust: 22 } : {})),
                hourly(12, (h) => (h <= 6 ? { speed: 17, dir: 100, gust: 24 } : {})),
            ],
            'ukmo_global_deterministic_10km',
            100,
            T0,
        );
        expect(sampleRouteForecast(fc, 50, T0 + 6 * HOUR).twsKts).toBeCloseTo(16, 6);
        const past = sampleRouteForecast(fc, 50, T0 + 9 * HOUR);
        expect(past.twsKts).toBeNull();
        // The words, not just the dashes: the timestamps run on to hour 11.
        expect(past.beyond).toBe(true);
    });

    it('a hole in the MIDDLE of a run is a dash, but it is not the end of the forecast', () => {
        const fc = parseRouteForecast(
            [
                { alongNm: 0, lat: -28, lon: 153 },
                { alongNm: 100, lat: -26.3, lon: 153 },
            ],
            [
                hourly(8, (h) => (h === 3 || h === 4 ? {} : { speed: 15, dir: 100 })),
                hourly(8, (h) => (h === 3 || h === 4 ? {} : { speed: 15, dir: 100 })),
            ],
            'dwd_icon',
            100,
            T0,
        );
        const hole = sampleRouteForecast(fc, 50, T0 + 3.5 * HOUR);
        expect(hole.twsKts).toBeNull();
        expect(hole.beyond).toBe(false);
    });

    it('a model that publishes no gust gives a null gust, with the wind still there', () => {
        const fc = parseRouteForecast(
            [
                { alongNm: 0, lat: -28, lon: 153 },
                { alongNm: 100, lat: -26.3, lon: 153 },
            ],
            [hourly(3, () => ({ speed: 14, dir: 120 })), hourly(3, () => ({ speed: 16, dir: 120 }))],
            'jma_gsm',
            100,
            T0,
        );
        const s = sampleRouteForecast(fc, 50, T0 + HOUR);
        expect(s.twsKts).toBeCloseTo(15, 6);
        expect(s.gustKts).toBeNull();
    });

    it('HTTP 200 with every wind null is a model that is not there — not a calm', () => {
        expect(() =>
            parseRouteForecast(
                [
                    { alongNm: 0, lat: -28, lon: 153 },
                    { alongNm: 100, lat: -26.3, lon: 153 },
                ],
                [hourly(4, () => ({ gust: 22 })), hourly(4, () => ({ gust: 25 }))],
                'ncep_gfs025',
                100,
                T0,
            ),
        ).toThrow(/no wind/);
    });

    it('refuses a reply that does not line up with the stations it asked about', () => {
        expect(() =>
            parseRouteForecast(
                [
                    { alongNm: 0, lat: -28, lon: 153 },
                    { alongNm: 100, lat: -26.3, lon: 153 },
                ],
                [hourly(4, () => ({ speed: 10, dir: 90 }))],
                'dwd_icon',
                100,
                T0,
            ),
        ).toThrow(/misaligned/);
    });

    it('reads a series the provider has suffixed with the model id', () => {
        const reply = hourly(3, () => ({ speed: 18, dir: 200 }));
        const h = reply.hourly as Record<string, unknown>;
        h.wind_speed_10m_dwd_icon = h.wind_speed_10m;
        h.wind_direction_10m_dwd_icon = h.wind_direction_10m;
        delete h.wind_speed_10m;
        delete h.wind_direction_10m;
        const fc = parseRouteForecast(
            [
                { alongNm: 0, lat: -28, lon: 153 },
                { alongNm: 100, lat: -26.3, lon: 153 },
            ],
            [reply, reply],
            'dwd_icon',
            100,
            T0,
        );
        expect(sampleRouteForecast(fc, 10, T0 + HOUR).twsKts).toBeCloseTo(18, 6);
    });
});

describe('one request per route and model', () => {
    const good = (points: { lat: number; lon: number }[]) =>
        points.map(() =>
            hourly(FORECAST_HOURS, (h) => ({ speed: 12 + (h % 5), dir: 140, gust: 20, rain: 0, prob: 5 })),
        );

    it('asks for enough hours that the far end of seven days always has an hour either side of it', () => {
        // The series starts at the FLOORED hour: at xx:59, now + 168 h is 168.98 h in.
        expect(FORECAST_HOURS - 1).toBeGreaterThanOrEqual(169);
    });

    it('names the model, asks in knots, seven days and a bracket, for every station at once', async () => {
        proxy.reply = good;
        const fc = await loadRouteForecast(ROUTE, 'ecmwf_ifs025');
        expect(fc?.model).toBe('ecmwf_ifs025');
        expect(proxy.calls).toHaveLength(1);
        expect(proxy.calls[0].params).toMatchObject({
            models: 'ecmwf_ifs025',
            wind_speed_unit: 'kn',
            timeformat: 'unixtime',
            forecast_hours: 170,
        });
        expect(String(proxy.calls[0].params.hourly)).toContain('precipitation_probability');
        expect(proxy.calls[0].points.length).toBe(routeStations(ROUTE).length);
    });

    it('two askers at once share one request, and the answer is kept', async () => {
        proxy.reply = good;
        const [a, b] = await Promise.all([loadRouteForecast(ROUTE, 'dwd_icon'), loadRouteForecast(ROUTE, 'dwd_icon')]);
        expect(a).toBe(b);
        await loadRouteForecast(ROUTE, 'dwd_icon');
        expect(proxy.calls).toHaveLength(1);
        expect(peekRouteForecast(ROUTE, 'dwd_icon')).toBe(a);
    });

    it('another model is another forecast — never the first one under a new name', async () => {
        proxy.reply = good;
        const a = await loadRouteForecast(ROUTE, 'dwd_icon');
        const b = await loadRouteForecast(ROUTE, 'ukmo_global_deterministic_10km');
        expect(proxy.calls).toHaveLength(2);
        expect(b?.model).toBe('ukmo_global_deterministic_10km');
        expect(a).not.toBe(b);
        expect(routeForecastKey(ROUTE, 'dwd_icon')).not.toBe(routeForecastKey(ROUTE, 'jma_gsm'));
    });

    it('goes stale after an hour and asks again', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        proxy.reply = good;
        await loadRouteForecast(ROUTE, 'dwd_icon');
        vi.setSystemTime(T0 + FORECAST_TTL_MS + 1);
        expect(peekRouteForecast(ROUTE, 'dwd_icon')).toBeNull();
        await loadRouteForecast(ROUTE, 'dwd_icon');
        expect(proxy.calls).toHaveLength(2);
    });

    it('offline is null, not a throw — and it does not hammer the service', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        expect(await loadRouteForecast(ROUTE, 'dwd_icon')).toBeNull();
        expect(await loadRouteForecast(ROUTE, 'dwd_icon')).toBeNull();
        expect(proxy.calls).toHaveLength(1);
        vi.setSystemTime(T0 + 61_000);
        proxy.reply = good;
        expect((await loadRouteForecast(ROUTE, 'dwd_icon'))?.model).toBe('dwd_icon');
        expect(proxy.calls).toHaveLength(2);
    });
});

describe('apparent wind, estimated', () => {
    it('dead ahead adds her own speed; dead astern takes it away', () => {
        expect(estimateApparentWind(15, 0, 6, 0)).toEqual({ awsKts: 21, awaDeg: 0 });
        const astern = estimateApparentWind(15, 180, 6, 0)!;
        expect(astern.awsKts).toBeCloseTo(9, 6);
        expect(Math.abs(astern.awaDeg)).toBeCloseTo(180, 6);
    });

    it('a beam wind draws forward, to the side it blows from', () => {
        const stbd = estimateApparentWind(12, 90, 6, 0)!;
        expect(stbd.awsKts).toBeCloseTo(Math.hypot(12, 6), 6);
        expect(stbd.awaDeg).toBeCloseTo(63.435, 2);
        const port = estimateApparentWind(12, 270, 6, 0)!;
        expect(port.awaDeg).toBeCloseTo(-63.435, 2);
    });

    it('works across north, on any course', () => {
        // Course 350, wind from 020: 30° on the starboard bow.
        const a = estimateApparentWind(10, 20, 5, 350)!;
        expect(a.awaDeg).toBeGreaterThan(0);
        expect(a.awaDeg).toBeLessThan(30);
    });

    it('is nothing at all without a forecast to work from', () => {
        expect(estimateApparentWind(null, 90, 6, 0)).toBeNull();
        expect(estimateApparentWind(12, null, 6, 0)).toBeNull();
    });
});
