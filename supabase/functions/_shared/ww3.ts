/**
 * Dependency-free validation and sampling helpers for the NOAA WW3 JSON cache.
 *
 * This module is shared by the route-weather Edge Function and the browser
 * visualisation client. It deliberately throws/rejects malformed model data:
 * weather routing must never turn an absent value into calm water.
 */

export const WW3_CACHE_BUCKET = 'ww3-cache';
export const WW3_METADATA_FILE = 'ww3_latest.json';
export const WW3_MAX_MODEL_AGE_MS = 18 * 60 * 60 * 1000;
export const WW3_MAX_TEMPORAL_GAP_HOURS = 6;

export interface WW3Metadata {
    schema_version?: number;
    model?: string;
    cycle: string;
    valid_from: string;
    valid_to: string;
    hours_available: number[];
    total_hours: number;
    bucket: string;
    file_pattern: string;
    updated_at?: string;
}

export interface WW3GridDescriptor {
    nlat: number;
    nlon: number;
    lat_min: number;
    lat_max: number;
    lon_min: number;
    lon_max: number;
    /**
     * Legacy shards used one signed field for both axes. In those shards its
     * sign describes latitude orientation; longitude is always west→east.
     */
    resolution_deg: number;
    lat_first?: number;
    lat_last?: number;
    lon_first?: number;
    lon_last?: number;
    lat_step?: number;
    lon_step?: number;
}

export interface WW3Shard {
    schema_version?: number;
    model?: string;
    cycle: string;
    forecast_hour: number;
    valid_time: string;
    missing_value?: number;
    grid: WW3GridDescriptor;
    data: {
        wave_ht_m?: Array<number | null>;
        peak_period_s?: Array<number | null>;
        wave_dir_deg?: Array<number | null>;
        wind_wave_ht_m?: Array<number | null>;
        swell_ht_m?: Array<number | null>;
    };
}

export interface WaveConditions {
    wave_ht_m: number;
    peak_period_s: number;
    wave_dir_deg?: number;
    wind_wave_ht_m?: number;
    swell_ht_m?: number;
}

export interface WW3Axis {
    first: number;
    step: number;
    count: number;
    min: number;
    max: number;
    cyclic: boolean;
}

export interface ValidatedWW3Shard extends WW3Shard {
    grid: WW3GridDescriptor;
    latAxis: WW3Axis;
    lonAxis: WW3Axis;
    missing_value?: number;
    data: {
        wave_ht_m: Array<number | null>;
        peak_period_s: Array<number | null>;
        wave_dir_deg?: Array<number | null>;
        wind_wave_ht_m?: Array<number | null>;
        swell_ht_m?: Array<number | null>;
    };
}

export interface WW3TemporalBracket {
    lowerHour: number;
    upperHour: number;
    fraction: number;
}

export class WW3ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WW3ValidationError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new WW3ValidationError(`${label} must be a finite number`);
    }
    return value;
}

function finiteInteger(value: unknown, label: string): number {
    const parsed = finiteNumber(value, label);
    if (!Number.isInteger(parsed)) {
        throw new WW3ValidationError(`${label} must be an integer`);
    }
    return parsed;
}

function parseIsoMs(value: unknown, label: string): number {
    if (typeof value !== 'string' || value.length > 64) {
        throw new WW3ValidationError(`${label} must be an ISO timestamp`);
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
        throw new WW3ValidationError(`${label} must be an ISO timestamp`);
    }
    return parsed;
}

export function cycleToEpochMs(cycle: string): number {
    if (!/^\d{10}$/.test(cycle)) {
        throw new WW3ValidationError('WW3 cycle must use YYYYMMDDHH');
    }
    const year = Number(cycle.slice(0, 4));
    const month = Number(cycle.slice(4, 6));
    const day = Number(cycle.slice(6, 8));
    const hour = Number(cycle.slice(8, 10));
    if (![0, 6, 12, 18].includes(hour)) {
        throw new WW3ValidationError('WW3 cycle hour must be 00, 06, 12, or 18 UTC');
    }
    const epoch = Date.UTC(year, month - 1, day, hour);
    const roundTrip = new Date(epoch);
    if (
        roundTrip.getUTCFullYear() !== year ||
        roundTrip.getUTCMonth() !== month - 1 ||
        roundTrip.getUTCDate() !== day ||
        roundTrip.getUTCHours() !== hour
    ) {
        throw new WW3ValidationError('WW3 cycle contains an invalid date');
    }
    return epoch;
}

