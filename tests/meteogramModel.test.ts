// @vitest-environment node
/**
 * The point meteogram's pure half (131-02): every series on one grid of
 * epoch hours, nothing drawn across a missing hour, the week marked where
 * the forecast runs out, the models' spread on the same hours, the pressure's
 * fast falls, nights where the sun is down at the spot, and days named on
 * the place's clock or the phone's. Fictional readings, real places.
 */
import SunCalc from 'suncalc';
import { describe, expect, it } from 'vitest';
import {
    HOUR_MS,
    METEOGRAM_HOURS,
    alignHourly,
    bandPath,
    bareClock,
    barsPath,
    dayMarks,
    fastFallPath,
    fastFallSegments,
    firstAtOrOver,
    forecastEnd,
    forecastTimeMs,
    formatHour,
    linePath,
    niceTop,
    nightSpans,
    runs,
    spreadBand,
    steepestFall,
    tendencyNow,
    threeHourChange,
    yScale,
    zoneName,
    zoneOffsetSeconds,
    type HourValues,
} from '../components/weather/meteogramModel';
import type { HourlyForecast } from '../types';
import type { AtmosVar, SpreadBlock } from '../services/weather/ModelSpreadService';

const H = HOUR_MS;
/** 00:00 UTC on Fri 16 Oct 2026: 10:00 in Brisbane, 02:00 in Marseille. */
const T0 = Date.UTC(2026, 9, 16, 0);
const BRISBANE = { lat: -27.47, lon: 153.03 };

const hour = (time: string, extra: Partial<HourlyForecast> = {}): HourlyForecast =>
    ({ time, windSpeed: null, waveHeight: null, temperature: 20, condition: 'Clear', ...extra }) as HourlyForecast;

const series = (length: number, at: (i: number) => number | null): HourValues =>
    Array.from({ length }, (_, i) => at(i));

describe('forecast stamps become instants', () => {
    it('reads zoned stamps as written', () => {
        expect(forecastTimeMs('2026-10-16T04:00:00Z')).toBe(T0 + 4 * H);
        expect(forecastTimeMs('2026-10-16T14:00:00+10:00')).toBe(T0 + 4 * H);
        expect(forecastTimeMs('2026-10-16T04:00:00.000Z', { timeZone: 'Europe/Paris' })).toBe(T0 + 4 * H);
    });

    it('reads bare stamps on the place’s zone, or at a fixed offset', () => {
        expect(forecastTimeMs('2026-10-16T14:00', { timeZone: 'Australia/Brisbane' })).toBe(T0 + 4 * H);
        expect(forecastTimeMs('2026-10-16T14:00', { utcOffsetSeconds: 36_000 })).toBe(T0 + 4 * H);
        expect(forecastTimeMs('2026-10-16T05:30', { timeZone: 'Asia/Kolkata' })).toBe(T0);
    });

    it('keeps the right hour across a clock change on the place’s zone', () => {
        // Marseille goes from CEST (+2) to CET (+1) early on Sun 25 Oct 2026.
        expect(forecastTimeMs('2026-10-24T12:00', { timeZone: 'Europe/Paris' })).toBe(Date.UTC(2026, 9, 24, 10));
        expect(forecastTimeMs('2026-10-26T12:00', { timeZone: 'Europe/Paris' })).toBe(Date.UTC(2026, 9, 26, 11));
    });

    it('is NaN for anything that is not a time', () => {
        expect(forecastTimeMs('soon')).toBeNaN();
        expect(forecastTimeMs('')).toBeNaN();
        expect(forecastTimeMs(undefined)).toBeNaN();
    });

    it('takes the place’s zone when the report’s offset is that zone’s, else the fixed offset', () => {
        const now = Date.UTC(2026, 9, 20, 12);
        expect(bareClock(now, 'Europe/Paris', 7200)).toEqual({ timeZone: 'Europe/Paris' });
        // A publisher answering in GMT: its bare stamps are UTC, not the place's.
        expect(bareClock(now, 'Europe/Paris', 0)).toEqual({ utcOffsetSeconds: 0 });
        // The StormGlass transformer's offset is in hours.
        expect(bareClock(now, 'Australia/Brisbane', 10)).toEqual({ timeZone: 'Australia/Brisbane' });
        expect(bareClock(now, 'Australia/Brisbane', undefined)).toEqual({});
        expect(zoneOffsetSeconds(now, 'Asia/Kolkata')).toBe(19_800);
    });
});

