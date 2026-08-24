/**
 * heroSlideHelpers — tests for the extracted display value & trend computation.
 */
import { describe, it, expect } from 'vitest';
import {
    buildSlides,
    reconcileDayCondition,
    computeDisplayValues,
    computeTrends,
    resolveHeroRowTemperatureRange,
} from '../components/dashboard/hero/heroSlideHelpers';
import { HourlyForecast, SourcedWeatherMetrics } from '../types';

const baseData: Partial<SourcedWeatherMetrics> = {
    airTemperature: 24,
    highTemp: 28,
    lowTemp: 18,
    windSpeed: 15,
    windGust: 22,
    waveHeight: 1.5,
    visibility: 30,
    pressure: 1013,
    cloudCover: 40,
    uvIndex: 5,
    sunrise: '06:00',
    sunset: '18:30',
    currentSpeed: 0.8,
    humidity: 65,
    feelsLike: 23,
    dewPoint: 16,
    waterTemperature: 22,
    currentDirection: 180,
    precipitation: 2.5,
    precipChance: 30,
    secondarySwellHeight: 0.8,
    secondarySwellPeriod: 6,
};

const metricUnits = {
    speed: 'kts' as const,
    temp: 'C' as const,
    length: 'm' as const,
    distance: 'nm' as const,
    waveHeight: 'm' as const,
    visibility: 'nm' as const,
};

describe('computeDisplayValues', () => {
    it('converts temperatures to Celsius', () => {
        const result = computeDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 0);
        expect(result.airTemp).toBe('24');
        expect(result.sunrise).toBe('06:00');
        expect(result.sunset).toBe('18:30');
    });

    it('returns -- for null values', () => {
        const emptyData = {
            ...baseData,
            airTemperature: null,
            windSpeed: null,
            waveHeight: null,
        } as unknown as SourcedWeatherMetrics;
        const result = computeDisplayValues(emptyData, metricUnits, 0);
        expect(result.airTemp).toBe('--');
        expect(result.windSpeed).toBe('--');
        expect(result.waveHeight).toBe('--');
    });

    it('uses precipChance for forecast days (index > 0)', () => {
        const result = computeDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 1);
        expect(result.precipUnit).toBe('%');
        expect(result.precip).toBe(30);
    });

    it('uses precipitation total for today (index === 0)', () => {
        const result = computeDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 0);
        expect(result.precipUnit).toBe('mm');
    });

    it('returns "0" for wave height when landlocked', () => {
        const result = computeDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 0, true);
        expect(result.waveHeight).toBe('0');
    });

    it('converts current direction from degrees to cardinal', () => {
        const result = computeDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 0);
        expect(result.currentDirection).toBe('S');
    });

    it('handles default sunrise/sunset when missing', () => {
        const noSun = { ...baseData, sunrise: undefined, sunset: undefined } as unknown as SourcedWeatherMetrics;
        const result = computeDisplayValues(noSun, metricUnits, 0);
        expect(result.sunrise).toBe('--:--');
        expect(result.sunset).toBe('--:--');
    });
});

describe('computeTrends', () => {
    const now = new Date('2024-06-15T10:30:00Z').getTime();
    const hourlyData = [
        { time: '2024-06-15T09:00:00Z', windSpeed: 10, windGust: 15, waveHeight: 1.0, pressure: 1013 },
        { time: '2024-06-15T10:00:00Z', windSpeed: 15, windGust: 22, waveHeight: 1.5, pressure: 1012 },
        { time: '2024-06-15T11:00:00Z', windSpeed: 20, windGust: 28, waveHeight: 2.0, pressure: 1011 },
    ];

    it('returns undefined when no hourly data', () => {
        expect(computeTrends(baseData as SourcedWeatherMetrics, undefined, now)).toBeUndefined();
        expect(computeTrends(baseData as SourcedWeatherMetrics, [], now)).toBeUndefined();
    });

    it('computes rising trend when current > previous', () => {
        const result = computeTrends({ ...baseData, windSpeed: 20 } as SourcedWeatherMetrics, hourlyData, now);
        expect(result).toBeDefined();
        expect(result!.wind).toBe('rising');
    });

    it('computes falling trend when current < previous', () => {
        const result = computeTrends({ ...baseData, windSpeed: 5 } as SourcedWeatherMetrics, hourlyData, now);
        expect(result).toBeDefined();
        expect(result!.wind).toBe('falling');
    });

    it('computes steady when within threshold', () => {
        const result = computeTrends({ ...baseData, windSpeed: 10.5 } as SourcedWeatherMetrics, hourlyData, now);
        expect(result).toBeDefined();
        expect(result!.wind).toBe('steady');
    });

    it('returns undefined when time is far from any hourly slot', () => {
        const farFuture = new Date('2024-12-31T00:00:00Z').getTime();
        const result = computeTrends(baseData as SourcedWeatherMetrics, hourlyData, farFuture);
        expect(result).toBeUndefined();
    });
});

