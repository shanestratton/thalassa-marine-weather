/**
 * routeForecastSpread — where the models DISAGREE along the route.
 *
 * Phase 3 of the passage strip. Twelve models exist so that their disagreement
 * is visible; posting one number as fact when they are split by a factor of
 * two is how a forecast becomes wrong in public (measured 2026-07-19 at
 * Newport: ECMWF 12.3 kn, UKMO 28.0 kn, same hour). Probed for this build off
 * Gladstone, 2026-09-19: ECMWF 3.9 kn from 198°, JMA 11.0 kn from 143° — same
 * place, same hour.
 *
 * ONE request for all five models along the route, and it is a SUPERSET of
 * phase 2's: every member is handed to routeForecastSampler's cache, so the
 * pinned model needs no request of its own and changing model in the dialog is
 * instant. If this request fails the strip falls back to phase 2's
 * single-model one — the spread is extra, never a precondition.
 *
 * WHAT THE SPREAD IS, AND IS NOT:
 *   - the strip's HEADLINE stays the chart's one named model (WindStore). The
 *     spread is the range AROUND it. A five-model mean would be a number that
 *     matches no field on the chart and no provider;
 *   - each member is sampled to the ghost's place and moment FIRST, then
 *     min/max is taken. Interpolating an envelope breaks the round-north rule;
 *   - members are COUNTED: "n of 5". A model that runs out (UKMO ≈ day 7) or
 *     returned nothing drops out by name, so a band that narrows late in the
 *     axis is not mistaken for agreement. Fewer than two members is no spread;
 *   - only SUFFIXED keys are read. If a degraded reply ever came back
 *     unsuffixed, reading it for every model would give a perfect, false zero;
 *   - gust spread has at most three members: AIFS and JMA publish none. It is
 *     never filled, and never drawn as though it were the same population;
 *   - direction spread is the short way round, and is not judged in light air,
 *     where five knots from anywhere is not a disagreement;
 *   - thresholds are the Glass convergence sheet's (4 / 8 kn, 20° / 45°), so the
 *     strip and the Glass cannot contradict each other at one place and hour.
 */
import { fetchOpenMeteoPoints } from './weather/openMeteoProxy';
import {
    FORECAST_HOURS,
    FORECAST_TTL_MS,
    primeRouteForecast,
    routeForecastKey,
    routeStations,
    sampleRouteForecast,
    type RouteForecast,
    type RouteStationSeries,
} from './routeForecastSampler';
import type { RoutePoint } from './routeProgress';
import { createLogger } from '../utils/createLogger';

const log = createLogger('RouteSpread');

/**
 * After a failure: a minute, then two, four … up to half an hour. A request the
 * proxy keeps refusing (a 400 for an id it no longer accepts) was being re-sent
 * every two minutes for ever — a quota unit each time, with the headline
 * waiting behind it (review, 2026-09-19). During the back-off this returns at
 * once, so the strip goes straight to its one model.
 */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
export const spreadRetryAfterMs = (failures: number): number =>
    Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
/** Below this, a difference in DIRECTION is light air wandering, not a split. */
export const DIRECTION_JUDGED_FROM_KTS = 6;
/** The Glass convergence sheet's thresholds — keep them the same numbers. */
export const SPREAD_SOME_KTS = 4;
export const SPREAD_SPLIT_KTS = 8;
export const SPREAD_SOME_DEG = 20;
export const SPREAD_SPLIT_DEG = 45;

export type SpreadLevel = 'none' | 'agree' | 'some' | 'split';

export interface RouteSpread {
    /** Every model that was ASKED, in the order asked. */
    asked: string[];
    /** The ones that answered with wind, keyed by model id. */
    members: Record<string, RouteForecast>;
    /** Asked, but returned no wind along this route. Named, not hidden. */
    missing: string[];
    fetchedAt: number;
}

export interface SpreadMember {
    model: string;
    twsKts: number;
    twdDeg: number | null;
    gustKts: number | null;
}

export interface RouteSpreadSample {
    /** Members with a wind speed at this place and moment. */
    members: SpreadMember[];
    /** How many were asked — the "5" in "4 of 5". */
    of: number;
    minKts: number | null;
    maxKts: number | null;
    /** Full range, max − min. NOT a ±. */
    spreadKts: number | null;
    /** Smallest arc holding every member's direction; null in light air or with < 2. */
    dirSpreadDeg: number | null;
    gustMinKts: number | null;
    gustMaxKts: number | null;
    /** Gust members — at most three of the five publish gust. */
    gustCount: number;
    level: SpreadLevel;
}

