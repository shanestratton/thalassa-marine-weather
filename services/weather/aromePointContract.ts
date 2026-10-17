import {
    aromeDomain,
    AROME_HORIZON_HOURS,
    AROME_MAX_SOURCE_AGE_MS,
    AROME_STEP_DEGREES,
    type AromeModelId,
} from './aromeDomains.ts';

export const AROME_HOURLY_UNITS = {
    wind_speed_10m: 'kn',
    wind_direction_10m: '°',
    wind_gusts_10m: 'kn',
    pressure_msl: 'hPa',
    temperature_2m: '°C',
    relative_humidity_2m: '%',
    precipitation: 'mm',
} as const;
export type AromeVariable = keyof typeof AROME_HOURLY_UNITS;
export interface AromePointForecast {
    schema: 1;
    model: AromeModelId;
    provider: 'Météo-France';
    product: 'AROME-OM';
    licence: 'Etalab-2.0';
    runUtc: string;
    cohortSha256: string;
    maskSha256: string;
    seaCell: {
        longitude: number;
        latitude: number;
        i: number;
        j: number;
        landFraction: 0;
        method: 'nearest-original-sea-cell';
    };
    hourly_units: typeof AROME_HOURLY_UNITS;
    hourly: { time: number[] } & Record<AromeVariable, (number | null)[]>;
}

const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ranges: Record<AromeVariable, readonly [number, number]> = {
    wind_speed_10m: [0, 200],
    wind_direction_10m: [0, 360],
    wind_gusts_10m: [0, 250],
    pressure_msl: [800, 1100],
    temperature_2m: [-80, 65],
    relative_humidity_2m: [0, 100],
    precipitation: [0, 1000],
};

/** Fail closed. Never restamp the original model run, substitute a global
 * forecast, or mistake a syntactically successful land sample for sea data.
 */
export function parseAromePoint(
    value: unknown,
    model: string,
    point: { lat: number; lon: number },
    now = Date.now(),
): AromePointForecast | null {
    const domain = aromeDomain(model);
    if (!domain || !record(value) || !finite(now) || !finite(point.lat) || !finite(point.lon)) return null;
    const [south, north, west, east] = domain.region;
    if (point.lat < south || point.lat > north || point.lon < west || point.lon > east) return null;
    if (
        value.schema !== 1 ||
        value.model !== model ||
        value.provider !== 'Météo-France' ||
        value.product !== 'AROME-OM' ||
        value.licence !== 'Etalab-2.0' ||
        !hash(value.cohortSha256) ||
        !hash(value.maskSha256) ||
        typeof value.runUtc !== 'string' ||
        !/^\d{4}-\d\d-\d\dT(?:00|06|12|18):00:00Z$/.test(value.runUtc)
    )
        return null;
    const run = Date.parse(value.runUtc);
    if (!finite(run) || new Date(run).toISOString() !== value.runUtc.replace('Z', '.000Z')) return null;
    if (run > now || now - run > AROME_MAX_SOURCE_AGE_MS) return null;
    const cell = value.seaCell;
    if (
        !record(cell) ||
        !finite(cell.i) ||
        !finite(cell.j) ||
        !Number.isInteger(cell.i) ||
        !Number.isInteger(cell.j) ||
        cell.i < 0 ||
        cell.i >= domain.width ||
        cell.j < 0 ||
        cell.j >= domain.height ||
        !finite(cell.latitude) ||
        !finite(cell.longitude) ||
        Math.abs(cell.latitude - (south + cell.j * AROME_STEP_DEGREES)) > 1e-7 ||
        Math.abs(cell.longitude - (west + cell.i * AROME_STEP_DEGREES)) > 1e-7 ||
        cell.landFraction !== 0 ||
        cell.method !== 'nearest-original-sea-cell'
    )
        return null;
    // Three original grid intervals in each direction. We never walk to a
    // distant offshore cell to make an inland place appear supported.
    if (
        Math.abs(cell.latitude - point.lat) > 3 * AROME_STEP_DEGREES + 1e-7 ||
        Math.abs(cell.longitude - point.lon) > 3 * AROME_STEP_DEGREES + 1e-7
    )
        return null;
    const hourly = value.hourly;
    const units = value.hourly_units;
    if (!record(hourly) || !record(units) || !Array.isArray(hourly.time)) return null;
    if (hourly.time.length !== AROME_HORIZON_HOURS + 1) return null;
    if (hourly.time.some((time, index) => time !== run / 1000 + index * 3600)) return null;
    for (const variable of Object.keys(AROME_HOURLY_UNITS) as AromeVariable[]) {
        const values = hourly[variable];
        const [min, max] = ranges[variable];
        if (
            units[variable] !== AROME_HOURLY_UNITS[variable] ||
            !Array.isArray(values) ||
            values.length !== hourly.time.length ||
            values.some((sample) => sample !== null && (!finite(sample) || sample < min || sample > max))
        )
            return null;
    }
    // Missing individual samples remain null. An entire missing wind run is
    // not admitted as a qualified capability.
    if (!Array.isArray(hourly.wind_speed_10m) || !hourly.wind_speed_10m.some(finite)) return null;
    return value as unknown as AromePointForecast;
}
