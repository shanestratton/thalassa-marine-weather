/**
 * check-weather-alerts' decisions (129-07), pure so every rule has a test
 * (tests/ForecastAlertsAhead.test.ts). The edge function reads the accounts,
 * fetches the batches and writes what this returns.
 *
 * Shane, 13 Oct 2026: "go with your recommendations for all answers", so the
 * roadmap's recommendation is the rule: look 24 h ahead, and push only when
 * two of three models agree.
 *
 * Wind and gusts: ECMWF IFS (ecmwf_ifs025), DWD ICON (icon_seamless) and the
 * UK Met Office global model (ukmo_global_deterministic_10km), the ids the
 * app already asks the commercial endpoint for (proxy-openmeteo's list,
 * services/weather/forecastModels.ts), each pinned by &models= so the answer
 * always says which model it is. A push goes only when at least two of them
 * cross the skipper's threshold inside the same 3 h, inside the look-ahead
 * (6, 12 or 24 h, the skipper's choice; 24 by default). It says "2 of 3
 * models agree", names them, and gives the agreed window on the boat's clock.
 * One model alone is never pushed: the status says "models disagree" with the
 * numbers. A model whose hours come back null counts as not answering, and
 * with fewer than two answering nothing is pushed: "not enough models
 * answered".
 * Licence (decision B): UKMO's open data is CC BY-SA 4.0. It is named and
 * counted, and its numbers are never shown, pushed or stored; every value in
 * a push or a status line is ECMWF's or ICON's (CC BY 4.0, credited as
 * "Forecast data: ECMWF, DWD ICON"). Even the push's strength word comes from
 * the quotable models only.
 * Seas: one named wave model, ECMWF WAM (ecmwf_wam025), else Météo-France
 * MFWAM (meteofrance_wave) where WAM has no water (the Whitsunday Passage,
 * docs/PASSAGE_HUD.md). There is no wave spread to agree on: four wave
 * models that mostly cannot see the water she is in are not a second opinion
 * (services/routeSeaSampler.ts). Where neither answers, the status says "no
 * wave model here", never calm. Wave height and the total sea's mean period
 * (the in-app check's swellPeriod) are read.
 * Good window opens: a 6 h window rated Go, by the same scorer as the passage
 * card (windowScore.ts, services/WeatherWindowService.ts), against the
 * skipper's own wind and wave limits, by at least two of the three models,
 * when the hours now are not. Opt-in.
 * Official warnings (decision C): an alert already covered by an official
 * warning of the same kind, at least as strong, in force at the same place,
 * is dropped (cover.ts, 129-06's predicate), but only by a warning this
 * skipper was sent (official_alert_deliveries: deliveredOfficial). One they
 * muted (official warnings off, small craft advisories off) or were told at
 * the boat's fix somewhere else covers nothing: their own threshold still
 * pushes. A good window is never pushed while any official wind or sea
 * warning is in force there, sent to them or not.
 * Quiet hours (decision D): forecast alerts are not warnings. Between 22:00
 * and 07:00 on the boat's clock (its IANA zone, as cyclone-watch keeps it)
 * they wait, unless the agreed window starts within 3 h. A held alert is not
 * claimed, so the first run after 07:00 (or once its window is 3 h off)
 * sends it.
 * Once a day per strength (weather_alerts_log's key): a push claims its
 * kind, its strength (wind: your limit, strong, gale, storm, storm inside
 * 3 h; seas: your limit, rough, dangerous) and its alert day, and the weaker
 * strengths of that day too. A forecast that gets worse pushes again; one
 * that eases does not. The alert day turns at 07:00 on the boat, when quiet
 * hours end, not at midnight: an event still under way at 00:00 starts "now"
 * (never held), and a midnight day would push it again in the night.
 * Style (decision E): every title starts "Forecast:", every body says "Not an
 * official warning", and the type is weather_alert (the app's forecast toast),
 * never official_warning; storm force agreed inside 3 h goes as
 * severe_weather_alert (send-push's critical type), which the toast styles
 * as the forecast too.
 * The current hour (visibility, UV, temperature, rain): read from hourly
 * series, the hour under way, per model. Open-Meteo's `current` block does
 * not split by model: asked for two, it answers the first one only, under
 * plain keys (probed 2026-10-14).
 * Copy: in the skipper's own units (Settings → Preferences) and on the boat's
 * clock. Thresholds are stored in kts, ft, s, nm and °C (AlertsTab).
 */
import { isQuietHour } from '../cyclone/watch.ts';
import type { OfficialHazard } from '../official-alerts/classify.ts';
import { officialCovers, type OfficialForCover } from './cover.ts';
import { scoreDepartureWindow } from './windowScore.ts';

export interface AheadModel {
    /** The Open-Meteo model id, pinned with &models=. */
    id: string;
    /** The name a push and a status line use. */
    name: string;
    /** Who the credit names. */
    credit: string;
    /** False for UKMO (CC BY-SA): named and counted, never its values. */
    quotable: boolean;
    /** The model's grid, degrees, where the snap check reads it (the first wave model's). */
    gridDeg?: number;
}

export const WIND_MODELS: readonly AheadModel[] = [
    { id: 'ecmwf_ifs025', name: 'ECMWF', credit: 'ECMWF', quotable: true },
    { id: 'icon_seamless', name: 'ICON', credit: 'DWD ICON', quotable: true },
    { id: 'ukmo_global_deterministic_10km', name: 'UKMO', credit: 'UK Met Office', quotable: false },
];

/** In order: the first that has water here is the one read. */
export const WAVE_MODELS: readonly AheadModel[] = [
    { id: 'ecmwf_wam025', name: 'ECMWF WAM', credit: 'ECMWF', quotable: true, gridDeg: 0.25 },
    { id: 'meteofrance_wave', name: 'Météo-France MFWAM', credit: 'Météo-France', quotable: true },
];

/** The current-hour checks (visibility, UV, temperature, rain): ECMWF, else GFS where ECMWF has no such field. */
export const NOW_MODELS: readonly AheadModel[] = [
    { id: 'ecmwf_ifs025', name: 'ECMWF', credit: 'ECMWF', quotable: true },
    { id: 'gfs_seamless', name: 'GFS', credit: 'NOAA', quotable: true },
];

