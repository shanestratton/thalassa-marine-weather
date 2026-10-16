/** Explicit sensor clocks and units for derived instruments; legacy gauge receipts do not qualify. */
export type InstrumentUnit = 'knots' | 'degrees' | 'rpm';
export type InstrumentReference = 'true' | 'magnetic' | 'relative' | 'water' | 'ground';
export interface InstrumentReading {
    value: number | null;
    at: number;
    unit: InstrumentUnit;
    reference?: InstrumentReference;
    source: string;
    /** Reported physical engine record; missing/multiple never implies a single-engine hourmeter. */
    engineId?: string;
    engineCount?: number;
}
export const INSTRUMENT_MEASUREMENT_KEYS = [
    'sog',
    'cogTrue',
    'stw',
    'headingTrue',
    'tws',
    'twaSigned',
    'twdTrue',
    'rpm',
    'heel',
    'leeway',
    'position',
] as const;
export type InstrumentMeasurementKey = (typeof INSTRUMENT_MEASUREMENT_KEYS)[number];
export type InstrumentMeasurementTimes = Partial<Record<InstrumentMeasurementKey, number>>;
export interface InstrumentEvidence {
    engine?: import('./engineTelemetry').EngineTelemetry;
    /** One boat/feed generation; never combine values from another boat or account. */
    identity: string;
    /** Stable configured vessel identity for the voyage meter; session identity still fences live samples. */
    meterIdentity?: string;
    via: 'gateway' | 'lan' | 'cloud' | 'signalk';
    readings: Partial<Record<Exclude<InstrumentMeasurementKey, 'position'>, InstrumentReading>>;
    position?: { lat: number; lon: number; at: number };
}

export const INSTRUMENT_MAX_AGE_MS = 13_000;
export const INSTRUMENT_LIVE_AGE_MS = 6_500;
export const INSTRUMENT_MAX_SKEW_MS = 6_000;
export const TRUE = Math.PI / 180;
export const wrapDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360;

export function usableReading(
    reading: InstrumentReading | undefined,
    unit: InstrumentUnit,
    now: number,
    low: number,
    high: number,
    reference?: InstrumentReference,
): reading is InstrumentReading & { value: number } {
    return (
        !!reading &&
        reading.unit === unit &&
        (!reference || reading.reference === reference) &&
        typeof reading.value === 'number' &&
        Number.isFinite(reading.value) &&
        reading.value >= low &&
        reading.value <= high &&
        Number.isFinite(reading.at) &&
        reading.at > 0 &&
        reading.at <= now + 1_000 &&
        now - reading.at <= INSTRUMENT_MAX_AGE_MS &&
        typeof reading.source === 'string' &&
        !!reading.source.trim() &&
        reading.source.length <= 120
    );
}
export function simultaneous(readings: readonly InstrumentReading[]): boolean {
    const clocks = readings.map((value) => value.at);
    return clocks.length > 0 && Math.max(...clocks) - Math.min(...clocks) <= INSTRUMENT_MAX_SKEW_MS;
}
export function measurementTimes(value: unknown): InstrumentMeasurementTimes | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result: InstrumentMeasurementTimes = {};
    for (const key of INSTRUMENT_MEASUREMENT_KEYS) {
        const at = (value as Record<string, unknown>)[key];
        if (typeof at === 'number' && Number.isFinite(at) && at > 0) result[key] = at;
    }
    return Object.keys(result).length ? result : undefined;
}
export const speedVector = (knots: number, towardTrue: number) => ({
    east: knots * Math.sin(towardTrue * TRUE),
    north: knots * Math.cos(towardTrue * TRUE),
});

/** Fixed Signal K contract, carried as one scalar through the unchanged bounded telemetry relay. */
export function unpackInstrumentTimes(
    value: unknown,
): { times: InstrumentMeasurementTimes; leewayDeg: number | null; leewaySource?: string } | null {
    if (typeof value !== 'string' || value.length > 120) return null;
    try {
        const row: unknown = JSON.parse(value);
        if (!Array.isArray(row) || row.length !== 8) return null;
        for (const index of [0, 1, 2, 3, 4, 5, 7])
            if (
                row[index] !== null &&
                !(
                    typeof row[index] === 'number' &&
                    Number.isSafeInteger(row[index]) &&
                    row[index] > 0 &&
                    row[index] < 1e14
                )
            )
                return null;
        if (row[6] !== null && !(typeof row[6] === 'number' && Number.isFinite(row[6]) && Math.abs(row[6]) <= 20))
            return null;
        if ((row[6] === null) !== (row[7] === null)) return null;
        const times: InstrumentMeasurementTimes = {};
        for (const [index, key] of (['sog', 'cogTrue', 'stw', 'tws', 'twaSigned', 'rpm'] as const).entries())
            if (row[index] !== null) times[key] = row[index];
        if (row[7] !== null) times.leeway = row[7];
        return {
            times,
            leewayDeg: row[6],
            ...(row[6] !== null ? { leewaySource: 'Signal K navigation.leewayAngle' } : {}),
        };
    } catch {
        return null;
    }
}

export function unpackRpmSource(value: unknown): { rpmEngineCount: number; rpmEngineId?: string } | null {
    if (typeof value !== 'string' || value.length > 120) return null;
    try {
        const row: unknown = JSON.parse(value);
        if (
            !Array.isArray(row) ||
            row.length !== 2 ||
            !Number.isInteger(row[0]) ||
            row[0] < 1 ||
            row[0] > 32 ||
            !(row[1] === null || (typeof row[1] === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(row[1])))
        )
            return null;
        return { rpmEngineCount: row[0], ...(row[1] !== null ? { rpmEngineId: row[1] } : {}) };
    } catch {
        return null;
    }
}
