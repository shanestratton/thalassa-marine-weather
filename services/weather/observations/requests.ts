import { NDBC_LATEST_URL, MAX_FEED_BYTES } from './model.js';
export interface ObservationRequest {
    url: string;
    nativeOnly: true;
    timeoutMs: number;
    maxBytes: number;
    redirect: 'error';
    credentials: 'omit';
    ttlMs: number;
}
const request = (url: string): ObservationRequest => ({
    url,
    nativeOnly: true,
    timeoutMs: 15000,
    maxBytes: MAX_FEED_BYTES,
    redirect: 'error',
    credentials: 'omit',
    ttlMs: 10 * 60000,
});
export const ndbcLatestRequest = (): ObservationRequest => request(NDBC_LATEST_URL);
export function ndbcHistoryRequest(id: string): ObservationRequest {
    if (!/^[A-Za-z0-9]{3,8}$/.test(id)) throw new Error('Invalid public NDBC station ID.');
    return request(`https://www.ndbc.noaa.gov/data/realtime2/${id.toUpperCase()}.txt`);
}
/** Public station IDs only. History is one selected station, bounded to 12–72 h. */
export function metarRequest(ids: readonly string[], hours?: number): ObservationRequest {
    if (!ids.length || ids.length > (hours === undefined ? 20 : 1) || ids.some((id) => !/^[A-Z0-9]{4}$/.test(id)))
        throw new Error('Invalid public ICAO station selection.');
    if (hours !== undefined && (!Number.isInteger(hours) || hours < 12 || hours > 72))
        throw new Error('History must cover 12–72 hours.');
    const q = new URLSearchParams({
        ids: [...new Set(ids)].join(','),
        format: 'json',
        hours: String(hours ?? 3),
    });
    return request(`https://aviationweather.gov/api/data/metar?${q}`);
}
