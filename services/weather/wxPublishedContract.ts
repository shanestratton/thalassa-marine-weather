/** Versioned, coarse-cell wx forecasts. The storage alias prevents older apps
 * from treating a retained publication-time current block as live weather. */
import SunCalc from 'suncalc';

const DOMAINS: Record<string, readonly string[]> = {
    ecmwf_ifs025: ['ecmwf_ifs025'],
    ecmwf_aifs025_single: ['ecmwf_aifs025_single'],
    dwd_icon: ['dwd_icon'],
    ukmo_global_deterministic_10km: ['ukmo_global_deterministic_10km'],
    jma_gsm: ['jma_gsm'],
    gfs_seamless: ['ncep_gfs013', 'ncep_gfs025'],
};
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const utc = (v: unknown): number => {
    if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?Z$/.test(v)) return NaN;
    const at = Date.parse(v);
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === v.slice(0, 10) ? at : NaN;
};
const UNITS: Record<string, string> = {
    temperature_2m: '°C',
    relative_humidity_2m: '%',
    dew_point_2m: '°C',
    precipitation_probability: '%',
    precipitation: 'mm',
    weather_code: 'wmo code',
    pressure_msl: 'hPa',
    surface_pressure: 'hPa',
    cloud_cover: '%',
    visibility: 'm',
    wind_speed_10m: 'km/h',
    wind_direction_10m: '°',
    wind_gusts_10m: 'km/h',
    uv_index: '',
    cape: 'J/kg',
};
const DAILY_UNITS: Record<string, string> = {
    weather_code: 'wmo code',
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
function reading(field: string, value: unknown): boolean {
    if (value === null) return true;
    if (!finite(value)) return false;
    if (field.includes('temperature') || field === 'dew_point_2m') return value >= -120 && value <= 80;
    if (field.startsWith('wind_speed') || field.startsWith('wind_gusts')) return value >= 0 && value <= 600;
    if (field.startsWith('wind_direction')) return value >= 0 && value <= 360;
    if (['relative_humidity_2m', 'cloud_cover', 'precipitation_probability'].includes(field))
        return value >= 0 && value <= 100;
    if (field.includes('pressure')) return value >= 100 && value <= 1200;
    if (field === 'weather_code') return Number.isInteger(value) && value >= 0 && value <= 99;
    if (field === 'precipitation_hours') return value >= 0 && value <= 24;
    if (field.startsWith('uv_index')) return value >= 0 && value <= 50;
    if (field === 'cape') return value >= 0 && value <= 50_000;
    if (field === 'visibility') return value >= 0 && value <= 1_000_000;
    return value >= 0 && value <= (field === 'precipitation_sum' ? 10_000 : 2000);
}
function valuesValid(block: Obj, units: Obj, expected: Record<string, string>, count: number): boolean {
    if (units.time !== 'iso8601' || Object.keys(block).some((key) => key !== 'time' && !Object.hasOwn(expected, key)))
        return false;
    for (const [field, unit] of Object.entries(expected)) {
        const values = block[field];
        if (!Array.isArray(values) || values.length !== count) return false;
        if (units[field] !== unit && !(units[field] === 'undefined' && values.every((value) => value === null)))
            return false;
        if (
            !values.every((value) =>
                field === 'sunrise' || field === 'sunset'
                    ? value === null || Number.isFinite(utc(value))
                    : reading(field, value),
            )
        )
            return false;
    }
    return true;
}

export const publishedStorageModel = (model: string): string =>
    Object.hasOwn(DOMAINS, model) ? `wx2:${model}` : model;

export function publishedRawModel(model: string): string | null {
    if (model === 'spitfire') return model;
    if (!model.startsWith('wx2:')) return null;
    const raw = model.slice(4);
    return Object.hasOwn(DOMAINS, raw) ? raw : null;
}

export function quarterCellId(lat: number, lon: number): string {
    const snap = (v: number) => Math.round(Math.floor(v / 0.25) * 25);
    return `${snap(lat)}_${snap(lon)}`;
}

/** Rebase the retained hourly run at the current UTC hour. Never extrapolate
 * its old current block, upgrade its resolution, or manufacture missing data. */
export function projectCoarseForecast(
    payload: unknown,
    model: string,
    lat: number,
    lon: number,
    runAt: string,
    now = Date.now(),
): Obj | null {
    if (
        !Object.hasOwn(DOMAINS, model) ||
        !finite(lat) ||
        !finite(lon) ||
        lat < -90 ||
        lat >= 90 ||
        lon < -180 ||
        lon >= 180 ||
        !finite(now)
    )
        return null;
    // PostgREST serialises timestamptz as +00:00; provenance keeps issuer Z.
    const run = utc(runAt.replace(/\+00:00$/, 'Z'));
    if (!Number.isFinite(run) || run % (3 * HOUR) !== 0 || now - run < 20 * 60_000 || now - run > DAY) return null;
    if (!object(payload) || !object(payload.thalassa_provenance)) return null;
    const p = payload.thalassa_provenance;
    const cell = quarterCellId(lat, lon);
    const [south, west] = cell.split('_').map(Number);
    const centreLat = south / 100 + 0.125;
    const centreLon = west / 100 + 0.125;
    if (
        p.version !== 2 ||
        p.source !== 'wx' ||
        p.model !== model ||
        utc(p.run_at) !== run ||
        p.cell_selection !== 'sea' ||
        p.sampling !== 'cell-centre' ||
        p.cell_id !== cell ||
        p.cell_degrees !== 0.25 ||
        p.latitude !== centreLat ||
        p.longitude !== centreLon ||
        payload.utc_offset_seconds !== 0 ||
        !['UTC', 'GMT', 'Etc/UTC'].includes(String(payload.timezone)) ||
        !finite(payload.latitude) ||
        Math.abs(payload.latitude) > 90 ||
        !finite(payload.longitude) ||
        Math.abs(payload.longitude) > 180 ||
        Math.abs(payload.latitude - centreLat) > 1 ||
        Math.abs(((payload.longitude - centreLon + 540) % 360) - 180) > 1 ||
        JSON.stringify(p.source_domains) !== JSON.stringify(DOMAINS[model]) ||
        !Array.isArray(p.source_runs) ||
        p.source_runs.length !== DOMAINS[model].length
    )
        return null;
    const sourceRuns: number[] = [];
    for (const [i, source] of p.source_runs.entries()) {
        if (!object(source) || source.domain !== DOMAINS[model][i]) return null;
        const at = utc(source.run_at);
        const end = utc(source.data_end_at);
        if (
            !Number.isFinite(at) ||
            at % (3 * HOUR) !== 0 ||
            now - at < 20 * 60_000 ||
            now - at > DAY ||
            !Number.isFinite(end) ||
            end < now + 23 * HOUR
        )
            return null;
        sourceRuns.push(at);
    }
    if (Math.min(...sourceRuns) !== run) return null;
    if (
        !object(payload.hourly) ||
        !object(payload.daily) ||
        !object(payload.hourly_units) ||
        !object(payload.daily_units)
    )
        return null;
    const hourly = payload.hourly;
    const daily = payload.daily;
    if (
        !Array.isArray(hourly.time) ||
        hourly.time.length < 24 ||
        hourly.time.length > 384 ||
        !Array.isArray(daily.time) ||
        !daily.time.length
    )
        return null;
    const times = hourly.time.map(utc);
    if (
        !times.length ||
        !times.every((at, i) => Number.isFinite(at) && at % HOUR === 0 && (!i || at - times[i - 1] === HOUR)) ||
        times[times.length - 1] > now + 16 * DAY ||
        !valuesValid(hourly, payload.hourly_units, UNITS, times.length)
    )
        return null;
    const index = times.indexOf(Math.floor(now / HOUR) * HOUR);
    if (index < 0 || index + 24 > times.length) return null;
    for (const [key, values] of Object.entries(hourly)) {
        if (
            key !== 'time' &&
            (!Array.isArray(values) || values.length !== times.length || !values.every((v) => v === null || finite(v)))
        )
            return null;
    }
    for (const [field, unit] of [
        ['wind_speed_10m', 'km/h'],
        ['wind_direction_10m', '°'],
        ['temperature_2m', '°C'],
    ]) {
        const values = hourly[field];
        if (
            payload.hourly_units[field] !== unit ||
            !Array.isArray(values) ||
            !values.slice(index, index + 24).every(finite)
        )
            return null;
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const dayIndex = daily.time.indexOf(day);
    if (
        dayIndex < 0 ||
        daily.time.length > 16 ||
        !daily.time.every(
            (d, i) =>
                typeof d === 'string' &&
                /^\d{4}-\d\d-\d\d$/.test(d) &&
                (!i ||
                    Date.parse(d + 'T00:00:00Z') -
                        Date.parse(String((daily.time as unknown[])[i - 1]) + 'T00:00:00Z') ===
                        DAY),
        )
    )
        return null;
    if (
        !valuesValid(daily, payload.daily_units, DAILY_UNITS, daily.time.length) ||
        Date.parse(String(daily.time[daily.time.length - 1]) + 'T23:00:00Z') > times[times.length - 1]
    )
        return null;
    const rebasedDaily: Obj = {};
    for (const [key, values] of Object.entries(daily)) {
        if (!Array.isArray(values) || values.length !== daily.time.length) return null;
        rebasedDaily[key] = values.slice(dayIndex);
    }
    const current: Obj = { time: new Date(times[index]).toISOString(), interval: 3600 };
    const currentFields = [
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
    ];
    const currentUnits: Obj = { time: 'iso8601', interval: 'seconds' };
    for (const field of currentFields) {
        const values = hourly[field];
        current[field] = Array.isArray(values) ? values[index] : null;
        currentUnits[field] = payload.hourly_units[field] ?? 'undefined';
    }
    current.is_day = SunCalc.getPosition(new Date(now), lat, lon).altitude > 0 ? 1 : 0;
    currentUnits.is_day = '';
    const firstToday = times.indexOf(Math.floor(now / DAY) * DAY);
    if (firstToday < 0) return null;
    const rebasedHourly = Object.fromEntries(
        Object.entries(hourly).map(([key, values]) => [key, (values as unknown[]).slice(firstToday)]),
    );
    return { ...payload, current, current_units: currentUnits, hourly: rebasedHourly, daily: rebasedDaily };
}
