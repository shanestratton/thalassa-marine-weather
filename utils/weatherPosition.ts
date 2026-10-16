/** Portable, fixed weather-position wire. No credentials, URLs or receipt-time substitution. */
export const WEATHER_POSITION_VERSION = 1;
export const WEATHER_POSITION_FRESH_MS = 13_000;
export const WEATHER_POSITION_HOLD_MS = 15 * 60_000;
export const WEATHER_POSITION_REQUEST_MS = 10 * 60_000;
export const WEATHER_TELEMETRY_BYTES = 16_384;
export interface WeatherPositionFix {
    lat: number;
    lon: number;
    at: number;
}
export interface WeatherPositionIdentity {
    ownerId: string;
    piDeviceId: string;
    relayId: string;
}
export interface WeatherPositionSource extends WeatherPositionIdentity {
    schema: 1;
    selfKey: string;
    sourceKey: string;
    position: WeatherPositionFix;
    servedAt: number;
}
export interface WeatherPositionRequest {
    schema: 1;
    revision: string;
    selfKey: string;
    sourceKey: string;
    expiresAt: number;
}
export interface WeatherPositionProof extends WeatherPositionFix {
    schema: 1;
    revision: string;
    selfKey: string;
    sourceKey: string;
}
export interface WeatherPositionRegistration {
    revision: string;
    relayId: string;
    selfKey: string;
    sourceKey: string;
    enabled: boolean;
}
export interface WeatherPositionStatus {
    registration: WeatherPositionRegistration | null;
    position: (WeatherPositionFix & { revision: string; zone: string }) | null;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length && Object.keys(v).every((k) => keys.includes(k));
export const weatherPositionUuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
export const weatherPositionHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{64}$/.test(v);
export const weatherPositionRelay = (v: unknown): v is string =>
    typeof v === 'string' && /^[A-Za-z\d_-]{16,128}$/.test(v);
const stamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function weatherPositionFix(
    value: unknown,
    now: number,
    age = WEATHER_POSITION_FRESH_MS,
): WeatherPositionFix | null {
    if (
        !stamp(now) ||
        !Number.isFinite(age) ||
        age <= 0 ||
        !object(value) ||
        typeof value.lat !== 'number' ||
        !Number.isFinite(value.lat) ||
        Math.abs(value.lat) > 90 ||
        typeof value.lon !== 'number' ||
        !Number.isFinite(value.lon) ||
        Math.abs(value.lon) > 180 ||
        !stamp(value.at) ||
        value.at > now ||
        now - value.at > age
    )
        return null;
    return { lat: value.lat, lon: value.lon, at: value.at };
}
export function parseWeatherPositionSource(value: unknown, now: number): WeatherPositionSource | null {
    if (
        !object(value) ||
        !exact(value, ['schema', 'ownerId', 'piDeviceId', 'relayId', 'selfKey', 'sourceKey', 'position', 'servedAt']) ||
        value.schema !== 1 ||
        !weatherPositionUuid(value.ownerId) ||
        !weatherPositionUuid(value.piDeviceId) ||
        !weatherPositionRelay(value.relayId) ||
        !weatherPositionHash(value.selfKey) ||
        !weatherPositionHash(value.sourceKey) ||
        !stamp(value.servedAt) ||
        value.servedAt > now + 1000 ||
        now - value.servedAt > WEATHER_POSITION_FRESH_MS ||
        !object(value.position) ||
        !exact(value.position, ['lat', 'lon', 'at'])
    )
        return null;
    const position = weatherPositionFix(value.position, now);
    return position
        ? {
              schema: 1,
              ownerId: value.ownerId,
              piDeviceId: value.piDeviceId,
              relayId: value.relayId,
              selfKey: value.selfKey,
              sourceKey: value.sourceKey,
              position,
              servedAt: value.servedAt,
          }
        : null;
}
export function parseWeatherPositionRequest(value: unknown, now: number): WeatherPositionRequest | null {
    if (
        !stamp(now) ||
        !object(value) ||
        !exact(value, ['schema', 'revision', 'selfKey', 'sourceKey', 'expiresAt']) ||
        value.schema !== 1 ||
        !weatherPositionUuid(value.revision) ||
        !weatherPositionHash(value.selfKey) ||
        !weatherPositionHash(value.sourceKey) ||
        !stamp(value.expiresAt) ||
        value.expiresAt <= now ||
        value.expiresAt > now + WEATHER_POSITION_REQUEST_MS + 1000
    )
        return null;
    return value as unknown as WeatherPositionRequest;
}
export function parseWeatherPositionProof(value: unknown, now: number): WeatherPositionProof | null {
    if (
        !object(value) ||
        !exact(value, ['schema', 'revision', 'selfKey', 'sourceKey', 'lat', 'lon', 'at']) ||
        value.schema !== 1 ||
        !weatherPositionUuid(value.revision) ||
        !weatherPositionHash(value.selfKey) ||
        !weatherPositionHash(value.sourceKey)
    )
        return null;
    const fix = weatherPositionFix(value, now);
    return fix
        ? { schema: 1, revision: value.revision, selfKey: value.selfKey, sourceKey: value.sourceKey, ...fix }
        : null;
}
export function parseWeatherPositionStatus(value: unknown, now: number): WeatherPositionStatus | null {
    if (!object(value) || !exact(value, ['registration', 'position'])) return null;
    let registration: WeatherPositionRegistration | null = null;
    if (value.registration !== null) {
        const r = value.registration;
        if (
            !object(r) ||
            !exact(r, ['revision', 'relayId', 'selfKey', 'sourceKey', 'enabled']) ||
            !weatherPositionUuid(r.revision) ||
            !weatherPositionRelay(r.relayId) ||
            !weatherPositionHash(r.selfKey) ||
            !weatherPositionHash(r.sourceKey) ||
            typeof r.enabled !== 'boolean'
        )
            return null;
        registration = r as unknown as WeatherPositionRegistration;
    }
    let position: WeatherPositionStatus['position'] = null;
    if (value.position !== null) {
        const p = value.position;
        if (
            !object(p) ||
            !exact(p, ['revision', 'lat', 'lon', 'at', 'zone']) ||
            !registration?.enabled ||
            p.revision !== registration.revision ||
            typeof p.zone !== 'string' ||
            p.zone.length > 80
        )
            return null;
        try {
            new Intl.DateTimeFormat('en', { timeZone: p.zone });
        } catch {
            return null;
        }
        const fix = weatherPositionFix(p, now, WEATHER_POSITION_HOLD_MS);
        if (fix) position = { ...fix, revision: registration.revision, zone: p.zone };
    }
    return { registration, position };
}
