/**
 * Missing marine and weather values reach the Glass as null, never as a
 * confident 0 (Shane, 2026-09-26: "1 - yes" to carrying null through so the
 * existing '--' path fires). The UX referee had measured WAVE '0 m' with a
 * red worsening arrow, PER. '0 s' and 'UV 0' on a Glass whose WIND and GUST
 * cells honestly said '--' for the same missing model.
 *
 * Two rules, pinned here for the StormGlass transformer and the two shared
 * helpers:
 *   1. absent → null / undefined / '' / '--', by field type;
 *   2. a GENUINE 0 the source reported stays 0 (transformersMarineNulls.test
 *      holds the marine half of that; this file holds precipitation and UV).
 *
 * UX scorecard run 6 (F-invented-zeros) extended both rules to the producers
 * 5b098bd8 did not reach: StormGlass wind, gust, temperature, visibility,
 * cloud and humidity; the 06:00/18:00 sun fallbacks; WeatherKit hourly and
 * daily wind and temperatures (both the REST mapper and the native unified
 * converter); the multi-model comparison and its consensus; and the map's
 * tap-to-inspect popup.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => ({ single: vi.fn(), points: vi.fn() }));
const sun = vi.hoisted(() => ({ polar: false }));

vi.mock('../services/weather/openMeteoProxy', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/weather/openMeteoProxy')>()),
    fetchOpenMeteoProxy: proxy.single,
    fetchOpenMeteoPoints: proxy.points,
}));

// Polar day/night is the one case with no sun times; switchable per test.
vi.mock('../utils/math', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/math')>();
    return {
        ...actual,
        getSunTimes: (...args: Parameters<typeof actual.getSunTimes>) =>
            sun.polar ? null : actual.getSunTimes(...args),
    };
});

import { ModelComparisonCard } from '../components/passage/ModelComparisonCard';
import { WeatherInspectPopup } from '../components/map/WeatherInspectPopup';
import { getPrecipitationLabelV2 } from '../services/WeatherFormatter';
import { queryMultiModel } from '../services/weather/MultiModelWeatherService';
import { mapDailyForecast, mapHourlyForecast } from '../services/weather/api/weatherkit';
import { mapToMarineReport, nativeWeatherKitToStandard } from '../services/weather/api/unified';
import { clearPointWeatherCache, fetchPointWeather } from '../services/weather/pointWeather';
import { getCondition, mapStormGlassToReport } from '../services/weather/transformers';
import type { StormGlassHour } from '../types/api';

/** Wind only — the shape of a model that has no UV, precipitation, pressure,
 *  cloud or direction at this point. */
function bareHour(time: string): StormGlassHour {
    return {
        time,
        airTemperature: { sg: 21 },
        windSpeed: { sg: 5 },
        gust: { sg: 7 },
        humidity: { sg: 60 },
        visibility: { sg: 10 },
    } as unknown as StormGlassHour;
}

function hoursFrom(base: Date, n: number, make: (iso: string, i: number) => StormGlassHour) {
    return Array.from({ length: n }, (_, i) => make(new Date(base.getTime() + i * 3600_000).toISOString(), i));
}

const LAT = -27.21;
const LON = 153.1;

describe('StormGlass transformer — absent atmospheric fields stay absent', () => {
    const now = new Date();
    const report = mapStormGlassToReport(
        hoursFrom(now, 48, (iso) => bareHour(iso)),
        LAT,
        LON,
        'Nowhere Bay',
    );

    it('current: UV, precipitation and pressure are null, not 0', () => {
        expect(report.current.uvIndex).toBeNull();
        expect(report.current.precipitation).toBeNull();
        expect(report.current.pressure).toBeNull();
    });

    it('current: no direction means no cardinal, no degree and no swell label', () => {
        expect(report.current.windDirection).toBe('--');
        expect(report.current.windDegree).toBeUndefined();
        expect(report.current.swellDirection).toBeUndefined();
    });

    it('current: no cloud and no precipitation means no condition word', () => {
        expect(report.current.condition).toBe('');
        expect(report.current.precipLabel).toBe('--');
    });

    it('hourly: UV, pressure and precipitation carry null; direction carries --/undefined', () => {
        const h = report.hourly[0];
        expect(h.uvIndex).toBeNull();
        expect(h.pressure).toBeNull();
        expect(h.precipitation).toBeNull();
        expect(h.windDirection).toBe('--');
        expect(h.windDegree).toBeUndefined();
    });

    it('daily: a day with no reported precipitation or pressure has neither, and UV is null', () => {
        const d = report.forecast[0];
        expect(d.precipitation).toBeUndefined();
        expect(d.pressure).toBeUndefined();
        expect(d.uvIndex).toBeNull();
        expect(d.precipLabel).toBe('--');
        // No hour reported cloud cover: no invented 'Sunny'.
        expect(d.condition).toBe('');
        expect(d.cloudCover).toBeUndefined();
    });
});

