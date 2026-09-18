/**
 * routeSeaSampler — the sea she will be in, and the water moving under her.
 *
 * Every fixture below is shaped from a MEASURED probe of the marine data
 * through the project's own proxy (2026-09-19): the units, the suffixed keys,
 * the snap distances and the land-mask zeros are what the service really sent.
 *
 * What would mislead a skipper: open-water swell painted onto a marina because
 * the service answered from 13 km away; 2.0 m shown as 2.0 ft (or a 1 kn current
 * as 3.6); a land-mask cell read as a flat calm from the north; waves that come
 * FROM confused with a current that sets TOWARD; the last hour held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => ({
    calls: [] as { op: string; params: Record<string, unknown>; points: number }[],
    reply: null as null | ((points: { lat: number; lon: number }[]) => unknown[]),
}));
vi.mock('../services/weather/openMeteoProxy', () => ({
    fetchOpenMeteoPoints: async (
        op: string,
        points: { lat: number; lon: number }[],
        params: Record<string, unknown>,
    ) => {
        proxy.calls.push({ op, params, points: points.length });
        if (!proxy.reply) throw new Error('offline');
        return proxy.reply(points);
    },
}));

import {
    SEA_CURRENT_PROVIDER,
    SEA_WAVE_MODEL,
    SEA_WAVE_PROVIDER,
    __clearRouteSeaCacheForTests,
    currentAlongKts,
    loadRouteSea,
    parseRouteSea,
    sampleRouteSea,
    seaStations,
    type RouteSea,
} from '../services/routeSeaSampler';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 19, 0, 0, 0);
const UNITS = {
    time: 'unixtime',
    wave_height_meteofrance_wave: 'm',
    wave_period_meteofrance_wave: 's',
    wave_direction_meteofrance_wave: '°',
    ocean_current_velocity_meteofrance_wave: 'undefined',
    ocean_current_direction_meteofrance_wave: 'undefined',
    wave_height_marine_best_match: 'm',
    ocean_current_velocity_marine_best_match: 'km/h',
    ocean_current_direction_marine_best_match: '°',
};

type Hour = { h?: number | null; p?: number | null; from?: number | null; kmh?: number | null; set?: number | null };
/** One station's reply, as the service sends it for models=meteofrance_wave,best_match. */
const reply = (
    echo: [number, number] | null,
    hours: number,
    at: (h: number) => Hour,
    units: Record<string, unknown> = UNITS,
) => {
    const col = (pick: (v: Hour) => number | null | undefined) =>
        Array.from({ length: hours }, (_, h) => pick(at(h)) ?? null);
    return {
        ...(echo ? { latitude: echo[0], longitude: echo[1] } : {}),
        hourly_units: units,
        hourly: {
            time: Array.from({ length: hours }, (_, h) => (T0 + h * HOUR) / 1000),
            wave_height_meteofrance_wave: col((v) => v.h),
            wave_period_meteofrance_wave: col((v) => v.p),
            wave_direction_meteofrance_wave: col((v) => v.from),
            // A named wave model carries NO currents: nulls, exactly as measured.
            ocean_current_velocity_meteofrance_wave: col(() => null),
            ocean_current_direction_meteofrance_wave: col(() => null),
            wave_height_marine_best_match: col((v) => v.h),
            ocean_current_velocity_marine_best_match: col((v) => v.kmh),
            ocean_current_direction_marine_best_match: col((v) => v.set),
        },
    };
};

// Gladstone marina → open water. The marina's answer really came from 13.1 km away.
const MARINA = { alongNm: 0, lat: -23.835, lon: 151.255 };
const OPEN = { alongNm: 20, lat: -23.4, lon: 151.8 };
const FURTHER = { alongNm: 40, lat: -23.1, lon: 152.1 };
const MARINA_ECHO: [number, number] = [-23.7917, 151.375]; // ~13 km off
const OPEN_ECHO: [number, number] = [-23.375, 151.7917]; // ~2.9 km off
const FURTHER_ECHO: [number, number] = [-23.125, 152.125];