describe('every series on one grid of epoch hours', () => {
    const clock = { timeZone: 'Australia/Brisbane' };

    it('lines up zoned and bare stamps on the same hour, and drops what is outside the week', () => {
        const grid = alignHourly(
            [
                hour('2026-10-15T23:00:00Z', { windSpeed: 1 }), // before the week
                hour('2026-10-16T00:00:00Z', { windSpeed: 10, windGust: 14, pressure: 1015 }),
                hour('2026-10-16T00:00:00Z', { windSpeed: 99 }), // a second sample for hour 0
                hour('2026-10-16T11:00', { windSpeed: 12 }), // bare, Brisbane: 01:00Z
                hour('2026-10-16T03:30:00Z', { windSpeed: 13, waveHeight: 3.3, swellPeriod: 8 }),
                hour('2026-10-23T00:00:00Z', { windSpeed: 30 }), // hour 168: past the week
            ],
            T0,
            METEOGRAM_HOURS,
            clock,
        );
        expect(grid.startMs).toBe(T0);
        expect(grid.series.wind.slice(0, 5)).toEqual([10, 12, null, 13, null]);
        expect(grid.series.gust.slice(0, 2)).toEqual([14, null]);
        expect(grid.series.wave[3]).toBe(3.3);
        expect(grid.series.period[3]).toBe(8);
        expect(grid.series.wind).toHaveLength(METEOGRAM_HOURS);
        expect(grid.series.wind.filter((v) => v !== null)).toHaveLength(3);
    });

    it('starts on the hour now is in', () => {
        expect(alignHourly([], T0 + 25 * 60_000).startMs).toBe(T0);
    });

    it('leaves a missing or non-numeric reading missing, never zero', () => {
        const grid = alignHourly(
            [
                hour('2026-10-16T00:00:00Z', { windSpeed: 8, precipitation: 0, precipChance: 10 }),
                hour('2026-10-16T01:00:00Z', { windSpeed: null, precipitation: null, pressure: Number.NaN }),
                hour('2026-10-16T02:00:00Z', { windSpeed: 9 }),
            ],
            T0,
        );
        expect(grid.series.wind.slice(0, 3)).toEqual([8, null, 9]);
        expect(grid.series.rain.slice(0, 2)).toEqual([0, null]);
        expect(grid.series.rainChance.slice(0, 2)).toEqual([10, null]);
        expect(grid.series.pressure[1]).toBeNull();
    });
});

describe('no line across a gap', () => {
    it('splits a series into its unbroken stretches', () => {
        expect(runs([1, 2, null, 4, null, null, 7, 8])).toEqual([
            { from: 0, to: 1 },
            { from: 3, to: 3 },
            { from: 6, to: 7 },
        ]);
        expect(runs([null, null])).toEqual([]);
    });

    it('draws one stroke per stretch, a lone hour as a tick, and never joins the gap', () => {
        const y = (v: number) => v;
        const d = linePath([1, 2, null, 4, null, 6, 7], y);
        expect(d).toBe('M0 1L1 2M2.6 4H3.4M5 6L6 7');
        expect(d.match(/M/g)).toHaveLength(3);
    });

    it('bands only the hours both edges have', () => {
        const y = (v: number) => v;
        expect(bandPath([1, 1, null, 2], [3, 4, 5, 6], y)).toBe('M0 3L1 4L1 1L0 1ZM3 6L3 2Z');
    });

    it('draws a bar only for an hour with rain, at least a sliver tall', () => {
        const y = yScale(0, 10);
        expect(barsPath([0, null, 5, 0.001], y)).toBe(`M2.15 96V${y(5)}H2.85V96ZM3.15 96V95H3.85V96Z`);
    });

    it('scales into the plot box and rounds the top up to a step in display units', () => {
        const y = yScale(0, 20);
        expect(y(0)).toBe(96);
        expect(y(20)).toBe(8);
        expect(niceTop(18, 1, 5)).toBe(20);
        // 1.8 m of sea, stored in feet, on a half-metre step: 2 m.
        expect(niceTop(5.9, 0.3048, 0.5) * 0.3048).toBeCloseTo(2);
        expect(niceTop(0, 1, 5)).toBe(5);
    });
});

