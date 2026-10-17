/**
 * ModelSpreadService — one-request multi-model forecasts for the Glass's
 * ten-day model comparison (and, from W1-09, the day cards' agreement chip).
 *
 * Unlike MultiModelWeatherService (one request per model, four params), this
 * asks Open-Meteo, through the proxy-openmeteo edge function, for all seven
 * comparison models (COMPARE_MODELS) in a single call and parses the
 * model-suffixed response keys (`wind_speed_10m_dwd_icon`, …), plus a second
 * call to the marine endpoint for the wave models: 2 requests instead of 11.
 *
 * Always ten days (240 h) and memoised per 0.1° cell for 30 minutes, so every
 * caller at the Glass point shares one answer: the sheet and the day cards
 * cannot disagree, and reopening the sheet costs nothing.
 *
 * Times are requested as `timeformat=unixtime` so parsing is exact epoch
 * math — ISO strings without a zone suffix get parsed as LOCAL time by
 * `new Date()`, which silently shifts every sample by the device's UTC
 * offset (a live bug class in the older per-model fetchers).
 */
import { pruneMap } from '../../utils/boundedMap';

import { fetchOpenMeteoProxy } from './openMeteoProxy';
import { selectableForecastModels, SPREAD_EXTRA_MODELS, SELECTABLE_MODELS, WAVE_SPREAD_MODELS } from './forecastModels';
import { refreshCoastalModelCapabilities, supportedRegionalModel } from './coastalModelSupport';
import { markModelUnavailable } from './modelLiveness';
import { ECMWF_9KM, regionalModelLabel } from './regionalModels';
import { isAromeModel, AROME_MAX_SOURCE_AGE_MS } from './aromeDomains';
import { fetchOwnAromePoint } from './aromeSource';
import type { AromePointForecast, AromeVariable } from './aromePointContract';

export interface ComparisonModel {
    id: string;
    label: string;
    provider: string;
    hex: string;
    horizonHours?: number;
    /** UKV is licensed for labelled display only, never any derived value. */
    displayOnly?: boolean;
}

export function comparisonModelsFor(lat: number, lon: number): ComparisonModel[] {
    const regional = supportedRegionalModel(lat, lon);
    return [
        ...selectableForecastModels(),
        ...SPREAD_EXTRA_MODELS,
        ...(regional
            ? [
                  {
                      id: regional.id,
                      label: regionalModelLabel(regional),
                      provider: regional.provider,
                      hex: '#e879f9',
                      horizonHours: regional.horizonHours,
                      displayOnly: regional.displayOnly,
                  },
              ]
            : []),
    ];
}

export const ATMOS_VARS = [
    'wind_speed_10m',
    'wind_gusts_10m',
    'wind_direction_10m',
    'pressure_msl',
    'temperature_2m',
    'relative_humidity_2m',
    'precipitation',
    'visibility',
    'uv_index',
    // WMO codes, for Plan Your Day's thunder count (95, 96, 99). The
    // comparison names its variables itself, so this adds no tab (build 124).
    'weather_code',
] as const;
export type AtmosVar = (typeof ATMOS_VARS)[number];

export const MARINE_VARS = ['wave_height', 'wave_period'] as const;
export type MarineVar = (typeof MARINE_VARS)[number];

export interface SpreadModelSeries<V extends string> {
    id: string;
    label: string;
    provider: string;
    hex: string;
    horizonHours?: number;
    displayOnly?: boolean;
    /** Own regional source facts; never inferred from a successful HTTP request. */
    sourceRunAtMs?: number;
    sourceCohortSha256?: string;
    /** Per-variable hourly values aligned to the block's `times`. null = the
     *  model doesn't publish that variable (or that hour is missing). */
    values: Record<V, (number | null)[]>;
}

/** Exact UTC alignment. A short local run never borrows global tail values. */
export function addAromeSeries(
    block: SpreadBlock<AtmosVar> | null,
    own: AromePointForecast,
    member: ComparisonModel,
): SpreadBlock<AtmosVar> {
    const times = block?.times ?? own.hourly.time.map((time) => time * 1000);
    const positions = new Map(own.hourly.time.map((time, index) => [time * 1000, index]));
    const values = {} as Record<AtmosVar, (number | null)[]>;
    for (const variable of ATMOS_VARS) {
        const samples = own.hourly[variable as AromeVariable];
        values[variable] = times.map((time) => {
            const index = positions.get(time);
            return index !== undefined && samples ? (samples[index] ?? null) : null;
        });
    }
    return {
        times,
        models: [
            ...(block?.models ?? []),
            { ...member, values, sourceRunAtMs: Date.parse(own.runUtc), sourceCohortSha256: own.cohortSha256 },
        ],
    };
}