const NO_SPREAD: RouteSpreadSample = Object.freeze({
    members: [],
    of: 0,
    minKts: null,
    maxKts: null,
    spreadKts: null,
    dirSpreadDeg: null,
    gustMinKts: null,
    gustMaxKts: null,
    gustCount: 0,
    level: 'none' as SpreadLevel,
});

// ── Parse ──────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** SUFFIXED keys only — see the header. */
function suffixed(
    hourly: Record<string, unknown> | undefined,
    key: string,
    model: string,
    length: number,
): (number | null)[] {
    const raw = hourly?.[`${key}_${model}`];
    if (!Array.isArray(raw)) return new Array<number | null>(length).fill(null);
    return Array.from({ length }, (_, i) => num(raw[i]));
}

/** Parse one multi-model reply. Exported for the tests. */
export function parseRouteSpread(
    stations: { alongNm: number; lat: number; lon: number }[],
    replies: { hourly?: Record<string, unknown> }[],
    models: readonly string[],
    totalNm: number,
    fetchedAt: number,
): RouteSpread {
    if (replies.length !== stations.length) throw new Error('misaligned route spread');
    const axes = replies.map((reply) => {
        const time = Array.isArray(reply?.hourly?.time) ? (reply.hourly.time as unknown[]) : [];
        const timesMs: number[] = [];
        for (const t of time) {
            const sec = num(t);
            if (sec === null || (timesMs.length > 0 && sec * 1000 <= timesMs[timesMs.length - 1])) break;
            timesMs.push(sec * 1000);
        }
        return timesMs;
    });

    const members: Record<string, RouteForecast> = {};
    const missing: string[] = [];
    for (const model of models) {
        const series: RouteStationSeries[] = stations.map((station, i) => {
            const hourly = replies[i]?.hourly;
            const n = axes[i].length;
            return {
                ...station,
                timesMs: axes[i],
                speedKts: suffixed(hourly, 'wind_speed_10m', model, n),
                dirDeg: suffixed(hourly, 'wind_direction_10m', model, n),
                gustKts: suffixed(hourly, 'wind_gusts_10m', model, n),
                precipMm: suffixed(hourly, 'precipitation', model, n),
                precipProb: suffixed(hourly, 'precipitation_probability', model, n),
            };
        });
        // Count VALUES, never keys: a model that is not there answers 200 with nulls.
        const winds = series.reduce((sum, s) => sum + s.speedKts.filter((v) => v !== null).length, 0);
        if (winds === 0) missing.push(model);
        else members[model] = { model, fetchedAt, totalNm, stations: series };
    }
    if (Object.keys(members).length === 0) throw new Error('no model returned wind along this route');
    return { asked: [...models], members, missing, fetchedAt };
}

// ── Fetch ──────────────────────────────────────────────────────

interface Entry {
    spread: RouteSpread | null;
    failedAt: number;
    /** Consecutive failures — the back-off grows with it. */
    failures: number;
    inflight: Promise<RouteSpread | null> | null;
}
const cache = new Map<string, Entry>();
const CACHE_MAX = 3;

const spreadKey = (coords: readonly RoutePoint[], models: readonly string[]): string =>
    routeForecastKey(coords, `spread:${models.join('+')}`);

export function peekRouteSpread(
    coords: readonly RoutePoint[],
    models: readonly string[],
    now = Date.now(),
): RouteSpread | null {
    const hit = cache.get(spreadKey(coords, models))?.spread ?? null;
    return hit && now - hit.fetchedAt <= FORECAST_TTL_MS ? hit : null;
}

