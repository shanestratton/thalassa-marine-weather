/**
 * routeForecastSpread — where the five models disagree along the route.
 *
 * "Where models disagree, say so." Probed for this build off Gladstone on
 * 2026-09-19: ECMWF 3.9 kn from 198°, JMA 11.0 kn from 143°, same place, same
 * hour. What would mislead a skipper: a "five-model" spread that is quietly
 * three; a band that narrows late in the axis because models RAN OUT, read as
 * agreement; a degraded unsuffixed reply read five times into a perfect false
 * zero; 350° against 010° called a 340° split; light airs from anywhere called
 * a disagreement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proxy = vi.hoisted(() => ({
    calls: [] as { models: string; points: number }[],
    reply: null as null | ((points: { lat: number; lon: number }[], models: string[]) => unknown[]),
}));
vi.mock('../services/weather/openMeteoProxy', () => ({
    fetchOpenMeteoPoints: async (
        _op: string,
        points: { lat: number; lon: number }[],
        params: Record<string, unknown>,
    ) => {
        const models = String(params.models).split(',');
        proxy.calls.push({ models: String(params.models), points: points.length });
        if (!proxy.reply) throw new Error('offline');
        return proxy.reply(points, models);
    },
}));

import {
    __clearRouteSpreadCacheForTests,
    circularSpreadDeg,
    loadRouteSpread,
    parseRouteSpread,
    sampleRouteSpread,
    spreadRetryAfterMs,
} from '../services/routeForecastSpread';
import {
    __clearRouteForecastCacheForTests,
    loadRouteForecast,
    peekRouteForecast,
} from '../services/routeForecastSampler';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 19, 0, 0, 0);
const FIVE = ['dwd_icon', 'ecmwf_ifs025', 'ecmwf_aifs025_single', 'ukmo_global_deterministic_10km', 'jma_gsm'];
const STATIONS = [
    { alongNm: 0, lat: -28, lon: 153 },
    { alongNm: 100, lat: -26.3, lon: 153 },
];
const ROUTE = [
    { lat: -28, lon: 153 },
    { lat: -26, lon: 153 },
];

type Per = { speed?: number | null; dir?: number | null; gust?: number | null };
/** A reply shaped as the service really sends it: one time axis, every model SUFFIXED. */
const reply = (hours: number, per: Record<string, (h: number) => Per>) => {
    const hourly: Record<string, (number | null)[]> = {
        time: Array.from({ length: hours }, (_, h) => (T0 + h * HOUR) / 1000),
    };
    for (const [model, at] of Object.entries(per)) {
        hourly[`wind_speed_10m_${model}`] = [];
        hourly[`wind_direction_10m_${model}`] = [];
        hourly[`wind_gusts_10m_${model}`] = [];
        for (let h = 0; h < hours; h++) {
            const v = at(h);
            hourly[`wind_speed_10m_${model}`].push(v.speed ?? null);
            hourly[`wind_direction_10m_${model}`].push(v.dir ?? null);
            hourly[`wind_gusts_10m_${model}`].push(v.gust ?? null);
        }
    }
    return { hourly };
};

/** The Gladstone probe, as five constant winds. */
const GLADSTONE: Record<string, (h: number) => Per> = {
    dwd_icon: () => ({ speed: 8.8, dir: 152, gust: 11.7 }),
    ecmwf_ifs025: () => ({ speed: 3.9, dir: 198, gust: 8.2 }),
    ecmwf_aifs025_single: () => ({ speed: 4.7, dir: 163 }),
    ukmo_global_deterministic_10km: () => ({ speed: 9.3, dir: 115, gust: 12.4 }),
    jma_gsm: () => ({ speed: 11, dir: 143 }),
};
const spreadOf = (per: Record<string, (h: number) => Per>, hours = 12, asked = FIVE) =>
    parseRouteSpread(STATIONS, [reply(hours, per), reply(hours, per)], asked, 100, T0);

beforeEach(() => {
    __clearRouteSpreadCacheForTests();
    __clearRouteForecastCacheForTests();
    proxy.calls.length = 0;
    proxy.reply = null;
});
afterEach(() => vi.useRealTimers());

