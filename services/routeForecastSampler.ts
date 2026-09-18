/**
 * routeForecastSampler — the forecast she will SAIL INTO, not the forecast
 * where she is now.
 *
 * Shane, 2026-09-17: "with the scrubber at the bottom, it needs to show the
 * vessel going along the route as its normal cruising speed … and all of the
 * wind and rain etc should alter as the yacht progresses along the route."
 *
 * So the question is never "what is the wind at 14:00" — it is "what is the
 * wind at 14:00 AT THE PLACE SHE WILL BE at 14:00". This module answers it
 * with ONE batched point-forecast request per (route, model): stations fixed
 * along the whole route, hourly series at each, and a pure sampler that
 * interpolates between the two stations either side of the ghost and the two
 * hours either side of the moment.
 *
 * STATIONS ARE FIXED ON THE ROUTE, not measured from the boat, so the cache
 * stays good as she advances: the same request serves the whole passage until
 * it goes stale.
 *
 * HONESTY:
 *   - one named model, always passed as `models=` — never the provider's
 *     silent default standing in for the one the strip names;
 *   - past the end of the series the answer is `beyond: true` and NULLS. The
 *     last hour is never held as a pretend forecast (WindFieldAdapter.getWind
 *     clamps; this must not);
 *   - a field the model does not publish (AIFS and JMA have no gust) is null,
 *     never borrowed from another model;
 *   - apparent wind here is ARITHMETIC on a forecast and a planned speed. It
 *     is labelled an estimate wherever it is shown.
 */
import { fetchOpenMeteoPoints } from './weather/openMeteoProxy';
import { pointAlongRoute, routeLengthNm, type RoutePoint } from './routeProgress';
import { createLogger } from '../utils/createLogger';

const log = createLogger('RouteForecast');

/** One request is 50 points at most (proxy-openmeteo); stay well inside it. */
export const MAX_STATIONS = 40;
/** Closer than this and neighbouring stations share a model grid cell. */
export const MIN_STATION_SPACING_NM = 10;
/**
 * Shane 2026-09-18: seven days. The series starts at the FLOORED current hour,
 * so "now + 168 h" lands up to 59 minutes past hour 168: +2, so the far end of
 * a seven-day scrub always has an hour either side of it. (+1 left the last
 * tick flipping between a number and PAST FORECAST depending on the minute.)
 */
export const FORECAST_HOURS = 7 * 24 + 2;
/** A series this old is refetched; models run six-hourly. */
export const FORECAST_TTL_MS = 60 * 60_000;
/** After a failed fetch, do not ask again for this long. */
const RETRY_AFTER_MS = 60_000;
/**
 * Further than this outside the series is off it. Half an hour: the reach of
 * "the nearest hour", and no more. At 90 minutes — the tolerance the waypoint
 * report uses for a nearest-hour LOOKUP — this held the last hour's wind for an
 * hour and a half past the end of the forecast, which is the one thing the
 * look-ahead promises never to do (review, 2026-09-18).
 */
const BEYOND_MS = 30 * 60_000;

export interface RouteStationSeries {
    alongNm: number;
    lat: number;
    lon: number;
    /** Valid times, epoch ms, ascending. */
    timesMs: number[];
    speedKts: (number | null)[];
    dirDeg: (number | null)[];
    gustKts: (number | null)[];
    precipMm: (number | null)[];
    precipProb: (number | null)[];
}

export interface RouteForecast {
    /** Open-Meteo model-domain id the numbers came from. */
    model: string;
    fetchedAt: number;
    totalNm: number;
    stations: RouteStationSeries[];
}

export interface RouteForecastSample {
    twsKts: number | null;
    /** Direction the wind blows FROM, degrees true. */
    twdDeg: number | null;
    gustKts: number | null;
    /** Millimetres in the hour. */
    precipMm: number | null;
    /** Percent. */
    precipProb: number | null;
    /** The moment is outside the series: every field above is null. */
    beyond: boolean;
}