function expiredArome(result: ModelSpreadResult): boolean {
    return (
        result.atmos?.models.some(
            (model) =>
                isAromeModel(model.id) &&
                (model.sourceRunAtMs === undefined ||
                    model.sourceRunAtMs > Date.now() ||
                    Date.now() - model.sourceRunAtMs > AROME_MAX_SOURCE_AGE_MS),
        ) ?? false
    );
}

export interface SpreadBlock<V extends string> {
    /** Epoch milliseconds, hourly. */
    times: number[];
    models: SpreadModelSeries<V>[];
}

export interface ModelSpreadResult {
    atmos: SpreadBlock<AtmosVar> | null;
    marine: SpreadBlock<MarineVar> | null;
    /** The legs whose request failed (offline, timeout, a refusal): their
     *  block is null because no server answered, not because no model
     *  publishes there. Absent when both answered, as on every memoised
     *  result. */
    unreachable?: ('atmos' | 'marine')[];
}

/** Ten days: ICON and UKMO end near day 7, GEM near day 9.5, and the rest
 *  run the whole way (the proxy allows up to 384 h). */
const SPREAD_HOURS = 240;
/** Models run every 6 h, so half an hour stays fresh and keeps the comparison
 *  to two proxy calls per place per half hour, however often it opens. */
const MEMO_TTL_MS = 30 * 60 * 1000;

const memo = new Map<string, { at: number; data: ModelSpreadResult }>();
const inflight = new Map<string, Promise<ModelSpreadResult>>();
/** The last answer per cell with a leg missing, and how long a passive
 *  reader takes it rather than asking again (W1-09 review). */
const incomplete = new Map<string, { at: number; data: ModelSpreadResult }>();
const PASSIVE_RETRY_MS = 5 * 60 * 1000;

export interface SpreadQueryOptions {
    /** A reader that asks without being opened: the Glass day cards' chip,
     *  which asks on every day swipe. It also takes a recent answer that
     *  came back with a leg missing (or none), so a refused or timed-out leg
     *  costs one pair of requests per five minutes rather than one per swipe.
     *  The comparison sheet asks without it, so opening it still retries. */
    passive?: boolean;
}

/** The 0.1° cell (~11 km) a point falls in. The antimeridian's two sides share
 *  a cell, and so do ±0. Exported for tests. */
export function spreadCellKey(lat: number, lon: number): string {
    const cell = (v: number) => Math.round(v * 10) / 10 || 0;
    const lonCell = cell(lon);
    return `${cell(lat).toFixed(1)},${(lonCell === 180 ? -180 : lonCell).toFixed(1)}`;
}

/**
 * Parse a multi-model hourly block. Open-Meteo suffixes every variable with
 * the model id when `models=` lists more than one — `wave_height_dwd_gwam` —
 * and omits the key entirely for models that don't publish the variable.
 * Exported for tests.
 */
export function parseSuffixedHourly<V extends string>(
    hourly: Record<string, unknown> | undefined,
    vars: readonly V[],
    models: ComparisonModel[],
): SpreadBlock<V> | null {
    const rawTimes = hourly?.time;
    if (!Array.isArray(rawTimes) || rawTimes.length === 0) return null;
    // timeformat=unixtime → seconds since epoch
    const times = (rawTimes as number[]).map((t) => t * 1000);

    const out: SpreadModelSeries<V>[] = [];
    for (const m of models) {
        const values = {} as Record<V, (number | null)[]>;
        let hasAny = false;
        for (const v of vars) {
            const arr = hourly?.[`${v}_${m.id}`];
            if (Array.isArray(arr)) {
                values[v] = times.map((_, i) => {
                    const x: unknown = arr[i];
                    return i < (m.horizonHours ?? Infinity) && typeof x === 'number' && Number.isFinite(x) ? x : null;
                });
                if (values[v].some((x) => x != null)) hasAny = true;
            } else {
                values[v] = times.map(() => null);
            }
        }
        // A model with no data at all (not synced / outside domain) is
        // dropped rather than plotted as a flat null line.
        if (hasAny) out.push({ ...m, values });
    }
    return out.length ? { times, models: out } : null;
}

