/**
 * Plan Your Day, build 124: the trip home reads the ONE-WAY leg's forecasts
 * backwards (services/dayPlanner/mirror.ts).
 *
 * The trap it exists for: routeStations spaces stations evenly with both ends
 * included and at least 10 NM apart, so a round trip [A, B, A] under 20 NM
 * gets two stations, both at A, and the stop is never sampled.
 */
import { describe, expect, it } from 'vitest';
import { mirrorRouteForecast, mirrorRouteSea, mirrorRouteSpread } from '../services/dayPlanner/mirror';
import { routeStations, sampleRouteForecast, type RouteForecast } from '../services/routeForecastSampler';
import { sampleRouteSpread, type RouteSpread } from '../services/routeForecastSpread';
import { sampleRouteSea, type RouteSea } from '../services/routeSeaSampler';
import { routeLengthNm } from '../services/routeProgress';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 7, 20);
const A = { lat: -20.265, lon: 148.719 };
// About 6 NM east of A.
const B = { lat: -20.265, lon: 148.8254 };
const times = Array.from({ length: 24 }, (_, h) => T0 + h * HOUR);

function forecast(model: string, windAt: (alongNm: number) => number, gust: number | null = 20): RouteForecast {
    const total = routeLengthNm([A, B]);
    return {
        model,
        fetchedAt: T0,
        totalNm: total,
        stations: [0, total / 2, total].map((alongNm, i) => ({
            alongNm,
            lat: A.lat,
            lon: A.lon + (B.lon - A.lon) * (i / 2),
            timesMs: [...times],
            speedKts: times.map(() => windAt(alongNm)),
            dirDeg: times.map(() => 135),
            gustKts: times.map(() => gust),
            precipMm: times.map(() => 0),
            precipProb: times.map(() => 0),
        })),
    };
}

function sea(): RouteSea {
    const total = routeLengthNm([A, B]);
    return {
        fetchedAt: T0,
        totalNm: total,
        stations: [0, total / 3, (2 * total) / 3, total].map((alongNm, i) => ({
            alongNm,
            lat: A.lat,
            lon: A.lon + (B.lon - A.lon) * (i / 3),
            // The berth end is snapped too far; the stop end is open water.
            snapKm: i === 0 ? 12 : 3,
            inshore: i === 0,
            timesMs: [...times],
            waveM: times.map(() => (i === 0 ? null : 0.4 + i * 0.1)),
            wavePeriodS: times.map(() => 6),
            waveFromDeg: times.map(() => 120),
            currentKts: times.map(() => 0.3),
            currentSetDeg: times.map(() => 270),
        })),
    };
}

describe('mirrorRouteForecast', () => {
    it('turns the one-way leg round: the stop becomes along 0 and the start becomes the far end', () => {
        const out = forecast('ecmwf_ifs025', (along) => (along < 1 ? 5 : 25));
        const home = mirrorRouteForecast(out);
        const total = out.totalNm;
        expect(home.totalNm).toBe(total);
        expect(home.stations.map((s) => s.alongNm)).toEqual([0, total / 2, total]);
        // Along 0 on the way home is the stop, B: its wind, not A's.
        expect(sampleRouteForecast(home, 0, T0 + 3 * HOUR).twsKts).toBe(25);
        expect(sampleRouteForecast(home, total, T0 + 3 * HOUR).twsKts).toBe(5);
        expect(home.stations[0].lon).toBeCloseTo(B.lon, 6);
        expect(home.model).toBe('ecmwf_ifs025');
        expect(home.fetchedAt).toBe(T0);
    });

    it('is its own inverse and never mutates the leg it was given', () => {
        const out = forecast('ecmwf_ifs025', (along) => 10 + along);
        const before = JSON.parse(JSON.stringify(out));
        expect(mirrorRouteForecast(mirrorRouteForecast(out))).toEqual(out);
        expect(out).toEqual(before);
    });

    it('passes null through', () => {
        expect(mirrorRouteForecast(null)).toBeNull();
        expect(mirrorRouteSpread(null)).toBeNull();
        expect(mirrorRouteSea(null)).toBeNull();
    });
});

describe('mirrorRouteSpread', () => {
    it('mirrors every member and keeps who was asked and who is missing', () => {
        const spread: RouteSpread = {
            asked: ['ecmwf_ifs025', 'dwd_icon', 'jma_gsm'],
            members: {
                ecmwf_ifs025: forecast('ecmwf_ifs025', (along) => (along < 1 ? 6 : 20)),
                dwd_icon: forecast('dwd_icon', (along) => (along < 1 ? 8 : 24)),
            },
            missing: ['jma_gsm'],
            fetchedAt: T0,
        };
        const home = mirrorRouteSpread(spread)!;
        expect(home.asked).toEqual(spread.asked);
        expect(home.missing).toEqual(['jma_gsm']);
        expect(Object.keys(home.members)).toEqual(['ecmwf_ifs025', 'dwd_icon']);
        const atStop = sampleRouteSpread(home, 0, T0 + HOUR);
        expect(atStop.minKts).toBe(20);
        expect(atStop.maxKts).toBe(24);
    });
});

describe('mirrorRouteSea', () => {
    it('keeps each station its own snap verdict: the berth stays inshore at the far end', () => {
        const out = sea();
        const home = mirrorRouteSea(out)!;
        const total = out.totalNm;
        expect(home.stations[home.stations.length - 1].inshore).toBe(true);
        expect(home.stations[0].inshore).toBe(false);
        expect(sampleRouteSea(home, total, T0 + HOUR).inshore).toBe(true);
        expect(sampleRouteSea(home, 0, T0 + HOUR).waveM).toBeCloseTo(0.7, 6);
        expect(mirrorRouteSea(home)).toEqual(out);
    });
});

describe('the round-trip trap the mirror avoids', () => {
    it('a 12 NM round trip [A, B, A] gets two stations, both at A; the one-way leg [A, B] samples B', () => {
        const roundTrip = routeStations([A, B, A]);
        expect(roundTrip).toHaveLength(2);
        for (const s of roundTrip) {
            expect(s.lat).toBeCloseTo(A.lat, 6);
            expect(s.lon).toBeCloseTo(A.lon, 6);
        }
        const oneWay = routeStations([A, B]);
        expect(oneWay[oneWay.length - 1].lon).toBeCloseTo(B.lon, 6);
    });
});