describe('StormGlass transformer — a reported zero is still a zero', () => {
    const now = new Date();
    const report = mapStormGlassToReport(
        hoursFrom(
            now,
            48,
            (iso) => ({ ...bareHour(iso), precipitation: { sg: 0 }, uvIndex: { sg: 0 } }) as StormGlassHour,
        ),
        LAT,
        LON,
        'Dry Bay',
    );

    it('keeps precipitation 0 and UV 0 when the source said so', () => {
        expect(report.current.precipitation).toBe(0);
        expect(report.current.uvIndex).toBe(0);
        expect(report.forecast[0].precipitation).toBe(0);
        expect(report.forecast[0].uvIndex).toBe(0);
        expect(report.current.precipLabel).toBe('DRY');
    });
});

describe('shared helpers', () => {
    it('getPrecipitationLabelV2 says -- for a missing value and DRY for a reported 0', () => {
        expect(getPrecipitationLabelV2(null, null)).toEqual({ label: '--', value: '--' });
        expect(getPrecipitationLabelV2(null, 0)).toEqual({ label: 'DRY', value: '0.0 mm' });
        expect(getPrecipitationLabelV2(null, 2.3).label).toBe('SHOWERS');
    });

    it('getCondition returns the empty sentinel when it has nothing to go on', () => {
        expect(getCondition(null, null, true)).toBe('');
        expect(getCondition(null, 0, true)).toBe('');
        expect(getCondition(10, null, true)).toBe('Sunny');
        expect(getCondition(10, 0, true)).toBe('Sunny');
        expect(getCondition(null, 6, true)).toBe('Rain');
    });
});

// ── UX scorecard run 6: the producers 5b098bd8 did not reach ─────────────

/** Nothing but a timestamp and a pressure — a partially synced model. */
function emptyHour(time: string): StormGlassHour {
    return { time, pressure: { sg: 1012 } } as unknown as StormGlassHour;
}

describe('StormGlass transformer — absent atmospherics stay absent (run 6)', () => {
    const now = new Date();
    const report = mapStormGlassToReport(
        hoursFrom(now, 48, (iso) => emptyHour(iso)),
        LAT,
        LON,
        'Nowhere Bay',
    );

    it('current: wind, gust, temperature, visibility, cloud, humidity and feels-like are null, not 0', () => {
        const c = report.current;
        expect(c.windSpeed).toBeNull();
        expect(c.windGust).toBeNull();
        expect(c.airTemperature).toBeNull();
        expect(c.visibility).toBeNull();
        expect(c.cloudCover).toBeNull();
        expect(c.humidity).toBeNull();
        expect(c.feelsLike).toBeNull();
        expect(c.cape).toBeNull();
    });

    it('current: no visibility reading raises no fog advisory', () => {
        expect(report.alerts?.some((a) => /FOG|Visibility/i.test(a))).toBe(false);
    });

    it('hourly: wind, gust, temperature, visibility, cloud and humidity are null; no invented tide or feels-like', () => {
        const h = report.hourly[0];
        expect(h.windSpeed).toBeNull();
        expect(h.windGust).toBeNull();
        expect(h.temperature).toBeNull();
        expect(h.visibility).toBeNull();
        expect(h.cloudCover).toBeNull();
        expect(h.humidity).toBeNull();
        expect(h.feelsLike).toBeUndefined();
        expect(h.tideHeight).toBeUndefined();
        expect(h.cape).toBeNull();
    });

    it('daily: a day with no wind, gust, temperature, humidity, visibility or current reports none of them', () => {
        const d = report.forecast[0];
        expect(d.windSpeed).toBeNull();
        expect(d.windGust).toBeNull();
        expect(d.highTemp).toBeNull();
        expect(d.lowTemp).toBeNull();
        expect(d.humidity).toBeUndefined();
        expect(d.visibility).toBeUndefined();
        expect(d.currentDirection).toBeUndefined();
        // The pressure that WAS reported still averages normally.
        expect(d.pressure).toBe(1012);
    });

    it('a reported calm and a reported 0 °C are still readings', () => {
        const calm = mapStormGlassToReport(
            hoursFrom(
                now,
                48,
                (iso) =>
                    ({
                        ...bareHour(iso),
                        windSpeed: { sg: 0 },
                        gust: { sg: 0 },
                        airTemperature: { sg: 0 },
                    }) as StormGlassHour,
            ),
            LAT,
            LON,
            'Flat Bay',
        );
        expect(calm.current.windSpeed).toBe(0);
        expect(calm.current.windGust).toBe(0);
        expect(calm.current.airTemperature).toBe(0);
        expect(calm.hourly[0].temperature).toBe(0);
        expect(calm.forecast[0].windSpeed).toBe(0);
        expect(calm.forecast[0].highTemp).toBe(0);
    });
});