describe('where the forecast runs out', () => {
    it('marks the hour after the last reading, across all the panel’s series', () => {
        const wave = series(168, (i) => (i < 72 ? 3 : null));
        const period = series(168, (i) => (i < 80 ? 8 : null));
        expect(forecastEnd(168, wave)).toBe(72);
        expect(forecastEnd(168, wave, period)).toBe(80);
    });

    it('is null when the forecast fills the week, 0 when there is nothing', () => {
        expect(
            forecastEnd(
                168,
                series(168, () => 1),
            ),
        ).toBeNull();
        expect(
            forecastEnd(
                168,
                series(168, () => null),
            ),
        ).toBe(0);
    });

    it('treats a gap with readings after it as a gap, not the end', () => {
        expect(
            forecastEnd(
                168,
                series(168, (i) => (i > 20 && i < 30 ? null : 1)),
            ),
        ).toBeNull();
    });
});

describe('limits', () => {
    it('finds the first hour at or over a limit', () => {
        expect(firstAtOrOver([10, null, 21, 22, 25], 22)).toBe(3);
        expect(firstAtOrOver([10, 12], 22)).toBeNull();
    });
});

describe('the models’ spread, on the same hours', () => {
    const block = (start: number, models: [string, string, (number | null)[]][]): SpreadBlock<AtmosVar> => ({
        times: models[0][2].map((_, j) => start + j * H),
        models: models.map(([label, provider, wind]) => ({
            id: label.toLowerCase(),
            label,
            provider,
            hex: '#fff',
            values: { wind_speed_10m: wind } as Record<AtmosVar, (number | null)[]>,
        })),
    });

    it('takes each hour’s lowest and highest model, by epoch hour', () => {
        // The answer starts two hours before the week.
        const band = spreadBand(
            block(T0 - 2 * H, [
                ['ICON', 'DWD', [1, 1, 10, 12, 14]],
                ['ECMWF', 'ECMWF', [1, 1, 14, null, 18]],
                ['AIFS', 'ECMWF', [1, 1, 12, 16, null]],
                ['GEM', 'Environment and Climate Change Canada', [null, null, null, null, null]],
            ]),
            T0,
        );
        expect(band?.lo.slice(0, 4)).toEqual([10, 12, 14, null]);
        expect(band?.hi.slice(0, 4)).toEqual([14, 16, 18, null]);
        expect(band?.models).toEqual(['ICON', 'ECMWF', 'AIFS']);
        expect(band?.providers).toEqual(['DWD', 'ECMWF']);
    });

    it('has no spread under two models, or with no answer', () => {
        expect(spreadBand(block(T0, [['ICON', 'DWD', [10, 12]]]), T0)).toBeNull();
        expect(spreadBand(null, T0)).toBeNull();
    });
});

