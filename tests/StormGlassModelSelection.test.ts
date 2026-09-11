import { describe, expect, it } from 'vitest';
import { blendOffshoreForecast, mapStormGlassToReport } from '../services/weather/transformers';
import type { StormGlassHour } from '../types';

function hours(extra: Record<string, unknown> = {}): StormGlassHour[] {
    return Array.from(
        { length: 3 },
        (_, i) =>
            ({
                time: new Date(Date.now() + i * 3_600_000).toISOString(),
                windSpeed: { sg: 11, ecmwf: 3, noaa: 7, icon: 20 },
                gust: { sg: 15, ecmwf: 5, noaa: 9, icon: 25 },
                windDirection: { sg: 270, ecmwf: 90, noaa: 180, icon: 0 },
                airTemperature: { sg: 26, ecmwf: 19, noaa: 23, icon: 30 },
                pressure: { sg: 1005, ecmwf: 1018, noaa: 1010, icon: 999 },
                humidity: { sg: 60 },
                cloudCover: { sg: 30 },
                precipitation: { sg: 0 },
                waveHeight: { sg: 2, ecmwf: 1, noaa: 1.5 },
                wavePeriod: { sg: 8 },
                ...extra,
            }) as StormGlassHour,
    );
}
function report(model: string, rows = hours()) {
    return mapStormGlassToReport(rows, -24, 153, 'Ocean point', undefined, [], [], model, [], 'offshore');
}

describe('StormGlass selected-source forecasts', () => {
    it.each([
        ['ecmwf', 3, 19, 'E'],
        ['gfs', 7, 23, 'S'],
        ['sg', 11, 26, 'W'],
    ] as const)(
        '%s governs current, hourly and daily data, not whichever provider has the highest wind',
        (model, speed, temp, direction) => {
            const data = report(model);
            expect(data.current.windSpeed).toBeCloseTo(speed * 1.94384, 1);
            expect(data.current.airTemperature).toBe(temp);
            expect(data.current.windDirection).toBe(direction);
            for (const h of data.hourly) {
                expect(h.windSpeed).toBeCloseTo(speed * 1.94384, 1);
                expect(h.temperature).toBe(temp);
                expect(h.windDirection).toBe(direction);
            }
            for (const d of data.forecast) {
                expect(d.windSpeed).toBeCloseTo(speed * 1.94384, 1);
                expect(d.highTemp).toBe(temp);
                expect(d.lowTemp).toBe(temp);
            }
            expect(data.modelUsed).toContain(`stormglass_${model}`);
        },
    );
    it('preserves selected calm/zero values instead of taking a stronger fallback', () => {
        const data = report('ecmwf', hours({ windSpeed: { ecmwf: 0, sg: 20 }, gust: { ecmwf: 0, sg: 25 } }));
        expect(data.current.windSpeed).toBe(0);
        expect(data.current.windGust).toBe(0);
        expect(data.hourly.every((h) => h.windSpeed === 0 && h.windGust === 0)).toBe(true);
        expect(data.forecast.every((d) => d.windSpeed === 0 && d.windGust === 0)).toBe(true);
    });
    it('rejects invalid selected numbers and labels the real SG fallback', () => {
        const data = report(
            'ecmwf',
            hours({ windSpeed: { ecmwf: Number.NaN, sg: 4 }, pressure: { ecmwf: Infinity, sg: 1012 } }),
        );
        expect(data.current.windSpeed).toBeCloseTo(4 * 1.94384, 1);
        expect(data.current.pressure).toBe(1012);
        expect(data.current.sources?.windSpeed?.sourceName).toBe('StormGlass · SG');
        expect(data.modelUsed).toContain('fallback:sg');
    });
    it('uses NOAA keys for the persisted GFS selection and marks hybrid fields honestly', () => {
        const data = report('gfs');
        expect(data.current.sources?.windSpeed?.sourceName).toBe('StormGlass · NOAA');
        expect(data.current.sources?.humidity?.sourceName).toBe('StormGlass · SG');
        expect(data.modelUsed).toContain('fallback:sg');
    });
    it('does not dilute a supplied daily pressure/temperature with absent hours', () => {
        const rows = hours();
        rows[1].pressure = undefined;
        rows[1].airTemperature = undefined;
        const data = report('ecmwf', rows);
        expect(data.forecast[0].pressure).toBe(1018);
        expect(data.forecast[0].lowTemp).toBe(19);
    });
});

describe('offshore report supplementation', () => {
    it('only overlays provided fields; zero precipitation wins while missing humidity/UV use real fallback', () => {
        const rows = hours({ humidity: undefined, uvIndex: undefined });
        const selected = report('ecmwf', rows);
        const fallback = report(
            'sg',
            rows.map((h) => ({ ...h, humidity: { sg: 81 }, uvIndex: { sg: 7 }, precipitation: { sg: 12 } })),
        );
        fallback.modelUsed = 'weatherkit';
        const before = structuredClone(fallback);
        const merged = blendOffshoreForecast(selected, fallback);
        expect(merged.current.windSpeed).toBe(selected.current.windSpeed);
        expect(merged.current.humidity).toBe(81);
        expect(merged.current.uvIndex).toBe(7);
        expect(merged.current.precipitation).toBe(0);
        expect(merged.hourly[0].humidity).toBe(81);
        expect(merged.hourly[0].precipitation).toBe(0);
        expect(merged.forecast[0].humidity).toBe(81);
        expect(merged.forecast[0].windSpeed).toBe(selected.forecast[0].windSpeed);
        expect(merged.modelUsed).toContain('fallback:weatherkit');
        expect(fallback).toEqual(before);
    });
    it('preserves a longer fallback horizon without assigning the selected model to missing hours', () => {
        const rows = hours();
        const selected = report('ecmwf', rows.slice(0, 1));
        const fallback = report('sg', rows);
        const merged = blendOffshoreForecast(selected, fallback);
        expect(merged.hourly).toHaveLength(3);
        expect(merged.hourly[0].windSpeed).toBe(selected.hourly[0].windSpeed);
        expect(merged.hourly[2].windSpeed).toBe(fallback.hourly[2].windSpeed);
        expect(merged.modelUsed).toContain('fallback:');
    });
    it('retains selected-source hazards and existing fallback warnings', () => {
        const selected = report('ecmwf');
        const fallback = report('sg');
        selected.alerts = ['Selected model gale'];
        fallback.alerts = ['Coastal warning'];
        const merged = blendOffshoreForecast(selected, fallback);
        expect(merged.alerts).toEqual(['Coastal warning', 'Selected model gale']);
    });
    it('derives advice from the final supplied wind, not an absent model placeholder', () => {
        const selected = report('ecmwf', hours({ windSpeed: undefined }));
        const fallback = report('sg', hours({ windSpeed: { sg: 30 } }));
        const merged = blendOffshoreForecast(selected, fallback);
        expect(merged.current.windSpeed).toBe(fallback.current.windSpeed);
        expect(merged.boatingAdvice).toContain('STORM CONDITIONS');
    });
});