const sea = (): RouteSea =>
    parseRouteSea(
        [MARINA, OPEN, FURTHER],
        [
            reply(MARINA_ECHO, 12, () => ({ h: 0.36, p: 4.95, from: 94, kmh: 0.2, set: 270 })),
            reply(OPEN_ECHO, 12, (h) => ({ h: 1.0 + h * 0.1, p: 6, from: 100, kmh: 1.852, set: 330 })),
            reply(FURTHER_ECHO, 12, (h) => ({ h: 2.0 + h * 0.1, p: 8, from: 120, kmh: 3.704, set: 350 })),
        ],
        40,
        T0,
    );

beforeEach(() => {
    __clearRouteSeaCacheForTests();
    proxy.calls.length = 0;
    proxy.reply = null;
});
afterEach(() => vi.useRealTimers());

describe('where did that answer really come from?', () => {
    it('a marina answered from 13 km out to sea is INSHORE: it has no sea state, however confident the reply', () => {
        const s = sea().stations[0];
        expect(s.snapKm!).toBeGreaterThan(11);
        expect(s.inshore).toBe(true);
        expect(s.waveM.every((v) => v === null)).toBe(true);
        expect(s.currentKts.every((v) => v === null)).toBe(true);
    });

    it('an open-water station snapped three kilometres is just the grid: believed', () => {
        const s = sea().stations[1];
        expect(s.snapKm!).toBeLessThan(4);
        expect(s.inshore).toBe(false);
        expect(s.waveM[0]).toBe(1.0);
    });

    it('a reply that does not say where it came from is unprovable, and refused', () => {
        const parsed = parseRouteSea(
            [OPEN, FURTHER],
            [
                reply(null, 3, () => ({ h: 1, p: 6, from: 100 })),
                reply(FURTHER_ECHO, 3, () => ({ h: 2, p: 8, from: 120 })),
            ],
            20,
            T0,
        );
        expect(parsed.stations[0].inshore).toBe(true);
        expect(parsed.stations[0].snapKm).toBeNull();
    });

    it('an inshore station is NEVER interpolated through: the open water speaks for its own half of the gap only', () => {
        const near = sampleRouteSea(sea(), 4, T0 + HOUR); // 4 NM out of the marina
        expect(near.inshore).toBe(true);
        expect(near.waveM).toBeNull();
        expect(near.currentKts).toBeNull();
        const out = sampleRouteSea(sea(), 16, T0 + HOUR); // 4 NM from the open-water station
        expect(out.inshore).toBe(false);
        // The open-water station's own value — NOT a lerp down toward the marina's 0.36 m.
        expect(out.waveM).toBeCloseTo(1.1, 6);
    });

    it('a route that never leaves the river is an ANSWER, not a failure: every station inshore, and the strip can say so', () => {
        const river = parseRouteSea(
            [MARINA, { ...MARINA, alongNm: 3 }],
            [
                reply(MARINA_ECHO, 3, () => ({ h: 0.4, p: 5, from: 90 })),
                reply(MARINA_ECHO, 3, () => ({ h: 0.4, p: 5, from: 90 })),
            ],
            3,
            T0,
        );
        expect(river.stations.every((st) => st.inshore)).toBe(true);
        expect(sampleRouteSea(river, 1.5, T0 + HOUR)).toMatchObject({ inshore: true, waveM: null, currentKts: null });
    });

    it('…but a reply that cannot say where ANY of it came from, or is nulls from believed stations, still fails', () => {
        expect(() =>
            parseRouteSea(
                [OPEN, FURTHER],
                [reply(null, 3, () => ({ h: 1, p: 6, from: 100 })), reply(null, 3, () => ({ h: 2, p: 8, from: 120 }))],
                20,
                T0,
            ),
        ).toThrow(/no sea state/);
        expect(() =>
            parseRouteSea(
                [OPEN, FURTHER],
                [reply(OPEN_ECHO, 3, () => ({})), reply(FURTHER_ECHO, 3, () => ({}))],
                20,
                T0,
            ),
        ).toThrow(/no sea state/);
    });

    it('the probe’s own Mackay marina (7.1 km) is REFUSED; the Whitsunday Passage (6.2 km) is believed', () => {
        // The report path's 15% pad believed Mackay. Geometry allows half the grid diagonal
        // (6.34 km at 21°S) plus coordinate rounding; the sea pads 3%.
        const mackay = { alongNm: 0, lat: -21.108, lon: 149.226 };
        const passage = { alongNm: 30, lat: -20.3, lon: 148.9 };
        const parsed = parseRouteSea(
            [mackay, passage],
            [
                reply([-21.125, 149.2917], 3, () => ({ h: 0.52, p: 3.4, from: 106, kmh: 0.9, set: 349 })),
                reply([-20.2917, 148.9583], 3, () => ({ h: 0.62, p: 3.45, from: 118, kmh: 1.5, set: 330 })),
            ],
            30,
            T0,
        );
        expect(parsed.stations[0].snapKm!).toBeGreaterThan(6.9);
        expect(parsed.stations[0].snapKm!).toBeLessThan(7.3);
        expect(parsed.stations[0].inshore).toBe(true);
        expect(parsed.stations[0].waveM.every((v) => v === null)).toBe(true);
        expect(parsed.stations[1].snapKm!).toBeGreaterThan(6.0);
        expect(parsed.stations[1].inshore).toBe(false);
        expect(parsed.stations[1].waveM[0]).toBe(0.62);
    });
});

