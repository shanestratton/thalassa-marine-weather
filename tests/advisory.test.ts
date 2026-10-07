import { describe, it, expect } from 'vitest';
import {
    generateTacticalAdvice,
    checkForecastThresholds,
    generateSafetyAlerts,
    getSkipperLockerItems,
} from '../utils/advisory';
import { isCriticalForecastAlert } from '../utils/forecastAlerts';
import { calculateApparentTemp } from '../utils/math';
import type { WeatherMetrics, HourlyForecast, NotificationPreferences, ForecastDay } from '../types';

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
        expect(result).toMatch(/gale-force winds/i);
    });

    it('never claims an official warning or advisory is in effect (W1-02)', () => {
        for (const windSpeed of [3, 12, 18, 23, 30, 40]) {
            for (const waveHeight of [0.5, 4, 8, 12]) {
                const result = generateTacticalAdvice({ ...baseMetrics, windSpeed, waveHeight });
                expect(result).not.toMatch(/\b(warning|advisory)\b/i);
                expect(result).not.toMatch(/small craft/i);
            }
        }
    });

    const adviceOf = (windSpeed: number, waveHeight: number) => {
        const result = generateTacticalAdvice({ ...baseMetrics, windSpeed, waveHeight });
        return result.slice(result.indexOf('Skippers Advice:'));
    };

    it('says heavy seas, not strong wind, on a swell-only day', () => {
        const advice = adviceOf(8, 7);
        expect(advice).toMatch(/^Skippers Advice: Heavy seas forecast\./);
        expect(advice).not.toMatch(/wind/i);
    });

    it('names the wind when the wind crossed the line, and both when both did', () => {
        expect(adviceOf(23, 2)).toMatch(/^Skippers Advice: Strong wind forecast\./);
        expect(adviceOf(23, 8)).toMatch(/^Skippers Advice: Strong wind and heavy seas forecast\./);
    });

    it('calls 25–34 kts strong to gale force: 25 kts is Beaufort 6, not a near gale', () => {
        for (const windSpeed of [25, 27, 30, 34.6]) {
            const result = generateTacticalAdvice({ ...baseMetrics, windSpeed, waveHeight: 2 });
            expect(result).toContain(`Strong to gale-force winds (${windSpeed.toFixed(0)} kts)`);
            expect(result).not.toMatch(/near-gale/i);
        }
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

    it('does not turn a missing hourly temperature into a 0° low-temp alert', () => {
        // Providers report a missing hour as null; Math.min read it as 0.
        const hourly = Array(24)
            .fill(null)
            .map((_, i) => makeHourly({ temperature: (i % 2 ? null : 18) as unknown as number }));
        const prefs = {
            ...defaultPrefs,
            tempLow: { enabled: true, threshold: 2 },
            tempHigh: { enabled: true, threshold: 30 },
        };
        expect(checkForecastThresholds(hourly, [], prefs)).toEqual([]);

        const allMissing = Array(24)
            .fill(null)
            .map(() => makeHourly({ temperature: null as unknown as number }));
        expect(checkForecastThresholds(allMissing, [], prefs)).toEqual([]);
    });

    it('ignores disabled thresholds', () => {
        const hourly = Array(24)
            .fill(null)
            .map(() => makeHourly({ windSpeed: 50 }));
        const prefs = { ...defaultPrefs, wind: { enabled: false, threshold: 10 } };
        expect(checkForecastThresholds(hourly, [], prefs)).toEqual([]);
    });
});

// ── The pre-W1-02 generator, frozen ──────────────────────────────────────
// generateSafetyAlerts exactly as it shipped before build 123 (labels and
// all), with the classifier the three alert surfaces each carried. The sweep
// below uses it to prove the relabel changed WORDS only: the same alerts fire,
// in the same order, with the same critical (never dismissable) flags.
const LEGACY_CRITICAL = [
    'STORM WARNING',
    'GALE WARNING',
    'DANGEROUS SEAS',
    'FREEZING SPRAY',
    'FREEZE WARNING',
    'EXCESSIVE HEAT',
    'DENSE FOG',
    'STORM WATCH',
    'GALE WATCH',
];
const legacyIsCritical = (alert: string) => LEGACY_CRITICAL.some((p) => alert.toUpperCase().includes(p));

