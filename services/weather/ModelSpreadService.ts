/**
 * ModelSpreadService — one-request multi-model forecasts for the Glass
 * convergence chart.
 *
 * Unlike MultiModelWeatherService (one request per model, four params), this
 * asks Open-Meteo for ALL selectable models in a single call and parses the
 * model-suffixed response keys (`wind_speed_10m_dwd_icon`, …), plus a second
 * call to the marine endpoint for the wave models. Against the self-hosted
 * wx server that's two round-trips of a few ms; against the commercial API
 * it's still 2 requests instead of 7+.
 *
 * Times are requested as `timeformat=unixtime` so parsing is exact epoch
 * math — ISO strings without a zone suffix get parsed as LOCAL time by
 * `new Date()`, which silently shifts every sample by the device's UTC
 * offset (a live bug class in the older per-model fetchers).
 */
import { CapacitorHttp } from '@capacitor/core';

import { isWxServerAvailable, wxServerBase } from './wxServer';
import { fetchOpenMeteoProxy } from './openMeteoProxy';
import { SELECTABLE_MODELS, WAVE_SPREAD_MODELS } from './forecastModels';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('ModelSpreadService');

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
] as const;
export type AtmosVar = (typeof ATMOS_VARS)[number];

export const MARINE_VARS = ['wave_height', 'wave_period'] as const;
export type MarineVar = (typeof MARINE_VARS)[number];

export interface SpreadModelSeries<V extends string> {
    id: string;
    label: string;
    provider: string;
    hex: string;
    /** Per-variable hourly values aligned to the block's `times`. null = the
     *  model doesn't publish that variable (or that hour is missing). */
    values: Record<V, (number | null)[]>;
}

export interface SpreadBlock<V extends string> {
    /** Epoch milliseconds, hourly. */
    times: number[];
    models: SpreadModelSeries<V>[];
}

export interface ModelSpreadResult {
    fromWxServer: boolean;
    atmos: SpreadBlock<AtmosVar> | null;
    marine: SpreadBlock<MarineVar> | null;
}

const FETCH_TIMEOUT_MS = 15_000;
const MEMO_TTL_MS = 5 * 60 * 1000;

const memo = new Map<string, { at: number; data: ModelSpreadResult }>();
const inflight = new Map<string, Promise<ModelSpreadResult>>();

async function getJson(url: string): Promise<Record<string, unknown> | null> {
    try {
        const res = await Promise.race([
            CapacitorHttp.get({ url, connectTimeout: FETCH_TIMEOUT_MS, readTimeout: FETCH_TIMEOUT_MS }),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('spread fetch timeout')), FETCH_TIMEOUT_MS),
            ),
        ]);
        if (!res || res.status !== 200 || !res.data) return null;
        return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch (e) {
        log.warn('spread fetch failed:', (e as Error)?.message || e);
        return null;
    }
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
    models: { id: string; label: string; provider: string; hex: string }[],
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
                values[v] = (arr as (number | null)[]).map((x) => (typeof x === 'number' ? x : null));
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
    hours: number,
): Promise<{ data: ModelSpreadResult; complete: boolean }> {
    const useWx = await isWxServerAvailable();

    const common = {
        latitude: lat.toFixed(4),
        longitude: lon.toFixed(4),
        forecast_hours: String(hours),
        timeformat: 'unixtime',
    };

    const atmosParams = new URLSearchParams({
        ...common,
        hourly: ATMOS_VARS.join(','),
        models: SELECTABLE_MODELS.map((m) => m.id).join(','),
        wind_speed_unit: 'kn',
    });
    const marineParams = new URLSearchParams({
        ...common,
        hourly: MARINE_VARS.join(','),
        models: WAVE_SPREAD_MODELS.map((m) => m.id).join(','),
    });
    const [atmosRaw, marineRaw] = useWx
        ? await Promise.all([
              getJson(`${wxServerBase()}/v1/forecast?${atmosParams}`),
              getJson(`${wxServerBase()}/v1/marine?${marineParams}`),
          ])
        : await Promise.all([
              fetchOpenMeteoProxy<Record<string, unknown>>('forecast', Object.fromEntries(atmosParams.entries())).catch(
                  () => null,
              ),
              fetchOpenMeteoProxy<Record<string, unknown>>('marine', Object.fromEntries(marineParams.entries())).catch(
                  () => null,
              ),
          ]);

    return {
        // Both endpoints ANSWERED (a 200 with legitimately-empty data — e.g.
        // marine inland — still counts). Distinct from data presence: only
        // complete results are safe to memoise.
        complete: atmosRaw !== null && marineRaw !== null,
        data: {
            fromWxServer: useWx,
            atmos: parseSuffixedHourly(
                atmosRaw?.hourly as Record<string, unknown> | undefined,
                ATMOS_VARS,
                SELECTABLE_MODELS.map((m) => ({ id: m.id, label: m.label, provider: m.provider, hex: m.hex })),
            ),
            marine: parseSuffixedHourly(
                marineRaw?.hourly as Record<string, unknown> | undefined,
                MARINE_VARS,
                WAVE_SPREAD_MODELS,
            ),
        },
    };
}

/** Memoised + inflight-deduped spread fetch. */
export async function queryModelSpread(lat: number, lon: number, hours = 72): Promise<ModelSpreadResult> {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)},${hours}`;
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.data;
    const pending = inflight.get(key);
    if (pending) return pending;

    const promise = fetchSpread(lat, lon, hours)
        .then(({ data, complete }) => {
            // Only memoise when BOTH endpoints answered — a transient failure
            // on either leg must not lock in a false "no model publishes
            // this" empty state for 5 minutes.
            if (complete) memo.set(key, { at: Date.now(), data });
            return data;
        })
        .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
}