describe('pressure and its trend', () => {
    // Steady, then a front: down 1.5 hPa an hour from hour 6 to hour 12.
    const p = series(24, (i) => (i <= 6 ? 1016 : i <= 12 ? 1016 - 1.5 * (i - 6) : 1007));

    it('reads each hour’s change over the three before it', () => {
        const change = threeHourChange(p);
        expect(change.slice(0, 3)).toEqual([null, null, null]);
        expect(change[3]).toBe(0);
        expect(change[9]).toBeCloseTo(-4.5);
    });

    it('marks the stretches inside a fall of 3 hPa in 3 h, and draws them on their own', () => {
        const fast = fastFallSegments(p);
        expect(fast[5]).toBe(false);
        expect(fast.slice(6, 12).every(Boolean)).toBe(true);
        expect(fast[13]).toBe(false);
        const d = fastFallPath(p, (v) => v);
        expect(d.match(/M/g)).toHaveLength(1);
        expect(d.startsWith('M6 1016')).toBe(true);
    });

    it('names the steepest fall and the next three hours in the barometer’s words', () => {
        expect(steepestFall(p)).toEqual({ hour: 9, hpa: -4.5 });
        expect(steepestFall(series(10, () => 1013))).toBeNull();
        expect(tendencyNow(p)).toBe('Steady');
        expect(tendencyNow(series(6, (i) => 1016 - 1.4 * i))).toBe('Falling quickly');
        expect(tendencyNow([null, 1, 2, 3])).toBeNull();
    });
});

describe('nights at the spot', () => {
    it('shades from sunset to sunrise in Brisbane, to within a few minutes', () => {
        const nights = nightSpans(T0, METEOGRAM_HOURS, BRISBANE.lat, BRISBANE.lon);
        expect(nights).toHaveLength(7);
        const times = SunCalc.getTimes(new Date(T0 + 2 * H), BRISBANE.lat, BRISBANE.lon);
        const next = SunCalc.getTimes(new Date(T0 + 26 * H), BRISBANE.lat, BRISBANE.lon);
        expect(Math.abs(T0 + nights[0].from * H - times.sunset.getTime())).toBeLessThan(3 * 60_000);
        expect(Math.abs(T0 + nights[0].to * H - next.sunrise.getTime())).toBeLessThan(3 * 60_000);
    });

    it('has no night in a Tromsø June and one long night in its December', () => {
        expect(nightSpans(Date.UTC(2026, 5, 18), METEOGRAM_HOURS, 69.65, 18.96)).toEqual([]);
        expect(nightSpans(Date.UTC(2026, 11, 18), METEOGRAM_HOURS, 69.65, 18.96)).toEqual([
            { from: 0, to: METEOGRAM_HOURS },
        ]);
    });
});

describe('days and times on a clock', () => {
    it('puts midnights where the place’s days start, half-hour zones included', () => {
        const kolkata = dayMarks(T0, METEOGRAM_HOURS, 'Asia/Kolkata');
        expect(kolkata.midnights[0]).toBe(18.5);
        expect(kolkata.midnights).toHaveLength(7);
        expect(kolkata.labels[0]).toEqual({ at: 9.25, text: 'Fri 16' });
    });

    it('names a different day on another clock', () => {
        const honolulu = dayMarks(T0, METEOGRAM_HOURS, 'Pacific/Honolulu');
        expect(honolulu.midnights[0]).toBe(10);
        expect(honolulu.labels[0].text).toBe('Thu 15');
        // A sliver of a day at the end carries no name.
        const brisbane = dayMarks(T0, METEOGRAM_HOURS, 'Australia/Brisbane');
        expect(brisbane.midnights[0]).toBe(14);
        expect(brisbane.labels.map((l) => l.text)).toEqual([
            'Fri 16',
            'Sat 17',
            'Sun 18',
            'Mon 19',
            'Tue 20',
            'Wed 21',
            'Thu 22',
            'Fri 23',
        ]);
    });

    it('formats an hour and names the clock', () => {
        expect(formatHour(T0 + 4 * H, 'Australia/Brisbane')).toBe('Fri 14:00');
        expect(formatHour(T0 + 4 * H, 'Pacific/Honolulu')).toBe('Thu 18:00');
        expect(zoneName(T0, 'Australia/Brisbane')).not.toBe('');
        expect(zoneName(T0, 'Australia/Brisbane')).not.toBe(zoneName(T0, 'Pacific/Honolulu'));
    });
});
