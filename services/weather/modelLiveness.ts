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
    } catch {
        // Unreadable or corrupt storage: no verdicts, so every model is unknown.
    }
    return records;
}

function save(record: ModelLivenessRecord): void {
    const all = store();
    all.set(record.model, record);
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
export function modelLiveness(model: string): ModelLiveness {
    const r = store().get(model);
    const age = r ? ageOf(r.checkedAt) : null;
    if (!r || age === null || age > LIVENESS_TTL_MS) return 'unknown';
    return r.live ? 'live' : 'dead';
}

export function isModelLive(model: string): boolean {
    return modelLiveness(model) === 'live';
}

type ProbeReply = { hourly?: Record<string, unknown> };

/** Probe once now. Resolves null (and records nothing) when the request fails. */
export function probeModelLiveness(
    model: string,
    point: { lat: number; lon: number },
): Promise<ModelLivenessRecord | null> {
    const pending = inFlight.get(model);
    if (pending) return pending;
    const run = (async () => {
        try {
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
                },
                PROBE_TIMEOUT_MS,
            );
            const hourly = reply.hourly ?? {};
            const values = hourly[`wind_speed_10m_${model}`] ?? hourly.wind_speed_10m;
            const nonNull = countNonNullValues(values);
            const total = Array.isArray(values) ? values.length : 0;
            const record: ModelLivenessRecord = {
                model,
                live: total > 0 && nonNull >= Math.max(1, Math.ceil(total * LIVENESS_MIN_FRACTION)),
                nonNull,
                total,
                checkedAt: Date.now(),
                lat: point.lat,
                lon: point.lon,
            };
            failedAt.delete(model);
            save(record);
            return record;
        } catch {
            failedAt.set(model, Date.now());
            return null;
        } finally {
            inFlight.delete(model);
        }
    })();
    inFlight.set(model, run);
    return run;
}

/**
 * Start a background probe when today's verdict is missing — never awaited,
 * never more than one at a time per model, and not again within an hour of a
 * failed request.
 */
export function ensureModelLiveness(model: string, point: { lat: number; lon: number }): void {
    if (modelLiveness(model) !== 'unknown' || inFlight.has(model)) return;
    const failed = failedAt.get(model);
    const sinceFailure = failed === undefined ? null : ageOf(failed);
    if (sinceFailure !== null && sinceFailure < LIVENESS_FAILURE_BACKOFF_MS) return;
    void probeModelLiveness(model, point);
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