describe('the five models at one place and moment', () => {
    it('reads the real Gladstone split: 3.9 to 11 kn is a range of 7.1 — some divergence, by the Glass’s own numbers', () => {
        const s = sampleRouteSpread(spreadOf(GLADSTONE), 50, T0 + 2 * HOUR);
        expect(s.members).toHaveLength(5);
        expect(s.of).toBe(5);
        expect(s.minKts).toBeCloseTo(3.9, 6);
        expect(s.maxKts).toBeCloseTo(11, 6);
        expect(s.spreadKts).toBeCloseTo(7.1, 6);
        expect(s.level).toBe('some');
        // Light air in the set (3.9 kn): direction is NOT judged — it wanders.
        expect(s.dirSpreadDeg).toBeNull();
    });

    it('8 kn or more apart is a SPLIT — the Newport case, 12.3 against 28', () => {
        const s = sampleRouteSpread(
            spreadOf({
                ecmwf_ifs025: () => ({ speed: 12.3, dir: 140 }),
                ukmo_global_deterministic_10km: () => ({ speed: 28, dir: 145 }),
            }),
            50,
            T0 + HOUR,
        );
        expect(s.level).toBe('split');
        expect(s.spreadKts).toBeCloseTo(15.7, 6);
    });

    it('agreeing on speed but not on where it blows from is still a split — judged only in a real breeze', () => {
        const s = sampleRouteSpread(
            spreadOf({
                dwd_icon: () => ({ speed: 16, dir: 100 }),
                ecmwf_ifs025: () => ({ speed: 17, dir: 160 }),
                jma_gsm: () => ({ speed: 15, dir: 120 }),
            }),
            50,
            T0 + HOUR,
        );
        expect(s.spreadKts).toBeCloseTo(2, 6);
        expect(s.dirSpreadDeg).toBeCloseTo(60, 6);
        expect(s.level).toBe('split');
    });

    it('350° against 010° is twenty degrees, not three hundred and forty', () => {
        expect(circularSpreadDeg([350, 10])).toBeCloseTo(20, 9);
        expect(circularSpreadDeg([350, 10, 0, 355])).toBeCloseTo(20, 9);
        expect(circularSpreadDeg([10, 190])).toBeCloseTo(180, 9);
        expect(circularSpreadDeg([90])).toBeNull();
    });

    it('is the range max − min, never a ±', () => {
        const s = sampleRouteSpread(
            spreadOf({ dwd_icon: () => ({ speed: 10, dir: 90 }), jma_gsm: () => ({ speed: 13, dir: 90 }) }),
            50,
            T0 + HOUR,
        );
        expect(s.spreadKts).toBe(3);
        expect(s.level).toBe('agree');
    });

    it('each model is taken to the ghost’s place and moment FIRST, then compared', () => {
        // ICON rises along the route, ECMWF falls: half way they agree exactly.
        const replies = [
            reply(6, { dwd_icon: () => ({ speed: 10, dir: 90 }), ecmwf_ifs025: () => ({ speed: 20, dir: 90 }) }),
            reply(6, { dwd_icon: () => ({ speed: 20, dir: 90 }), ecmwf_ifs025: () => ({ speed: 10, dir: 90 }) }),
        ];
        const spread = parseRouteSpread(STATIONS, replies, ['dwd_icon', 'ecmwf_ifs025'], 100, T0);
        expect(sampleRouteSpread(spread, 50, T0 + HOUR).spreadKts).toBeCloseTo(0, 6);
        expect(sampleRouteSpread(spread, 0, T0 + HOUR).spreadKts).toBeCloseTo(10, 6);
    });
});

describe('who actually answered', () => {
    it('counts and names the members: a model that returned nothing is MISSING, not silently gone', () => {
        const spread = spreadOf({ ...GLADSTONE, jma_gsm: () => ({}) });
        expect(spread.missing).toEqual(['jma_gsm']);
        const s = sampleRouteSpread(spread, 50, T0 + HOUR);
        expect(s.members.map((m) => m.model)).not.toContain('jma_gsm');
        expect(s.members).toHaveLength(4);
        expect(s.of).toBe(5); // "4 of 5", never a quiet "4"
    });

    it('a model that RUNS OUT leaves the count — a narrowing band late in the axis is not agreement', () => {
        const spread = spreadOf(
            {
                dwd_icon: () => ({ speed: 10, dir: 90 }),
                ecmwf_ifs025: () => ({ speed: 12, dir: 90 }),
                ukmo_global_deterministic_10km: (h) => (h <= 4 ? { speed: 25, dir: 90 } : {}),
            },
            12,
        );
        const early = sampleRouteSpread(spread, 50, T0 + 2 * HOUR);
        expect(early.members).toHaveLength(3);
        expect(early.level).toBe('split');
        const late = sampleRouteSpread(spread, 50, T0 + 9 * HOUR);
        expect(late.members).toHaveLength(2);
        expect(late.of).toBe(5);
        expect(late.level).toBe('agree'); // true of the two that are left — and the count says two
    });

    it('fewer than two members is NO spread — one model cannot disagree with itself', () => {
        const s = sampleRouteSpread(spreadOf({ dwd_icon: () => ({ speed: 10, dir: 90 }) }), 50, T0 + HOUR);
        expect(s.level).toBe('none');
        expect(s.minKts).toBeNull();
        expect(s.members).toHaveLength(1);
        expect(sampleRouteSpread(null, 50, T0).level).toBe('none');
    });

    it('gust is compared only among the models that PUBLISH gust — never filled for AIFS or JMA', () => {
        const s = sampleRouteSpread(spreadOf(GLADSTONE), 50, T0 + HOUR);
        expect(s.gustCount).toBe(3);
        expect(s.gustMinKts).toBeCloseTo(8.2, 6);
        expect(s.gustMaxKts).toBeCloseTo(12.4, 6);
    });

    it('reads ONLY suffixed keys: an unsuffixed reply is not five copies of one model agreeing perfectly', () => {
        const degraded = {
            hourly: {
                time: [T0 / 1000, (T0 + HOUR) / 1000],
                wind_speed_10m: [14, 14],
                wind_direction_10m: [90, 90],
            },
        };
        expect(() => parseRouteSpread(STATIONS, [degraded, degraded], FIVE, 100, T0)).toThrow(/no model returned wind/);
    });

    it('refuses a reply that does not line up with its stations', () => {
        expect(() => parseRouteSpread(STATIONS, [reply(3, GLADSTONE)], FIVE, 100, T0)).toThrow(/misaligned/);
    });
});

