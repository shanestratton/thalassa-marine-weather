import { Capacitor } from '@capacitor/core';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, subscribeAuthIdentityScope } from '../../authIdentityScope';
import { satelliteModeActive } from '../../networkPolicy';
import { type Observation, type ObservationProvider } from './model';
import { distanceNm, ObservationHistory, type ProviderAvailability } from './nearby';
import { parseAwcMetars, parseNdbcHistory, parseNdbcLatest } from './parsers';
import { metarRequest, ndbcHistoryRequest, ndbcLatestRequest, type ObservationRequest } from './requests';
import { airportCatalogueRequest, nearbyAirportIds, parseAirportCatalogue } from './catalogue';
import { readObservation } from './transport';
import { ndbcOwner } from '../buoys/providers/ndbc';

export interface ObservationFeedResult {
    point: { lat: number; lon: number };
    radiusNm: number;
    rows: Observation[];
    availability: Record<ObservationProvider, ProviderAvailability>;
    partial: boolean;
    cachedOnly: boolean;
}
let history = new ObservationHistory();
interface ResponseBody {
    text: string;
    retrievedAt: number;
}
interface CachedRequest {
    at: number;
    promise: Promise<ResponseBody>;
    controller: AbortController;
    consumers: number;
    complete: boolean;
}
let cache = new Map<string, CachedRequest>();
let failureUntil = new Map<string, number>();
let active = 0;
const waiting: (() => void)[] = [];
let controllers = new Set<AbortController>();
let requestStarts: number[] = [];
subscribeAuthIdentityScope(() => {
    for (const c of controllers) c.abort();
    controllers = new Set();
    cache = new Map();
    failureUntil = new Map();
    history = new ObservationHistory();
});
async function acquire(): Promise<() => void> {
    if (active < 2) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    return () => {
        const next = waiting.shift();
        if (next) next();
        else active--;
    };
}
function consume(entry: CachedRequest, signal?: AbortSignal): Promise<ResponseBody> {
    if (signal?.aborted) return Promise.reject(new Error('Observation request cancelled'));
    entry.consumers++;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown, value?: ResponseBody) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', cancel);
            entry.consumers--;
            if (!entry.complete && entry.consumers === 0) entry.controller.abort();
            if (error) reject(error);
            else resolve(value!);
        };
        const cancel = () => finish(new Error('Observation request cancelled'));
        signal?.addEventListener('abort', cancel, { once: true });
        entry.promise.then(
            (value) => finish(undefined, value),
            (error) => finish(error),
        );
    });
}
async function cached(request: ObservationRequest, signal?: AbortSignal): Promise<ResponseBody> {
    if (signal?.aborted) throw new Error('Observation request cancelled');
    const now = Date.now(),
        hit = cache.get(request.url);
    if (hit && now - hit.at < request.ttlMs && !hit.controller.signal.aborted) return consume(hit, signal);
    if (satelliteModeActive() || (typeof navigator !== 'undefined' && navigator.onLine === false))
        throw new Error('Observations cache only');
    if ((failureUntil.get(request.url) ?? 0) > now) throw new Error('Observation source cooling down');
    for (const [key, value] of cache) if (value.complete && cache.size >= 16) cache.delete(key);
    if (cache.size >= 16) throw new Error('Observation request capacity reached');
    requestStarts = requestStarts.filter((time) => now - time < 60000);
    if (requestStarts.length >= 20) throw new Error('Observation request rate reached');
    requestStarts.push(now);
    const scope = getAuthIdentityScope();
    const controller = new AbortController();
    controllers.add(controller);
    const entry: CachedRequest = {
        at: now,
        promise: null as unknown as Promise<ResponseBody>,
        controller,
        consumers: 0,
        complete: false,
    };
    const promise = (async () => {
        const release = await acquire();
        try {
            if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Observation account changed');
            const value = await readObservation(request, controller.signal);
            if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Observation account changed');
            entry.at = Date.now();
            return { text: value, retrievedAt: entry.at };
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope) && cache.get(request.url) === entry) {
                cache.delete(request.url);
                if (!controller.signal.aborted) {
                    failureUntil.set(request.url, Date.now() + 10 * 60000);
                    while (failureUntil.size > 32) failureUntil.delete(failureUntil.keys().next().value!);
                }
            }
            throw error;
        } finally {
            entry.complete = true;
            controllers.delete(controller);
            release();
        }
    })();
    entry.promise = promise;
    cache.set(request.url, entry);
    while (cache.size > 16) {
        const key = [...cache].find(([, value]) => value.complete)?.[0];
        if (!key) break;
        cache.delete(key);
    }
    return consume(entry, signal);
}
const nativeAvailable = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
/** Global catalogues are downloaded without a location; public station IDs alone enter METAR requests. */
export async function loadNearbyObservations(
    point: { lat: number; lon: number },
    signal?: AbortSignal,
): Promise<ObservationFeedResult> {
    const scope = getAuthIdentityScope(),
        now = Date.now();
    if (
        !Number.isFinite(point.lat) ||
        !Number.isFinite(point.lon) ||
        Math.abs(point.lat) > 90 ||
        Math.abs(point.lon) > 180
    )
        throw new Error('Invalid observation point');
    const result: ObservationFeedResult = {
        point: { ...point },
        radiusNm: 50,
        rows: [],
        availability: { ndbc: 'not-loaded', 'awc-metar': 'not-loaded' },
        partial: false,
        cachedOnly: satelliteModeActive() || (typeof navigator !== 'undefined' && navigator.onLine === false),
    };
    if (!nativeAvailable()) {
        result.availability = { ndbc: 'native-required', 'awc-metar': 'native-required' };
        return result;
    }
    const answers = await Promise.allSettled([
        cached(ndbcLatestRequest(), signal).then(({ text, retrievedAt }) => {
            const parsed = parseNdbcLatest(text, Date.now());
            if (parsed.error) throw new Error(parsed.error);
            for (const row of parsed.rows) {
                row.retrievedAtMs = retrievedAt;
                const owner = ndbcOwner(row.id);
                if (owner) {
                    row.owner = owner;
                    row.attribution = `NOAA NDBC / ${owner}`;
                }
            }
            return parsed;
        }),
        cached(airportCatalogueRequest(), signal)
            .then(({ text }) => parseAirportCatalogue(text))
            .then(async (stations) => {
                const ids = nearbyAirportIds(stations, point);
                result.partial ||=
                    stations.filter((station) => distanceNm(point, station) <= result.radiusNm).length > ids.length;
                if (!ids.length) return { rows: [], partial: false, error: null };
                const { text, retrievedAt } = await cached(metarRequest(ids), signal);
                const parsed = text ? parseAwcMetars(text, Date.now()) : { rows: [], partial: false, error: null };
                if (parsed.error) throw new Error(parsed.error);
                return {
                    ...parsed,
                    rows: parsed.rows
                        .filter((r) => ids.includes(r.id))
                        .map((row) => ({ ...row, retrievedAtMs: retrievedAt })),
                };
            }),
    ]);
    if (!isAuthIdentityScopeCurrent(scope) || signal?.aborted) throw new Error('Observation request cancelled');
    answers.forEach((answer, i) => {
        const provider: ObservationProvider = i === 0 ? 'ndbc' : 'awc-metar';
        if (answer.status === 'fulfilled') {
            result.availability[provider] = 'available';
            result.rows.push(...answer.value.rows);
            result.partial ||= answer.value.partial;
        } else result.availability[provider] = result.cachedOnly ? 'not-loaded' : 'failed';
    });
    if (result.cachedOnly)
        for (const row of history.latest(now))
            if (!result.rows.some((r) => r.provider === row.provider && r.id === row.id)) result.rows.push(row);
    history.put(
        result.rows.filter((row) => distanceNm(point, row) <= result.radiusNm),
        Date.now(),
    );
    return result;
}
export async function loadObservationHistory(
    station: Observation,
    hours: 12 | 24 | 48 | 72,
    signal?: AbortSignal,
): Promise<{ rows: Observation[]; partial: boolean; cachedOnly: boolean }> {
    const scope = getAuthIdentityScope(),
        now = Date.now();
    if (satelliteModeActive() || (typeof navigator !== 'undefined' && navigator.onLine === false))
        return { rows: history.get(station.provider, station.id, now, hours), partial: true, cachedOnly: true };
    const { text, retrievedAt } = await cached(
        station.provider === 'ndbc' ? ndbcHistoryRequest(station.id) : metarRequest([station.id], hours),
        signal,
    );
    const parsed =
        station.provider === 'ndbc'
            ? parseNdbcHistory(text, station, Date.now())
            : text
              ? parseAwcMetars(text, Date.now())
              : { rows: [], partial: false, error: null };
    if (parsed.error) throw new Error(parsed.error);
    if (!isAuthIdentityScopeCurrent(scope) || signal?.aborted) throw new Error('Observation request cancelled');
    history.put(
        parsed.rows.filter((r) => r.id === station.id).map((row) => ({ ...row, retrievedAtMs: retrievedAt })),
        Date.now(),
    );
    return { rows: history.get(station.provider, station.id, now, hours), partial: parsed.partial, cachedOnly: false };
}