export function validateWW3Metadata(value: unknown, nowMs: number = Date.now()): WW3Metadata {
    if (!isRecord(value)) {
        throw new WW3ValidationError('WW3 metadata must be an object');
    }

    const schemaVersion =
        value.schema_version === undefined ? undefined : finiteInteger(value.schema_version, 'WW3 schema_version');
    if (schemaVersion !== undefined && schemaVersion !== 2) {
        throw new WW3ValidationError('WW3 metadata uses an unsupported schema version');
    }
    const model = typeof value.model === 'string' ? value.model : undefined;
    if (model !== undefined && model !== 'NOAA_WW3') {
        throw new WW3ValidationError('WW3 metadata identifies an unexpected model');
    }
    if (schemaVersion === 2 && model !== 'NOAA_WW3') {
        throw new WW3ValidationError('WW3 schema v2 metadata must identify NOAA_WW3');
    }

    const cycle = typeof value.cycle === 'string' ? value.cycle : '';
    const cycleMs = cycleToEpochMs(cycle);
    const validFromMs = parseIsoMs(value.valid_from, 'WW3 valid_from');
    const validToMs = parseIsoMs(value.valid_to, 'WW3 valid_to');
    if (Math.abs(validFromMs - cycleMs) > 60_000) {
        throw new WW3ValidationError('WW3 valid_from does not match its model cycle');
    }
    if (cycleMs > nowMs + 60 * 60 * 1000 || nowMs - cycleMs > WW3_MAX_MODEL_AGE_MS) {
        throw new WW3ValidationError('WW3 model cycle is stale or from the future');
    }

    if (!Array.isArray(value.hours_available) || value.hours_available.length < 2) {
        throw new WW3ValidationError('WW3 metadata has insufficient forecast hours');
    }
    const hours = value.hours_available.map((hour, index) => finiteInteger(hour, `WW3 hours_available[${index}]`));
    if (hours.length > 121 || hours.some((hour) => hour < 0 || hour > 240)) {
        throw new WW3ValidationError('WW3 forecast-hour range is invalid');
    }
    for (let index = 1; index < hours.length; index++) {
        if (hours[index] <= hours[index - 1]) {
            throw new WW3ValidationError('WW3 forecast hours must be strictly increasing');
        }
        if (hours[index] - hours[index - 1] > WW3_MAX_TEMPORAL_GAP_HOURS) {
            throw new WW3ValidationError('WW3 forecast coverage contains an unsafe temporal gap');
        }
    }

    const totalHours = finiteInteger(value.total_hours, 'WW3 total_hours');
    if (totalHours !== hours.length) {
        throw new WW3ValidationError('WW3 total_hours does not match hours_available');
    }
    const expectedValidToMs = cycleMs + hours[hours.length - 1] * 60 * 60 * 1000;
    if (Math.abs(validToMs - expectedValidToMs) > 60_000) {
        throw new WW3ValidationError('WW3 valid_to does not match the advertised forecast');
    }

    const bucket = typeof value.bucket === 'string' ? value.bucket : '';
    if (bucket !== WW3_CACHE_BUCKET) {
        throw new WW3ValidationError('WW3 metadata references an unexpected storage bucket');
    }
    const expectedPattern = `ww3_${cycle}_f{HHH}.json`;
    const filePattern = typeof value.file_pattern === 'string' ? value.file_pattern : '';
    if (filePattern !== expectedPattern) {
        throw new WW3ValidationError('WW3 metadata contains an unexpected file pattern');
    }

    if (schemaVersion === 2 && value.updated_at === undefined) {
        throw new WW3ValidationError('WW3 schema v2 metadata is missing updated_at');
    }
    if (value.updated_at !== undefined) {
        const updatedAtMs = parseIsoMs(value.updated_at, 'WW3 updated_at');
        if (updatedAtMs > nowMs + 60 * 60 * 1000 || nowMs - updatedAtMs > WW3_MAX_MODEL_AGE_MS) {
            throw new WW3ValidationError('WW3 cache metadata is stale or from the future');
        }
    }

    return {
        schema_version: schemaVersion,
        model,
        cycle,
        valid_from: new Date(validFromMs).toISOString(),
        valid_to: new Date(validToMs).toISOString(),
        hours_available: hours,
        total_hours: totalHours,
        bucket,
        file_pattern: filePattern,
        updated_at:
            value.updated_at === undefined
                ? undefined
                : new Date(parseIsoMs(value.updated_at, 'WW3 updated_at')).toISOString(),
    };
}

