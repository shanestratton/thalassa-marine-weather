import { describe, expect, it, vi } from 'vitest';
import { suggestPassageDeparture, type PassageDepartureSuggestionInput } from '../services/passageDepartureSuggestion';
import * as windSampler from '../services/routeForecastSampler';
import { FORECAST_TTL_MS, type RouteForecast } from '../services/routeForecastSampler';
import type { RouteSea } from '../services/routeSeaSampler';
import type { RouteIndex } from '../services/routeProgress';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 21, 10);
const index: RouteIndex = {
    points: [
        { lat: -27, lon: 153 },
        { lat: -26.9, lon: 153 },
        { lat: -26.9, lon: 153.1 },
    ],
    cumNm: [0, 6, 12],
    bearingDeg: [0, 90],
    totalNm: 12,
    lastRealLeg: 1,
};
function forecast(value: (hour: number, along: number) => number | null = () => 10): RouteForecast {
    const timesMs = Array.from({ length: 171 }, (_, h) => NOW + h * HOUR);
    return {
        model: 'ecmwf_ifs025',
        fetchedAt: NOW,
        totalNm: 12,
        stations: [0, 12].map((alongNm) => ({
            alongNm,
            lat: -27,
            lon: 153,
            timesMs: [...timesMs],
            speedKts: timesMs.map((_, h) => value(h, alongNm)),
            dirDeg: timesMs.map(() => 180),
            gustKts: timesMs.map(() => 15),
            precipMm: timesMs.map(() => 0),
            precipProb: timesMs.map(() => 0),
        })),
    };
}
function sea(value: (hour: number) => number | null = () => 1): RouteSea {
    const timesMs = Array.from({ length: 171 }, (_, h) => NOW + h * HOUR);
    return {
        fetchedAt: NOW,
        totalNm: 12,
        stations: [0, 12].map((alongNm) => ({
            alongNm,
            lat: -27,
            lon: 153,
            snapKm: 0,
            inshore: false,
            timesMs: [...timesMs],
            waveM: timesMs.map((_, h) => value(h)),
            wavePeriodS: timesMs.map(() => 8),
            waveFromDeg: timesMs.map(() => 180),
            currentKts: timesMs.map(() => 0),
            currentSetDeg: timesMs.map(() => null),
        })),
    };
}
const input = (overrides: Partial<PassageDepartureSuggestionInput> = {}): PassageDepartureSuggestionInput => ({
    index,
    startAlongNm: 2,
    backNm: 0,
    cruiseKts: 5,
    forecast: forecast(),
    sea: sea(),
    nowMs: NOW,
    modelLabel: 'ECMWF',
    ...overrides,
});
const ready = (overrides: Partial<PassageDepartureSuggestionInput> = {}) => {
    const result = suggestPassageDeparture(input(overrides));
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.message);
    return result.suggestion;
};

