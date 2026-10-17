/**
 * modelLiveness — is a forecast model publishing at all, judged by VALUES.
 *
 * Why it exists: BOM suspended ACCESS-G open-data delivery in June 2025. Since
 * then every request for `bom_access_global` answers HTTP 200 with the wind key
 * present and every value null, everywhere on Earth (measured 2026-10-07 at the
 * Whitsundays, the Med, the North Sea, the Caribbean and San Francisco). A
 * status code or a key proves nothing; only non-null numbers do.
 *
 * The probe asks the app's own Open-Meteo proxy for one day of 10 m wind — the
 * variable every comparison leads with — at a point the caller names (a route
 * midpoint, so it is wherever in the world the skipper is), counts the finite
 * values, and keeps the verdict for a day on this device. Callers read the
 * verdict synchronously and start a probe in the background; nothing waits on
 * the network. A failed request is not a verdict: the model stays 'unknown'
 * and the probe retries after an hour.
 */
import { fetchOpenMeteoProxy } from './openMeteoProxy';
import { pruneMap } from '../../utils/boundedMap';
import { ECMWF_9KM, REGIONAL_MODELS } from './regionalModels';
import { isAromeModel, AROME_MAX_SOURCE_AGE_MS } from './aromeDomains';
import { fetchOwnAromePoint } from './aromeSource';

export type ModelLiveness = 'live' | 'dead' | 'unknown';

export interface ModelLivenessRecord {
    /** Open-Meteo model-domain id, exactly as sent in `&models=`. */
    model: string;
    live: boolean;
    /** Finite 10 m wind values in the reply. */
    nonNull: number;
    /** Values the reply carried for the probed hours. */
    total: number;
    checkedAt: number;
    lat: number;
    lon: number;
    /** Original own-source run expiry; a new check cannot extend it. */
    validUntilMs?: number;
}

export const LIVENESS_PROBE_HOURS = 24;
/** A day with wind for under half its hours is a partial sync, not a model. */
export const LIVENESS_MIN_FRACTION = 0.5;
export const LIVENESS_TTL_MS = 24 * 3_600_000;
export const LIVENESS_FAILURE_BACKOFF_MS = 3_600_000;
/**
 * A verdict stamped further ahead than this was written while the device
 * clock ran fast. Its age would read negative and it would outlive its day by
 * however far the clock was out (a year, on a phone set a year ahead), so it
 * is no verdict at all.
 */
export const LIVENESS_CLOCK_SKEW_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const STORAGE_KEY = 'thalassa_model_liveness_v1';
const MAX_RECORDS = 64;
type Point = { lat: number; lon: number };
const regionalIds = new Set(REGIONAL_MODELS.map((m) => m.id));
function verdictKey(model: string, point?: Point): string {
    // New coastal capabilities require a sea-cell probe. Regional verdicts
    // are local: a finite London response never unlocks a different domain.
    if (regionalIds.has(model)) {
        const precision = isAromeModel(model) ? 4 : 1;
        return `sea:${model}:${point ? `${point.lat.toFixed(precision)},${point.lon.toFixed(precision)}` : 'unknown'}`;
    }
    return model === ECMWF_9KM ? `sea:${model}` : model;
}

let records: Map<string, ModelLivenessRecord> | null = null;
const inFlight = new Map<string, Promise<ModelLivenessRecord | null>>();
const failedAt = new Map<string, number>();

/** Milliseconds since `at`, or null when `at` lies in the future beyond clock jitter. */
function ageOf(at: number): number | null {
    const age = Date.now() - at;
    return age < -LIVENESS_CLOCK_SKEW_MS ? null : age;
}

/** Finite numbers only — never keys, nulls, NaN or numeric strings. */
export function countNonNullValues(values: unknown): number {
    if (!Array.isArray(values)) return 0;
    let n = 0;
    for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) n += 1;
    return n;
}

function store(): Map<string, ModelLivenessRecord> {
    if (records) return records;
    records = new Map();
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, ModelLivenessRecord>;
        for (const [model, r] of Object.entries(parsed ?? {})) {
            if (r && typeof r.live === 'boolean' && Number.isFinite(r.checkedAt) && ageOf(r.checkedAt) !== null) {
                records.set(model, r);
            }
        }
        pruneMap(records, MAX_RECORDS, (r) => (ageOf(r.checkedAt) ?? Infinity) > LIVENESS_TTL_MS);
    } catch {
        // Unreadable or corrupt storage: no verdicts, so every model is unknown.
    }
    return records;
}

function save(record: ModelLivenessRecord, key = record.model): void {
    const all = store();
    all.set(key, record);
    pruneMap(all, MAX_RECORDS, (r) => (ageOf(r.checkedAt) ?? Infinity) > LIVENESS_TTL_MS);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(all)));
    } catch {
        // Memory still holds today's verdict.
    }
}

/**
 * Today's verdict for a model: 'unknown' until a probe has answered within a
 * day — and unknown for a verdict stamped in the future (see LIVENESS_CLOCK_SKEW_MS).
 */
