import { describe, expect, it } from 'vitest';
import type { MarineWeatherReport } from '../../types';
import { aromeContext, aromeReport } from './aromeReport';
import { aromePointFixture, AROME_TEST_POINT as point, AROME_TEST_RUN as run } from '../../tests/fixtures/arome142';
import {
    activeRowIsoDate,
    buildSlides,
    resolveHeroRowTemperatureRange,
} from '../../components/dashboard/hero/heroSlideHelpers';

const now = run + 3600_000;
function source() {
    const own = aromePointFixture();
    own.hourly.temperature_2m = Array.from({ length: 49 }, (_, index) => 20 + index / 10);
    own.hourly.pressure_msl = Array(49).fill(1012.345);
    own.hourly.relative_humidity_2m = Array(49).fill(72);
    return own;
}
function base(): MarineWeatherReport {
    const report = aromeContext(point, 'Fictional exact point', 'coastal', now);
    report.modelUsed = 'om:dwd_icon';
    report.current = {
        ...report.current,
        windSpeed: 99,
        windGust: 180,
        condition: 'Rain',
        precipitation: 90,
        cloudCover: 100,
        fogRisk: true,
        cape: 999,
        highTemp: 60,
        lowTemp: -20,
    };
    report.hourly = Array.from({ length: 200 }, (_, index) => ({
        time: new Date(run + index * 3600_000).toISOString(),
        temperature: 50,
        windSpeed: 99,
        windGust: 180,
        waveHeight: 9,
        condition: 'Rain',
    }));
    return report;
}