export const AGREE_WINDOW_HOURS = 3;
export const AGREE_MIN = 2;
export const GOOD_WINDOW_HOURS = 6;
/** An alert whose window starts inside this of now is sent at night: it is about to begin. */
export const ONSET_SOON_MS = 3 * 3_600_000;
/** Locations per request. Open-Meteo takes a list; proxy-openmeteo caps the app's at 50 too. */
export const BATCH_POINTS = 50;
/** Days asked for: 24 h ahead from late on a UTC day still needs the day after tomorrow's first hours. */
export const FORECAST_DAYS = 3;
const HOUR_MS = 3_600_000;

// ── Batches and the call volume on the paid key ──────────────────────────

export type RequestKind = 'ahead' | 'sea' | 'now';
export interface LatLon {
    lat: number;
    lon: number;
}

interface KindSpec {
    /**
     * Always hourly: every kind pins two models or more, and Open-Meteo's
     * `current` block answers only the first of them, unsuffixed.
     */
    block: 'hourly';
    variables: readonly string[];
    models: readonly AheadModel[];
    days: number;
    extra: Record<string, string>;
}

const KIND: Record<RequestKind, KindSpec> = {
    ahead: {
        block: 'hourly',
        variables: ['wind_speed_10m', 'wind_gusts_10m'],
        models: WIND_MODELS,
        days: FORECAST_DAYS,
        // A boat is on the water: the sea cell, not the land one beside the berth.
        extra: { wind_speed_unit: 'kn', cell_selection: 'sea' },
    },
    sea: {
        block: 'hourly',
        variables: ['wave_height', 'wave_period'],
        models: WAVE_MODELS,
        days: FORECAST_DAYS,
        extra: {},
    },
    now: {
        // The hour under way is read from today's hours (GMT), per model.
        block: 'hourly',
        variables: ['weather_code', 'temperature_2m', 'visibility', 'uv_index'],
        models: NOW_MODELS,
        days: 1,
        extra: {},
    },
};

export const kindVariables = (kind: RequestKind): readonly string[] => KIND[kind].variables;
export const kindModels = (kind: RequestKind): readonly AheadModel[] => KIND[kind].models;

export function batchPoints<T>(points: readonly T[], size = BATCH_POINTS): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size));
    return out;
}

/**
 * The query for one batch, without the key (the edge function adds it and
 * never logs the result). Every request pins its models, asks for absolute
 * times (unix seconds, GMT) and lists every location of the batch.
 */
export function requestParams(kind: RequestKind, batch: readonly LatLon[]): Record<string, string> {
    const spec = KIND[kind];
    return {
        latitude: batch.map((p) => String(p.lat)).join(','),
        longitude: batch.map((p) => String(p.lon)).join(','),
        [spec.block]: spec.variables.join(','),
        models: spec.models.map((m) => m.id).join(','),
        forecast_days: String(spec.days),
        timezone: 'GMT',
        timeformat: 'unixtime',
        ...spec.extra,
    };
}

/**
 * What one location of one request costs on the paid key, by Open-Meteo's
 * published counting: a call per location, weighted up past 10 variables
 * (each model's counted) and past 14 days. Confirm against the account's
 * usage page after the deploy.
 */
export function callWeight(kind: RequestKind): number {
    const spec = KIND[kind];
    const variables = spec.variables.length * spec.models.length;
    return Math.max(1, variables / 10) * Math.max(1, spec.days / 14);
}

export interface CallVolume {
    /** HTTP requests per run (one per batch of up to BATCH_POINTS locations, per kind). */
    requestsPerRun: number;
    /** Weighted calls per run on the paid key. */
    callsPerRun: number;
    callsPerDay: number;
    callsPer30Days: number;
}

/** The volume for so many distinct (0.1°) locations per kind, at the cron's 48 runs a day. */
export function estimateCallVolume(locations: Partial<Record<RequestKind, number>>, runsPerDay = 48): CallVolume {
    let requestsPerRun = 0;
    let callsPerRun = 0;
    for (const kind of Object.keys(KIND) as RequestKind[]) {
        const n = Math.max(0, Math.floor(locations[kind] ?? 0));
        requestsPerRun += Math.ceil(n / BATCH_POINTS);
        callsPerRun += n * callWeight(kind);
    }
    return {
        requestsPerRun,
        callsPerRun,
        callsPerDay: callsPerRun * runsPerDay,
        callsPer30Days: callsPerRun * runsPerDay * 30,
    };
}

// ── Reading the replies ──────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * One reply per location, in the order asked: Open-Meteo answers a list of
 * locations with an array and one location with an object. Anything else,
 * or a list of another length, is no answer for the whole batch.
 */
export function parseReplies(value: unknown, expected: number): (Rec | null)[] | null {
    const list = Array.isArray(value) ? value : rec(value) ? [value] : null;
    if (!list || list.length !== expected) return null;
    return list.map(rec);
}

/** A model's own key: `wind_speed_10m_icon_seamless`; with one model asked, Open-Meteo leaves the suffix off. */
function modelField(block: Rec, variable: string, model: string, onlyModel: boolean): unknown {
    const own = block[`${variable}_${model}`];
    return own === undefined && onlyModel ? block[variable] : own;
}

export interface Hourly {
    /** Each hour's start, in ms. */
    times: number[];
    /** The grid cell the reply echoes (the first pinned model's), where it gives one. */
    cell?: LatLon;
    /** Keyed `${variable}|${modelId}`, aligned with times; a null hour is a model that did not answer it. */
    series: Record<string, (number | null)[]>;
}

export function readHourly(
    reply: Rec | null,
    variables: readonly string[],
    models: readonly AheadModel[],
): Hourly | null {
    const hourly = rec(reply?.hourly);
    const rawTimes = hourly?.time;
    if (!hourly || !Array.isArray(rawTimes) || rawTimes.length === 0 || rawTimes.length > 24 * 16) return null;
    const times = rawTimes.map((t) => (typeof t === 'number' && Number.isFinite(t) ? t * 1000 : NaN));
    if (times.some((t) => !Number.isFinite(t))) return null;
    const series: Hourly['series'] = {};
    for (const variable of variables) {
        for (const model of models) {
            const raw = modelField(hourly, variable, model.id, models.length === 1);
            series[`${variable}|${model.id}`] = times.map((_, i) => (Array.isArray(raw) ? finite(raw[i]) : null));
        }
    }
    const lat = finite(reply?.latitude);
    const lon = finite(reply?.longitude);
    return lat !== null && lon !== null ? { times, series, cell: { lat, lon } } : { times, series };
}