export function modelLiveness(model: string, point?: Point): ModelLiveness {
    const r = store().get(verdictKey(model, point));
    const age = r ? ageOf(r.checkedAt) : null;
    if (
        !r ||
        age === null ||
        age > LIVENESS_TTL_MS ||
        (isAromeModel(model) &&
            r.live &&
            (typeof r.validUntilMs !== 'number' || !Number.isFinite(r.validUntilMs) || Date.now() > r.validUntilMs))
    )
        return 'unknown';
    return r.live ? 'live' : 'dead';
}

export function isModelLive(model: string, point?: Point): boolean {
    return modelLiveness(model, point) === 'live';
}

type ProbeReply = { hourly?: Record<string, unknown> };

/** Probe once now. Resolves null (and records nothing) when the request fails. */
export function probeModelLiveness(model: string, point: Point): Promise<ModelLivenessRecord | null> {
    const key = verdictKey(model, point);
    const pending = inFlight.get(key);
    if (pending) return pending;
    if (
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lon) ||
        Math.abs(point.lat) > 90 ||
        Math.abs(point.lon) > 180 ||
        inFlight.size >= MAX_RECORDS
    )
        return Promise.resolve(null);
    const run = (async () => {
        try {
            if (isAromeModel(model)) {
                const own = await fetchOwnAromePoint(model, point);
                if (!own) throw new Error('Original AROME sea-cell cohort unavailable');
                const values = own.hourly.wind_speed_10m;
                const nonNull = countNonNullValues(values);
                const record: ModelLivenessRecord = {
                    model,
                    live: nonNull >= Math.ceil(values.length * LIVENESS_MIN_FRACTION),
                    nonNull,
                    total: values.length,
                    checkedAt: Date.now(),
                    lat: point.lat,
                    lon: point.lon,
                    validUntilMs: Date.parse(own.runUtc) + AROME_MAX_SOURCE_AGE_MS,
                };
                failedAt.delete(key);
                save(record, key);
                return record;
            }
            const reply = await fetchOpenMeteoProxy<ProbeReply>(
                'forecast',
                {
                    latitude: point.lat.toFixed(4),
                    longitude: point.lon.toFixed(4),
                    hourly: 'wind_speed_10m',
                    models: model,
                    forecast_hours: LIVENESS_PROBE_HOURS,
                    timeformat: 'unixtime',
                    timezone: 'UTC',
                    ...(model === ECMWF_9KM || regionalIds.has(model) ? { cell_selection: 'sea' } : {}),
                },
                PROBE_TIMEOUT_MS,
            );
            const hourly = reply.hourly ?? {};
            const values = hourly[`wind_speed_10m_${model}`] ?? hourly.wind_speed_10m;
            const nonNull = countNonNullValues(values);
            const total = Array.isArray(values) ? values.length : 0;
            const record: ModelLivenessRecord = {
                model,
                live: nonNull >= Math.ceil(Math.max(total, LIVENESS_PROBE_HOURS) * LIVENESS_MIN_FRACTION),
                nonNull,
                total,
                checkedAt: Date.now(),
                lat: point.lat,
                lon: point.lon,
            };
            failedAt.delete(key);
            save(record, key);
            return record;
        } catch {
            failedAt.set(key, Date.now());
            pruneMap(failedAt, MAX_RECORDS, (at) => (ageOf(at) ?? Infinity) >= LIVENESS_FAILURE_BACKOFF_MS);
            return null;
        } finally {
            inFlight.delete(key);
        }
    })();
    inFlight.set(key, run);
    return run;
}

/**
 * Start a background probe when today's verdict is missing — never awaited,
 * never more than one at a time per model, and not again within an hour of a
 * failed request.
 */
export function ensureModelLiveness(model: string, point: { lat: number; lon: number }): void {
    void refreshModelLiveness(model, point);
}

/** Awaitable form for capability discovery; shares the same daily verdict,
 * in-flight coalescing and failure backoff as the passive callers. */
export function refreshModelLiveness(model: string, point: Point): Promise<ModelLivenessRecord | null> {
    const key = verdictKey(model, point);
    if (modelLiveness(model, point) !== 'unknown') return Promise.resolve(store().get(key) ?? null);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const failed = failedAt.get(key);
    const sinceFailure = failed === undefined ? null : ageOf(failed);
    if (sinceFailure !== null && sinceFailure < LIVENESS_FAILURE_BACKOFF_MS) return Promise.resolve(null);
    return probeModelLiveness(model, point);
}

/** A real request can disprove a prior capability (proxy rollback/null run). */
export function markModelUnavailable(model: string, point: Point = { lat: 0, lon: 0 }): void {
    save(
        { model, live: false, nonNull: 0, total: LIVENESS_PROBE_HOURS, checkedAt: Date.now(), ...point },
        verdictKey(model, point),
    );
}

/** Forget every verdict (tests). `keepStorage` simulates an app restart. */
export function resetModelLivenessForTests(options: { keepStorage?: boolean } = {}): void {
    records = null;
    inFlight.clear();
    failedAt.clear();
    if (!options.keepStorage) {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch {
            /* nothing stored */
        }
    }
}