function validateAxis(
    first: number,
    step: number,
    count: number,
    reportedMin: number,
    reportedMax: number,
    label: 'latitude' | 'longitude',
): WW3Axis {
    if (!Number.isFinite(first) || !Number.isFinite(step) || step === 0) {
        throw new WW3ValidationError(`WW3 ${label} axis is invalid`);
    }
    const last = first + step * (count - 1);
    const min = Math.min(first, last);
    const max = Math.max(first, last);
    const tolerance = Math.max(0.02, Math.abs(step) * 0.15);
    if (Math.abs(min - reportedMin) > tolerance || Math.abs(max - reportedMax) > tolerance) {
        throw new WW3ValidationError(`WW3 ${label} axis does not match its advertised bounds`);
    }
    if (label === 'latitude' && (min < -90.001 || max > 90.001)) {
        throw new WW3ValidationError('WW3 latitude axis exceeds the globe');
    }
    const coveredDegrees = Math.abs(step) * count;
    return {
        first,
        step,
        count,
        min,
        max,
        cyclic: label === 'longitude' && coveredDegrees >= 359 && coveredDegrees <= 361.5,
    };
}

function requireArray(
    value: unknown,
    expectedLength: number,
    label: string,
    required: boolean,
): Array<number | null> | undefined {
    if (value === undefined && !required) return undefined;
    if (!Array.isArray(value) || value.length !== expectedLength) {
        throw new WW3ValidationError(`${label} must contain exactly ${expectedLength} cells`);
    }
    return value as Array<number | null>;
}

