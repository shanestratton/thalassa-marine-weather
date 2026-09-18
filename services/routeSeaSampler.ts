/**
 * routeSeaSampler — the sea she will be in, and the water moving under her.
 *
 * Phase 4 of the passage strip (Shane 2026-09-19, "phase 4 - go"): sea state
 * and current at the ghost's place and moment. It began with a MEASURED PROBE
 * of the marine data through this project's own proxy (docs/PASSAGE_HUD.md has
 * the table), because the survey before phase 3 found this data misreports
 * near the coast in ways that produce a confident wrong number. What the probe
 * found decides everything below:
 *
 *   1. SNAPPING. An inshore request is not refused and does not return nulls:
 *      it is answered from the nearest WET cell, confidently. Gladstone marina
 *      came back from 13.1 km away, Newport from 10.7 km — open-water swell
 *      painted onto a berth. Route ends are usually berths. So every station's
 *      ECHOED coordinates are checked against the app's existing guard
 *      (maxLegitimateSnapKm: half the 1/12° grid diagonal). A station snapped
 *      further than that — or that did not echo its position at all — is
 *      INSHORE: it has no sea state, and it is never interpolated through.
 *   2. ONE NAMED WAVE MODEL, the right one for this coast. Météo-France MFWAM
 *      (1/12°) is what "best match" resolves to here, snaps 3–7 km in open
 *      water, and ANSWERS INSIDE THE REEF. The 0.25° models snap 10–27 km;
 *      ECMWF WAM is null in the Whitsunday Passage, and GFS Wave returned a
 *      literal 0 m / 0 s / 0° for Gladstone harbour (a land-mask cell, which
 *      is refused here whoever sends it). So there is no wave "spread": four
 *      models that mostly cannot see the water she is in are not a second
 *      opinion.
 *   3. CURRENTS COME ONLY WITH "best match" — every named wave model returns
 *      nulls for them. One request carries both: models=meteofrance_wave,
 *      best_match, read as wave_*_meteofrance_wave and
 *      ocean_current_*_marine_best_match. Suffixed keys only.
 *   4. THE CURRENT IS TIDAL BUT COARSE. In the Whitsunday Passage it swings
 *      0.8 kn → slack → reverses over about twelve hours — but this is a
 *      five-mile grid reading 0.8 kn in a passage that runs two to four. It is
 *      shown marked approximate, it is NEVER folded into the ETA, and no
 *      wind-against-tide warning is built on it: a warning that under-reads is
 *      a false all-clear.
 *   5. UNITS. Waves arrive in METRES (the app's report path holds feet — use
 *      convertMetersTo, never convertLength). Current arrives in KM/H (the
 *      legacy path assumes m/s and would read it 3.6x fast). The reply's own
 *      hourly_units are checked; a unit this module does not recognise is no
 *      data. Wave direction is where it comes FROM; current is where it SETS.
 *
 * Keyed by ROUTE only — the sea does not change when the skipper picks another
 * wind model — so changing model costs no second marine request.
 */
import { fetchOpenMeteoPoints } from './weather/openMeteoProxy';
import { maxLegitimateSnapKm } from './weather/api/marine';
import { FORECAST_HOURS, FORECAST_TTL_MS, routeForecastKey, routeStations } from './routeForecastSampler';
import type { RoutePoint } from './routeProgress';
import { calculateDistance } from '../utils/navigationCalculations';
import { createLogger } from '../utils/createLogger';

const log = createLogger('RouteSea');

/** The wave model, by name: the finest grid on this coast, and what answers inside the reef. */
export const SEA_WAVE_MODEL = 'meteofrance_wave';
export const SEA_WAVE_PROVIDER = 'Météo-France';
/** Currents have no model of their own to name: they come with Open-Meteo's marine best match. */
const CURRENT_SUFFIX = 'marine_best_match';
export const SEA_CURRENT_PROVIDER = 'Open-Meteo';

