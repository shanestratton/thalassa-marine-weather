import { describe, it, expect } from 'vitest';
import {
    generateTacticalAdvice,
    checkForecastThresholds,
    generateSafetyAlerts,
    getSkipperLockerItems,
} from '../utils/advisory';
import type { WeatherMetrics, HourlyForecast, NotificationPreferences } from '../types';

const baseMetrics: WeatherMetrics = {
    windSpeed: 10,
    windGust: 15,
    windDirection: 'NE',
    waveHeight: 1.5,
    swellPeriod: 8,
    airTemperature: 25,
    humidity: 60,
    pressure: 1013,
    precipitation: 0,
    cloudCover: 30,
    visibility: 10,
    condition: 'Partly Cloudy',
    description: 'Partly cloudy skies',
    uvIndex: 5,
};

const defaultPrefs: NotificationPreferences = {
    wind: { enabled: false, threshold: 20 },
    gusts: { enabled: false, threshold: 30 },
    waves: { enabled: false, threshold: 5 },
    swellPeriod: { enabled: false, threshold: 10 },
    visibility: { enabled: false, threshold: 1 },
    uv: { enabled: false, threshold: 8 },
    tempHigh: { enabled: false, threshold: 35 },
    tempLow: { enabled: false, threshold: 5 },
    precipitation: { enabled: false },
};

describe('generateTacticalAdvice', () => {
    it('generates advice for calm conditions', () => {
        const calm = { ...baseMetrics, windSpeed: 3, waveHeight: 0.2 };
        const result = generateTacticalAdvice(calm);
        expect(result).toContain("Captain's Log");
        expect(result).toContain('still');
    });

    it('generates advice for moderate wind', () => {
        const moderate = { ...baseMetrics, windSpeed: 12 };
        const result = generateTacticalAdvice(moderate);
        expect(result).toContain('Moderate');
    });

    it('generates advice for strong wind', () => {
        const strong = { ...baseMetrics, windSpeed: 18 };
        const result = generateTacticalAdvice(strong);
        expect(result).toContain('Fresh');
    });

    it('generates advice for gale conditions', () => {
        const gale = { ...baseMetrics, windSpeed: 30 };
        const result = generateTacticalAdvice(gale);
        expect(result).toContain('GALE');
    });

    it('generates advice for storm conditions', () => {
        const storm = { ...baseMetrics, windSpeed: 40 };
        const result = generateTacticalAdvice(storm);
        expect(result).toContain('STORM');
    });

    it('handles landlocked mode', () => {
        const result = generateTacticalAdvice(baseMetrics, true);
        expect(result).toContain("Captain's Log");
    });

    it('includes location name', () => {
        const result = generateTacticalAdvice(baseMetrics, false, 'Brisbane');
        expect(result).toContain('Brisbane');
    });

    it('includes vessel specific checks', () => {
        const vessel = {
            name: 'TestVessel',
            type: 'sail' as const,
            length: 40,
            beam: 12,
            draft: 6,
            displacement: 15000,
            maxWaveHeight: 8,
            maxWindSpeed: 25,
            cruisingSpeed: 7,
        };
        const result = generateTacticalAdvice(baseMetrics, false, 'Test', vessel);
        expect(result).toContain('TestVessel');
    });

    it('warns when wind exceeds vessel limits', () => {
        const metrics = { ...baseMetrics, windSpeed: 30 };
        const vessel = {
            name: 'SmallBoat',
            type: 'power' as const,
            length: 20,
            beam: 8,
            draft: 3,
            displacement: 5000,
            maxWaveHeight: 6,
            maxWindSpeed: 25,
            cruisingSpeed: 15,
        };
        const result = generateTacticalAdvice(metrics, false, 'Test', vessel);
        expect(result).toContain('CRITICAL');
    });

    it('includes tide analysis when tides provided', () => {
        const futureTime = new Date(Date.now() + 3600000).toISOString();
        const tides = [{ time: futureTime, height: 1.5, type: 'High' as const }];
        const result = generateTacticalAdvice(baseMetrics, false, 'Test', undefined, tides);
        expect(result).toContain('Tides');
    });

    it('warns about rain conditions', () => {
        const rainy = { ...baseMetrics, condition: 'Light Rain' };
        const result = generateTacticalAdvice(rainy);
        expect(result).toContain('rain');
    });

    it('warns about fog', () => {
        const foggy = { ...baseMetrics, visibility: 1 };
        const result = generateTacticalAdvice(foggy);
        expect(result).toContain('Fog');
    });

    it('warns about thunderstorms', () => {
        const stormy = { ...baseMetrics, condition: 'Thunderstorm' };
        const result = generateTacticalAdvice(stormy);
        expect(result).toContain('ELECTRICAL STORM');
    });
});