export type CurrentRead = Record<string, { value: number; model: AheadModel } | null>;

/**
 * The hour under way, each field from the first model that has it (ECMWF,
 * else GFS), from hourly series suffixed per model. Not Open-Meteo's
 * `current` block: with two models asked it carries the first one only,
 * under plain keys, so GFS's visibility and UV would never be seen. Null
 * when the reply has no hour under way.
 */
export function readNow(
    reply: Rec | null,
    variables: readonly string[],
    models: readonly AheadModel[],
    nowMs: number,
): CurrentRead | null {
    const h = readHourly(reply, variables, models);
    const i = h ? h.times.findIndex((t) => t <= nowMs && nowMs < t + HOUR_MS) : -1;
    if (!h || i < 0) return null;
    const out: CurrentRead = {};
    for (const variable of variables) {
        out[variable] = null;
        for (const model of models) {
            const value = h.series[`${variable}|${model.id}`]?.[i] ?? null;
            if (value !== null) {
                out[variable] = { value, model };
                break;
            }
        }
    }
    return out;
}

// ── Agreement ────────────────────────────────────────────────────────────

/** The hours the look-ahead reads: the one under way now, to `hours` from now. */
function aheadIndexes(times: readonly number[], nowMs: number, hours: number): number[] {
    const out: number[] = [];
    times.forEach((t, i) => {
        if (t > nowMs - HOUR_MS && t < nowMs + hours * HOUR_MS) out.push(i);
    });
    return out;
}

/** A model answered when at least half the hours ahead carry a number. */
function answers(values: readonly (number | null)[], idx: readonly number[]): boolean {
    if (idx.length === 0) return false;
    return idx.filter((i) => values[i] !== null).length * 2 >= idx.length;
}

const peakOf = (values: readonly (number | null)[], idx: readonly number[]): number | null => {
    let best: number | null = null;
    for (const i of idx) {
        const v = values[i];
        if (v !== null && (best === null || v > best)) best = v;
    }
    return best;
};

export interface ModelPeak {
    model: AheadModel;
    /** Its highest value in the hours that matter; never set for a model that is not quotable. */
    peak: number | null;
}

export type Agreement =
    | {
        state: 'agree';
        startMs: number;
        endMs: number;
        /** The models crossing inside the agreed window, in model order. */
        agreeing: AheadModel[];
        /** The quotable agreeing models' peaks inside the window. */
        peaks: ModelPeak[];
        /** What the quotable agreeing models all reach: the lowest of their peaks. */
        agreedValue: number;
        answered: AheadModel[];
    }
    | ({ state: 'disagree' } & Unagreed)
    | ({ state: 'clear' } & Unagreed)
    | { state: 'not-enough'; answered: AheadModel[] };

interface Unagreed {
    /** The models that cross somewhere ahead (disagree: one, or two more than 3 h apart). */
    crossing: AheadModel[];
    /** Every answering model, with its peak ahead where it is quotable. */
    peaks: ModelPeak[];
    answered: AheadModel[];
}

const quotablePeaks = (models: readonly AheadModel[], peak: (m: AheadModel) => number | null): ModelPeak[] =>
    models.map((model) => ({ model, peak: model.quotable ? peak(model) : null }));

/**
 * Do at least two models cross `threshold` (at or above) inside the same 3 h,
 * in the look-ahead? The window is the 3 h from the first hour a model
 * crosses in which a second also does.
 */
export function agreeAhead(
    h: Hourly,
    variable: string,
    threshold: number,
    nowMs: number,
    hours: number,
    models: readonly AheadModel[] = WIND_MODELS,
): Agreement {
    const idx = aheadIndexes(h.times, nowMs, hours);
    const valuesOf = (m: AheadModel) => h.series[`${variable}|${m.id}`] ?? [];
    const answered = models.filter((m) => answers(valuesOf(m), idx));
    if (answered.length < AGREE_MIN) return { state: 'not-enough', answered };
    const crossesAt = (m: AheadModel, i: number) => {
        const v = valuesOf(m)[i];
        return v !== null && v !== undefined && v >= threshold;
    };
    for (const i of idx) {
        if (!answered.some((m) => crossesAt(m, i))) continue;
        const startMs = h.times[i];
        const endMs = startMs + AGREE_WINDOW_HOURS * HOUR_MS;
        const inWindow = idx.filter((j) => h.times[j] >= startMs && h.times[j] < endMs);
        const agreeing = answered.filter((m) => inWindow.some((j) => crossesAt(m, j)));
        if (agreeing.length < AGREE_MIN) continue;
        const peaks = agreeing
            .filter((m) => m.quotable)
            .map((model) => ({ model, peak: peakOf(valuesOf(model), inWindow) }));
        const values = peaks.map((p) => p.peak).filter((v): v is number => v !== null);
        // Two crossing models always hold one quotable one: only UKMO is not.
        return {
            state: 'agree',
            startMs,
            endMs,
            agreeing,
            peaks,
            agreedValue: values.length > 0 ? Math.min(...values) : threshold,
            answered,
        };
    }
    const crossing = answered.filter((m) => idx.some((i) => crossesAt(m, i)));
    return {
        state: crossing.length > 0 ? 'disagree' : 'clear',
        crossing,
        peaks: quotablePeaks(answered, (m) => peakOf(valuesOf(m), idx)),
        answered,
    };
}

// ── Seas: one named wave model ───────────────────────────────────────────

export interface WaveRead {
    model: AheadModel;
    times: number[];
    height: (number | null)[];
    period: (number | null)[];
}

const KM_PER_DEG = 111.32;
const SNAP_TOLERANCE = 1.15;

/** Great-circle km. */
export function distanceKm(a: LatLon, b: LatLon): number {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(x)));
}

