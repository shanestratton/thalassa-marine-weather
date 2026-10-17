/** Pure schema-2 marine boundary. No keys, platform state, fallback numbers or clock restamping. */
export const MARINE_SCHEMA = 2;
export const MARINE_HOURS = 240;
export const MARINE_WAVE_MODEL = 'meteofrance_wave';
export const MARINE_MOTION_MODEL = 'best_match';
export const MARINE_WAVE_FIELDS = [
    'wave_height',
    'wave_direction',
    'wave_period',
    'wind_wave_height',
    'wind_wave_direction',
    'wind_wave_period',
    'swell_wave_height',
    'swell_wave_direction',
    'swell_wave_period',
    'secondary_swell_wave_height',
    'secondary_swell_wave_direction',
    'secondary_swell_wave_period',
] as const;
export const MARINE_MOTION_FIELDS = [
    'sea_surface_temperature',
    'ocean_current_velocity',
    'ocean_current_direction',
] as const;
export type MarineFieldV2 = (typeof MARINE_WAVE_FIELDS)[number] | (typeof MARINE_MOTION_FIELDS)[number];
export type MarineKindV2 = 'waves' | 'motion';
export type MarinePointV2 = { latitude: number; longitude: number };
export interface MarineSourceV2 extends MarinePointV2 {
    utc_offset_seconds: 0;
    current: { time: number; interval: number } & Partial<Record<MarineFieldV2, number | null>>;
    hourly: { time: number[] } & Partial<Record<MarineFieldV2, (number | null)[]>>;
    current_units: Record<string, string>;
    hourly_units: Record<string, string>;
}
export interface MarineEnvelopeV2 {
    marine_schema: 2;
    requested: MarinePointV2;
    /** Server fetch receipt, retained on every cache read. It is not a model issue clock. */
    fetched_at_ms: number;
    wave_model: 'meteofrance_wave';
    motion_model: 'best_match';
    waves: MarineSourceV2 | null;
    motion: MarineSourceV2 | null;
}
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const second = (v: unknown): v is number =>
    Number.isSafeInteger(v) && (v as number) >= 946684800 && (v as number) <= 4102444800;
export function marinePointV2(v: unknown): v is MarinePointV2 {
    return (
        object(v) &&
        number(v.latitude) &&
        Math.abs(v.latitude) <= 90 &&
        number(v.longitude) &&
        Math.abs(v.longitude) <= 180
    );
}
const fieldsFor = (kind: MarineKindV2): readonly MarineFieldV2[] =>
    kind === 'waves' ? MARINE_WAVE_FIELDS : MARINE_MOTION_FIELDS;