const EMPTY: RouteForecastSample = Object.freeze({
    twsKts: null,
    twdDeg: null,
    gustKts: null,
    precipMm: null,
    precipProb: null,
    beyond: false,
});

// ── Stations ───────────────────────────────────────────────────

/** Stations along the WHOLE route, both ends included, evenly spaced. */
export function routeStations(coords: readonly RoutePoint[]): { alongNm: number; lat: number; lon: number }[] {
    const totalNm = routeLengthNm(coords.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)));
    if (!(totalNm > 0)) return [];
    const count = Math.max(2, Math.min(MAX_STATIONS, Math.floor(totalNm / MIN_STATION_SPACING_NM) + 1));
    const out: { alongNm: number; lat: number; lon: number }[] = [];
    for (let i = 0; i < count; i++) {
        const alongNm = (totalNm * i) / (count - 1);
        const at = pointAlongRoute(coords, alongNm);
        if (!at) return [];
        out.push({ alongNm, lat: at.lat, lon: at.lon });
    }
    return out;
}

/** Identity of a route for the cache: its ends, its length and its shape. */
export function routeForecastKey(coords: readonly RoutePoint[], model: string): string {
    let h = 2166136261;
    for (const p of coords) {
        const lat = Math.round((p?.lat ?? 0) * 1e4);
        const lon = Math.round((p?.lon ?? 0) * 1e4);
        h = Math.imul(h ^ lat, 16777619);
        h = Math.imul(h ^ lon, 16777619);
    }
    return `${model}:${coords.length}:${(h >>> 0).toString(36)}`;
}

// ── Fetch ──────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

type Hourly = Record<string, unknown> | undefined;

/** Open-Meteo suffixes the key with the model id when it feels like it. */
function series(hourly: Hourly, key: string, model: string, length: number): (number | null)[] {
    const raw = hourly?.[key] ?? hourly?.[`${key}_${model}`];
    if (!Array.isArray(raw)) return new Array<number | null>(length).fill(null);
    return Array.from({ length }, (_, i) => num(raw[i]));
}

/** Parse one batched reply. Exported for the tests; throws on a useless one. */
export function parseRouteForecast(
    stations: { alongNm: number; lat: number; lon: number }[],
    replies: { hourly?: Record<string, unknown> }[],
    model: string,
    totalNm: number,
    fetchedAt: number,
): RouteForecast {
    if (replies.length !== stations.length) throw new Error('misaligned route forecast');
    const out: RouteStationSeries[] = stations.map((station, i) => {
        const hourly = replies[i]?.hourly;
        const time = Array.isArray(hourly?.time) ? (hourly.time as unknown[]) : [];
        const timesMs: number[] = [];
        for (const t of time) {
            const sec = num(t);
            if (sec === null || (timesMs.length > 0 && sec * 1000 <= timesMs[timesMs.length - 1])) break;
            timesMs.push(sec * 1000);
        }
        const n = timesMs.length;
        return {
            ...station,
            timesMs,
            speedKts: series(hourly, 'wind_speed_10m', model, n),
            dirDeg: series(hourly, 'wind_direction_10m', model, n),
            gustKts: series(hourly, 'wind_gusts_10m', model, n),
            precipMm: series(hourly, 'precipitation', model, n),
            precipProb: series(hourly, 'precipitation_probability', model, n),
        };
    });
    // HTTP 200 with every wind value null is a model that is not there (the
    // GFS lesson, 2026-07-21). Count values, never keys.
    const winds = out.reduce((sum, s) => sum + s.speedKts.filter((v) => v !== null).length, 0);
    if (winds === 0) throw new Error(`${model} returned no wind along this route`);
    return { model, fetchedAt, totalNm, stations: out };
}

interface CacheEntry {
    forecast: RouteForecast | null;
    failedAt: number;
    inflight: Promise<RouteForecast | null> | null;
}
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 6;

/** The cached series, if there is one and it is still fresh. No fetch. */
export function peekRouteForecast(
    coords: readonly RoutePoint[],
    model: string,
    now = Date.now(),
): RouteForecast | null {
    const hit = cache.get(routeForecastKey(coords, model))?.forecast ?? null;
    return hit && now - hit.fetchedAt <= FORECAST_TTL_MS ? hit : null;
}