/** Never rejects. Null = no spread to show; the strip carries on with its one model. */
export async function loadRouteSpread(
    coords: readonly RoutePoint[],
    models: readonly string[],
): Promise<RouteSpread | null> {
    // A duplicated or empty id fails the WHOLE request at the proxy (400) and
    // still costs a quota unit. Do not send one.
    const ids = [...new Set(models.filter((m) => /^[a-z0-9_]+$/.test(m)))];
    if (ids.length < 2) return null;
    const key = spreadKey(coords, ids);
    const now = Date.now();
    let entry = cache.get(key);
    if (entry?.spread && now - entry.spread.fetchedAt <= FORECAST_TTL_MS) return entry.spread;
    if (entry?.inflight) return entry.inflight;
    if (entry && entry.failures > 0 && now - entry.failedAt < spreadRetryAfterMs(entry.failures)) return entry.spread;

    const stations = routeStations(coords);
    if (stations.length < 2) return null;
    const totalNm = stations[stations.length - 1].alongNm;
    if (!entry) {
        entry = { spread: null, failedAt: 0, failures: 0, inflight: null };
        cache.set(key, entry);
        while (cache.size > CACHE_MAX) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
        }
    }
    const mine = entry;
    mine.inflight = (async () => {
        try {
            const replies = await fetchOpenMeteoPoints<{ hourly?: Record<string, unknown> }>('forecast', stations, {
                hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,precipitation_probability',
                models: ids.join(','),
                wind_speed_unit: 'kn',
                timeformat: 'unixtime',
                forecast_hours: FORECAST_HOURS,
            });
            const spread = parseRouteSpread(stations, replies, ids, totalNm, Date.now());
            mine.spread = spread;
            mine.failedAt = 0;
            mine.failures = 0;
            // The superset: every member is now the sampler's own cached series
            // for that model.
            for (const member of Object.values(spread.members)) primeRouteForecast(coords, member);
            if (spread.missing.length > 0) log.warn(`route spread: no wind from ${spread.missing.join(', ')}`);
        } catch (err) {
            mine.failedAt = Date.now();
            mine.failures += 1;
            log.warn(`route spread failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            mine.inflight = null;
        }
        return mine.spread;
    })();
    return mine.inflight;
}

/** Test seam. */
export function __clearRouteSpreadCacheForTests(): void {
    cache.clear();
}

// ── Sample ─────────────────────────────────────────────────────

/** Smallest arc (degrees) that holds every bearing — the short way round. */
export function circularSpreadDeg(bearings: readonly number[]): number | null {
    const a = bearings.filter((b) => Number.isFinite(b)).map((b) => ((b % 360) + 360) % 360);
    if (a.length < 2) return null;
    a.sort((x, y) => x - y);
    let widestGap = 360 - a[a.length - 1] + a[0];
    for (let i = 1; i < a.length; i++) widestGap = Math.max(widestGap, a[i] - a[i - 1]);
    return 360 - widestGap;
}

const worse = (a: SpreadLevel, b: SpreadLevel): SpreadLevel => {
    const order: SpreadLevel[] = ['none', 'agree', 'some', 'split'];
    return order.indexOf(a) >= order.indexOf(b) ? a : b;
};

/** The five models at ONE place and moment on the route. */
export function sampleRouteSpread(spread: RouteSpread | null, alongNm: number, atMs: number): RouteSpreadSample {
    if (!spread) return NO_SPREAD;
    const members: SpreadMember[] = [];
    for (const model of spread.asked) {
        const forecast = spread.members[model];
        if (!forecast) continue;
        const s = sampleRouteForecast(forecast, alongNm, atMs);
        // Past a member's own last wind hour it has nothing to say; it leaves
        // the count rather than narrowing the band with a held number.
        if (s.twsKts === null) continue;
        members.push({ model, twsKts: s.twsKts, twdDeg: s.twdDeg, gustKts: s.gustKts });
    }
    const of = spread.asked.length;
    if (members.length < 2) return { ...NO_SPREAD, members, of };

    const speeds = members.map((m) => m.twsKts);
    const minKts = Math.min(...speeds);
    const maxKts = Math.max(...speeds);
    const spreadKts = maxKts - minKts;
    let level: SpreadLevel = spreadKts >= SPREAD_SPLIT_KTS ? 'split' : spreadKts >= SPREAD_SOME_KTS ? 'some' : 'agree';

    let dirSpreadDeg: number | null = null;
    if (minKts >= DIRECTION_JUDGED_FROM_KTS) {
        dirSpreadDeg = circularSpreadDeg(members.flatMap((m) => (m.twdDeg === null ? [] : [m.twdDeg])));
        if (dirSpreadDeg !== null) {
            level = worse(
                level,
                dirSpreadDeg >= SPREAD_SPLIT_DEG ? 'split' : dirSpreadDeg >= SPREAD_SOME_DEG ? 'some' : 'agree',
            );
        }
    }

    const gusts = members.flatMap((m) => (m.gustKts === null ? [] : [m.gustKts]));
    return {
        members,
        of,
        minKts,
        maxKts,
        spreadKts,
        dirSpreadDeg,
        gustMinKts: gusts.length >= 2 ? Math.min(...gusts) : null,
        gustMaxKts: gusts.length >= 2 ? Math.max(...gusts) : null,
        gustCount: gusts.length,
        level,
    };
}