/**
 * The furthest a point is from its own cell's centre on a grid of `gridDeg`:
 * half the cell's diagonal, 15% over (services/weather/api/marine.ts
 * maxLegitimateSnapKm, the app's rule). Further means Open-Meteo reached
 * past dry cells to find water, so the value is not the sea at the point.
 */
export function maxSnapKm(lat: number, gridDeg: number): number {
    const ns = 0.5 * gridDeg * KM_PER_DEG;
    return Math.hypot(ns, ns * Math.cos((lat * Math.PI) / 180)) * SNAP_TOLERANCE;
}

/**
 * ECMWF WAM where it has water here, else MFWAM; null where neither does:
 * "no wave model here". `at` is the point asked: a two-model reply echoes
 * the first pinned model's cell (WAM's), and where that is further than its
 * own grid allows (a river berth answered from the bay 25 km off, probed
 * 2026-10-14) WAM is passed over. MFWAM's cell is not echoed; it answered
 * null in that river rather than reach out, so it is read where it answers.
 */
export function waveChain(h: Hourly | null, nowMs: number, hours: number, at?: LatLon): WaveRead | null {
    if (!h) return null;
    const idx = aheadIndexes(h.times, nowMs, hours);
    const echoed = WAVE_MODELS[0];
    const tooFar = at !== undefined && h.cell !== undefined && echoed.gridDeg !== undefined &&
        distanceKm(at, h.cell) > maxSnapKm(at.lat, echoed.gridDeg);
    for (const model of WAVE_MODELS) {
        if (model === echoed && tooFar) continue;
        const height = h.series[`wave_height|${model.id}`] ?? [];
        if (!answers(height, idx)) continue;
        // A land-mask cell answers 0 m with no period: that is no water, not a flat calm.
        const period = h.series[`wave_period|${model.id}`] ?? [];
        if (idx.every((i) => (height[i] ?? 0) === 0 && (period[i] ?? 0) === 0)) continue;
        return { model, times: h.times, height, period };
    }
    return null;
}

export type SeaAhead =
    | { state: 'cross'; startMs: number; endMs: number; peak: number }
    | { state: 'clear'; peak: number | null };

/** The wave model's first hour over the limit and its peak in the 3 h from there, or its peak ahead. */
export function seaAhead(
    w: WaveRead,
    which: 'height' | 'period',
    threshold: number,
    nowMs: number,
    hours: number,
): SeaAhead {
    const values = w[which];
    const idx = aheadIndexes(w.times, nowMs, hours);
    const first = idx.find((i) => (values[i] ?? -Infinity) >= threshold);
    if (first === undefined) return { state: 'clear', peak: peakOf(values, idx) };
    const startMs = w.times[first];
    const endMs = startMs + AGREE_WINDOW_HOURS * HOUR_MS;
    const inWindow = idx.filter((i) => w.times[i] >= startMs && w.times[i] < endMs);
    return { state: 'cross', startMs, endMs, peak: peakOf(values, inWindow) ?? threshold };
}

// ── Good window opens ────────────────────────────────────────────────────

export type GoodWindow =
    | { state: 'opens'; startMs: number; endMs: number; agreeing: AheadModel[]; peaks: ModelPeak[] }
    | { state: 'already' }
    | { state: 'none' }
    | { state: 'not-enough'; answered: AheadModel[] };

/**
 * The first 6 h window ahead that at least two models rate Go against the
 * skipper's limits, when the 6 h from now are not. Seas from the one wave
 * model, where there is one; without one, wind alone is scored.
 */
export function goodWindowAhead(
    h: Hourly,
    sea: WaveRead | null,
    limits: { maxWindKts: number; maxWaveM: number },
    nowMs: number,
    hours: number,
): GoodWindow {
    const idx = aheadIndexes(h.times, nowMs, hours);
    const valuesOf = (m: AheadModel) => h.series[`wind_speed_10m|${m.id}`] ?? [];
    const answered = WIND_MODELS.filter((m) => answers(valuesOf(m), idx));
    if (answered.length < AGREE_MIN) return { state: 'not-enough', answered };
    const waveAt = (t: number): number | null => {
        if (!sea) return null;
        const j = sea.times.indexOf(t);
        return j < 0 ? null : sea.height[j];
    };
    /** The hours of the 6 h from `start`: past the look-ahead's end too, where the window runs on. */
    const hoursFrom = (start: number) =>
        h.times.flatMap((t, i) => (t >= start && t < start + GOOD_WINDOW_HOURS * HOUR_MS ? [i] : []));
    const goAt = (start: number): AheadModel[] => {
        const span = hoursFrom(start);
        if (span.length < GOOD_WINDOW_HOURS) return [];
        const waves = span.map((i) => waveAt(h.times[i])).filter((v): v is number => v !== null);
        return answered.filter((m) => {
            const wind = span.map((i) => valuesOf(m)[i]);
            if (wind.some((v) => v === null || v === undefined)) return false;
            return scoreDepartureWindow(wind as number[], waves, { ...limits, preferredAngles: [] }).rating === 'go';
        });
    };
    if (idx.length === 0) return { state: 'none' };
    if (goAt(h.times[idx[0]]).length >= AGREE_MIN) return { state: 'already' };
    for (const i of idx.slice(1)) {
        const agreeing = goAt(h.times[i]);
        if (agreeing.length < AGREE_MIN) continue;
        const startMs = h.times[i];
        const span = hoursFrom(startMs);
        return {
            state: 'opens',
            startMs,
            endMs: startMs + GOOD_WINDOW_HOURS * HOUR_MS,
            agreeing,
            peaks: agreeing.filter((m) => m.quotable).map((model) => ({ model, peak: peakOf(valuesOf(model), span) })),
        };
    }
    return { state: 'none' };
}

// ── Units and the boat's clock ───────────────────────────────────────────

export interface UnitChoice {
    speed?: unknown;
    waveHeight?: unknown;
    visibility?: unknown;
    temp?: unknown;
}

const round1 = (n: number) => String(Math.round(n * 10) / 10);
const FT_PER_M = 1 / 0.3048;