describe('checkForecastThresholds', () => {
    const makeHourly = (overrides: Partial<HourlyForecast> = {}): HourlyForecast => ({
        time: '12:00',
        temperature: 25,
        windSpeed: 10,
        windGust: 15,
        windDirection: 'NE',
        waveHeight: 1,
        swellPeriod: 8,
        precipitation: 0,
        condition: 'Clear',
        ...overrides,
    });

    it('returns empty array when no thresholds exceeded', () => {
        const hourly = Array(24)
            .fill(null)
            .map(() => makeHourly());
        expect(checkForecastThresholds(hourly, [], defaultPrefs)).toEqual([]);
    });

    it('returns empty array for empty hourly data', () => {
        expect(checkForecastThresholds([], [], defaultPrefs)).toEqual([]);
    });

    it('detects wind threshold exceedance', () => {
        const hourly = Array(24)
            .fill(null)
            .map(() => makeHourly({ windSpeed: 30 }));
        const prefs = { ...defaultPrefs, wind: { enabled: true, threshold: 25 } };
        const alerts = checkForecastThresholds(hourly, [], prefs);
        expect(alerts.length).toBeGreaterThan(0);
        expect(alerts[0]).toContain('wind');
    });

    it('detects wave threshold exceedance', () => {
        const hourly = Array(24)
            .fill(null)
            .map(() => makeHourly({ waveHeight: 8 }));
        const prefs = { ...defaultPrefs, waves: { enabled: true, threshold: 6 } };
        const alerts = checkForecastThresholds(hourly, [], prefs);
        expect(alerts.length).toBeGreaterThan(0);
        expect(alerts[0]).toContain('Seas');
    });

    it('detects temperature thresholds', () => {
        const hourly = Array(24)
            .fill(null)
            .map(() => makeHourly({ temperature: 40 }));
        const prefs = { ...defaultPrefs, tempHigh: { enabled: true, threshold: 35 } };
        const alerts = checkForecastThresholds(hourly, [], prefs);
        expect(alerts.length).toBeGreaterThan(0);
        expect(alerts[0]).toContain('High Temp');
    });

    it('ignores disabled thresholds', () => {
        const hourly = Array(24)
            .fill(null)
            .map(() => makeHourly({ windSpeed: 50 }));
        const prefs = { ...defaultPrefs, wind: { enabled: false, threshold: 10 } };
        expect(checkForecastThresholds(hourly, [], prefs)).toEqual([]);
    });
});