export function marineFieldUnitV2(field: MarineFieldV2): string {
    return field === 'sea_surface_temperature'
        ? '°C'
        : field === 'ocean_current_velocity'
          ? 'km/h'
          : field.endsWith('_direction')
            ? '°'
            : field.endsWith('_period')
              ? 's'
              : 'm';
}
function admittedValue(field: MarineFieldV2, v: unknown): number | null {
    if (!number(v)) return null;
    if (field === 'sea_surface_temperature') return v >= -3 && v <= 45 ? v : null;
    if (field.endsWith('_direction')) return v >= 0 && v <= 360 ? v : null;
    if (field.endsWith('_period')) return v > 0 && v <= 60 ? v : null;
    return v >= 0 && v <= 50 ? v : null;
}
/** Admit only the requested vocabulary and original UTC clocks. Unknown stays null. */
export function marineSourceV2(raw: unknown, kind: MarineKindV2): MarineSourceV2 | null {
    if (!object(raw)) return null;
    // Keep the provider record distinct from its validated coordinate DTO.
    const point = { latitude: raw.latitude, longitude: raw.longitude };
    if (
        !marinePointV2(point) ||
        raw.utc_offset_seconds !== 0 ||
        !object(raw.current) ||
        !object(raw.hourly) ||
        !object(raw.current_units) ||
        !object(raw.hourly_units)
    )
        return null;
    const times = raw.hourly.time;
    if (
        !second(raw.current.time) ||
        raw.current_units.time !== 'unixtime' ||
        raw.hourly_units.time !== 'unixtime' ||
        !Array.isArray(times) ||
        !times.length ||
        times.length > MARINE_HOURS ||
        !times.every((v, i) => second(v) && v % 3600 === 0 && (!i || v - times[i - 1] === 3600))
    )
        return null;
    const interval = raw.current.interval;
    if (
        !number(interval) ||
        !Number.isSafeInteger(interval) ||
        interval < 300 ||
        interval > 10800 ||
        raw.current_units.interval !== 'seconds'
    )
        return null;
    const current: MarineSourceV2['current'] = { time: raw.current.time, interval };
    const hourly: MarineSourceV2['hourly'] = { time: [...times] };
    const currentUnits: Record<string, string> = { time: 'unixtime', interval: 'seconds' },
        hourlyUnits: Record<string, string> = { time: 'unixtime' };
    for (const field of fieldsFor(kind)) {
        const expected = marineFieldUnitV2(field),
            series = raw.hourly[field];
        const currentOk = raw.current_units[field] === expected,
            hourlyOk = raw.hourly_units[field] === expected;
        const currentMask =
            kind === 'waves' &&
            raw.current.wave_height === 0 &&
            raw.current.wave_period === 0 &&
            raw.current.wave_direction === 0;
        current[field] = currentOk && !currentMask ? admittedValue(field, raw.current[field]) : null;
        hourly[field] = Array.from({ length: times.length }, (_, i) => {
            const h = raw.hourly as Obj;
            const mask =
                kind === 'waves' &&
                Array.isArray(h.wave_height) &&
                h.wave_height[i] === 0 &&
                Array.isArray(h.wave_period) &&
                h.wave_period[i] === 0 &&
                Array.isArray(h.wave_direction) &&
                h.wave_direction[i] === 0;
            return hourlyOk && !mask && Array.isArray(series) && series.length === times.length
                ? admittedValue(field, series[i])
                : null;
        });
        if (currentOk) currentUnits[field] = expected;
        if (hourlyOk) hourlyUnits[field] = expected;
    }
    return {
        latitude: point.latitude,
        longitude: point.longitude,
        utc_offset_seconds: 0,
        current,
        hourly,
        current_units: currentUnits,
        hourly_units: hourlyUnits,
    };
}
export function marineQueryV2(kind: MarineKindV2, point: MarinePointV2): URLSearchParams {
    if (!marinePointV2(point) || !['waves', 'motion'].includes(kind)) throw Error('Invalid marine query context');
    const fields = fieldsFor(kind).join(',');
    return new URLSearchParams({
        latitude: point.latitude.toFixed(4),
        longitude: point.longitude.toFixed(4),
        models: kind === 'waves' ? MARINE_WAVE_MODEL : MARINE_MOTION_MODEL,
        hourly: fields,
        current: fields,
        forecast_days: '10',
        timezone: 'UTC',
        timeformat: 'unixtime',
        cell_selection: 'sea',
    });
}
export function marineEnvelopeV2(
    point: MarinePointV2,
    fetchedAt: number,
    waves: unknown,
    motion: unknown,
): MarineEnvelopeV2 {
    if (
        !marinePointV2(point) ||
        !Number.isSafeInteger(fetchedAt) ||
        fetchedAt < 946684800000 ||
        fetchedAt > 4102444800000
    )
        throw Error('Invalid marine envelope context');
    return {
        marine_schema: MARINE_SCHEMA,
        requested: { latitude: point.latitude, longitude: point.longitude },
        fetched_at_ms: fetchedAt,
        wave_model: MARINE_WAVE_MODEL,
        motion_model: MARINE_MOTION_MODEL,
        waves: marineSourceV2(waves, 'waves'),
        motion: marineSourceV2(motion, 'motion'),
    };
}
/** Legacy/cache mixing and model switches cannot silently enter the new chain. */
export function readMarineEnvelopeV2(raw: unknown, point: MarinePointV2, now: number): MarineEnvelopeV2 | null {
    if (
        !marinePointV2(point) ||
        !number(now) ||
        !object(raw) ||
        raw.marine_schema !== MARINE_SCHEMA ||
        raw.wave_model !== MARINE_WAVE_MODEL ||
        raw.motion_model !== MARINE_MOTION_MODEL ||
        !marinePointV2(raw.requested) ||
        raw.requested.latitude.toFixed(4) !== point.latitude.toFixed(4) ||
        raw.requested.longitude.toFixed(4) !== point.longitude.toFixed(4) ||
        !number(raw.fetched_at_ms) ||
        raw.fetched_at_ms > now + 5000 ||
        now - raw.fetched_at_ms > 3600000
    )
        return null;
    try {
        return marineEnvelopeV2(point, raw.fetched_at_ms, raw.waves, raw.motion);
    } catch {
        return null;
    }
}