/** Wind in the skipper's unit: kts (shown "kt"), mph, km/h or m/s. */
export function speedText(kts: number, units: UnitChoice): string {
    switch (units.speed) {
        case 'mph':
            return `${Math.round(kts * 1.15078)} mph`;
        case 'kmh':
            return `${Math.round(kts * 1.852)} km/h`;
        case 'mps':
            return `${round1(kts * 0.514444)} m/s`;
        default:
            return `${Math.round(kts)} kt`;
    }
}

/** Seas in the skipper's unit, metres unless feet are chosen (the Seas picker's fallback). */
export function waveText(metres: number, units: UnitChoice): string {
    return units.waveHeight === 'ft' ? `${round1(metres * FT_PER_M)} ft` : `${round1(metres)} m`;
}

export function visibilityText(nm: number, units: UnitChoice): string {
    if (units.visibility === 'mi') return `${round1(nm * 1.15078)} mi`;
    if (units.visibility === 'km') return `${round1(nm * 1.852)} km`;
    return `${round1(nm)} nm`;
}

export function tempText(celsius: number, units: UnitChoice): string {
    return units.temp === 'F' ? `${Math.round((celsius * 9) / 5 + 32)} °F` : `${Math.round(celsius)} °C`;
}

const clockFormats = new Map<string, Intl.DateTimeFormat | null>();
function clockFormat(zone: string): Intl.DateTimeFormat | null {
    if (!clockFormats.has(zone)) {
        try {
            clockFormats.set(
                zone,
                new Intl.DateTimeFormat('en-GB', {
                    timeZone: zone,
                    weekday: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                    hourCycle: 'h23',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                }),
            );
        } catch {
            clockFormats.set(zone, null);
        }
    }
    return clockFormats.get(zone) ?? null;
}

/** The boat's clock at ms: its IANA zone, or a longitude's nautical zone (cyclone/watch.ts boatZone). */
function boatParts(ms: number, zone: string | number): { weekday: string; hm: string; date: string; hour: number } {
    const fmt = typeof zone === 'string' ? clockFormat(zone) : null;
    const shifted = typeof zone === 'number' ? ms + Math.round(zone / 15) * HOUR_MS : ms;
    const parts = (fmt ?? clockFormat('UTC')!).formatToParts(new Date(fmt ? ms : shifted));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return {
        weekday: get('weekday'),
        hm: `${get('hour')}:${get('minute')}`,
        date: `${get('year')}-${get('month')}-${get('day')}`,
        hour: Number(get('hour')),
    };
}

/** "Wed 15:00" on the boat's clock. */
export function boatClock(ms: number, zone: string | number): string {
    const p = boatParts(ms, zone);
    return `${p.weekday} ${p.hm}`;
}

/** "Wed 15:00–18:00" on the boat's clock. */
export function windowText(startMs: number, endMs: number, zone: string | number): string {
    return `${boatClock(startMs, zone)}–${boatParts(endMs, zone).hm}`;
}

/** When the boat's alert day turns: the end of quiet hours (cyclone/watch.ts isQuietHour). */
export const ALERT_DAY_STARTS_HOUR = 7;

/**
 * The alert day of ms on the boat's clock: 07:00 to 07:00, named for the
 * calendar day it starts on. 06:00 Thursday is still Wednesday's: a blow
 * under way all night keeps the key it was pushed under and wakes no one at
 * midnight; the morning after, at 07:00, it may remind once.
 */