export function validateWW3Shard(
    value: unknown,
    expectedCycle?: string,
    expectedForecastHour?: number,
): ValidatedWW3Shard {
    if (!isRecord(value) || !isRecord(value.grid) || !isRecord(value.data)) {
        throw new WW3ValidationError('WW3 shard must contain grid and data objects');
    }

    const schemaVersion =
        value.schema_version === undefined ? undefined : finiteInteger(value.schema_version, 'WW3 schema_version');
    if (schemaVersion !== undefined && schemaVersion !== 2) {
        throw new WW3ValidationError('WW3 shard uses an unsupported schema version');
    }
    const cycle = typeof value.cycle === 'string' ? value.cycle : '';
    const cycleMs = cycleToEpochMs(cycle);
    if (expectedCycle !== undefined && cycle !== expectedCycle) {
        throw new WW3ValidationError('WW3 shard cycle does not match metadata');
    }
    const forecastHour = finiteInteger(value.forecast_hour, 'WW3 forecast_hour');
    if (
        forecastHour < 0 ||
        forecastHour > 240 ||
        (expectedForecastHour !== undefined && forecastHour !== expectedForecastHour)
    ) {
        throw new WW3ValidationError('WW3 shard forecast hour is invalid');
    }
    const validTimeMs = parseIsoMs(value.valid_time, 'WW3 valid_time');
    if (Math.abs(validTimeMs - (cycleMs + forecastHour * 60 * 60 * 1000)) > 60_000) {
        throw new WW3ValidationError('WW3 shard valid_time does not match its forecast hour');
    }

    const grid = value.grid;
    const nlat = finiteInteger(grid.nlat, 'WW3 grid.nlat');
    const nlon = finiteInteger(grid.nlon, 'WW3 grid.nlon');
    if (nlat < 2 || nlat > 1000 || nlon < 2 || nlon > 2000 || nlat * nlon > 1_000_000) {
        throw new WW3ValidationError('WW3 grid dimensions are outside safe limits');
    }
    const latMin = finiteNumber(grid.lat_min, 'WW3 grid.lat_min');
    const latMax = finiteNumber(grid.lat_max, 'WW3 grid.lat_max');
    const lonMin = finiteNumber(grid.lon_min, 'WW3 grid.lon_min');
    const lonMax = finiteNumber(grid.lon_max, 'WW3 grid.lon_max');
    const resolution = finiteNumber(grid.resolution_deg, 'WW3 grid.resolution_deg');
    if (latMin >= latMax || lonMin >= lonMax || Math.abs(resolution) < 0.01 || Math.abs(resolution) > 10) {
        throw new WW3ValidationError('WW3 grid bounds or resolution are invalid');
    }

    const hasExplicitAxes =
        grid.lat_first !== undefined ||
        grid.lat_step !== undefined ||
        grid.lon_first !== undefined ||
        grid.lon_step !== undefined;
    if (
        hasExplicitAxes &&
        (grid.lat_first === undefined ||
            grid.lat_step === undefined ||
            grid.lon_first === undefined ||
            grid.lon_step === undefined)
    ) {
        throw new WW3ValidationError('WW3 shard has an incomplete explicit axis description');
    }

    // Legacy shards stored the signed latitude step as resolution_deg. Their
    // longitude rows were still always west→east, hence abs(resolution).
    const latFirst = hasExplicitAxes
        ? finiteNumber(grid.lat_first, 'WW3 grid.lat_first')
        : resolution < 0
          ? latMax
          : latMin;
    const latStep = hasExplicitAxes ? finiteNumber(grid.lat_step, 'WW3 grid.lat_step') : resolution;
    const lonFirst = hasExplicitAxes ? finiteNumber(grid.lon_first, 'WW3 grid.lon_first') : lonMin;
    const lonStep = hasExplicitAxes ? finiteNumber(grid.lon_step, 'WW3 grid.lon_step') : Math.abs(resolution);

    const latAxis = validateAxis(latFirst, latStep, nlat, latMin, latMax, 'latitude');
    const lonAxis = validateAxis(lonFirst, lonStep, nlon, lonMin, lonMax, 'longitude');
    if (
        hasExplicitAxes &&
        ((grid.lat_last !== undefined &&
            Math.abs(finiteNumber(grid.lat_last, 'WW3 grid.lat_last') - (latFirst + latStep * (nlat - 1))) >
                Math.max(0.02, Math.abs(latStep) * 0.15)) ||
            (grid.lon_last !== undefined &&
                Math.abs(finiteNumber(grid.lon_last, 'WW3 grid.lon_last') - (lonFirst + lonStep * (nlon - 1))) >
                    Math.max(0.02, Math.abs(lonStep) * 0.15)))
    ) {
        throw new WW3ValidationError('WW3 explicit axis endpoints are inconsistent');
    }
    if (value.model !== undefined && value.model !== 'NOAA_WW3') {
        throw new WW3ValidationError('WW3 shard identifies an unexpected model');
    }
    if (schemaVersion === 2 && (!hasExplicitAxes || value.model !== 'NOAA_WW3' || value.missing_value === undefined)) {
        throw new WW3ValidationError('WW3 schema v2 shard is missing required provenance or axis metadata');
    }
    const cellCount = nlat * nlon;
    const rawData = value.data;
    const waveHeight = requireArray(rawData.wave_ht_m, cellCount, 'WW3 wave_ht_m', true)!;
    const peakPeriod = requireArray(rawData.peak_period_s, cellCount, 'WW3 peak_period_s', true)!;
    const waveDirection = requireArray(rawData.wave_dir_deg, cellCount, 'WW3 wave_dir_deg', schemaVersion === 2);

    const missingValue =
        value.missing_value === undefined ? undefined : finiteNumber(value.missing_value, 'WW3 missing_value');

    return {
        schema_version: schemaVersion,
        model: typeof value.model === 'string' ? value.model : undefined,
        cycle,
        forecast_hour: forecastHour,
        valid_time: new Date(validTimeMs).toISOString(),
        missing_value: missingValue,
        grid: {
            nlat,
            nlon,
            lat_min: latMin,
            lat_max: latMax,
            lon_min: lonMin,
            lon_max: lonMax,
            resolution_deg: resolution,
            lat_first: latFirst,
            lat_last: latFirst + latStep * (nlat - 1),
            lon_first: lonFirst,
            lon_last: lonFirst + lonStep * (nlon - 1),
            lat_step: latStep,
            lon_step: lonStep,
        },
        latAxis,
        lonAxis,
        data: {
            wave_ht_m: waveHeight,
            peak_period_s: peakPeriod,
            wave_dir_deg: waveDirection,
            wind_wave_ht_m: requireArray(rawData.wind_wave_ht_m, cellCount, 'WW3 wind_wave_ht_m', false),
            swell_ht_m: requireArray(rawData.swell_ht_m, cellCount, 'WW3 swell_ht_m', false),
        },
    };
}