describe('units and conventions, as measured', () => {
    it('waves stay in METRES here — the strip converts once, for display', () => {
        expect(sampleRouteSea(sea(), 20, T0).waveM).toBe(1.0);
    });

    it('current arrives in km/h and leaves in knots: 1.852 km/h is ONE knot, not 3.6', () => {
        expect(sampleRouteSea(sea(), 20, T0).currentKts).toBeCloseTo(1, 9);
        expect(sampleRouteSea(sea(), 40, T0).currentKts).toBeCloseTo(2, 9);
    });

    it('if the service is ever asked for knots, knots are believed; a unit it does not know is NO data', () => {
        const kn = parseRouteSea(
            [OPEN, FURTHER],
            [
                reply(OPEN_ECHO, 3, () => ({ h: 1, p: 6, from: 100, kmh: 0.8, set: 330 }), {
                    ...UNITS,
                    ocean_current_velocity_marine_best_match: 'kn',
                }),
                reply(FURTHER_ECHO, 3, () => ({ h: 2, p: 8, from: 120, kmh: 0.5, set: 350 }), {
                    ...UNITS,
                    ocean_current_velocity_marine_best_match: 'kn',
                }),
            ],
            20,
            T0,
        );
        expect(sampleRouteSea(kn, 0, T0).currentKts).toBeCloseTo(0.8, 9);
        const odd = parseRouteSea(
            [OPEN, FURTHER],
            [
                reply(OPEN_ECHO, 3, () => ({ h: 1, p: 6, from: 100, kmh: 5, set: 330 }), {
                    ...UNITS,
                    ocean_current_velocity_marine_best_match: 'm/s',
                }),
                reply(FURTHER_ECHO, 3, () => ({ h: 2, p: 8, from: 120, kmh: 5, set: 350 }), {
                    ...UNITS,
                    ocean_current_velocity_marine_best_match: 'm/s',
                }),
            ],
            20,
            T0,
        );
        expect(sampleRouteSea(odd, 0, T0).currentKts).toBeNull();
        expect(sampleRouteSea(odd, 0, T0).waveM).toBe(1); // the waves are untouched by it
    });

    it('waves in anything but metres are no data either — never a number under the wrong unit', () => {
        const feet = parseRouteSea(
            [OPEN, FURTHER],
            [
                reply(OPEN_ECHO, 3, () => ({ h: 3.3, p: 6, from: 100, kmh: 1, set: 330 }), {
                    ...UNITS,
                    wave_height_meteofrance_wave: 'ft',
                }),
                reply(FURTHER_ECHO, 3, () => ({ h: 6.6, p: 8, from: 120, kmh: 1, set: 350 }), {
                    ...UNITS,
                    wave_height_meteofrance_wave: 'ft',
                }),
            ],
            20,
            T0,
        );
        expect(sampleRouteSea(feet, 0, T0).waveM).toBeNull();
    });

    it('a land-mask cell answers 0 m / 0 s / 0° — that is NOT a flat calm from the north', () => {
        const masked = parseRouteSea(
            [OPEN, FURTHER],
            [
                reply(OPEN_ECHO, 3, () => ({ h: 0, p: 0, from: 0, kmh: 1, set: 330 })),
                reply(FURTHER_ECHO, 3, () => ({ h: 2, p: 8, from: 120, kmh: 1, set: 350 })),
            ],
            20,
            T0,
        );
        const s = sampleRouteSea(masked, 0, T0);
        expect(s.waveM).toBeNull();
        expect(s.waveFromDeg).toBeNull();
        expect(s.currentKts).toBeCloseTo(1 / 1.852, 6); // the current there is real
    });

    it('a genuine glassy calm WITH a period is kept: 0.0 m, 3 s', () => {
        const calm = parseRouteSea(
            [OPEN, FURTHER],
            [
                reply(OPEN_ECHO, 3, () => ({ h: 0, p: 3, from: 100 })),
                reply(FURTHER_ECHO, 3, () => ({ h: 0.2, p: 3, from: 100 })),
            ],
            20,
            T0,
        );
        expect(sampleRouteSea(calm, 0, T0).waveM).toBe(0);
    });

    it('reads the NAMED wave model only — best match’s waves are never shown under Météo-France’s name', () => {
        const replyWithoutNamed = reply(OPEN_ECHO, 3, () => ({ h: 1.5, p: 6, from: 100, kmh: 1, set: 330 }));
        const h = replyWithoutNamed.hourly as Record<string, unknown>;
        h.wave_height_meteofrance_wave = [null, null, null];
        h.wave_period_meteofrance_wave = [null, null, null];
        const parsed = parseRouteSea(
            [OPEN, FURTHER],
            [replyWithoutNamed, reply(FURTHER_ECHO, 3, () => ({ kmh: 1, set: 350 }))],
            20,
            T0,
        );
        expect(sampleRouteSea(parsed, 0, T0).waveM).toBeNull(); // although best match had 1.5 m
        expect(SEA_WAVE_MODEL).toBe('meteofrance_wave');
        expect(SEA_WAVE_PROVIDER).toBe('Météo-France');
        expect(SEA_CURRENT_PROVIDER).toBe('Open-Meteo');
    });
});