/**
 * The series for this route and model. Never rejects: null means "no forecast
 * to show" (offline, the service said no, the model has no wind here), and the
 * strip shows dashes.
 */
export async function loadRouteForecast(coords: readonly RoutePoint[], model: string): Promise<RouteForecast | null> {
    const key = routeForecastKey(coords, model);
    const now = Date.now();
    let entry = cache.get(key);
    if (entry?.forecast && now - entry.forecast.fetchedAt <= FORECAST_TTL_MS) return entry.forecast;
    if (entry?.inflight) return entry.inflight;
    // A stale series beats nothing while the service is down, but only until
    // it no longer reaches NOW — `sampleRouteForecast` decides that per moment.
    if (entry && now - entry.failedAt < RETRY_AFTER_MS) return entry.forecast;

    const stations = routeStations(coords);
    if (stations.length < 2) return null;
    const totalNm = stations[stations.length - 1].alongNm;

    if (!entry) {
        entry = { forecast: null, failedAt: 0, inflight: null };
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
                models: model,
                wind_speed_unit: 'kn',
                timeformat: 'unixtime',
                forecast_hours: FORECAST_HOURS,
            });
            mine.forecast = parseRouteForecast(stations, replies, model, totalNm, Date.now());
            mine.failedAt = 0;
        } catch (err) {
            mine.failedAt = Date.now();
            // log.warn, not info: info is a no-op in production builds, and a
            // strip of dashes at sea needs a reason in the device log.
            log.warn(`route forecast (${model}) failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            mine.inflight = null;
        }
        return mine.forecast;
    })();
    return mine.inflight;
}

/** Test seam. */
export function __clearRouteForecastCacheForTests(): void {
    cache.clear();
}

// ── Sample ─────────────────────────────────────────────────────

interface PointValue {
    speed: number | null;
    /** Unit vector of the FROM direction, so directions average round north. */
    ux: number | null;
    uy: number | null;
    gust: number | null;
    precip: number | null;
    prob: number | null;
}

const lerp = (a: number | null, b: number | null, t: number): number | null =>
    a === null ? (t >= 0.5 ? b : null) : b === null ? (t < 0.5 ? a : null) : a + (b - a) * t;

/** One station at one moment, or null when the moment is off its series. */
function stationAt(s: RouteStationSeries, atMs: number): PointValue | null {
    const n = s.timesMs.length;
    if (n === 0) return null;
    if (atMs < s.timesMs[0] - BEYOND_MS || atMs > s.timesMs[n - 1] + BEYOND_MS) return null;
    let hi = s.timesMs.findIndex((t) => t >= atMs);
    if (hi === -1) hi = n - 1;
    const lo = hi > 0 && s.timesMs[hi] > atMs ? hi - 1 : hi;
    const span = s.timesMs[hi] - s.timesMs[lo];
    const t = span > 0 ? Math.max(0, Math.min(1, (atMs - s.timesMs[lo]) / span)) : 0;
    const unit = (i: number, axis: 'x' | 'y'): number | null => {
        const d = s.dirDeg[i];
        if (d === null) return null;
        const r = (d * Math.PI) / 180;
        return axis === 'x' ? Math.sin(r) : Math.cos(r);
    };
    return {
        speed: lerp(s.speedKts[lo], s.speedKts[hi], t),
        ux: lerp(unit(lo, 'x'), unit(hi, 'x'), t),
        uy: lerp(unit(lo, 'y'), unit(hi, 'y'), t),
        gust: lerp(s.gustKts[lo], s.gustKts[hi], t),
        // Rain is an hourly TOTAL stamped on the hour it ends: take the hour
        // she is in, do not smear two hours into each other.
        precip: s.precipMm[hi],
        prob: s.precipProb[hi],
    };
}

/**
 * When this station's forecast really ends: its last hour with a WIND VALUE.
 * Open-Meteo sends the whole axis that was asked for and pads a model that
 * runs out sooner with nulls (UKMO stops near day 7, the request asks past
 * it) — so the last TIMESTAMP says nothing. Without this the strip showed bare
 * dashes past a model's horizon and never the words that explain them.
 */
function lastWindMs(s: RouteStationSeries): number {
    for (let i = s.timesMs.length - 1; i >= 0; i--) {
        if (s.speedKts[i] !== null) return s.timesMs[i];
    }
    return -Infinity;
}

/**
 * The forecast at `alongNm` down the route at `atMs`. Speed is interpolated as
 * a scalar and direction as a unit vector — interpolating u and v together
 * makes a 20-knot shift from NE to SE read as 14 knots of easterly half way.
 */
export function sampleRouteForecast(
    forecast: RouteForecast | null,
    alongNm: number,
    atMs: number,
): RouteForecastSample {
    if (!forecast || forecast.stations.length === 0 || !Number.isFinite(alongNm) || !Number.isFinite(atMs)) {
        return EMPTY;
    }
    const st = forecast.stations;
    const want = Math.max(st[0].alongNm, Math.min(alongNm, st[st.length - 1].alongNm));
    let hi = st.findIndex((s) => s.alongNm >= want);
    if (hi === -1) hi = st.length - 1;
    const lo = hi > 0 && st[hi].alongNm > want ? hi - 1 : hi;
    const span = st[hi].alongNm - st[lo].alongNm;
    const t = span > 0 ? (want - st[lo].alongNm) / span : 0;

    const a = stationAt(st[lo], atMs);
    const b = stationAt(st[hi], atMs);
    if (!a && !b) return { ...EMPTY, beyond: true };
    const pick = (key: keyof PointValue): number | null =>
        a && b ? lerp(a[key], b[key], t) : ((a ?? b) as PointValue)[key];

    // No wind, and the moment is past the last hour either station HAS wind
    // for: that is the end of the model's run, and it is said in words.
    if (pick('speed') === null && atMs > Math.max(lastWindMs(st[lo]), lastWindMs(st[hi]))) {
        return { ...EMPTY, beyond: true };
    }

    const ux = pick('ux');
    const uy = pick('uy');
    const twdDeg =
        ux === null || uy === null || (Math.abs(ux) < 1e-9 && Math.abs(uy) < 1e-9)
            ? null
            : ((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360;
    const near = t < 0.5 ? (a ?? b) : (b ?? a);
    return {
        twsKts: pick('speed'),
        twdDeg,
        gustKts: pick('gust'),
        precipMm: near?.precip ?? null,
        precipProb: near?.prob ?? null,
        beyond: false,
    };
}

// ── Apparent wind, estimated ───────────────────────────────────

/**
 * Apparent wind for a boat making `boatKts` on `courseDeg` through a true wind
 * of `twsKts` FROM `twdDeg`. Angle is signed: negative to port, positive to
 * starboard, the Instrument Panel's convention. An ESTIMATE by construction —
 * forecast wind, planned speed, the route's bearing standing in for a heading,
 * no leeway, no current.
 */
export function estimateApparentWind(
    twsKts: number | null,
    twdDeg: number | null,
    boatKts: number,
    courseDeg: number,
): { awsKts: number; awaDeg: number } | null {
    if (twsKts === null || twdDeg === null || !Number.isFinite(boatKts) || !Number.isFinite(courseDeg)) return null;
    // True wind angle off the bow, signed (+ starboard).
    const twa = ((((twdDeg - courseDeg) % 360) + 540) % 360) - 180;
    const r = (twa * Math.PI) / 180;
    // Bow-frame components of the wind she feels: true wind plus her own way.
    const ahead = twsKts * Math.cos(r) + Math.max(0, boatKts);
    const abeam = twsKts * Math.sin(r);
    const awsKts = Math.hypot(ahead, abeam);
    if (awsKts < 1e-6) return { awsKts: 0, awaDeg: 0 };
    return { awsKts, awaDeg: (Math.atan2(abeam, ahead) * 180) / Math.PI };
}