describe('generateSafetyAlerts', () => {
    it('returns empty array for calm conditions', () => {
        const calm = { ...baseMetrics, windSpeed: 5, windGust: 8, waveHeight: 0.5 };
        expect(generateSafetyAlerts(calm).length).toBe(0);
    });

    it('generates storm warning for extreme wind', () => {
        const storm = { ...baseMetrics, windSpeed: 50 };
        const alerts = generateSafetyAlerts(storm);
        expect(alerts.some((a) => a.includes('STORM WARNING'))).toBe(true);
    });

    it('generates gale warning for high wind', () => {
        const gale = { ...baseMetrics, windSpeed: 36 };
        const alerts = generateSafetyAlerts(gale);
        expect(alerts.some((a) => a.includes('GALE WARNING'))).toBe(true);
    });

    it('generates small craft advisory', () => {
        const advisory = { ...baseMetrics, windSpeed: 24, windGust: 20 };
        const alerts = generateSafetyAlerts(advisory);
        expect(alerts.some((a) => a.includes('Small Craft'))).toBe(true);
    });

    it('generates dangerous seas alert', () => {
        const bigSeas = { ...baseMetrics, waveHeight: 16 };
        const alerts = generateSafetyAlerts(bigSeas);
        expect(alerts.some((a) => a.includes('DANGEROUS SEAS'))).toBe(true);
    });

    it('generates fog advisory', () => {
        const foggy = { ...baseMetrics, visibility: 0.5 };
        const alerts = generateSafetyAlerts(foggy);
        expect(alerts.some((a) => a.includes('DENSE FOG'))).toBe(true);
    });

    it('generates heat warning for extreme temps', () => {
        const hot = { ...baseMetrics, airTemperature: 40, humidity: 50 };
        const alerts = generateSafetyAlerts(hot);
        expect(alerts.some((a) => a.includes('HEAT'))).toBe(true);
    });

    it('generates freeze warning for cold temps', () => {
        const cold = { ...baseMetrics, airTemperature: -2 };
        const alerts = generateSafetyAlerts(cold);
        expect(alerts.some((a) => a.includes('FREEZING'))).toBe(true);
    });

    it('detects thunderstorm condition', () => {
        const stormy = { ...baseMetrics, condition: 'Severe Thunderstorm' };
        const alerts = generateSafetyAlerts(stormy);
        expect(alerts.some((a) => a.includes('Thunderstorm'))).toBe(true);
    });

    it('deduplicates alerts', () => {
        const extreme = { ...baseMetrics, windSpeed: 50, windGust: 65 };
        const alerts = generateSafetyAlerts(extreme);
        const unique = new Set(alerts);
        expect(alerts.length).toBe(unique.size);
    });
});

describe('getSkipperLockerItems', () => {
    it('returns array of items', () => {
        const items = getSkipperLockerItems(baseMetrics, 'C');
        expect(items.length).toBeGreaterThan(0);
        expect(items.length).toBeLessThanOrEqual(12);
    });

    it('includes safety items for offshore', () => {
        const items = getSkipperLockerItems(baseMetrics, 'C', false, '27.45, 153.02');
        expect(items.some((i) => i.name.includes('EPIRB'))).toBe(true);
    });

    it('returns landlocked items when landlocked', () => {
        const items = getSkipperLockerItems(baseMetrics, 'C', true);
        expect(items.some((i) => i.name.includes('Hiking Boots'))).toBe(true);
    });

    it('includes rain gear when raining', () => {
        const rainy = { ...baseMetrics, condition: 'Heavy Rain' };
        const items = getSkipperLockerItems(rainy, 'C', true);
        expect(items.some((i) => i.category === 'Rain Gear')).toBe(true);
    });

    it('includes cold weather gear when cold', () => {
        const cold = { ...baseMetrics, airTemperature: 5 };
        const items = getSkipperLockerItems(cold, 'C', true);
        expect(items.some((i) => i.name.includes('Fleece') || i.name.includes('Beanie'))).toBe(true);
    });

    it('always includes default safety items', () => {
        const items = getSkipperLockerItems(baseMetrics, 'C');
        expect(items.some((i) => i.name === 'First Aid Kit')).toBe(true);
    });

    it('returns max 12 items', () => {
        const items = getSkipperLockerItems(baseMetrics, 'C', false, 'offshore');
        expect(items.length).toBeLessThanOrEqual(12);
    });
});