describe('StormGlass transformer — no invented 06:00 / 18:00 (run 6)', () => {
    afterEach(() => {
        sun.polar = false;
    });

    it('with no sun times, sunrise and sunset are absent rather than 06:00 and 18:00', () => {
        sun.polar = true;
        const report = mapStormGlassToReport(
            hoursFrom(new Date(), 48, (iso) => bareHour(iso)),
            89.9,
            0,
            'Pole',
        );
        expect(report.current.sunrise).toBeUndefined();
        expect(report.current.sunset).toBeUndefined();
        expect(report.forecast[0].sunrise).toBeUndefined();
        expect(report.forecast[0].sunset).toBeUndefined();
    });
});

describe('WeatherKit mappers — wind and temperature carry null (run 6)', () => {
    it('hourly: an hour with no wind or temperature is null, and a reported 0 °C is kept', () => {
        const hours = mapHourlyForecast({
            hours: [
                { forecastStart: '2026-09-26T00:00:00Z', conditionCode: 'Clear' },
                { forecastStart: '2026-09-26T01:00:00Z', conditionCode: 'Clear', windSpeed: 18.52, temperature: 0 },
            ],
        });
        expect(hours[0].windSpeed).toBeNull();
        expect(hours[0].windGust).toBeNull();
        expect(hours[0].temperature).toBeNull();
        expect(hours[1].windSpeed).toBe(10);
        expect(hours[1].temperature).toBe(0);
    });

    it('daily: a day with no temperatures or wind is null, not 0° / 0 kt', () => {
        const days = mapDailyForecast(
            {
                days: [
                    { forecastStart: '2026-09-26T00:00:00Z', conditionCode: 'Clear' },
                    {
                        forecastStart: '2026-09-27T00:00:00Z',
                        conditionCode: 'Clear',
                        temperatureMax: 24,
                        temperatureMin: 0,
                        windSpeedMax: 18.52,
                    },
                ],
            },
            'UTC',
        );
        expect(days[0].highTemp).toBeNull();
        expect(days[0].lowTemp).toBeNull();
        expect(days[0].windSpeed).toBeNull();
        expect(days[1].highTemp).toBe(24);
        expect(days[1].lowTemp).toBe(0);
        expect(days[1].windSpeed).toBe(10);
    });

    it('native unified converter: missing hourly and daily wind, temperature and rain chance stay absent', () => {
        const std = nativeWeatherKitToStandard(
            {
                currentWeather: { asOf: '2026-09-26T00:00:00Z' },
                forecastHourly: { hours: [{ forecastStart: '2026-09-26T00:00:00Z' }] },
                forecastDaily: { days: [{ forecastStart: '2026-09-26T00:00:00Z' }] },
            },
            LAT,
            LON,
        );
        expect(std).not.toBeNull();
        const report = mapToMarineReport(std!, LAT, LON, 'Nowhere Bay');
        expect(report.hourly[0].windSpeed).toBeNull();
        expect(report.hourly[0].temperature).toBeNull();
        expect(report.hourly[0].precipChance).toBeUndefined();
        expect(report.forecast[0].windSpeed).toBeNull();
        expect(report.forecast[0].highTemp).toBeNull();
        expect(report.forecast[0].lowTemp).toBeNull();
    });
});