describe('14206 original AROME Glass adapter', () => {
    it('preserves exact49 UTC hours with no global tail, invented gust/rain/code or receipt-restamped run', () => {
        const b = base(),
            s = source(),
            original = structuredClone({ b, s });
        const report = aromeReport(b, s, point, now)!;
        expect(report.hourly).toHaveLength(49);
        expect(report.hourly[0].time).toBe('2026-10-17T00:00:00.000Z');
        expect(report.hourly.at(-1)?.time).toBe('2026-10-19T00:00:00.000Z');
        expect(report.current.windSpeed).toBe(10);
        expect(report.current.airTemperature).toBe(20.1);
        expect(report.current.pressure).toBe(1012.345);
        expect(report.current.windGust).toBeNull();
        expect(report.current.precipitation).toBeNull();
        expect(report.current.fogRisk).toBeUndefined();
        expect(report.current.cape).toBeNull();
        expect(report.hourly.every((h) => h.windGust === null && h.precipitation === null && h.condition === '')).toBe(
            true,
        );
        expect(report.generatedAt).toBe(b.generatedAt);
        expect(report.forecastRunAt).toBe(s.runUtc);
        expect(report.forecastSampling).toBe('original-regional-sea-cell');
        expect(report.regionalAtmosphere).toMatchObject({
            model: s.model,
            latitude: -20,
            longitude: 166,
            cohortSha256: s.cohortSha256,
            maskSha256: s.maskSha256,
        });
        expect({ b, s }).toEqual(original);
    });

    it('summarises only complete original local calendar days, and never pretends partial-day extrema are complete', () => {
        const report = aromeReport(base(), source(), point, now)!;
        expect(report.forecast.map((day) => day.isoDate)).toEqual(['2026-10-18']);
        expect(report.forecast[0]).toMatchObject({
            highTemp: 23.6,
            lowTemp: 21.3,
            windSpeed: 10,
            windGust: null,
            precipitation: null,
        });
        expect(report.current.highTemp).toBeUndefined(); //17Oct begins midway through the original run's local day.
        expect(report.forecast[0].sunrise).toMatch(/^\d\d:\d\d$/);
        // Exercise the actual Glass resolver too: neither Today nor its hourly
        // cards may borrow tomorrow's complete extrema or invent a daily pair.
        expect(
            resolveHeroRowTemperatureRange(report.current, report.forecast, report.hourly, {
                timeZone: report.timeZone,
                referenceTime: now,
                preferForecast: true,
                allowLeadingPreviousDayFallback: true,
            }),
        ).toEqual({ highTemp: undefined, lowTemp: undefined });
        const todayHours = report.hourly.slice(0, 13);
        const slides = buildSlides(
            { ...report.current, isoDate: '2026-10-17' },
            0,
            todayHours,
            report.forecast,
            report.timeZone,
        );
        expect(slides.every((slide) => slide.data.highTemp === undefined && slide.data.lowTemp === undefined)).toBe(
            true,
        );
        expect(activeRowIsoDate(report.forecast[0], 1, report.timeZone, new Date(now))).toBe('2026-10-18');
    });

    it('keeps native wind/pressure/humidity gaps unknown and refuses temperature gaps instead of using global temperatures', () => {
        const s = source();
        s.hourly.wind_speed_10m[20] = null;
        s.hourly.wind_direction_10m[20] = null;
        s.hourly.pressure_msl[20] = null;
        s.hourly.relative_humidity_2m[20] = null;
        const report = aromeReport(base(), s, point, now)!;
        expect(report.hourly[20]).toMatchObject({ windSpeed: null, pressure: null, humidity: null, windDirection: '' });
        expect(report.forecast[0].windSpeed).toBeNull();
        s.hourly.temperature_2m[20] = null;
        expect(aromeReport(base(), s, point, now)).toBeNull();
    });

    it('retains only explicitly recorded UV/visibility supplements at this exact point/hour', () => {
        const extra = base();
        extra.modelUsed = 'weatherkit';
        extra.current.uvIndex = 0;
        extra.current.visibility = 0;
        extra.hourly[1].uvIndex = 2.5;
        extra.hourly[1].visibility = 9;
        const report = aromeReport(base(), source(), point, now, extra)!;
        expect(report.current).toMatchObject({ uvIndex: 0, visibility: 0, precipitation: null });
        expect(report.hourly[1]).toMatchObject({ uvIndex: 2.5, visibility: 9, windSpeed: 10 });
        expect(report.hourly[2].uvIndex).toBeNull();
        expect(report.regionalAtmosphere?.supplementTag).toBe('weatherkit');
        extra.coordinates = { ...point, lat: point.lat + 0.001 };
        const foreign = aromeReport(base(), source(), point, now, extra)!;
        expect(foreign.current.uvIndex).toBeNull();
        expect(foreign.regionalAtmosphere?.supplementTag).toBeUndefined();
    });

    it('keeps genuine calm with no direction and never revives an expired/foreign/short cohort', () => {
        const s = source();
        s.hourly.wind_speed_10m[1] = 0;
        s.hourly.wind_direction_10m[1] = null;
        expect(aromeReport(base(), s, point, now)?.current).toMatchObject({
            windSpeed: 0,
            windDirection: '',
            windDegree: undefined,
        });
        expect(aromeReport(base(), s, point, run + 18 * 3600_000 + 1)).toBeNull();
        expect(aromeReport(base(), s, { lat: -35, lon: 166 }, now)).toBeNull();
        s.hourly.time.pop();
        expect(aromeReport(base(), s, point, now)).toBeNull();
    });

    it('provides only independent offline context when no global provider is available', () => {
        const context = aromeContext(point, 'Fictional', 'coastal', now);
        expect(context.current.windSpeed).toBeNull();
        expect(context.forecast).toEqual([]);
        expect(context.timeZone).toBe('Pacific/Noumea');
        expect(context.current.sunrise).toMatch(/^\d\d:\d\d$/);
        const report = aromeReport(context, source(), point, now)!;
        expect(report.current.windSpeed).toBe(10);
        expect(report.current.uvIndex).toBeNull();
        expect(report.modelUsed).toBe(`arome:${source().model}`);
    });
});