function legacySafetyAlerts(current: WeatherMetrics, todayHigh?: number, dailyForecast?: ForecastDay[]): string[] {
    const alerts: string[] = [];
    const wind = current.windSpeed || 0;
    const gust = current.windGust || wind * 1.2;
    const wave = current.waveHeight || 0;
    const vis = current.visibility;
    const temp = current.airTemperature;
    const precip = current.precipitation || 0;
    if (wind > 48 || gust > 60) alerts.push('STORM WARNING: Winds exceeding 48kts');
    else if (wind > 34 || gust > 45) alerts.push('GALE WARNING: Winds exceeding 34kts');
    else if (wind > 22 || gust > 30) alerts.push('Small Craft Advisory: Winds > 22kts');
    if (wave > 15) alerts.push('DANGEROUS SEAS: Waves exceeding 15ft');
    else if (wave > 8) alerts.push('Hazardous Seas Advisory: Waves > 8ft');
    if (vis !== null && vis !== undefined) {
        if (vis < 1) alerts.push('DENSE FOG ADVISORY: Visibility < 1nm');
        else if (vis < 3) alerts.push('Low Visibility: < 3nm');
    }
    if (
        current.condition &&
        (current.condition.toLowerCase().includes('storm') || current.condition.toLowerCase().includes('thunder'))
    ) {
        alerts.push('Severe Thunderstorm Potential');
    }
    if (precip > 8) alerts.push('Heavy Rainfall: Visibility Reduced');
    if (dailyForecast && dailyForecast.length > 0) {
        const upcoming = dailyForecast.slice(0, 3);
        const stormKeywords = ['storm', 'thunder', 'hurricane', 'tornado', 'cyclone', 'gale', 'violent'];
        upcoming.forEach((day) => {
            const condLower = day.condition.toLowerCase();
            const isStormy = stormKeywords.some((k) => condLower.includes(k));
            const isHighWind = (day.windSpeed ?? 0) >= 34;
            const isExtremeGust = (day.windGust ?? 0) > 45;
            const isToday =
                day.day === 'Today' ||
                day.date === new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            if (!isToday || (isToday && !current.condition.toLowerCase().includes('storm'))) {
                if (isStormy) alerts.push(`STORM WATCH: ${day.condition} forecast for ${day.day}`);
                else if (isHighWind || isExtremeGust)
                    alerts.push(`GALE WATCH: High winds (${day.windSpeed}kts) forecast for ${day.day}`);
            }
        });
    }
    if (temp !== undefined && temp !== null) {
        const apparent = calculateApparentTemp(temp, current.humidity || 0, current.windSpeed || 0);
        const feelC = apparent || temp;
        const maxThreatTemp = Math.max(feelC, todayHigh || -99);
        if (maxThreatTemp >= 38) alerts.push('EXCESSIVE HEAT WARNING: Extreme Danger');
        else if (maxThreatTemp >= 33) alerts.push('HEAT ADVISORY: Dangerous temperatures expected');
        else if (maxThreatTemp >= 29) alerts.push('Heat Caution: Prolonged sun exposure risky');
        if (temp < 0) alerts.push('FREEZING SPRAY WARNING: Icing risk');
        else if (temp < 4) alerts.push('FREEZE WARNING: Hypothermia risk');
    }
    const currentHour = new Date().getHours();
    const isDaytime = currentHour >= 6 && currentHour < 19;
    if (isDaytime && current.uvIndex != null && current.uvIndex >= 8) alerts.push(`HIGH UV ALERT: Protection Required`);
    return [...new Set(alerts)];
}

const day = (over: Partial<ForecastDay>): ForecastDay => ({
    day: 'Wed',
    date: 'Jan 1',
    highTemp: 24,
    lowTemp: 18,
    windSpeed: 12,
    windGust: 18,
    waveHeight: 3,
    condition: 'Partly Cloudy',
    ...over,
});