/**
 * The sea's OWN stations: no further apart than the wave grid is coarse (~5 NM),
 * and never fewer than four. Both ends of a route are usually berths the model
 * cannot see; on the wind's 10-NM stations a fifteen-mile hop between two
 * anchorages was two stations, both refused, and no sea state at all — which is
 * most of what a skipper cruising the Whitsundays sails. Same request, same one
 * quota unit: only the points differ.
 */
export const SEA_STATION_SPACING_NM = 4;
export const SEA_MIN_STATIONS = 4;
export const seaStations = (coords: readonly RoutePoint[]) =>
    routeStations(coords, SEA_STATION_SPACING_NM, SEA_MIN_STATIONS);

/**
 * How far past half the grid diagonal a snap is still believed. Geometry says a
 * point in open water is NEVER further than half the diagonal from its own cell's
 * centre (6.34 km at 21°S); the only honest slack is coordinate rounding (the
 * request is sent to four decimals, ~8 m). The report path pads 15%, and that
 * band BELIEVED THE PROBE'S OWN MACKAY MARINA (7.1 km) — open-coast sea painted
 * onto a berth (review, 2026-09-19). At 3% Mackay is refused (bound 6.53 km) and
 * the Whitsunday Passage (6.2 km) and the offshore probe (5.3 km) are still believed.
 */
const SEA_SNAP_PAD = 1.03;

const NM_TO_KM = 1.852;
const BEYOND_MS = 30 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

export interface SeaStationSeries {
    alongNm: number;
    lat: number;
    lon: number;
    /** How far the service reached for a wet cell, km; null when it did not echo a position. */
    snapKm: number | null;
    /** Snapped too far (or unprovable): this station has NO sea state. */
    inshore: boolean;
    timesMs: number[];
    waveM: (number | null)[];
    wavePeriodS: (number | null)[];
    /** Direction the waves come FROM, degrees true. */
    waveFromDeg: (number | null)[];
    currentKts: (number | null)[];
    /** Direction the water SETS toward, degrees true. */
    currentSetDeg: (number | null)[];
}

export interface RouteSea {
    fetchedAt: number;
    totalNm: number;
    stations: SeaStationSeries[];
}

export interface RouteSeaSample {
    waveM: number | null;
    wavePeriodS: number | null;
    waveFromDeg: number | null;
    currentKts: number | null;
    currentSetDeg: number | null;
    /** The ghost is off a station the service could only answer from open water. */
    inshore: boolean;
    /** The moment is past the last hour that has a wave value. */
    beyond: boolean;
}

const EMPTY: RouteSeaSample = Object.freeze({
    waveM: null,
    wavePeriodS: null,
    waveFromDeg: null,
    currentKts: null,
    currentSetDeg: null,
    inshore: false,
    beyond: false,
});

// ── Parse ──────────────────────────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface SeaReply {
    latitude?: unknown;
    longitude?: unknown;
    hourly?: Record<string, unknown>;
    hourly_units?: Record<string, unknown>;
}

function column(hourly: Record<string, unknown> | undefined, key: string, length: number): (number | null)[] {
    const raw = hourly?.[key];
    if (!Array.isArray(raw)) return new Array<number | null>(length).fill(null);
    return Array.from({ length }, (_, i) => num(raw[i]));
}

