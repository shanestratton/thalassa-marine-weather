export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_ROWS = 16;
export const MODELS: Record<string, readonly string[]> = {
    ecmwf_ifs025: ['ecmwf_ifs025'],
    ecmwf_aifs025_single: ['ecmwf_aifs025_single'],
    dwd_icon: ['dwd_icon'],
    ukmo_global_deterministic_10km: ['ukmo_global_deterministic_10km'],
    jma_gsm: ['jma_gsm'],
    gfs_seamless: ['ncep_gfs013', 'ncep_gfs025'],
};
export function storedModel(model: string): string {
    if (!Object.hasOwn(MODELS, model)) throw new InputError('Unsupported model');
    return `wx2:${model}`;
}
export function rawStoredModel(model: unknown): string | null {
    if (typeof model !== 'string' || !model.startsWith('wx2:')) return null;
    const raw = model.slice(4);
    return Object.hasOwn(MODELS, raw) ? raw : null;
}
export const CURRENT_FIELDS = [
    'temperature_2m',
    'relative_humidity_2m',
    'apparent_temperature',
    'is_day',
    'precipitation',
    'rain',
    'showers',
    'snowfall',
    'weather_code',
    'cloud_cover',
    'pressure_msl',
    'surface_pressure',
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_gusts_10m',
] as const;
export const HOURLY_FIELDS = [
    'temperature_2m',
    'relative_humidity_2m',
    'dew_point_2m',
    'precipitation_probability',
    'precipitation',
    'weather_code',
    'pressure_msl',
    'surface_pressure',
    'cloud_cover',
    'visibility',
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_gusts_10m',
    'uv_index',
    'cape',
] as const;
export const DAILY_FIELDS = [
    'weather_code',
    'temperature_2m_max',
    'temperature_2m_min',
    'sunrise',
    'sunset',
    'uv_index_max',
    'precipitation_sum',
    'precipitation_hours',
    'wind_speed_10m_max',
    'wind_gusts_10m_max',
    'wind_direction_10m_dominant',
] as const;
type Obj = Record<string, unknown>;
export interface PublishRow {
    cell_id: string;
    model: string;
    run_at: string;
    payload: Obj;
}
export class InputError extends Error {}
export function object(value: unknown): value is Obj {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}
export function cellCentre(id: unknown): { latitude: number; longitude: number } | null {
    if (typeof id !== 'string' || !/^-?\d{1,4}_-?\d{1,5}$/.test(id)) return null;
    const [lat, lon] = id.split('_').map(Number);
    if (`${lat}_${lon}` !== id || lat % 25 || lon % 25 || lat < -9000 || lat > 8975 || lon < -18000 || lon > 17975)
        return null;
    return { latitude: lat / 100 + 0.125, longitude: lon / 100 + 0.125 };
}
export function validCursor(value: unknown): value is string {
    // Historical RPC rows may include polar/dateline boundary cells that we
    // skip sampling, but pagination must still advance past them safely.
    return typeof value === 'string' && /^-?\d{1,4}_-?\d{1,5}$/.test(value);
}
function requireThat(ok: unknown, reason: string): asserts ok {
    if (!ok) throw new InputError(reason);
}
function utc(value: unknown): number {
    requireThat(
        typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?Z$/.test(value),
        'Explicit UTC timestamp required',
    );
    const at = Date.parse(value);
    requireThat(
        Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value.slice(0, 10),
        'Invalid timestamp',
    );
    return at;
}
function runTime(value: unknown, now: number): number {
    const at = utc(value);
    requireThat(
        at % (3 * 3600_000) === 0 && now - at >= 20 * 60_000 && now - at <= 24 * 3600_000,
        'Source run is future, stale or off-cycle',
    );
    return at;
}
export const FIELD_UNITS: Record<string, string> = {
    temperature_2m: '°C',
    relative_humidity_2m: '%',
    apparent_temperature: '°C',
    is_day: '',
    precipitation: 'mm',
    rain: 'mm',
    showers: 'mm',
    snowfall: 'cm',
    weather_code: 'wmo code',
    cloud_cover: '%',
    pressure_msl: 'hPa',
    surface_pressure: 'hPa',
    wind_speed_10m: 'km/h',
    wind_direction_10m: '°',
    wind_gusts_10m: 'km/h',
    dew_point_2m: '°C',
    precipitation_probability: '%',
    visibility: 'm',
    uv_index: '',
    cape: 'J/kg',
    temperature_2m_max: '°C',
    temperature_2m_min: '°C',
    sunrise: 'iso8601',
    sunset: 'iso8601',
    uv_index_max: '',
    precipitation_sum: 'mm',
    precipitation_hours: 'h',
    wind_speed_10m_max: 'km/h',
    wind_gusts_10m_max: 'km/h',
    wind_direction_10m_dominant: '°',
};
function keysOnly(block: Obj, allowed: readonly string[], reason: string): void {
    requireThat(
        Object.keys(block).every((key) => allowed.includes(key)),
        reason,
    );
}
function reading(field: string, value: unknown): boolean {
    if (value === null) return true;
    if (!finite(value)) return false;
    // Broad physical bounds reject sentinels/unit mixups, not ordinary extremes.
    if (field.includes('temperature') || field === 'dew_point_2m') return value >= -120 && value <= 80;
    if (field.startsWith('wind_speed') || field.startsWith('wind_gusts')) return value >= 0 && value <= 600;
    if (field.startsWith('wind_direction')) return value >= 0 && value <= 360;
    if (['relative_humidity_2m', 'cloud_cover', 'precipitation_probability'].includes(field))
        return value >= 0 && value <= 100;
    if (field === 'pressure_msl' || field === 'surface_pressure') return value >= 100 && value <= 1200;
    if (field === 'is_day') return value === 0 || value === 1;
    if (field === 'weather_code') return Number.isInteger(value) && value >= 0 && value <= 99;
    if (field === 'precipitation_hours') return value >= 0 && value <= 24;
    if (field.startsWith('uv_index')) return value >= 0 && value <= 50;
    if (field === 'cape') return value >= 0 && value <= 50_000;
    if (field === 'visibility') return value >= 0 && value <= 1_000_000;
    if (['precipitation', 'rain', 'showers', 'snowfall'].includes(field)) return value >= 0 && value <= 2000;
    if (field === 'precipitation_sum') return value >= 0 && value <= 10_000;
    return false;
}
function unitsFor(block: Obj, fields: readonly string[], values: Obj, current = false): void {
    keysOnly(block, ['time', ...(current ? ['interval'] : []), ...fields], 'Unexpected unit field');
    requireThat(block.time === 'iso8601', 'Invalid time units');
    if (current) requireThat(block.interval === 'seconds', 'Invalid current interval units');
    for (const field of fields) {
        const supplied = Array.isArray(values[field]) ? (values[field] as unknown[]) : [values[field]];
        // The installed OM server labels unsupported all-null fields literally
        // "undefined". It is accepted only when no reading claims those units.
        requireThat(
            block[field] === FIELD_UNITS[field] ||
                (block[field] === 'undefined' && supplied.every((value) => value === null)),
            `Invalid ${field} units`,
        );
    }
}
export function validateRow(input: unknown, now: number): PublishRow {
    requireThat(object(input), 'Invalid publication row');
    requireThat(
        Object.keys(input).every((key) => ['cell_id', 'model', 'run_at', 'payload'].includes(key)),
        'Unexpected row field',
    );
    const centre = cellCentre(input.cell_id);
    requireThat(centre, 'Invalid coarse cell');
    requireThat(typeof input.model === 'string' && Object.hasOwn(MODELS, input.model), 'Unsupported model');
    const model = input.model;
    const run = runTime(input.run_at, now);
    requireThat(object(input.payload), 'Invalid payload');
    const p = input.payload;
    keysOnly(
        p,
        [
            'latitude',
            'longitude',
            'elevation',
            'generationtime_ms',
            'timezone_abbreviation',
            'timezone',
            'utc_offset_seconds',
            'current',
            'hourly',
            'daily',
            'current_units',
            'hourly_units',
            'daily_units',
            'thalassa_provenance',
        ],
        'Unexpected payload field',
    );
    requireThat(new TextEncoder().encode(JSON.stringify(p)).length <= 128 * 1024, 'Payload too large');
    if (p.elevation !== undefined && p.elevation !== null)
        requireThat(finite(p.elevation) && p.elevation >= -500 && p.elevation <= 10_000, 'Invalid elevation');
    if (p.generationtime_ms !== undefined && p.generationtime_ms !== null)
        requireThat(
            finite(p.generationtime_ms) && p.generationtime_ms >= 0 && p.generationtime_ms <= 120_000,
            'Invalid generation time',
        );
    if (p.timezone_abbreviation !== undefined && p.timezone_abbreviation !== null)
        requireThat(
            p.timezone_abbreviation === 'UTC' || p.timezone_abbreviation === 'GMT',
            'Invalid time zone abbreviation',
        );
    requireThat(
        p.utc_offset_seconds === 0 && ['UTC', 'GMT', 'Etc/UTC'].includes(String(p.timezone)),
        'UTC payload required',
    );
    requireThat(
        finite(p.latitude) && Math.abs(p.latitude) <= 90 && finite(p.longitude) && Math.abs(p.longitude) <= 180,
        'Invalid grid coordinates',
    );
    requireThat(
        Math.abs(p.latitude - centre.latitude) <= 1 &&
            Math.abs(((p.longitude - centre.longitude + 540) % 360) - 180) <= 1,
        'Grid belongs to another area',
    );
    const provenance = p.thalassa_provenance;
    requireThat(
        object(provenance) &&
            provenance.version === 2 &&
            provenance.source === 'wx' &&
            provenance.model === model &&
            provenance.cell_selection === 'sea' &&
            provenance.sampling === 'cell-centre' &&
            provenance.cell_id === input.cell_id &&
            provenance.cell_degrees === 0.25 &&
            provenance.latitude === centre.latitude &&
            provenance.longitude === centre.longitude &&
            provenance.run_at === input.run_at,
        'Invalid coarse-cell provenance',
    );
    keysOnly(
        provenance,
        [
            'version',
            'source',
            'model',
            'cell_selection',
            'sampling',
            'cell_id',
            'cell_degrees',
            'latitude',
            'longitude',
            'run_at',
            'source_domains',
            'source_runs',
        ],
        'Unexpected provenance field',
    );
    const domains = MODELS[model];
    requireThat(
        Array.isArray(provenance.source_domains) &&
            JSON.stringify(provenance.source_domains) === JSON.stringify(domains),
        'Invalid source domains',
    );
    requireThat(
        Array.isArray(provenance.source_runs) && provenance.source_runs.length === domains.length,
        'Missing source-run evidence',
    );
    const runs = provenance.source_runs.map((source, i) => {
        requireThat(object(source) && source.domain === domains[i], 'Wrong source-run domain');
        keysOnly(source, ['domain', 'run_at', 'data_end_at'], 'Unexpected source-run field');
        const initialised = runTime(source.run_at, now);
        requireThat(utc(source.data_end_at) >= now + 23 * 3600_000, 'Source horizon too short');
        return initialised;
    });
    requireThat(Math.min(...runs) === run, 'run_at must be the oldest dependent source run');
    requireThat(
        object(p.current) &&
            object(p.hourly) &&
            object(p.daily) &&
            object(p.current_units) &&
            object(p.hourly_units) &&
            object(p.daily_units),
        'Missing forecast blocks or units',
    );
    const current = p.current,
        hourly = p.hourly,
        daily = p.daily;
    keysOnly(current, ['time', 'interval', ...CURRENT_FIELDS], 'Unexpected current field');
    keysOnly(hourly, ['time', ...HOURLY_FIELDS], 'Unexpected hourly field');
    keysOnly(daily, ['time', ...DAILY_FIELDS], 'Unexpected daily field');
    requireThat(
        finite(current.interval) &&
            Number.isInteger(current.interval) &&
            current.interval > 0 &&
            current.interval <= 3600,
        'Invalid current interval',
    );
    const currentAt = utc(current.time);
    requireThat(now - currentAt >= -5 * 60_000 && now - currentAt <= 90 * 60_000, 'Current block is stale or future');
    for (const field of CURRENT_FIELDS) requireThat(reading(field, current[field]), `Invalid current ${field}`);
    for (const field of ['wind_speed_10m', 'wind_direction_10m', 'temperature_2m'])
        requireThat(finite(current[field]), `Missing current ${field}`);
    requireThat(
        Array.isArray(hourly.time) && hourly.time.length >= 24 && hourly.time.length <= 384,
        'Invalid hourly axis',
    );
    const times = hourly.time.map(utc);
    requireThat(
        times.every((at, i) => at % 3600_000 === 0 && (!i || at - times[i - 1] === 3600_000)),
        'Hourly axis must be consecutive UTC hours',
    );
    requireThat(
        times[0] >= Math.floor(now / 86400_000) * 86400_000 &&
            times[0] <= now &&
            times[times.length - 1] >= now + 22 * 3600_000 &&
            times[times.length - 1] <= now + 16 * 86400_000,
        'Invalid hourly horizon',
    );
    for (const field of HOURLY_FIELDS)
        requireThat(
            Array.isArray(hourly[field]) &&
                hourly[field].length === times.length &&
                hourly[field].every((value) => reading(field, value)),
            `Invalid hourly ${field}`,
        );
    const start = times.findIndex((at) => at >= Math.floor(now / 3600_000) * 3600_000);
    requireThat(start >= 0 && start + 24 <= times.length, 'Missing next-day hours');
    for (const field of ['wind_speed_10m', 'wind_direction_10m', 'temperature_2m']) {
        requireThat((hourly[field] as unknown[]).slice(start, start + 24).every(finite), `Missing next-day ${field}`);
    }
    requireThat(Array.isArray(daily.time) && daily.time.length >= 1 && daily.time.length <= 16, 'Invalid daily axis');
    const days = daily.time.map((value) => {
        requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value), 'Invalid day');
        return utc(value + 'T00:00:00Z');
    });
    requireThat(
        days.every((at, i) => !i || at - days[i - 1] === 86400_000) &&
            days[0] === Math.floor(now / 86400_000) * 86400_000 &&
            days[days.length - 1] + 23 * 3600_000 <= times[times.length - 1],
        'Incomplete daily horizon',
    );
    for (const field of DAILY_FIELDS) {
        requireThat(Array.isArray(daily[field]) && daily[field].length === days.length, `Invalid daily ${field}`);
        if (field === 'sunrise' || field === 'sunset') {
            for (const value of daily[field]) if (value !== null) utc(value);
        } else
            requireThat(
                daily[field].every((value) => reading(field, value)),
                `Invalid daily ${field}`,
            );
    }
    unitsFor(p.current_units, CURRENT_FIELDS, current, true);
    unitsFor(p.hourly_units, HOURLY_FIELDS, hourly);
    unitsFor(p.daily_units, DAILY_FIELDS, daily);
    return input as unknown as PublishRow;
}