describe('the place and the moment', () => {
    it('half way between two open-water stations, half way between two hours', () => {
        const s = sampleRouteSea(sea(), 30, T0 + 1.5 * HOUR);
        expect(s.waveM).toBeCloseTo((1.15 + 2.15) / 2, 6);
        expect(s.wavePeriodS).toBeCloseTo(7, 6);
        expect(s.currentKts).toBeCloseTo(1.5, 6);
        expect(s.waveFromDeg).toBeCloseTo(110, 0);
        expect(s.currentSetDeg).toBeCloseTo(340, 0);
    });

    it('a set swinging through north is averaged round north', () => {
        const parsed = parseRouteSea(
            [OPEN, FURTHER],
            [
                reply(OPEN_ECHO, 3, () => ({ h: 1, p: 6, from: 100, kmh: 2, set: 350 })),
                reply(FURTHER_ECHO, 3, () => ({ h: 1, p: 6, from: 100, kmh: 2, set: 10 })),
            ],
            20,
            T0,
        );
        // Half way between the station at 20 NM (350°) and the one at 40 NM (010°).
        const set = sampleRouteSea(parsed, 30, T0).currentSetDeg!;
        expect(Math.min(set, 360 - set)).toBeLessThan(0.001);
    });

    it('slack water has no set: a direction of nothing is not shown', () => {
        const parsed = parseRouteSea(
            [OPEN, FURTHER],
            [
                reply(OPEN_ECHO, 3, () => ({ h: 1, p: 6, from: 100, kmh: 0, set: 90 })),
                reply(FURTHER_ECHO, 3, () => ({ h: 1, p: 6, from: 100, kmh: 0, set: 90 })),
            ],
            20,
            T0,
        );
        const s = sampleRouteSea(parsed, 10, T0);
        expect(s.currentKts).toBe(0);
        expect(s.currentSetDeg).toBeNull();
    });

    it('past the end of the sea forecast is NULLS and says so — never the last hour held', () => {
        const s = sampleRouteSea(sea(), 30, T0 + 20 * HOUR);
        expect(s.waveM).toBeNull();
        expect(s.currentKts).toBeNull();
        expect(s.beyond).toBe(true);
        expect(sampleRouteSea(sea(), 30, T0 + 11 * HOUR + 29 * 60_000).waveM).not.toBeNull();
        expect(sampleRouteSea(sea(), 30, T0 + 11 * HOUR + 31 * 60_000).beyond).toBe(true);
    });

    it('a run the service PADS WITH NULLS is past its forecast from the last hour with a value, not the last timestamp', () => {
        // What the service really does with a model that ends early: the whole axis, nulls after.
        const padded = parseRouteSea(
            [OPEN, FURTHER],
            [
                reply(OPEN_ECHO, 12, (h) => (h <= 5 ? { h: 1, p: 6, from: 100, kmh: 1, set: 330 } : {})),
                reply(FURTHER_ECHO, 12, (h) => (h <= 5 ? { h: 2, p: 8, from: 120, kmh: 1, set: 350 } : {})),
            ],
            20,
            T0,
        );
        expect(sampleRouteSea(padded, 30, T0 + 5 * HOUR).waveM).toBeCloseTo(1.5, 6);
        const past = sampleRouteSea(padded, 30, T0 + 9 * HOUR);
        expect(past.waveM).toBeNull();
        expect(past.beyond).toBe(true);
    });

    it('currents with NO waves at all is not "past the forecast" at +0 h — there is no last wave hour to be past', () => {
        const noWaves = parseRouteSea(
            [OPEN, FURTHER],
            [reply(OPEN_ECHO, 6, () => ({ kmh: 1, set: 330 })), reply(FURTHER_ECHO, 6, () => ({ kmh: 1, set: 350 }))],
            20,
            T0,
        );
        const s0 = sampleRouteSea(noWaves, 30, T0);
        expect(s0.waveM).toBeNull();
        expect(s0.beyond).toBe(false);
        expect(s0.currentKts).not.toBeNull();
    });

    it('is nothing at all without a sea to sample', () => {
        expect(sampleRouteSea(null, 10, T0)).toMatchObject({
            waveM: null,
            currentKts: null,
            inshore: false,
            beyond: false,
        });
    });
});

