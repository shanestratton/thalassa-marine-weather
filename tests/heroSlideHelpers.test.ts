/**
 * heroSlideHelpers — tests for the extracted display value & trend computation.
 */
import { describe, it, expect } from 'vitest';
import {
    buildSlides,
    reconcileDayCondition,
    computeCardDisplayValues,
    computeTrends,
    resolveHeroRowTemperatureRange,
    daySky,
    locationDayIso,
    activeRowIsoDate,
    MODEL_COMPARE_EVENT,
    requestModelComparison,
} from '../components/dashboard/hero/heroSlideHelpers';
import { HourlyForecast, SourcedWeatherMetrics } from '../types';
import { NO_TRUE_NIGHT, SUN_STAYS_UP } from '../utils/celestial';

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

// computeDisplayValues (the dead "active card" twin) was removed in UX
// scorecard run 7: nothing rendered it, and it still invented a gust from the
// sustained wind × 1.3. Its cases now cover the helper the carousel uses.
describe('computeCardDisplayValues', () => {
    it('converts temperatures to Celsius', () => {
        const result = computeCardDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 0, false);
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
        const result = computeCardDisplayValues(emptyData, metricUnits, 0, false);
        expect(result.airTemp).toBe('--');
        expect(result.windSpeed).toBe('--');
        expect(result.waveHeight).toBe('--');
    });

    it('uses precipChance for forecast days (index > 0)', () => {
        const result = computeCardDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 1, false);
        expect(result.precipUnit).toBe('%');
        expect(result.precip).toBe(30);
    });

    it('uses precipitation total for today (index === 0)', () => {
        const result = computeCardDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 0, false);
        expect(result.precipUnit).toBe('mm');
    });

    it('returns "0" for wave height when landlocked', () => {
        const result = computeCardDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 0, false, true);
        expect(result.waveHeight).toBe('0');
    });

    it('converts current direction from degrees to cardinal', () => {
        const result = computeCardDisplayValues(baseData as SourcedWeatherMetrics, metricUnits, 0, false);
        expect(result.currentDirection).toBe('S');
    });

    it('handles default sunrise/sunset when missing', () => {
        const noSun = { ...baseData, sunrise: undefined, sunset: undefined } as unknown as SourcedWeatherMetrics;
        const result = computeCardDisplayValues(noSun, metricUnits, 0, false);
        expect(result.sunrise).toBe('--:--');
        expect(result.sunset).toBe('--:--');
    });

    it('never invents a gust from the sustained wind', () => {
        const noGust = { ...baseData, windGust: null } as unknown as SourcedWeatherMetrics;
        expect(computeCardDisplayValues(noGust, metricUnits, 0, false).gusts).toBe('--');
    });

    it('reads a visibility of 0 (dense fog) as a reading, not a missing one', () => {
        const fog = { ...baseData, visibility: 0 } as SourcedWeatherMetrics;
        expect(computeCardDisplayValues(fog, metricUnits, 0, false).vis).not.toBe('--');
        const none = { ...baseData, visibility: null } as unknown as SourcedWeatherMetrics;
        expect(computeCardDisplayValues(none, metricUnits, 0, false).vis).toBe('--');
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

describe('rain chance never shows an invented value (UX scorecard run 7)', () => {
    const metricUnits = { speed: 'kts', length: 'm', temp: 'C', distance: 'nm', visibility: 'nm' } as never;
    it('shows -- for a forecast hour with no chance, not 0 % or the millimetres', () => {
        const noChance = { ...baseData, precipChance: undefined, precipitation: 5 } as SourcedWeatherMetrics;
        expect(computeCardDisplayValues(noChance, metricUnits, 3, true).precip).toBe('--');
        expect(computeCardDisplayValues(noChance, metricUnits, 2, false).precip).toBe('--');
    });
    it('keeps a real chance, rounded', () => {
        const chance = { ...baseData, precipChance: 42.4 } as SourcedWeatherMetrics;
        expect(computeCardDisplayValues(chance, metricUnits, 3, true).precip).toBe(42);
        expect(computeCardDisplayValues(chance, metricUnits, 2, false).precip).toBe(42);
    });
    it('shows -- for a day total the model did not supply', () => {
        const noAmount = { ...baseData, precipitation: null } as unknown as SourcedWeatherMetrics;
        expect(computeCardDisplayValues(noAmount, metricUnits, 0, false).precip).toBe('--');
    });
});

// ── Build 123, W1-09: the day card's sun & moon row, its own date, and the
// one way a day card asks the comparison to open ──

describe('daySky — first light, the sun, last light and the moon for the place’s own day', () => {
    const minutes = (hhmm: string) => {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
    };
    const near = (got: string | null, usno: string, tolerance = 2) =>
        expect(Math.abs(minutes(got ?? '') - minutes(usno))).toBeLessThanOrEqual(tolerance);

    // USNO rstt/oneday, 2026-10-07 (the W1-06 almanac fixtures).
    it('Airlie Beach, Whitsundays (AEST)', () => {
        const sky = daySky('2026-10-07', -20.27, 148.72, 'Australia/Brisbane')!;
        near(sky.firstLight, '05:19');
        near(sky.sunrise, '05:42');
        near(sky.sunset, '18:05');
        near(sky.lastLight, '18:27');
        near(sky.moonrise, '03:13');
        near(sky.moonset, '14:57');
        expect(sky.illumination).toBeGreaterThan(0.06);
        expect(sky.illumination).toBeLessThan(0.2);
        expect(sky.phaseName).toBe('Waning Crescent');
    });

    it('Marseille (CEST), Sint Maarten (AST) and Suva (FJT), whatever the phone’s clock', () => {
        const marseille = daySky('2026-10-07', 43.3, 5.37, 'Europe/Paris')!;
        near(marseille.firstLight, '07:14');
        near(marseille.lastLight, '19:38');
        near(marseille.moonset, '17:38');
        const sxm = daySky('2026-10-07', 18.03, -63.08, 'America/Lower_Princes')!;
        near(sxm.sunrise, '06:04');
        near(sxm.lastLight, '18:18');
        const suva = daySky('2026-10-07', -18.14, 178.42, 'Pacific/Fiji')!;
        near(suva.firstLight, '05:22');
        near(suva.moonrise, '03:08');
    });

    it('says what happens at Tromsø midsummer instead of --:--', () => {
        const sky = daySky('2026-06-21', 69.65, 18.96, 'Europe/Oslo')!;
        expect(sky.sunrise).toBe(SUN_STAYS_UP);
        expect(sky.sunset).toBe(SUN_STAYS_UP);
        expect(sky.firstLight).toBe(NO_TRUE_NIGHT);
        expect(sky.lastLight).toBe(NO_TRUE_NIGHT);
    });

    it('has nothing to say for an unplaced report at 0°, 0°', () => {
        expect(daySky('2026-10-07', 0, 0, 'UTC')).toBeNull();
    });
});

describe('locationDayIso — the Glass rows count from the place’s today', () => {
    it('is the place’s calendar, not the phone’s', () => {
        const now = new Date('2026-10-07T20:00:00Z'); // 06:00 on the 8th in Brisbane, 22:00 on the 7th in Paris
        expect(locationDayIso(0, 'Australia/Brisbane', now)).toBe('2026-10-08');
        expect(locationDayIso(2, 'Australia/Brisbane', now)).toBe('2026-10-10');
        expect(locationDayIso(1, 'Europe/Paris', now)).toBe('2026-10-08');
        expect(locationDayIso(30, 'America/Halifax', now)).toBe('2026-11-06');
    });
});

describe('activeRowIsoDate — the sun & moon sheet opens on the row on screen (W1-09 review)', () => {
    const now = new Date('2026-10-08T08:00:00Z'); // 10:00 in Simon's Town, 03:00 in Halifax
    it('takes the day row’s own date, even where rows skip a day', () => {
        expect(activeRowIsoDate({ isoDate: '2026-10-14' }, 2, 'Africa/Johannesburg', now)).toBe('2026-10-14');
    });
    it('takes an hourly card’s hour on the place’s clock', () => {
        // 01:00 on Wed 14 Oct in Halifax is still the 14th there, the 14th in UTC too.
        expect(activeRowIsoDate({ time: '2026-10-14T04:00:00Z' }, 2, 'America/Halifax', now)).toBe('2026-10-14');
        // 23:30 on Tue 13 Oct in Halifax is the 14th in UTC: the place's date wins.
        expect(activeRowIsoDate({ time: '2026-10-14T02:30:00Z' }, 2, 'America/Halifax', now)).toBe('2026-10-13');
    });
    it('counts from the place’s today only when the row has no date, and row 0 is always today', () => {
        expect(activeRowIsoDate(null, 3, 'America/Halifax', now)).toBe('2026-10-11');
        expect(activeRowIsoDate({ isoDate: '2026-10-07' }, 0, 'Africa/Johannesburg', now)).toBe('2026-10-08');
    });
});

describe('the day overview knows its own date', () => {
    it('from its hours, on the place’s calendar (Marseille read on any phone)', () => {
        // 00:00–23:00 CEST on Sat 10 Oct.
        const hours = Array.from({ length: 24 }, (_, h) => ({
            time: new Date(Date.UTC(2026, 9, 9, 22 + h)).toISOString(),
            temperature: 19,
            windSpeed: 12,
            windGust: 16,
            windDegree: 320,
            condition: 'Clear',
        })) as unknown as HourlyForecast[];
        const slides = buildSlides(
            { ...baseData, isoDate: '2026-10-10', date: '2026-10-10' } as SourcedWeatherMetrics,
            2,
            hours,
            [],
            'Europe/Paris',
        );
        expect(slides[0].type).toBe('daily');
        expect(slides[0].daily?.isoDate).toBe('2026-10-10');
    });

    it('from the row itself when the day has no hours (Fiji, past the hourly range)', () => {
        const slides = buildSlides(
            { ...baseData, isoDate: '2026-10-15', date: '2026-10-15' } as SourcedWeatherMetrics,
            8,
            [],
            [],
            'Pacific/Fiji',
        );
        expect(slides[0].daily?.isoDate).toBe('2026-10-15');
    });
});

describe('requestModelComparison — the one way a day card opens the comparison', () => {
    it('asks on one window event, with the day and the tab', () => {
        const seen: unknown[] = [];
        const on = (event: Event) => seen.push((event as CustomEvent).detail);
        window.addEventListener(MODEL_COMPARE_EVENT, on);
        requestModelComparison({ dayMs: Date.parse('2026-10-10T12:00:00+02:00'), param: 'dir' });
        window.removeEventListener(MODEL_COMPARE_EVENT, on);
        expect(seen).toEqual([{ dayMs: Date.parse('2026-10-10T12:00:00+02:00'), param: 'dir' }]);
    });
});