describe('Glass day-row temperature range', () => {
    const honoluluNextHour = {
        // 00:30 UTC is still 14:30 on the previous calendar day in Honolulu.
        // This is the exact device-vs-location timezone boundary that caused
        // the next hourly Glass card to select a different daily high/low.
        time: '2026-07-27T00:30:00Z',
        temperature: 25,
        windSpeed: 12,
        waveHeight: 1.2,
        condition: 'Fine',
    } as HourlyForecast;

    const adjacentDailyForecasts = [
        {
            isoDate: '2026-07-26',
            highTemp: 29,
            lowTemp: 19,
            condition: 'Fine',
            windSpeed: 12,
            waveHeight: 1.2,
        },
        {
            // What a UTC/device-time lookup sees for the hour above. This
            // pair must never leak into the July 26 Glass row.
            isoDate: '2026-07-27',
            highTemp: 38,
            lowTemp: 7,
            condition: 'Stormy',
            windSpeed: 30,
            waveHeight: 4,
        },
    ];

    it('keeps Now and hourly cards on the same location-day high/low pair', () => {
        const row = {
            ...baseData,
            isoDate: '2026-07-26',
            date: '2026-07-26',
            highTemp: 29,
            lowTemp: 19,
        } as SourcedWeatherMetrics;

        const slides = buildSlides(row, 0, [honoluluNextHour], adjacentDailyForecasts, 'Pacific/Honolulu');

        expect(slides).toHaveLength(2);
        expect(slides.map((slide) => [slide.data.highTemp, slide.data.lowTemp])).toEqual([
            [29, 19],
            [29, 19],
        ]);
    });

    it('uses that same pair for a forecast-day overview and all of its hours', () => {
        const row = {
            ...baseData,
            isoDate: '2026-07-26',
            date: '2026-07-26',
            highTemp: 29,
            lowTemp: 19,
        } as SourcedWeatherMetrics;

        const slides = buildSlides(row, 1, [honoluluNextHour], adjacentDailyForecasts, 'Pacific/Honolulu');

        expect(slides).toHaveLength(2);
        expect(slides[0].daily).toMatchObject({ highTemp: 29, lowTemp: 19 });
        expect(slides[1].data).toMatchObject({ highTemp: 29, lowTemp: 19 });
    });

    it('uses the forecast-location day as a safe fallback when a row lacks temperatures', () => {
        const rowWithoutTemperatures = {
            ...baseData,
            isoDate: undefined,
            date: undefined,
            highTemp: undefined,
            lowTemp: undefined,
        } as SourcedWeatherMetrics;

        const temperatures = resolveHeroRowTemperatureRange(
            rowWithoutTemperatures,
            adjacentDailyForecasts,
            [honoluluNextHour],
            { timeZone: 'Pacific/Honolulu' },
        );

        expect(temperatures).toEqual({ highTemp: 29, lowTemp: 19 });
    });

    it('keeps Essential-mode current conditions on the live location day over stale hourly cache', () => {
        const rowWithoutTemperatures = {
            ...baseData,
            isoDate: undefined,
            date: undefined,
            highTemp: undefined,
            lowTemp: undefined,
        } as SourcedWeatherMetrics;
        const staleTomorrowHour = {
            ...honoluluNextHour,
            // This cached entry is already July 27 in Honolulu, while the
            // current reference time is still July 26 there.
            time: '2026-07-28T00:30:00Z',
        } as HourlyForecast;

        const temperatures = resolveHeroRowTemperatureRange(
            rowWithoutTemperatures,
            adjacentDailyForecasts,
            [staleTomorrowHour],
            {
                timeZone: 'Pacific/Honolulu',
                referenceTime: '2026-07-26T20:00:00Z',
                preferForecast: true,
            },
        );

        expect(temperatures).toEqual({ highTemp: 29, lowTemp: 19 });
    });
});

describe('reconcileDayCondition — the day overview must not contradict its own hourly cards', () => {
    const hour = (hh: string, condition: string, precipitation = 0): HourlyForecast =>
        ({
            time: `2026-08-11T${hh}:00`,
            condition,
            precipitation,
            windSpeed: 10,
            waveHeight: null,
            temperature: 20,
        }) as HourlyForecast;

    const sunnyDay = Array.from({ length: 24 }, (_, i) =>
        hour(String(i).padStart(2, '0'), i >= 6 && i <= 17 ? 'Sunny' : 'Clear'),
    );

    it("drops a wet daily word when every hour is dry and the day's precip rounds to nothing (Shane 2026-08-10)", () => {
        // Open-Meteo daily weather_code = severest hour of the day: one model
        // blip says drizzle while all 24 cards are sunny and sum is 0.0 mm.
        expect(reconcileDayCondition('Light Drizzle', sunnyDay)).toBe('Sunny');
    });

    it('keeps the wet word when a daylight hour agrees', () => {
        const day = sunnyDay.map((h) => (h.time.includes('T14') ? { ...h, condition: 'Light Rain' } : h));
        expect(reconcileDayCondition('Light Rain', day)).toBe('Light Rain');
    });

    it('keeps the wet word when real rain falls at night even though daylight is dry', () => {
        const day = sunnyDay.map((h) => (h.time.includes('T02') ? { ...h, condition: 'Rain', precipitation: 3 } : h));
        expect(reconcileDayCondition('Rain', day)).toBe('Rain');
    });

    it('never second-guesses a dry provider word', () => {
        expect(reconcileDayCondition('Cloudy', sunnyDay)).toBe('Cloudy');
    });

    it('passes provider word through when there are no hours to consult', () => {
        expect(reconcileDayCondition('Light Drizzle', [])).toBe('Light Drizzle');
        expect(reconcileDayCondition(undefined, sunnyDay)).toBeUndefined();
    });
});