export function alertDay(ms: number, zone: string | number): string {
    const p = boatParts(ms, zone);
    if (p.hour >= ALERT_DAY_STARTS_HOUR) return p.date;
    const [y, m, d] = p.date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Held overnight: 22:00-07:00 on the boat's clock, unless the window starts within 3 h. */
export function holdOvernight(nowMs: number, zone: string | number, startMs: number): boolean {
    return isQuietHour(nowMs, zone) && startMs > nowMs + ONSET_SOON_MS;
}

// ── The decision for one account ─────────────────────────────────────────

export type AheadKind = 'wind' | 'gusts' | 'waves' | 'swellPeriod' | 'goodWindow';
export type NowKind = 'visibility' | 'uv' | 'tempHigh' | 'tempLow' | 'precipitation';

export interface AlertPreference {
    enabled: boolean;
    threshold?: number;
}

export interface AheadAccount {
    userId: string;
    /** The place's name, as the skipper saved it ("Your location" for a Guardian fix). */
    place: string;
    /** The boat's clock (cyclone/watch.ts boatZone). */
    zone: string | number;
    units: UnitChoice;
    hours: number;
    /** Enabled alerts only (check-weather-alerts parseAlertPreferences). */
    notifications: Record<string, AlertPreference>;
    /** "Good window opens" is on. */
    goodWindow: boolean;
    /** The stored wind (kts) and wave (ft) thresholds, armed or not: the good window's limits. */
    limits: { windKts: number | null; waveFt: number | null };
}

export interface AheadInputs {
    ahead: Hourly | null;
    sea: WaveRead | null;
    /** True where a marine reply came back (so a null sea is "no wave model here", not "no answer"). */
    seaAnswered: boolean;
    now: CurrentRead | null;
    /**
     * The official warnings in force at the place that this skipper was sent
     * (deliveredOfficial): what covers an alert.
     */
    official: readonly OfficialForCover[];
    /** Every official warning in force at the place (official_alerts_watch_match): holds a good window back. Default: official. */
    officialAtPlace?: readonly OfficialForCover[];
}

export interface ForecastPush {
    kind: AheadKind | NowKind;
    /** weather_alerts_log's key: one per kind, strength and alert day of the event on the boat's clock. */
    alertKey: string;
    /**
     * The weaker strengths' keys of the same kind and day, claimed with the
     * push, so the forecast easing later that day stays quiet.
     */
    alsoClaims: string[];
    type: 'weather_alert' | 'severe_weather_alert';
    title: string;
    body: string;
    data: Record<string, unknown>;
}

export interface AheadDecision {
    pushes: ForecastPush[];
    held: (AheadKind | NowKind)[];
    covered: (AheadKind | NowKind)[];
    /** Per-position status, one line per look-ahead check: weather_alert_status.lines. */
    lines: string[];
}

const NOT_OFFICIAL = 'Not an official warning.';

/** "Forecast data: ECMWF, DWD ICON." Each provider once, in model order. */
export function creditLine(models: readonly AheadModel[]): string {
    return `Forecast data: ${[...new Set(models.map((m) => m.credit))].join(', ')}.`;
}

const names = (models: readonly AheadModel[]) => models.map((m) => m.name).join(', ');

/** "ECMWF 28 kt, ICON 26 kt, UKMO not shown": values only where the model may be quoted. */
function peaksText(peaks: readonly ModelPeak[], format: (v: number) => string): string {
    return peaks
        .map(({ model, peak }) =>
            !model.quotable
                ? `${model.name} not shown`
                : peak === null
                ? `${model.name} no value`
                : `${model.name} ${format(peak)}`
        )
        .join(', ');
}

/** The strengths of each kind, weakest first: a push's key names one, and claims those before it too. */
const TIERS = {
    wind: ['limit', 'strong', 'gale', 'storm', 'severe'],
    sea: ['limit', 'rough', 'dangerous'],
    precipitation: ['wet', 'thunder'],
} as const;

/** `${kind}-${tier}-${day}` for the tier, and the same for every weaker one. */
function tierKeys(stem: string, tiers: readonly string[], tier: string, day: string): [string, string[]] {
    const at = tiers.indexOf(tier);
    return [`${stem}-${tier}-${day}`, tiers.slice(0, at).map((t) => `${stem}-${t}-${day}`)];
}

interface Stem {
    stem: string;
    hazard: readonly [OfficialHazard, number];
    tier: string;
}

/** The title stem and what it reads on the official classifier's scale (utils/forecastAlerts.ts stems). */
function windStem(kind: 'wind' | 'gusts', kts: number): Stem {
    const word = kind === 'wind' ? 'wind' : 'gusts';
    const [storm, gale, strong] = kind === 'wind' ? [48, 34, 22] : [60, 45, 30];
    if (kts > storm) return { stem: `Forecast: storm-force ${word}`, hazard: ['wind', 3], tier: 'storm' };
    if (kts > gale) return { stem: `Forecast: gale-force ${word}`, hazard: ['wind', 2], tier: 'gale' };
    if (kts > strong) {
        return {
            stem: kind === 'wind' ? 'Forecast: strong wind' : 'Forecast: strong gusts',
            hazard: ['wind', 1],
            tier: 'strong',
        };
    }
    return { stem: `Forecast: ${word} above your limit`, hazard: ['wind', 1], tier: 'limit' };
}

function seaStem(metres: number): Stem {
    const ft = metres * FT_PER_M;
    if (ft > 15) return { stem: 'Forecast: dangerous seas', hazard: ['sea', 2], tier: 'dangerous' };
    if (ft > 8) return { stem: 'Forecast: rough seas', hazard: ['sea', 1], tier: 'rough' };
    return { stem: 'Forecast: seas above your limit', hazard: ['sea', 1], tier: 'limit' };
}

/**
 * The current-hour checks on the classifier's scale, exactly as the app's
 * 129-06 predicate reads their titles (utils/officialWarningCover.ts, held
 * by the parity test): "Forecast: poor visibility" is fog, "Forecast: heat,"
 * heat, "Forecast: thunderstorms" thunder. A skipper's own cold limit has no
 * stem there ("near-freezing" is the app's own forecast), so it is never
 * covered, and sent: the safe way. UV and rain have no official type.
 */
const HAZARD_OF_NOW: Partial<Record<NowKind, readonly [OfficialHazard, number]>> = {
    visibility: ['fog', 1],
    tempHigh: ['heat', 1],
};
const THUNDER: readonly [OfficialHazard, number] = ['thunderstorm', 1];
/** WMO weather codes 95-99: thunderstorms, with or without hail. */
const isThunder = (code: number) => code >= 95;

const LABEL: Record<AheadKind, string> = {
    wind: 'Wind',
    gusts: 'Gusts',
    waves: 'Seas',
    swellPeriod: 'Swell period',
    goodWindow: 'Good window',
};

function weatherWords(code: number): string {
    if (code <= 55) return 'drizzle';
    if (code <= 57) return 'freezing drizzle';
    if (code <= 65) return 'rain';
    if (code <= 67) return 'freezing rain';
    if (code <= 77) return 'snow';
    if (code <= 82) return 'rain showers';
    if (code <= 86) return 'snow showers';
    if (code === 95) return 'thunderstorms';
    return 'thunderstorms with hail';
}

/**
 * The place as a push names it: "Suva (-18.1416, 178.4419)" is "Suva" (the
 * app writes a picked place's position into its name, and a push never
 * carries a coordinate), cut to 60 characters for the lock screen.
 */
export function placeLabel(name: string): string {
    const bare = name.replace(/\s*\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)\s*$/, '').trim() || 'your position';
    return bare.length > 60 ? `${bare.slice(0, 59).trimEnd()}…` : bare;
}

/**
 * The warnings in force at the place that this account was sent
 * (official_alert_deliveries, channel push, by alert id): only those cover a
 * forecast alert. One the skipper muted (official warnings off, small craft
 * advisories off), was told at the boat's fix somewhere else, or has not been
 * sent yet (held overnight) has no row, and covers nothing. A warning with
 * no id cannot be matched, so it never covers.
 */
export function deliveredOfficial(
    atPlace: readonly OfficialForCover[],
    delivered: ReadonlySet<number> | undefined,
): OfficialForCover[] {
    return atPlace.filter((o) => typeof o.id === 'number' && delivered?.has(o.id) === true);
}

/** The cron runs every 30 min: each run is one step of the rotation. */
export const RUN_MINUTES = 30;

/**
 * The places this run reads when there are more than `max`: a window of
 * `max` over the places in key order, moved on `max` each run, so every
 * place is read at least once every ceil(n / max) runs, and which places
 * wait never depends on the order the accounts were read in.
 */
export function placesThisRun(keys: readonly string[], max: number, runIndex: number): Set<string> {
    const sorted = [...new Set(keys)].sort();
    if (sorted.length <= max) return new Set(sorted);
    const start = (((runIndex * max) % sorted.length) + sorted.length) % sorted.length;
    return new Set(Array.from({ length: max }, (_, i) => sorted[(start + i) % sorted.length]));
}

const durationText = (minutes: number) => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
};

