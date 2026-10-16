/** Staged 135-03. Public observations remain separate from forecasts and alarms. */
export type ObservationProvider = 'ndbc' | 'awc-metar';
export type Exposure = 'unknown' | 'buoy' | 'platform' | 'coastal-land' | 'airport-land' | 'metar-station';
export interface Station {
    id: string;
    name: string;
    lat: number;
    lon: number;
    /** Only explicit station metadata may describe a marine station's exposure. */
    exposure: Exposure;
    owner: string | null;
}
export interface Observation extends Station {
    provider: ObservationProvider;
    observedAtMs: number;
    retrievedAtMs: number;
    /** A publisher receipt time is distinct from both observation and local retrieval. */
    receivedAtMs: number | null;
    windSpeedKts: number | null;
    gustKts: number | null;
    fromDeg: number | null;
    variableWind: boolean;
    seaLevelPressureHpa: number | null;
    altimeterHpa: number | null;
    airTempC: number | null;
    sourceUrl: string;
    attribution: string;
}
export interface ParsedObservations {
    rows: Observation[];
    partial: boolean;
    error: string | null;
}
export const HOUR_MS = 3_600_000;
export const MAX_HISTORY_HOURS = 72;
export const MAX_CURRENT_AGE_MS = 3 * HOUR_MS;
export const FUTURE_SLACK_MS = 5 * 60_000;
export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export const NDBC_LATEST_URL = 'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
export const NDBC_MEASUREMENTS_URL = 'https://www.ndbc.noaa.gov/faq/measdes.shtml';
export const AWC_API_URL = 'https://aviationweather.gov/data/api/';
export const NWS_USE_URL = 'https://www.weather.gov/disclaimer';
export const validPosition = (lat: number, lon: number): boolean =>
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0);
export function numberIn(raw: unknown, min: number, max: number): number | null {
    if (typeof raw !== 'number' && typeof raw !== 'string') return null;
    if (typeof raw === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
export function withinHistory(time: number, now: number): boolean {
    return (
        Number.isFinite(time) &&
        Number.isFinite(now) &&
        time <= now + FUTURE_SLACK_MS &&
        time >= now - MAX_HISTORY_HOURS * HOUR_MS
    );
}
export function currentObservation(row: Observation, now: number): boolean {
    return withinHistory(row.observedAtMs, now) && now - row.observedAtMs <= MAX_CURRENT_AGE_MS;
}
export function hasMeasurement(row: Observation): boolean {
    return [row.windSpeedKts, row.gustKts, row.seaLevelPressureHpa, row.altimeterHpa, row.airTempC].some(
        (n) => n !== null,
    );
}
export function safeText(value: unknown, max = 120): string | null {
    return typeof value === 'string' && value.trim()
        ? value
              .replace(/\p{Cc}/gu, '')
              .trim()
              .slice(0, max)
        : null;
}