/** A sweep of conditions wide enough to reach every rule, and its edges. */
function* sweepConditions(): Generator<[WeatherMetrics, number | undefined, ForecastDay[] | undefined]> {
    const winds = [0, 10, 22, 22.5, 26, 34, 34.5, 40, 48, 49];
    const gusts: (number | null | undefined)[] = [undefined, null, 0, 25, 30.5, 45.5, 61];
    const waves = [0, 8, 8.5, 15, 16];
    const visibilities: (number | null | undefined)[] = [undefined, null, 0, 0.5, 1, 2.9, 3, 10];
    const temps: (number | null | undefined)[] = [undefined, -2, 0, 3, 4, 20, 29, 33, 39];
    const conditions = ['Partly Cloudy', 'Thunderstorm', 'Heavy Rain', 'Storm'];
    const dailies: (ForecastDay[] | undefined)[] = [
        undefined,
        [day({ day: 'Today', condition: 'Thunderstorm' }), day({ day: 'Thu', windSpeed: 36 })],
        [
            day({ day: 'Today' }),
            day({ day: 'Tomorrow', windSpeed: 20, windGust: 47 }),
            day({ day: 'Fri', condition: 'Tropical Cyclone' }),
        ],
        [day({ day: 'Sat', windSpeed: null, windGust: 50 }), day({ day: 'Sun', condition: 'Violent rain showers' })],
    ];
    let i = 0;
    for (const windSpeed of winds)
        for (const windGust of gusts)
            for (const waveHeight of waves) {
                // Rotate the slower-moving fields so the sweep stays small.
                const visibility = visibilities[i % visibilities.length];
                const airTemperature = temps[(i * 7) % temps.length];
                const condition = conditions[(i * 3) % conditions.length];
                const daily = dailies[(i * 5) % dailies.length];
                const metrics = {
                    ...baseMetrics,
                    windSpeed,
                    windGust: windGust as number,
                    waveHeight,
                    visibility: visibility as number,
                    airTemperature: airTemperature as number,
                    condition,
                    precipitation: i % 4 === 0 ? 9 : 0,
                    uvIndex: i % 2 === 0 ? 9 : 4,
                };
                yield [metrics, i % 3 === 0 ? 40 : undefined, daily];
                i++;
            }
}