/** Parse one batched marine reply. Exported for the tests; throws on a useless one. */
export function parseRouteSea(
    stations: { alongNm: number; lat: number; lon: number }[],
    replies: SeaReply[],
    totalNm: number,
    fetchedAt: number,
): RouteSea {
    if (replies.length !== stations.length) throw new Error('misaligned route sea');
    const out: SeaStationSeries[] = stations.map((station, i) => {
        const reply = replies[i];
        const hourly = reply?.hourly;
        const units = reply?.hourly_units;
        const time = Array.isArray(hourly?.time) ? (hourly.time as unknown[]) : [];
        const timesMs: number[] = [];
        for (const t of time) {
            const sec = num(t);
            if (sec === null || (timesMs.length > 0 && sec * 1000 <= timesMs[timesMs.length - 1])) break;
            timesMs.push(sec * 1000);
        }
        const n = timesMs.length;

        // Where did this answer really come from?
        const gotLat = num(reply?.latitude);
        const gotLon = num(reply?.longitude);
        const snapKm =
            gotLat === null || gotLon === null
                ? null
                : calculateDistance(station.lat, station.lon, gotLat, gotLon) * NM_TO_KM;
        // Unprovable is refused, as mapMarine does for the single-point reading.
        const inshore = snapKm === null || snapKm > maxLegitimateSnapKm(station.lat, SEA_SNAP_PAD);

        const nothing = () => new Array<number | null>(n).fill(null);
        const waveUnitOk = units?.[`wave_height_${SEA_WAVE_MODEL}`] === 'm';
        let waveM = inshore || !waveUnitOk ? nothing() : column(hourly, `wave_height_${SEA_WAVE_MODEL}`, n);
        let wavePeriodS = inshore || !waveUnitOk ? nothing() : column(hourly, `wave_period_${SEA_WAVE_MODEL}`, n);
        let waveFromDeg = inshore || !waveUnitOk ? nothing() : column(hourly, `wave_direction_${SEA_WAVE_MODEL}`, n);
        // A land-mask cell answers 0 m / 0 s / 0°. That is not a flat calm from the north.
        for (let h = 0; h < n; h++) {
            if (waveM[h] === 0 && (wavePeriodS[h] === 0 || wavePeriodS[h] === null)) {
                waveM[h] = null;
                wavePeriodS[h] = null;
                waveFromDeg[h] = null;
            }
        }
        if (!waveM.some((v) => v !== null)) {
            waveM = nothing();
            wavePeriodS = nothing();
            waveFromDeg = nothing();
        }

        // km/h as it comes; knots if a caller ever asks the service for them.
        const currentUnit = units?.[`ocean_current_velocity_${CURRENT_SUFFIX}`];
        const toKts = currentUnit === 'km/h' ? 1 / NM_TO_KM : currentUnit === 'kn' ? 1 : null;
        const currentKts =
            inshore || toKts === null
                ? nothing()
                : column(hourly, `ocean_current_velocity_${CURRENT_SUFFIX}`, n).map((v) =>
                      v === null ? null : v * toKts,
                  );
        const currentSetDeg =
            inshore || toKts === null ? nothing() : column(hourly, `ocean_current_direction_${CURRENT_SUFFIX}`, n);

        return { ...station, snapKm, inshore, timesMs, waveM, wavePeriodS, waveFromDeg, currentKts, currentSetDeg };
    });
    const values = out.reduce(
        (sum, s) => sum + s.waveM.filter((v) => v !== null).length + s.currentKts.filter((v) => v !== null).length,
        0,
    );
    // Every station answered and every one was PROVABLY snapped too far: a route
    // that never leaves the river. That is an ANSWER, not a failure — it is kept
    // for the hour and the strip says INSHORE. (Treated as a failure it read "NO
    // DATA", offline's words, and was re-requested six times in its first hour and
    // every half hour for ever.) A reply of nulls from stations that were NOT
    // refused, or one that does not say where it came from, still is a failure.
    const allProvenInshore = out.length > 0 && out.every((s) => s.inshore && s.snapKm !== null);
    if (values === 0 && !allProvenInshore) throw new Error('no sea state or current along this route');
    return { fetchedAt, totalNm, stations: out };
}

// ── Fetch ──────────────────────────────────────────────────────

interface Entry {
    sea: RouteSea | null;
    failedAt: number;
    failures: number;
    inflight: Promise<RouteSea | null> | null;
}
const cache = new Map<string, Entry>();
const CACHE_MAX = 3;

const seaKey = (coords: readonly RoutePoint[]): string => routeForecastKey(coords, 'sea');
const retryAfterMs = (failures: number): number =>
    Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));

export function peekRouteSea(coords: readonly RoutePoint[], now = Date.now()): RouteSea | null {
    const hit = cache.get(seaKey(coords))?.sea ?? null;
    return hit && now - hit.fetchedAt <= FORECAST_TTL_MS ? hit : null;
}