describe('multi-model comparison — null models sit out of the consensus (run 6)', () => {
    const TIMES = ['2026-09-26T00:00', '2026-09-26T01:00'];
    const synced = {
        hourly: {
            time: TIMES,
            wind_speed_10m: [37.04, 37.04],
            wind_direction_10m: [180, 180],
            wind_gusts_10m: [55.56, 55.56],
            pressure_msl: [1012, 1012],
        },
    };
    const partial = {
        hourly: {
            time: TIMES,
            wind_speed_10m: [null, null],
            wind_direction_10m: [null, null],
            wind_gusts_10m: [null, null],
            pressure_msl: [1010, 1010],
        },
    };

    beforeEach(() => {
        proxy.points.mockReset();
    });

    it('a model with no 10 m wind reads null and does not drag the mean toward 0', async () => {
        proxy.points.mockImplementation(async (op: string, pts: unknown[], params: { models: string }) =>
            pts.map(() => (op === 'marine' ? { hourly: {} } : params.models === 'gfs_seamless' ? partial : synced)),
        );
        const result = await queryMultiModel([{ lat: LAT, lon: LON }], ['gfs', 'ecmwf', 'icon'], 2);
        const wp = result!.waypoints[0];
        const gfs = wp.forecasts.find((f) => f.model.id === 'gfs')!;
        expect(gfs.points[0].windSpeed).toBeNull();
        expect(gfs.points[0].windDirection).toBeNull();
        expect(gfs.points[0].windGust).toBeNull();
        // ECMWF and ICON both say 20 kt: the mean is 20, not (0 + 20 + 20) / 3.
        expect(wp.consensus.windSpeedMean).toBe(20);
        expect(wp.consensus.windSpeedSpread).toBe(0);
        expect(wp.consensus.pressureMean).toBe(1011);
    });

    it('one model with wind is not agreement: no spread, and never high confidence', async () => {
        proxy.points.mockImplementation(async (op: string, pts: unknown[], params: { models: string }) =>
            pts.map(() => (op === 'marine' ? { hourly: {} } : params.models === 'ecmwf_ifs025' ? synced : partial)),
        );
        const result = await queryMultiModel([{ lat: LAT, lon: LON }], ['gfs', 'ecmwf'], 2);
        const c = result!.waypoints[0].consensus;
        expect(c.windSpeedMean).toBe(20);
        expect(c.windSpeedSpread).toBeNull();
        expect(c.windDirectionSpread).toBeNull();
        expect(c.confidence).toBe('low');
    });

    it('no model with wind: the consensus is empty, and the card shows -- instead of 0kt', async () => {
        proxy.points.mockImplementation(async (op: string, pts: unknown[]) =>
            pts.map(() => (op === 'marine' ? { hourly: {} } : partial)),
        );
        const result = await queryMultiModel([{ lat: LAT, lon: LON }], ['aifs', 'jma'], 2);
        const c = result!.waypoints[0].consensus;
        expect(c.windSpeedMean).toBeNull();
        expect(c.windDirectionMean).toBeNull();

        render(React.createElement(ModelComparisonCard, { data: result! }));
        expect(screen.queryByText(/^0kt$/)).toBeNull();
        expect(screen.queryByText('±0kt')).toBeNull();
        // Consensus Wind and Dir cells, plus each model's own 24 h cell.
        expect(screen.getAllByText('--').length).toBeGreaterThanOrEqual(4);
    });
});

describe('map inspect popup — missing atmospherics read --, not 0 (run 6)', () => {
    beforeEach(() => {
        proxy.single.mockReset();
        clearPointWeatherCache();
    });

    it('the point service carries null for wind, gust, temperature, humidity and cloud', async () => {
        proxy.single.mockImplementation(async (op: string) =>
            op === 'forecast'
                ? {
                      current: {
                          temperature_2m: null,
                          relative_humidity_2m: null,
                          wind_speed_10m: null,
                          wind_direction_10m: null,
                          wind_gusts_10m: null,
                          pressure_msl: 1012,
                          cloud_cover: null,
                      },
                  }
                : { current: {} },
        );
        const data = await fetchPointWeather(LAT, LON);
        expect(data).toMatchObject({
            windSpeedKmh: null,
            windGustsKmh: null,
            temperatureC: null,
            humidity: null,
            cloudCover: null,
            pressureMsl: 1012,
        });

        const { container } = render(
            React.createElement(WeatherInspectPopup, { data, loading: false, onClose: () => {} }),
        );
        const card = within(container);
        expect(card.queryByText(/^0 kts$/)).toBeNull();
        expect(card.queryByText(/^0°C$/)).toBeNull();
        // Wind, Temp and Gusts each read '--'; the pressure that exists still shows.
        expect(card.getAllByText('--')).toHaveLength(3);
        expect(card.getByText('1012 hPa')).toBeInTheDocument();
    });
});