describe('one request, and it is a superset of the strip’s own', () => {
    const live = (points: { lat: number; lon: number }[]) => points.map(() => reply(170, GLADSTONE));

    it('asks for all five at once, by name, in knots', async () => {
        proxy.reply = live;
        const spread = await loadRouteSpread(ROUTE, FIVE);
        expect(Object.keys(spread!.members)).toHaveLength(5);
        expect(proxy.calls).toEqual([{ models: FIVE.join(','), points: expect.any(Number) }]);
    });

    it('hands every member to the sampler: the pinned model needs NO request of its own, and changing model is instant', async () => {
        proxy.reply = live;
        await loadRouteSpread(ROUTE, FIVE);
        expect(peekRouteForecast(ROUTE, 'jma_gsm')?.model).toBe('jma_gsm');
        const icon = await loadRouteForecast(ROUTE, 'dwd_icon');
        expect(icon?.model).toBe('dwd_icon');
        expect(proxy.calls).toHaveLength(1); // still the one request
    });

    it('never sends a duplicated or malformed id — that fails the WHOLE request at the proxy and still costs quota', async () => {
        proxy.reply = live;
        await loadRouteSpread(ROUTE, ['dwd_icon', 'dwd_icon', 'jma_gsm', 'Spitfire!', '']);
        expect(proxy.calls[0].models).toBe('dwd_icon,jma_gsm');
        expect(await loadRouteSpread(ROUTE, ['dwd_icon'])).toBeNull(); // one model is not a spread
        expect(proxy.calls).toHaveLength(1);
    });

    it('offline is null, not a throw, and it does not hammer the service', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        expect(await loadRouteSpread(ROUTE, FIVE)).toBeNull();
        expect(await loadRouteSpread(ROUTE, FIVE)).toBeNull();
        expect(proxy.calls).toHaveLength(1);
        vi.setSystemTime(T0 + 61_000);
        proxy.reply = live;
        expect((await loadRouteSpread(ROUTE, FIVE))?.asked).toEqual(FIVE);
    });

    it('two askers share one request', async () => {
        proxy.reply = live;
        const [a, b] = await Promise.all([loadRouteSpread(ROUTE, FIVE), loadRouteSpread(ROUTE, FIVE)]);
        expect(a).toBe(b);
        expect(proxy.calls).toHaveLength(1);
    });

    it('backs OFF a request that keeps failing — a minute, two, four … never a quota unit every two minutes for ever', async () => {
        expect([1, 2, 3, 4, 5, 6, 9].map(spreadRetryAfterMs)).toEqual([
            60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000,
        ]);
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        await loadRouteSpread(ROUTE, FIVE); // fails: offline
        vi.setSystemTime(T0 + 61_000);
        await loadRouteSpread(ROUTE, FIVE); // second failure → two minutes now
        expect(proxy.calls).toHaveLength(2);
        vi.setSystemTime(T0 + 61_000 + 100_000);
        await loadRouteSpread(ROUTE, FIVE); // still inside the back-off: returns at once, no request
        expect(proxy.calls).toHaveLength(2);
        vi.setSystemTime(T0 + 61_000 + 121_000);
        proxy.reply = (points) => points.map(() => reply(170, GLADSTONE));
        expect((await loadRouteSpread(ROUTE, FIVE))?.asked).toEqual(FIVE);
        // …and one success forgets the failures.
        expect(proxy.calls).toHaveLength(3);
    });
});
