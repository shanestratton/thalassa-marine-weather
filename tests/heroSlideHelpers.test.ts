/**
 * heroSlideHelpers — tests for the extracted display value & trend computation.
 */
import { describe, it, expect } from 'vitest';
import { computeDisplayValues, computeTrends } from '../components/dashboard/hero/heroSlideHelpers';
import { SourcedWeatherMetrics } from '../types';

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