function axisPosition(
    axis: WW3Axis,
    coordinate: number,
    allowLongitudeWrap: boolean,
): { lower: number; upper: number; fraction: number } | null {
    if (!Number.isFinite(coordinate)) return null;
    let raw = (coordinate - axis.first) / axis.step;

    if (axis.cyclic) {
        raw = ((raw % axis.count) + axis.count) % axis.count;
        const lower = Math.floor(raw);
        return { lower, upper: (lower + 1) % axis.count, fraction: raw - lower };
    }

    const candidates = [raw];
    if (allowLongitudeWrap) {
        candidates.push((coordinate + 360 - axis.first) / axis.step, (coordinate - 360 - axis.first) / axis.step);
    }
    const bounded = candidates.find((candidate) => candidate >= -1e-6 && candidate <= axis.count - 1 + 1e-6);
    if (bounded === undefined) return null;
    const clamped = Math.max(0, Math.min(axis.count - 1, bounded));
    const lower = Math.floor(clamped);
    const upper = Math.min(axis.count - 1, lower + 1);
    return { lower, upper, fraction: upper === lower ? 0 : clamped - lower };
}

function validCellValue(
    values: Array<number | null> | undefined,
    index: number,
    missingValue: number | undefined,
    min: number,
    max: number,
    allowZero: boolean,
): number | null {
    if (!values) return null;
    const value = values[index];
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (missingValue !== undefined && value === missingValue) ||
        value < min ||
        value > max ||
        (!allowZero && value === 0)
    ) {
        return null;
    }
    return value;
}

function bilinearScalar(
    shard: ValidatedWW3Shard,
    values: Array<number | null> | undefined,
    latPos: { lower: number; upper: number; fraction: number },
    lonPos: { lower: number; upper: number; fraction: number },
    min: number,
    max: number,
    allowZero: boolean,
): number | null {
    const width = shard.grid.nlon;
    const indices = [
        latPos.lower * width + lonPos.lower,
        latPos.lower * width + lonPos.upper,
        latPos.upper * width + lonPos.lower,
        latPos.upper * width + lonPos.upper,
    ];
    const weights = [
        (1 - latPos.fraction) * (1 - lonPos.fraction),
        (1 - latPos.fraction) * lonPos.fraction,
        latPos.fraction * (1 - lonPos.fraction),
        latPos.fraction * lonPos.fraction,
    ];
    let result = 0;
    for (let index = 0; index < indices.length; index++) {
        if (weights[index] <= 1e-12) continue;
        const cell = validCellValue(values, indices[index], shard.missing_value, min, max, allowZero);
        if (cell === null) return null;
        result += cell * weights[index];
    }
    return result;
}

export function lerpDegrees(a: number, b: number, fraction: number): number {
    let delta = b - a;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return (a + delta * fraction + 360) % 360;
}

function bilinearDirection(
    shard: ValidatedWW3Shard,
    values: Array<number | null> | undefined,
    latPos: { lower: number; upper: number; fraction: number },
    lonPos: { lower: number; upper: number; fraction: number },
): number | null {
    if (!values) return null;
    const width = shard.grid.nlon;
    const indices = [
        latPos.lower * width + lonPos.lower,
        latPos.lower * width + lonPos.upper,
        latPos.upper * width + lonPos.lower,
        latPos.upper * width + lonPos.upper,
    ];
    const weights = [
        (1 - latPos.fraction) * (1 - lonPos.fraction),
        (1 - latPos.fraction) * lonPos.fraction,
        latPos.fraction * (1 - lonPos.fraction),
        latPos.fraction * lonPos.fraction,
    ];
    let x = 0;
    let y = 0;
    for (let index = 0; index < indices.length; index++) {
        if (weights[index] <= 1e-12) continue;
        const cell = validCellValue(values, indices[index], shard.missing_value, 0, 360, true);
        if (cell === null) return null;
        const radians = (cell * Math.PI) / 180;
        x += Math.cos(radians) * weights[index];
        y += Math.sin(radians) * weights[index];
    }
    if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return null;
    return (Math.atan2(y, x) * 180) / Math.PI + (Math.atan2(y, x) < 0 ? 360 : 0);
}