/** The status line of an account whose place waits this run. */
export function overCapacityLine(places: number, max: number): string {
    const every = Math.ceil(places / max) * RUN_MINUTES;
    return `Not checked this run: more positions than one run can read. Yours is read at least every ${
        durationText(every)
    }.`;
}

export function decideForAccount(account: AheadAccount, inputs: AheadInputs, nowMs: number): AheadDecision {
    const out: AheadDecision = { pushes: [], held: [], covered: [], lines: [] };
    const { zone, units, hours } = account;
    const place = placeLabel(account.place);
    const on = (key: string) => account.notifications[key]?.enabled === true;
    const threshold = (key: string) => {
        const t = account.notifications[key]?.threshold;
        return typeof t === 'number' && Number.isFinite(t) ? t : null;
    };
    const ahead = `for the next ${hours} h`;
    // Any official wind or sea warning here, however mild, sent to this skipper or not,
    // and a good window is not news.
    const atPlace = inputs.officialAtPlace ?? inputs.official;
    const officialWindOrSea = officialCovers(['wind', 0], atPlace) || officialCovers(['sea', 0], atPlace);

    /** Push, hold or drop one alert; its status line (if it has one) says which. */
    const offer = (
        push: ForecastPush,
        startMs: number,
        hazard: readonly [OfficialHazard, number] | null,
        line: string | null,
    ): void => {
        const say = (text: string) => line !== null && out.lines.push(`${line}${text}`);
        if (hazard && officialCovers(hazard, inputs.official)) {
            out.covered.push(push.kind);
            say(' Covered by an official warning in force here.');
            return;
        }
        if (holdOvernight(nowMs, zone, startMs)) {
            out.held.push(push.kind);
            say(' Held overnight: sent at 07:00, or 3 h before it starts if sooner.');
            return;
        }
        out.pushes.push(push);
        say('');
    };

    // Wind and gusts: two of three models, inside the same 3 h.
    for (const kind of ['wind', 'gusts'] as const) {
        const limit = threshold(kind);
        if (!on(kind) || limit === null) continue;
        const label = LABEL[kind];
        if (!inputs.ahead) {
            out.lines.push(`${label}: no forecast answered this run.`);
            continue;
        }
        const a = agreeAhead(inputs.ahead, kind === 'wind' ? 'wind_speed_10m' : 'wind_gusts_10m', limit, nowMs, hours);
        const fmt = (v: number) => speedText(v, units);
        if (a.state === 'not-enough') {
            const who = a.answered.length > 0 ? `${names(a.answered)} only` : 'none';
            out.lines.push(`${label}: not enough models answered (${who}).`);
            continue;
        }
        if (a.state === 'clear') {
            out.lines.push(`${label}: below your ${fmt(limit)} ${ahead}: ${peaksText(a.peaks, fmt)}.`);
            continue;
        }
        if (a.state === 'disagree') {
            const missing = WIND_MODELS.filter((m) => !a.answered.includes(m));
            out.lines.push(
                `${label}: models disagree: ${peaksText(a.peaks, fmt)}${
                    missing.length > 0 ? `; ${names(missing)} did not answer` : ''
                } (your limit ${fmt(limit)}).`,
            );
            continue;
        }
        const { stem, hazard, tier } = windStem(kind, a.agreedValue);
        const when = windowText(a.startMs, a.endMs, zone);
        const agreed = `${a.agreeing.length} of ${WIND_MODELS.length} models agree (${names(a.agreeing)})`;
        const values = peaksText(a.peaks, fmt);
        const severe = a.startMs <= nowMs + ONSET_SOON_MS && a.agreedValue >= (kind === 'wind' ? 50 : 65);
        // Storm force inside 3 h is the critical push: a strength of its own, above storm.
        const [alertKey, alsoClaims] = tierKeys(
            `${kind}-ahead`,
            TIERS.wind,
            severe ? 'severe' : tier,
            alertDay(a.startMs, zone),
        );
        offer(
            {
                kind,
                alertKey,
                alsoClaims,
                type: severe ? 'severe_weather_alert' : 'weather_alert',
                title: `${stem}, ${when}`,
                body: `${agreed} at ${place}: ${values}, over your ${fmt(limit)}. ${NOT_OFFICIAL} ${
                    creditLine(a.agreeing)
                }`,
                data: {
                    alert_type: kind,
                    forecast: true,
                    window_start: new Date(a.startMs).toISOString(),
                    window_end: new Date(a.endMs).toISOString(),
                    models: a.agreeing.map((m) => m.name),
                    location: place,
                },
            },
            a.startMs,
            hazard,
            `${label}: ${agreed}, ${when}: ${values}.`,
        );
    }

    // Seas: one named wave model.
    for (const kind of ['waves', 'swellPeriod'] as const) {
        const stored = threshold(kind);
        if (!on(kind) || stored === null) continue;
        const label = LABEL[kind];
        if (!inputs.seaAnswered) {
            out.lines.push(`${label}: no wave forecast answered this run.`);
            continue;
        }
        if (!inputs.sea) {
            out.lines.push(`${label}: no wave model here.`);
            continue;
        }
        const model = inputs.sea.model;
        // Stored in feet (AlertsTab), read in metres; the period in seconds.
        const limit = kind === 'waves' ? stored * 0.3048 : stored;
        const fmt = (v: number) => (kind === 'waves' ? waveText(v, units) : `${Math.round(v)} s`);
        const s = seaAhead(inputs.sea, kind === 'waves' ? 'height' : 'period', limit, nowMs, hours);
        if (s.state === 'clear') {
            out.lines.push(
                `${label}: below your ${fmt(limit)} ${ahead}: ${model.name} ${
                    s.peak === null ? 'no value' : `up to ${fmt(s.peak)}`
                }.`,
            );
            continue;
        }
        const when = windowText(s.startMs, s.endMs, zone);
        const stem = kind === 'waves'
            ? seaStem(s.peak)
            : { stem: 'Forecast: long-period swell', hazard: null, tier: 'limit' };
        const [alertKey, alsoClaims] = tierKeys(`${kind}-ahead`, TIERS.sea, stem.tier, alertDay(s.startMs, zone));
        offer(
            {
                kind,
                alertKey,
                alsoClaims,
                type: 'weather_alert',
                title: `${stem.stem}, ${when}`,
                body: `${model.name} at ${place}: up to ${fmt(s.peak)}, over your ${fmt(limit)}. ${NOT_OFFICIAL} ${
                    creditLine([model])
                }`,
                data: {
                    alert_type: kind,
                    forecast: true,
                    window_start: new Date(s.startMs).toISOString(),
                    window_end: new Date(s.endMs).toISOString(),
                    models: [model.name],
                    location: place,
                },
            },
            s.startMs,
            stem.hazard,
            `${label}: ${model.name}, ${when}: up to ${fmt(s.peak)}.`,
        );
    }

    // Good window opens (opt-in).
    if (account.goodWindow) {
        const label = LABEL.goodWindow;
        const windKts = account.limits.windKts;
        if (windKts === null) {
            out.lines.push(`${label}: needs a high wind limit.`);
        } else if (!inputs.ahead) {
            out.lines.push(`${label}: no forecast answered this run.`);
        } else {
            const waveM = account.limits.waveFt === null ? Infinity : account.limits.waveFt * 0.3048;
            const g = goodWindowAhead(inputs.ahead, inputs.sea, { maxWindKts: windKts, maxWaveM: waveM }, nowMs, hours);
            if (g.state === 'not-enough') {
                const who = g.answered.length > 0 ? `${names(g.answered)} only` : 'none';
                out.lines.push(`${label}: not enough models answered (${who}).`);
            } else if (g.state === 'already') {
                out.lines.push(`${label}: inside your limits now.`);
            } else if (g.state === 'none') {
                out.lines.push(`${label}: none ${ahead}.`);
            } else if (officialWindOrSea) {
                out.covered.push('goodWindow');
                out.lines.push(`${label}: not sent while an official wind or sea warning is in force here.`);
            } else {
                const when = windowText(g.startMs, g.endMs, zone);
                const agreed = `${g.agreeing.length} of ${WIND_MODELS.length} models agree (${names(g.agreeing)})`;
                const seas = inputs.sea
                    ? `seas from ${inputs.sea.model.name}`
                    : inputs.seaAnswered
                    ? 'no wave model here, so seas are not checked'
                    : 'seas not checked this run';
                const sources = inputs.sea ? [...g.agreeing, inputs.sea.model] : g.agreeing;
                offer(
                    {
                        kind: 'goodWindow',
                        alertKey: `goodWindow-ahead-${alertDay(g.startMs, zone)}`,
                        alsoClaims: [],
                        type: 'weather_alert',
                        title: `Forecast: good window opens, ${when}`,
                        body: `${agreed} at ${place}: inside your ${speedText(windKts, units)} wind limit (${
                            peaksText(g.peaks, (v) => speedText(v, units))
                        }), ${seas}. ${NOT_OFFICIAL} ${creditLine(sources)}`,
                        data: {
                            alert_type: 'goodWindow',
                            forecast: true,
                            window_start: new Date(g.startMs).toISOString(),
                            window_end: new Date(g.endMs).toISOString(),
                            models: g.agreeing.map((m) => m.name),
                            location: place,
                        },
                    },
                    g.startMs,
                    null,
                    `${label}: ${agreed}, ${when}.`,
                );
            }
        }
    }

    // The hour under way: visibility, UV, temperature, rain (ECMWF, else GFS).
    const now = inputs.now;
    if (now) {
        const today = alertDay(nowMs, zone);
        const nowPush = (
            kind: NowKind,
            model: AheadModel,
            title: string,
            detail: string,
            keys: [string, string[]] = [`${kind}-${today}`, []],
            hazard: readonly [OfficialHazard, number] | null = HAZARD_OF_NOW[kind] ?? null,
        ): void => {
            offer(
                {
                    kind,
                    alertKey: keys[0],
                    alsoClaims: keys[1],
                    type: 'weather_alert',
                    title,
                    body: `${model.name} at ${place}: ${detail} ${NOT_OFFICIAL} ${creditLine([model])}`,
                    data: { alert_type: kind, forecast: true, models: [model.name], location: place },
                },
                // The current hour: it starts now, so the night never holds it.
                nowMs,
                hazard,
                null,
            );
        };
        const vis = now.visibility;
        const visLimit = threshold('visibility');
        if (on('visibility') && vis && visLimit !== null && vis.value / 1852 <= visLimit) {
            const nm = vis.value / 1852;
            nowPush(
                'visibility',
                vis.model,
                `Forecast: poor visibility now, ${visibilityText(nm, units)}`,
                `visibility ${visibilityText(nm, units)}, under your ${visibilityText(visLimit, units)}.`,
            );
        }
        const uv = now.uv_index;
        const uvLimit = threshold('uv');
        if (on('uv') && uv && uvLimit !== null && uv.value >= uvLimit) {
            nowPush(
                'uv',
                uv.model,
                `Forecast: high UV now, index ${Math.round(uv.value)}`,
                `UV index ${Math.round(uv.value)}, your limit ${uvLimit}.`,
            );
        }
        const temp = now.temperature_2m;
        const hot = threshold('tempHigh');
        if (on('tempHigh') && temp && hot !== null && temp.value >= hot) {
            nowPush(
                'tempHigh',
                temp.model,
                `Forecast: heat, ${tempText(temp.value, units)} now`,
                `air ${tempText(temp.value, units)}, over your ${tempText(hot, units)}.`,
            );
        }
        const cold = threshold('tempLow');
        if (on('tempLow') && temp && cold !== null && temp.value <= cold) {
            nowPush(
                'tempLow',
                temp.model,
                `Forecast: cold now, ${tempText(temp.value, units)}`,
                `air ${tempText(temp.value, units)}, under your ${tempText(cold, units)}.`,
            );
        }
        const code = now.weather_code;
        if (on('precipitation') && code && code.value >= 51) {
            const words = weatherWords(code.value);
            const thunder = isThunder(code.value);
            nowPush(
                'precipitation',
                code.model,
                `Forecast: ${words} now`,
                `${words} in the forecast for this hour.`,
                tierKeys('precipitation', TIERS.precipitation, thunder ? 'thunder' : 'wet', today),
                thunder ? THUNDER : null,
            );
        }
    }
    return out;
}