describe('generateSafetyAlerts', () => {
    it('returns empty array for calm conditions', () => {
        const calm = { ...baseMetrics, windSpeed: 5, windGust: 8, waveHeight: 0.5 };
        expect(generateSafetyAlerts(calm).length).toBe(0);
    });

    it('says storm-force wind as a forecast, not a STORM WARNING', () => {
        const alerts = generateSafetyAlerts({ ...baseMetrics, windSpeed: 50 });
        expect(alerts).toContain('Forecast: storm-force wind, 48 kt+');
    });

    it('says gale-force wind as a forecast, not a GALE WARNING', () => {
        const alerts = generateSafetyAlerts({ ...baseMetrics, windSpeed: 36 });
        expect(alerts).toContain('Forecast: gale-force wind, 34 kt+');
        expect(alerts.join(' ')).not.toContain('GALE WARNING');
    });

    it('names the gust when a real gust, not the mean wind, crossed the line', () => {
        expect(generateSafetyAlerts({ ...baseMetrics, windSpeed: 30, windGust: 46 })).toContain(
            'Forecast: gale-force gusts, 45 kt+',
        );
        expect(generateSafetyAlerts({ ...baseMetrics, windSpeed: 30, windGust: 61 })).toContain(
            'Forecast: storm-force gusts, 60 kt+',
        );
        expect(generateSafetyAlerts({ ...baseMetrics, windSpeed: 20, windGust: 31 })).toContain(
            'Forecast: strong gusts, 30 kt+',
        );
    });

    it('never words a gust the model did not publish', () => {
        for (const windGust of [undefined, null, 0]) {
            for (const windSpeed of [23, 26, 36, 50]) {
                const alerts = generateSafetyAlerts({ ...baseMetrics, windSpeed, windGust: windGust as number });
                expect(alerts.join(' ')).not.toMatch(/gust/i);
            }
        }
    });

    it('says strong wind instead of a Small Craft Advisory', () => {
        const alerts = generateSafetyAlerts({ ...baseMetrics, windSpeed: 24, windGust: 20 });
        expect(alerts).toContain('Forecast: strong wind, 22 kt+');
        expect(alerts.join(' ')).not.toMatch(/small craft/i);
    });

    it('says dangerous and rough seas in feet and metres', () => {
        expect(generateSafetyAlerts({ ...baseMetrics, waveHeight: 16 })).toContain(
            'Forecast: dangerous seas, 15 ft+ (4.6 m)',
        );
        expect(generateSafetyAlerts({ ...baseMetrics, waveHeight: 9 })).toContain(
            'Forecast: rough seas, 8 ft+ (2.4 m)',
        );
    });

    it('says dense fog as a forecast', () => {
        const alerts = generateSafetyAlerts({ ...baseMetrics, visibility: 0.5 });
        expect(alerts).toContain('Forecast: dense fog, visibility under 1 nm');
    });

    it('says extreme heat as a forecast', () => {
        const alerts = generateSafetyAlerts({ ...baseMetrics, airTemperature: 40, humidity: 50 });
        expect(alerts.some((a) => a.startsWith('Forecast: extreme heat'))).toBe(true);
    });

    it('says freezing spray as a forecast', () => {
        const alerts = generateSafetyAlerts({ ...baseMetrics, airTemperature: -2 });
        expect(alerts.some((a) => a.startsWith('Forecast: freezing spray'))).toBe(true);
    });

    it('detects thunderstorm condition', () => {
        const alerts = generateSafetyAlerts({ ...baseMetrics, condition: 'Severe Thunderstorm' });
        expect(alerts).toContain('Forecast: thunderstorms possible');
    });

    it('says the coming days as forecasts, never as a WATCH', () => {
        const alerts = generateSafetyAlerts(baseMetrics, undefined, [
            day({ day: 'Today' }),
            day({ day: 'Tue', condition: 'Thunderstorm' }),
            day({ day: 'Wed', windSpeed: 36 }),
        ]);
        expect(alerts).toContain('Forecast: storm risk on Tue (Thunderstorm)');
        expect(alerts).toContain('Forecast: gale-force wind on Wed, 36 kt');
        const gusty = generateSafetyAlerts(baseMetrics, undefined, [
            day({ day: 'Tomorrow', windSpeed: 20, windGust: 47 }),
        ]);
        expect(gusty).toContain('Forecast: gale-force gusts tomorrow, 47 kt');
    });

    it('deduplicates alerts', () => {
        const alerts = generateSafetyAlerts({ ...baseMetrics, windSpeed: 50, windGust: 65 });
        expect(alerts.length).toBe(new Set(alerts).size);
    });

    it('property: no generated text wears an official product name', () => {
        let seen = 0;
        for (const [metrics, high, daily] of sweepConditions()) {
            for (const alert of generateSafetyAlerts(metrics, high, daily)) {
                seen++;
                expect(alert.startsWith('Forecast: '), alert).toBe(true);
                expect(alert, alert).not.toMatch(/\b(warning|watch|advisory)\b/i);
                expect(alert, alert).not.toMatch(/small craft/i);
            }
        }
        expect(seen).toBeGreaterThan(500);
    });

    it('property: the same alerts fire with the same critical flags as before the relabel', () => {
        let critical = 0;
        for (const [metrics, high, daily] of sweepConditions()) {
            const before = legacySafetyAlerts(metrics, high, daily).map(legacyIsCritical);
            const after = generateSafetyAlerts(metrics, high, daily).map(isCriticalForecastAlert);
            expect(after).toEqual(before);
            critical += after.filter(Boolean).length;
        }
        // The sweep really exercises the non-dismissable path.
        expect(critical).toBeGreaterThan(100);
    });

    it('keeps a gale non-dismissable', () => {
        for (const metrics of [
            { ...baseMetrics, windSpeed: 36 },
            { ...baseMetrics, windSpeed: 30, windGust: 46 },
            { ...baseMetrics, windSpeed: 50 },
        ]) {
            const gale = generateSafetyAlerts(metrics).find((a) => /gale|storm/.test(a));
            expect(gale).toBeDefined();
            expect(isCriticalForecastAlert(gale!)).toBe(true);
        }
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