export function sampleWW3Shard(shard: ValidatedWW3Shard, lat: number, lon: number): WaveConditions | null {
    const latPos = axisPosition(shard.latAxis, lat, false);
    const lonPos = axisPosition(shard.lonAxis, lon, true);
    if (!latPos || !lonPos) return null;

    const waveHeight = bilinearScalar(shard, shard.data.wave_ht_m, latPos, lonPos, 0, 40, true);
    // A zero period is how legacy shards encoded GRIB missing values. Reject it
    // even when zero-height water would otherwise be physically possible.
    const peakPeriod = bilinearScalar(shard, shard.data.peak_period_s, latPos, lonPos, 0, 40, false);
    if (waveHeight === null || peakPeriod === null) return null;

    const windWaveHeight = bilinearScalar(shard, shard.data.wind_wave_ht_m, latPos, lonPos, 0, 40, true);
    const swellHeight = bilinearScalar(shard, shard.data.swell_ht_m, latPos, lonPos, 0, 40, true);
    const waveDirection = bilinearDirection(shard, shard.data.wave_dir_deg, latPos, lonPos);
    return {
        wave_ht_m: waveHeight,
        peak_period_s: peakPeriod,
        ...(waveDirection === null ? {} : { wave_dir_deg: waveDirection }),
        ...(windWaveHeight === null ? {} : { wind_wave_ht_m: windWaveHeight }),
        ...(swellHeight === null ? {} : { swell_ht_m: swellHeight }),
    };
}

export function findWW3TemporalBracket(metadata: WW3Metadata, timestampMs: number): WW3TemporalBracket | null {
    if (!Number.isFinite(timestampMs)) return null;
    const offsetHours = (timestampMs - cycleToEpochMs(metadata.cycle)) / (60 * 60 * 1000);
    const hours = metadata.hours_available;
    if (offsetHours < hours[0] || offsetHours > hours[hours.length - 1]) return null;

    for (let index = 0; index < hours.length; index++) {
        const hour = hours[index];
        if (Math.abs(offsetHours - hour) < 1e-9) {
            return { lowerHour: hour, upperHour: hour, fraction: 0 };
        }
        if (hour > offsetHours && index > 0) {
            const lower = hours[index - 1];
            return {
                lowerHour: lower,
                upperHour: hour,
                fraction: (offsetHours - lower) / (hour - lower),
            };
        }
    }
    return null;
}

export function requiredWW3ForecastHours(metadata: WW3Metadata, startTimeMs: number, horizonHours: number): number[] {
    if (!Number.isInteger(horizonHours) || horizonHours < 0 || horizonHours > 240) {
        throw new WW3ValidationError('Requested WW3 horizon is invalid');
    }
    const required = new Set<number>();
    for (let hour = 0; hour <= horizonHours; hour++) {
        const bracket = findWW3TemporalBracket(metadata, startTimeMs + hour * 60 * 60 * 1000);
        if (!bracket) {
            throw new WW3ValidationError('WW3 cache does not cover the requested departure and horizon');
        }
        required.add(bracket.lowerHour);
        required.add(bracket.upperHour);
    }
    return [...required].sort((a, b) => a - b);
}

export function interpolateWaveConditions(
    lower: WaveConditions,
    upper: WaveConditions,
    fraction: number,
): WaveConditions {
    const t = Math.max(0, Math.min(1, fraction));
    const lerpOptional = (a: number | undefined, b: number | undefined): number | undefined =>
        a === undefined || b === undefined ? undefined : a + (b - a) * t;
    const windWave = lerpOptional(lower.wind_wave_ht_m, upper.wind_wave_ht_m);
    const swell = lerpOptional(lower.swell_ht_m, upper.swell_ht_m);
    return {
        wave_ht_m: lower.wave_ht_m + (upper.wave_ht_m - lower.wave_ht_m) * t,
        peak_period_s: lower.peak_period_s + (upper.peak_period_s - lower.peak_period_s) * t,
        ...(lower.wave_dir_deg === undefined || upper.wave_dir_deg === undefined
            ? {}
            : { wave_dir_deg: lerpDegrees(lower.wave_dir_deg, upper.wave_dir_deg, t) }),
        ...(windWave === undefined ? {} : { wind_wave_ht_m: windWave }),
        ...(swell === undefined ? {} : { swell_ht_m: swell }),
    };
}