describe('suggestPassageDeparture', () => {
    it('compares the fixed remaining route and picks lower forecast wind at cruising speed', () => {
        const suggestion = ready({ forecast: forecast((hour) => (hour >= 20 && hour <= 30 ? 5 : 20)) });
        expect(suggestion.departureMs).toBe(NOW + 20 * HOUR);
        expect(suggestion.windowStartMs).toBe(suggestion.departureMs);
        expect(suggestion.windowEndMs).toBe(suggestion.departureMs + 3 * HOUR);
        expect(suggestion.windowDepartures).toBe(4);
        expect(suggestion.modelLabel).toBe('ECMWF');
        expect(suggestion.durationMs).toBe(2 * HOUR);
        expect(suggestion.maxWindKts).toBe(5);
        expect(suggestion.maxWaveM).toBe(1);
        expect(suggestion.windOnly).toBe(false);
        expect(suggestion.comparedDepartures).toBe(120);
    });

    it('samples from current progress, at least hourly, at the corner, and exactly at arrival', () => {
        const sample = vi.spyOn(windSampler, 'sampleRouteForecast');
        ready();
        const firstDeparture = NOW + HOUR;
        const points = sample.mock.calls.filter(([, , at]) => at >= firstDeparture && at <= firstDeparture + 2 * HOUR);
        expect(points.some(([, along, at]) => along === 2 && at === firstDeparture)).toBe(true);
        expect(points.some(([, along, at]) => along === 6 && at === firstDeparture + 0.8 * HOUR)).toBe(true);
        expect(points.some(([, along, at]) => along === 7 && at === firstDeparture + HOUR)).toBe(true);
        expect(points.some(([, along, at]) => along === 12 && at === firstDeparture + 2 * HOUR)).toBe(true);
        expect(sample.mock.calls.every(([, along]) => along >= 2)).toBe(true);
        sample.mockRestore();
    });

    it('allows only near-route comparison, offsets forecast times by the unchecked join, and labels it approximate', () => {
        const sample = vi.spyOn(windSampler, 'sampleRouteForecast');
        const suggestion = ready({ backNm: 0.05 });
        const joinMs = (0.05 / 5) * HOUR;
        expect(suggestion.approximateStart).toBe(true);
        expect(suggestion.uncheckedJoinNm).toBe(0.05);
        expect(suggestion.durationMs).toBe(2 * HOUR + joinMs);
        expect(sample.mock.calls.some(([, along, at]) => along === 2 && at === NOW + HOUR + joinMs)).toBe(true);
        expect(sample.mock.calls.some(([, along, at]) => along === 12 && at === NOW + 3 * HOUR + joinMs)).toBe(true);
        sample.mockRestore();
        expect(suggestPassageDeparture(input({ backNm: 0.050001 }))).toMatchObject({
            status: 'unavailable',
            reason: 'off-route',
        });
        expect(ready({ backNm: 0.000001 }).approximateStart).toBe(true);
    });

    it('never bridges an uncovered hourly candidate into a suggested window', () => {
        const holes = forecast((hour) => (hour === 4 ? null : 10));
        const suggestion = ready({ forecast: holes });
        expect(suggestion.departureMs).toBe(NOW + HOUR);
        expect(suggestion.windowStartMs).toBe(suggestion.departureMs);
        expect(suggestion.windowEndMs).toBe(suggestion.departureMs);
        expect(suggestion.windowDepartures).toBe(1);
    });

    it('does not include neighboring candidates more than 10 percent worse or over a configured limit', () => {
        const roughNext = forecast((hour) => (hour >= 4 ? 30 : 10));
        const suggestion = ready({ forecast: roughNext });
        expect(suggestion.windowDepartures).toBe(1);
        expect(ready({ forecast: roughNext, comfort: { maxWindKts: 15 } }).windowDepartures).toBe(1);
    });

    it('reports maxima across every evaluated departure in the displayed window', () => {
        const suggestion = ready({ forecast: forecast((hour) => (hour >= 4 ? 10.5 : 10)) });
        expect(suggestion.departureMs).toBe(NOW + HOUR);
        expect(suggestion.windowDepartures).toBe(4);
        expect(suggestion.maxWindKts).toBe(10.5);
    });

    it.each([
        [{ cruiseKts: null }, 'profile'],
        [{ cruiseKts: 0 }, 'profile'],
        [{ index: null }, 'route'],
        [{ startAlongNm: null }, 'position'],
        [{ startAlongNm: 12 }, 'position'],
        [{ backNm: 0.5 }, 'off-route'],
    ] as const)('requires a profile, remaining route, and covered start (%j)', (overrides, reason) => {
        expect(suggestPassageDeparture(input(overrides))).toMatchObject({ status: 'unavailable', reason });
    });

    it.each([NOW - FORECAST_TTL_MS - 1, NOW + 1, NaN])(
        'rejects stale or invalid forecast timestamp %s',
        (fetchedAt) => {
            expect(suggestPassageDeparture(input({ forecast: { ...forecast(), fetchedAt } }))).toMatchObject({
                status: 'unavailable',
                reason: 'forecast',
            });
        },
    );

    it('requires complete wind from both spatial neighbors instead of nearest-cell fallback', () => {
        const partial = forecast((_, along) => (along === 0 ? null : 5));
        expect(suggestPassageDeparture(input({ forecast: partial, startAlongNm: 10 }))).toMatchObject({
            status: 'unavailable',
            reason: 'coverage',
        });
    });

    it('rejects internal missing temporal neighbors, even when the display sampler can return a value', () => {
        const partial = forecast((hour) => (hour % 2 === 0 ? null : 5));
        expect(suggestPassageDeparture(input({ forecast: partial }))).toMatchObject({
            status: 'unavailable',
            reason: 'coverage',
        });
    });

    it('does not extend a forecast by the display sampler’s half-hour tolerance', () => {
        const short = forecast();
        for (const station of short.stations) {
            station.timesMs = [NOW, NOW + HOUR, NOW + 2 * HOUR, NOW + 2.75 * HOUR];
            station.speedKts = [10, 10, 10, 10];
            station.dirDeg = [180, 180, 180, 180];
        }
        expect(suggestPassageDeparture(input({ forecast: short }))).toMatchObject({
            status: 'unavailable',
            reason: 'coverage',
        });
    });

    it('rejects omitted forecast hours instead of interpolating across a gap', () => {
        const missingHour = forecast();
        for (const station of missingHour.stations) station.timesMs = [NOW, NOW + 170 * HOUR];
        expect(suggestPassageDeparture(input({ forecast: missingHour }))).toMatchObject({
            status: 'unavailable',
            reason: 'coverage',
        });
    });

    it('rejects a forecast whose stations do not reach the route endpoint', () => {
        const partial = forecast();
        partial.stations[1].alongNm = 11;
        expect(suggestPassageDeparture(input({ forecast: partial }))).toMatchObject({
            status: 'unavailable',
            reason: 'coverage',
        });
    });

    it('enforces configured wind, gust, and wave limits without presenting a clearance', () => {
        for (const comfort of [{ maxWindKts: 9 }, { maxGustKts: 14 }, { maxWaveM: 0.9 }]) {
            expect(suggestPassageDeparture(input({ comfort }))).toMatchObject({
                status: 'unavailable',
                reason: 'limits',
            });
        }
        expect(ready({ comfort: { maxWindKts: 10, maxGustKts: 15, maxWaveM: 1 } }).limits).toEqual({
            maxWindKts: 10,
            maxGustKts: 15,
            maxWaveM: 1,
        });
    });

    it('withholds suggestions when a configured gust or wave limit cannot be checked', () => {
        const noGusts = forecast();
        for (const station of noGusts.stations) station.gustKts.fill(null);
        expect(suggestPassageDeparture(input({ forecast: noGusts, comfort: { maxGustKts: 25 } }))).toMatchObject({
            status: 'unavailable',
            reason: 'coverage',
        });
        expect(suggestPassageDeparture(input({ sea: null, comfort: { maxWaveM: 2 } }))).toMatchObject({
            status: 'unavailable',
            reason: 'coverage',
        });
        expect(ready({ forecast: noGusts }).maxGustKts).toBeNull();
    });

    it('labels missing, stale, and partially inshore sea coverage as wind-only', () => {
        const inshore = sea();
        inshore.stations[0].inshore = true;
        for (const partial of [null, { ...sea(), fetchedAt: NOW - FORECAST_TTL_MS - 1 }, inshore]) {
            const suggestion = ready({ sea: partial });
            expect(suggestion.windOnly).toBe(true);
            expect(suggestion.maxWaveM).toBeNull();
            expect(suggestion.waveComplete).toBe(false);
        }
    });

    it('does not skip an inshore sea station on a fast short route between hourly samples', () => {
        const directIndex: RouteIndex = {
            ...index,
            points: [index.points[0], index.points[2]],
            cumNm: [0, 12],
            bearingDeg: [45],
            lastRealLeg: 0,
        };
        const hiddenInshore = sea();
        hiddenInshore.stations.splice(1, 0, { ...hiddenInshore.stations[0], alongNm: 6, inshore: true });
        expect(ready({ index: directIndex, startAlongNm: 0, cruiseKts: 40, sea: hiddenInshore }).waveComplete).toBe(
            false,
        );
        expect(
            suggestPassageDeparture(
                input({
                    index: directIndex,
                    startAlongNm: 0,
                    cruiseKts: 40,
                    sea: hiddenInshore,
                    comfort: { maxWaveM: 2 },
                }),
            ),
        ).toMatchObject({ status: 'unavailable', reason: 'coverage' });
        hiddenInshore.stations[1].inshore = false;
        hiddenInshore.stations[1].waveM = hiddenInshore.stations[1].waveM.map(() => 10);
        expect(
            suggestPassageDeparture(
                input({
                    index: directIndex,
                    startAlongNm: 0,
                    cruiseKts: 40,
                    sea: hiddenInshore,
                    comfort: { maxWaveM: 2 },
                }),
            ),
        ).toMatchObject({ status: 'unavailable', reason: 'limits' });
    });

    it.each([-1, 0, 999])('rejects a malformed final route leg index %s without throwing', (lastRealLeg) => {
        expect(suggestPassageDeparture(input({ index: { ...index, lastRealLeg } }))).toMatchObject({
            status: 'unavailable',
            reason: 'route',
        });
    });

    it('does not favor a later departure simply because its waves or gusts run out', () => {
        const laterGaps = forecast();
        for (const station of laterGaps.stations)
            station.gustKts = station.gustKts.map((v, hour) => (hour > 8 ? null : v));
        const suggestion = ready({ forecast: laterGaps, sea: sea((hour) => (hour > 8 ? null : 3)) });
        expect(suggestion.departureMs).toBe(NOW + HOUR);
        expect(suggestion.windOnly).toBe(true);
        expect(suggestion.gustsRanked).toBe(false);
        expect(suggestion.maxWaveM).toBe(3);
    });

    it('ranks waves when consistently covered and rejects negative physical values', () => {
        const suggestion = ready({ sea: sea((hour) => (hour >= 20 && hour <= 30 ? 0.5 : 3)) });
        expect(suggestion.departureMs).toBe(NOW + 20 * HOUR);
        expect(suggestion.windOnly).toBe(false);
        expect(suggestPassageDeparture(input({ forecast: forecast(() => -10) }))).toMatchObject({
            status: 'unavailable',
            reason: 'coverage',
        });
    });

    it('does not call truncated or stale spread members agreement', () => {
        const member = forecast();
        const rough = forecast(() => 30);
        const spread = { asked: ['a', 'b'], members: { a: member, b: rough }, missing: [], fetchedAt: NOW };
        expect(ready({ spread }).spreadLevel).toBe('split');
        rough.fetchedAt = NOW - FORECAST_TTL_MS - 1;
        expect(ready({ spread }).spreadLevel).toBe('none');
    });

    it('keeps the five-day candidate bound even if forecast extends further', () => {
        const suggestion = ready({ forecast: forecast((hour) => (hour >= 120 ? 1 : 30)) });
        expect(suggestion.departureMs).toBe(NOW + 120 * HOUR);
        expect(suggestion.departureMs).toBeLessThanOrEqual(NOW + 120 * HOUR);
        expect(suggestion.windowEndMs).toBe(suggestion.departureMs);
    });
});