/** Never rejects. Null = no sea to show; the strip's wind carries on without it. */
export async function loadRouteSea(coords: readonly RoutePoint[]): Promise<RouteSea | null> {
    const key = seaKey(coords);
    const now = Date.now();
    let entry = cache.get(key);
    if (entry?.sea && now - entry.sea.fetchedAt <= FORECAST_TTL_MS) return entry.sea;
    if (entry?.inflight) return entry.inflight;
    if (entry && entry.failures > 0 && now - entry.failedAt < retryAfterMs(entry.failures)) return entry.sea;

    const stations = seaStations(coords);
    if (stations.length < 2) return null;
    const totalNm = stations[stations.length - 1].alongNm;
    if (!entry) {
        entry = { sea: null, failedAt: 0, failures: 0, inflight: null };
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
            const replies = await fetchOpenMeteoPoints<SeaReply>('marine', stations, {
                hourly: 'wave_height,wave_period,wave_direction,ocean_current_velocity,ocean_current_direction',
                // The named wave model, AND best match — the only thing that carries currents.
                models: `${SEA_WAVE_MODEL},best_match`,
                timeformat: 'unixtime',
                forecast_hours: FORECAST_HOURS,
            });
            mine.sea = parseRouteSea(stations, replies, totalNm, Date.now());
            mine.failedAt = 0;
            mine.failures = 0;
        } catch (err) {
            mine.failedAt = Date.now();
            mine.failures += 1;
            log.warn(`route sea failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
            mine.inflight = null;
        }
        return mine.sea;
    })();
    return mine.inflight;
}

/** Test seam. */
export function __clearRouteSeaCacheForTests(): void {
    cache.clear();
}

// ── Sample ─────────────────────────────────────────────────────

const lerp = (a: number | null, b: number | null, t: number): number | null =>
    a === null ? (t >= 0.5 ? b : null) : b === null ? (t < 0.5 ? a : null) : a + (b - a) * t;

interface Bracket {
    lo: number;
    hi: number;
    t: number;
}

/** The two hours either side of `atMs`, or null when it is off the axis. */
function hours(timesMs: number[], atMs: number): Bracket | null {
    const n = timesMs.length;
    if (n === 0 || atMs < timesMs[0] - BEYOND_MS || atMs > timesMs[n - 1] + BEYOND_MS) return null;
    let hi = timesMs.findIndex((t) => t >= atMs);
    if (hi === -1) hi = n - 1;
    const lo = hi > 0 && timesMs[hi] > atMs ? hi - 1 : hi;
    const span = timesMs[hi] - timesMs[lo];
    return { lo, hi, t: span > 0 ? Math.max(0, Math.min(1, (atMs - timesMs[lo]) / span)) : 0 };
}

const scalarAt = (values: (number | null)[], b: Bracket): number | null => lerp(values[b.lo], values[b.hi], b.t);

/** A bearing as a unit vector, so that 350° and 010° meet at north and not at south. */
function bearingAt(values: (number | null)[], b: Bracket): { x: number; y: number } | null {
    const unit = (deg: number | null) =>
        deg === null ? null : { x: Math.sin((deg * Math.PI) / 180), y: Math.cos((deg * Math.PI) / 180) };
    const a = unit(values[b.lo]);
    const c = unit(values[b.hi]);
    const x = lerp(a?.x ?? null, c?.x ?? null, b.t);
    const y = lerp(a?.y ?? null, c?.y ?? null, b.t);
    return x === null || y === null ? null : { x, y };
}

const toBearing = (v: { x: number; y: number } | null): number | null =>
    !v || (Math.abs(v.x) < 1e-9 && Math.abs(v.y) < 1e-9) ? null : ((Math.atan2(v.x, v.y) * 180) / Math.PI + 360) % 360;

interface StationMoment {
    waveM: number | null;
    wavePeriodS: number | null;
    wave: { x: number; y: number } | null;
    currentKts: number | null;
    set: { x: number; y: number } | null;
}

function stationAt(s: SeaStationSeries, atMs: number): StationMoment | null {
    const b = hours(s.timesMs, atMs);
    if (!b) return null;
    return {
        waveM: scalarAt(s.waveM, b),
        wavePeriodS: scalarAt(s.wavePeriodS, b),
        wave: bearingAt(s.waveFromDeg, b),
        currentKts: scalarAt(s.currentKts, b),
        set: bearingAt(s.currentSetDeg, b),
    };
}

/** The last hour at which ANY station has a wave value: past it the sea forecast has ended. */
function lastWaveMs(sea: RouteSea): number {
    let last = -Infinity;
    for (const s of sea.stations) {
        for (let i = s.timesMs.length - 1; i >= 0; i--) {
            if (s.waveM[i] !== null) {
                if (s.timesMs[i] > last) last = s.timesMs[i];
                break;
            }
        }
    }
    return last;
}

/**
 * The sea at `alongNm` down the route at `atMs`.
 *
 * AN INSHORE STATION IS NEVER INTERPOLATED THROUGH. Between a refused station
 * (a berth) and a good one ten miles out, the good one speaks for the half of
 * the gap nearest it and nobody speaks for the other half: there the answer is
 * `inshore`, and the strip says so. Open-water swell is not lerped down onto a
 * marina to make a smooth line.
 */
export function sampleRouteSea(sea: RouteSea | null, alongNm: number, atMs: number): RouteSeaSample {
    if (!sea || sea.stations.length === 0 || !Number.isFinite(alongNm) || !Number.isFinite(atMs)) return EMPTY;
    const st = sea.stations;
    const want = Math.max(st[0].alongNm, Math.min(alongNm, st[st.length - 1].alongNm));
    let hi = st.findIndex((s) => s.alongNm >= want);
    if (hi === -1) hi = st.length - 1;
    const lo = hi > 0 && st[hi].alongNm > want ? hi - 1 : hi;
    const span = st[hi].alongNm - st[lo].alongNm;
    const t = span > 0 ? (want - st[lo].alongNm) / span : 0;

    const nearest = t < 0.5 ? st[lo] : st[hi];
    const both = !st[lo].inshore && !st[hi].inshore;
    if (!both && nearest.inshore) return { ...EMPTY, inshore: true };

    const a = both || nearest === st[lo] ? stationAt(st[lo], atMs) : null;
    const b = both || nearest === st[hi] ? stationAt(st[hi], atMs) : null;
    if (!a && !b) return { ...EMPTY, beyond: true };
    const mix = (pick: (m: StationMoment) => number | null): number | null =>
        a && b ? lerp(pick(a), pick(b), t) : pick((a ?? b) as StationMoment);
    const mixVec = (pick: (m: StationMoment) => { x: number; y: number } | null) => {
        if (!(a && b)) return pick((a ?? b) as StationMoment);
        const x = lerp(pick(a)?.x ?? null, pick(b)?.x ?? null, t);
        const y = lerp(pick(a)?.y ?? null, pick(b)?.y ?? null, t);
        return x === null || y === null ? null : { x, y };
    };

    const waveM = mix((m) => m.waveM);
    const currentKts = mix((m) => m.currentKts);
    const lastWave = lastWaveMs(sea);
    return {
        waveM,
        wavePeriodS: mix((m) => m.wavePeriodS),
        waveFromDeg: toBearing(mixVec((m) => m.wave)),
        currentKts,
        // A set with no drift is a direction of nothing.
        currentSetDeg: currentKts === null || currentKts < 0.05 ? null : toBearing(mixVec((m) => m.set)),
        inshore: false,
        // Only when there IS a last wave hour to be past: with currents but no waves
        // at all (-Infinity) this said PAST FORECAST at NOW.
        beyond: waveM === null && Number.isFinite(lastWave) && atMs > lastWave,
    };
}

/**
 * How much of the current is with her (+, fair) or against her (−, foul) on
 * `courseDeg`. For the skipper's eye only: it is NOT applied to the plan.
 */
export function currentAlongKts(
    currentKts: number | null,
    currentSetDeg: number | null,
    courseDeg: number | null,
): number | null {
    if (currentKts === null || currentSetDeg === null || courseDeg === null || !Number.isFinite(courseDeg)) return null;
    return currentKts * Math.cos(((currentSetDeg - courseDeg) * Math.PI) / 180);
}