describe('fair or foul', () => {
    it('a current setting the way she is going is fair; against her, foul; abeam, neither', () => {
        expect(currentAlongKts(1, 0, 0)).toBeCloseTo(1, 9);
        expect(currentAlongKts(1, 180, 0)).toBeCloseTo(-1, 9);
        expect(currentAlongKts(1, 90, 0)).toBeCloseTo(0, 9);
        expect(currentAlongKts(2, 350, 20)).toBeCloseTo(2 * Math.cos(Math.PI / 6), 9); // across north
    });

    it('is nothing without a current, a set or a course', () => {
        expect(currentAlongKts(null, 0, 0)).toBeNull();
        expect(currentAlongKts(1, null, 0)).toBeNull();
        expect(currentAlongKts(1, 0, null)).toBeNull();
    });
});

describe('one request, keyed by the ROUTE — the sea does not change when the wind model does', () => {
    const ROUTE = [
        { lat: -23.4, lon: 151.8 },
        { lat: -22.4, lon: 151.8 },
    ];
    const live = (points: { lat: number; lon: number }[]) =>
        points.map((p) =>
            reply([p.lat + 0.02, p.lon + 0.02], 170, () => ({ h: 1.2, p: 6, from: 110, kmh: 1, set: 330 })),
        );

    it('asks the marine service for the named wave model AND best match, in one call', async () => {
        proxy.reply = live;
        const result = await loadRouteSea(ROUTE);
        expect(result?.stations.length).toBeGreaterThan(1);
        expect(proxy.calls).toHaveLength(1);
        expect(proxy.calls[0].op).toBe('marine');
        expect(proxy.calls[0].params).toMatchObject({
            models: 'meteofrance_wave,best_match',
            timeformat: 'unixtime',
            forecast_hours: 170,
        });
        expect(String(proxy.calls[0].params.hourly)).toContain('ocean_current_velocity');
        // NOT asked for in knots: km/h keeps 0.05-kn resolution where knots rounds to 0.1.
        expect(proxy.calls[0].params.wind_speed_unit).toBeUndefined();
    });

    it('is cached for the hour, shared by two askers, and backs off when it keeps failing', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        expect(await loadRouteSea(ROUTE)).toBeNull(); // offline
        expect(await loadRouteSea(ROUTE)).toBeNull(); // inside the back-off: no second request
        expect(proxy.calls).toHaveLength(1);
        vi.setSystemTime(T0 + 61_000);
        proxy.reply = live;
        const [a, b] = await Promise.all([loadRouteSea(ROUTE), loadRouteSea(ROUTE)]);
        expect(a).not.toBeNull(); // (null === null would have passed this on total failure)
        expect(a).toBe(b);
        expect(proxy.calls).toHaveLength(2);
        await loadRouteSea(ROUTE);
        expect(proxy.calls).toHaveLength(2);
    });
});