async function fetchSpread(
    lat: number,
    lon: number,
    requested: ComparisonModel[],
): Promise<{ data: ModelSpreadResult; complete: boolean }> {
    const ownMember = requested.find((model) => isAromeModel(model.id));
    const paidModels = requested.filter((model) => !isAromeModel(model.id));
    let atmosModels = paidModels;
    const common = {
        latitude: lat.toFixed(4),
        longitude: lon.toFixed(4),
        forecast_hours: String(SPREAD_HOURS),
        timeformat: 'unixtime',
        cell_selection: 'sea',
    };
    const [atmosRaw, marineRaw, own] = await Promise.all([
        fetchOpenMeteoProxy<Record<string, unknown>>('forecast', {
            ...common,
            hourly: ATMOS_VARS.join(','),
            models: paidModels.map((m) => m.id).join(','),
            wind_speed_unit: 'kn',
        }).catch(async () => {
            // A proxy rollback must not blank the seven established models.
            // Retry once under their real IDs; never relabel ifs025 as 9 km.
            const newModels = paidModels.filter((m) => m.id === ECMWF_9KM || m.horizonHours !== undefined);
            if (!newModels.length) return null;
            newModels.forEach((m) => markModelUnavailable(m.id, { lat, lon }));
            atmosModels = [...SELECTABLE_MODELS, ...SPREAD_EXTRA_MODELS];
            return fetchOpenMeteoProxy<Record<string, unknown>>('forecast', {
                ...common,
                hourly: ATMOS_VARS.join(','),
                models: atmosModels.map((m) => m.id).join(','),
                wind_speed_unit: 'kn',
            }).catch(() => null);
        }),
        fetchOpenMeteoProxy<Record<string, unknown>>('marine', {
            ...common,
            hourly: MARINE_VARS.join(','),
            models: WAVE_SPREAD_MODELS.map((m) => m.id).join(','),
        }).catch(() => null),
        ownMember ? fetchOwnAromePoint(ownMember.id, { lat, lon }) : Promise.resolve(null),
    ]);

    const unreachable: ('atmos' | 'marine')[] = [];
    if (atmosRaw === null || (ownMember && own === null)) unreachable.push('atmos');
    if (marineRaw === null) unreachable.push('marine');
    let atmos = parseSuffixedHourly(atmosRaw?.hourly as Record<string, unknown> | undefined, ATMOS_VARS, atmosModels);
    if (own && ownMember) atmos = addAromeSeries(atmos, own, ownMember);
    else if (ownMember) markModelUnavailable(ownMember.id, { lat, lon });
    return {
        // Both endpoints ANSWERED (a 200 with legitimately-empty data — e.g.
        // marine inland — still counts). Distinct from data presence: only
        // complete results are safe to memoise.
        complete: unreachable.length === 0,
        data: {
            atmos,
            marine: parseSuffixedHourly(
                marineRaw?.hourly as Record<string, unknown> | undefined,
                MARINE_VARS,
                WAVE_SPREAD_MODELS,
            ),
            ...(unreachable.length ? { unreachable } : {}),
        },
    };
}

/**
 * The ten-day spread for the 0.1° cell holding (lat, lon): memoised for 30
 * minutes and in-flight-deduped per cell. The first caller's exact point is
 * the one fetched; later callers in the same cell share that answer. An
 * answer with a leg missing is not memoised, except for passive readers.
 */
export async function queryModelSpread(
    lat: number,
    lon: number,
    options: SpreadQueryOptions = {},
): Promise<ModelSpreadResult> {
    await refreshCoastalModelCapabilities({ lat, lon });
    const models = comparisonModelsFor(lat, lon);
    // Sub-km regional grids cannot share an 11 km memo at the coast. Include
    // the gated catalogue so a pre-deploy answer never survives the swap.
    const precision = models.some((m) => isAromeModel(m.id)) ? 4 : 3;
    const point = models.some((m) => m.horizonHours !== undefined)
        ? `${lat.toFixed(precision)},${lon.toFixed(precision)}`
        : spreadCellKey(lat, lon);
    const key = `sea:${point}:${models.map((m) => m.id).join(',')}`;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < MEMO_TTL_MS && !expiredArome(hit.data)) return hit.data;
    const pending = inflight.get(key);
    if (pending) return pending;
    const recent = options.passive ? incomplete.get(key) : undefined;
    if (recent && Date.now() - recent.at < PASSIVE_RETRY_MS && !expiredArome(recent.data)) return recent.data;

    const promise = fetchSpread(lat, lon, models)
        .then(({ data, complete }) => {
            // Only memoise when BOTH endpoints answered — a transient failure
            // on either leg must not lock in a false "no model publishes
            // this" empty state for half an hour. A passive reader may take
            // the incomplete answer for a few minutes (SpreadQueryOptions).
            if (complete) {
                memo.set(key, { at: Date.now(), data });
                incomplete.delete(key);
                pruneMap(memo, 8, (entry) => Date.now() - entry.at >= MEMO_TTL_MS);
            } else {
                incomplete.set(key, { at: Date.now(), data });
                pruneMap(incomplete, 8, (entry) => Date.now() - entry.at >= PASSIVE_RETRY_MS);
            }
            return data;
        })
        .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
}