describe('the sea has its own stations', () => {
    it('a fifteen-mile hop between two anchorages still has open-water stations in the middle', () => {
        const hop = [
            { lat: -20.27, lon: 148.72 }, // Airlie
            { lat: -20.35, lon: 148.95 }, // Hamilton Island
        ];
        const stations = seaStations(hop);
        expect(stations.length).toBeGreaterThanOrEqual(4);
        const gaps = stations.slice(1).map((s, i) => s.alongNm - stations[i].alongNm);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(5);
        // …and with the two ends refused, the middle still speaks.
        const replies = stations.map((st, i) =>
            reply(
                i === 0 || i === stations.length - 1 ? [st.lat + 0.12, st.lon] : [st.lat + 0.02, st.lon + 0.02],
                6,
                () => ({ h: 0.8, p: 4, from: 120, kmh: 1.5, set: 330 }),
            ),
        );
        const parsed = parseRouteSea(stations, replies, stations[stations.length - 1].alongNm, T0);
        expect(parsed.stations[0].inshore).toBe(true);
        expect(sampleRouteSea(parsed, stations[stations.length - 1].alongNm / 2, T0).waveM).toBeCloseTo(0.8, 6);
        expect(sampleRouteSea(parsed, 0.5, T0).inshore).toBe(true);
    });

    it('a long passage still fits one request', () => {
        const long = [
            { lat: -27, lon: 153 },
            { lat: -20, lon: 149 },
        ];
        expect(seaStations(long).length).toBeLessThanOrEqual(40);
    });
});
