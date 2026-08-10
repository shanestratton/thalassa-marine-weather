import { MarineWeatherReport } from '../../types';
import {
    canUsePlaintextWeatherCache,
    isIosPlaintextWeatherCacheBlocked,
    scrubIosPlaintextWeatherCaches,
} from './plaintextCachePrivacy';

const CACHE_KEY_PREFIX = 'marine_weather_cache_v9_point_';
const WEATHER_CACHE_KEY_PREFIX = 'marine_weather_cache_';
const RETIRED_LAST_REPORT_KEY = 'last_marine_report';
const COORDINATE_DECIMALS = 5;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_OFFLINE_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_POINT_CACHE_ENTRIES = 24;
export const MAX_WEATHER_HISTORY_ENTRIES = 24;

export interface WeatherCacheCoordinates {
    lat: number;
    lon: number;
}

interface CacheEntry {
    timestamp: number;
    coordinates: WeatherCacheCoordinates;
    data: MarineWeatherReport;
    model: string;
}

const normaliseCoordinate = (value: number, min: number, max: number): number | null => {
    if (!Number.isFinite(value) || value < min || value > max) return null;
    const rounded = Number(value.toFixed(COORDINATE_DECIMALS));
    return Object.is(rounded, -0) ? 0 : rounded;
};

const normaliseCoordinates = (coordinates: WeatherCacheCoordinates): WeatherCacheCoordinates | null => {
    const lat = normaliseCoordinate(coordinates.lat, -90, 90);
    const lon = normaliseCoordinate(coordinates.lon, -180, 180);
    return lat === null || lon === null ? null : { lat, lon };
};

/**
 * A bounded, stable identity for one weather point. Location names are not
 * identities: two different coordinates can both reverse-geocode to the same
 * suburb, bay, or generic "Current Location" label.
 */
export const weatherCacheKeyForCoordinates = (coordinates: WeatherCacheCoordinates): string | null => {
    const point = normaliseCoordinates(coordinates);
    if (!point) return null;
    return `${CACHE_KEY_PREFIX}${point.lat.toFixed(COORDINATE_DECIMALS)}_${point.lon.toFixed(COORDINATE_DECIMALS)}`;
};

export const weatherCoordinatesMatch = (
    first: WeatherCacheCoordinates | null | undefined,
    second: WeatherCacheCoordinates | null | undefined,
): boolean => {
    if (!first || !second) return false;
    const firstKey = weatherCacheKeyForCoordinates(first);
    return firstKey !== null && firstKey === weatherCacheKeyForCoordinates(second);
};

/**
 * "Same weather" proximity — deliberately NOT the metre-scale cache identity
 * above. Forecast grids are kilometres wide: a phone that drifted less than
 * this overnight (GPS jitter, a boat swinging at anchor, walking to the
 * kitchen) is asking about the same sky. The instant wake/boot paths use it
 * to decide whether a fresh GPS fix warrants a corrective re-fetch, and
 * resolveLocation uses it to reuse the on-screen place name for the same
 * point instead of holding the fetch for a reverse-geocode round trip.
 */
export const weatherCoordinatesNearby = (
    first: WeatherCacheCoordinates | null | undefined,
    second: WeatherCacheCoordinates | null | undefined,
    toleranceKm = 2,
): boolean => {
    if (!first || !second) return false;
    if (
        !Number.isFinite(first.lat) ||
        !Number.isFinite(first.lon) ||
        !Number.isFinite(second.lat) ||
        !Number.isFinite(second.lon)
    ) {
        return false;
    }
    const latM = (first.lat - second.lat) * 111_320;
    const lonM = (first.lon - second.lon) * 111_320 * Math.cos((((first.lat + second.lat) / 2) * Math.PI) / 180);
    return Math.hypot(latM, lonM) <= toleranceKm * 1000;
};

/** Coordinate identity used by the multi-location history cache. */
export const weatherHistoryKeyForCoordinates = (coordinates: WeatherCacheCoordinates): string | null =>
    weatherCacheKeyForCoordinates(coordinates);

/**
 * Retain only recent, point-identifiable history. This bounds precise-location
 * retention and folds legacy display-name keys into one record per point.
 */
export const normalizeWeatherHistoryCache = (
    history: Record<string, MarineWeatherReport>,
    now = Date.now(),
): Record<string, MarineWeatherReport> => {
    const newestByPoint = new Map<string, { report: MarineWeatherReport; generatedAt: number }>();
    for (const report of Object.values(history)) {
        const key = report?.coordinates ? weatherHistoryKeyForCoordinates(report.coordinates) : null;
        const generatedAt = Date.parse(report?.generatedAt ?? '');
        if (
            !key ||
            !Number.isFinite(generatedAt) ||
            generatedAt <= 0 ||
            generatedAt > now + MAX_CLOCK_SKEW_MS ||
            now - generatedAt > MAX_OFFLINE_CACHE_AGE_MS
        ) {
            continue;
        }
        const existing = newestByPoint.get(key);
        if (!existing || generatedAt >= existing.generatedAt) newestByPoint.set(key, { report, generatedAt });
    }

    return Object.fromEntries(
        [...newestByPoint.entries()]
            .sort((first, second) => second[1].generatedAt - first[1].generatedAt)
            .slice(0, MAX_WEATHER_HISTORY_ENTRIES)
            .map(([key, value]) => [key, value.report]),
    );
};

export const recordWeatherHistoryReport = (
    history: Record<string, MarineWeatherReport>,
    report: MarineWeatherReport,
): Record<string, MarineWeatherReport> => {
    const key = report.coordinates ? weatherHistoryKeyForCoordinates(report.coordinates) : null;
    return key ? normalizeWeatherHistoryCache({ ...history, [key]: report }) : normalizeWeatherHistoryCache(history);
};

export const weatherReportMatchesRequest = (
    report: MarineWeatherReport | null | undefined,
    locationName: string,
    coordinates?: WeatherCacheCoordinates,
): boolean => {
    if (!report) return false;
    if (coordinates) return weatherCoordinatesMatch(report.coordinates, coordinates);
    const normalizedName = locationName.trim().toLowerCase();
    return !!normalizedName && report.locationName?.trim().toLowerCase() === normalizedName;
};

/**
 * Resolve history without trusting a display name as a point identity.
 * Legacy name-keyed records remain readable only when their embedded
 * coordinates match. If no coordinates are available, an unambiguous single
 * name match is the strongest safe fallback; duplicate names fail closed.
 */
export const findWeatherHistoryReport = (
    history: Record<string, MarineWeatherReport>,
    locationName: string,
    coordinates?: WeatherCacheCoordinates,
): MarineWeatherReport | null => {
    const entries = Object.values(history).filter((report): report is MarineWeatherReport => !!report);
    if (coordinates) {
        const directKey = weatherHistoryKeyForCoordinates(coordinates);
        const direct = directKey ? history[directKey] : null;
        if (direct && weatherCoordinatesMatch(direct.coordinates, coordinates)) return direct;
        return entries.find((report) => weatherReportMatchesRequest(report, locationName, coordinates)) ?? null;
    }

    const normalizedName = locationName.trim().toLowerCase();
    if (!normalizedName) return null;
    const named = entries.filter((report) => weatherReportMatchesRequest(report, normalizedName));
    return named.length === 1 ? named[0] : null;
};

const keysMatching = (predicate: (key: string) => boolean): string[] => {
    if (typeof localStorage === 'undefined') return [];
    const keys: string[] = [];
    try {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key && predicate(key)) keys.push(key);
        }
    } catch {
        return [];
    }
    return keys;
};

/** Remove every retired/unscoped weather cache generation. */
export const purgeRetiredWeatherCacheEntries = (): number => {
    if (isIosPlaintextWeatherCacheBlocked()) return scrubIosPlaintextWeatherCaches();
    if (typeof localStorage === 'undefined') return 0;
    try {
        const retiredKeys = keysMatching(
            (key) => key.startsWith(WEATHER_CACHE_KEY_PREFIX) && !key.startsWith(CACHE_KEY_PREFIX),
        );
        if (localStorage.getItem(RETIRED_LAST_REPORT_KEY) !== null) retiredKeys.push(RETIRED_LAST_REPORT_KEY);
        for (const key of retiredKeys) localStorage.removeItem(key);
        return retiredKeys.length;
    } catch {
        // Storage denial must not break a live weather fetch.
        return 0;
    }
};

const prunePointWeatherCacheEntries = (): void => {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return;
    const now = Date.now();
    const retained: Array<{ key: string; timestamp: number }> = [];
    for (const key of keysMatching((candidate) => candidate.startsWith(CACHE_KEY_PREFIX))) {
        try {
            const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as { timestamp?: unknown } | null;
            const timestamp = parsed?.timestamp;
            if (
                typeof timestamp !== 'number' ||
                !Number.isFinite(timestamp) ||
                timestamp <= 0 ||
                timestamp > now + MAX_CLOCK_SKEW_MS ||
                now - timestamp > MAX_OFFLINE_CACHE_AGE_MS
            ) {
                localStorage.removeItem(key);
                continue;
            }
            retained.push({ key, timestamp });
        } catch {
            localStorage.removeItem(key);
        }
    }
    retained
        .sort((first, second) => second.timestamp - first.timestamp)
        .slice(MAX_POINT_CACHE_ENTRIES)
        .forEach(({ key }) => localStorage.removeItem(key));
};

const readEntry = (coordinates: WeatherCacheCoordinates): { key: string; entry: CacheEntry } | null => {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return null;
    purgeRetiredWeatherCacheEntries();
    const key = weatherCacheKeyForCoordinates(coordinates);
    if (!key) return null;

    const discard = () => {
        try {
            localStorage.removeItem(key);
        } catch {
            // A denied store remains an ordinary cache miss.
        }
    };

    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            discard();
            return null;
        }

        const candidate = value as Partial<CacheEntry>;
        const storedPointKey = candidate.coordinates ? weatherCacheKeyForCoordinates(candidate.coordinates) : null;
        const reportPointKey = candidate.data?.coordinates
            ? weatherCacheKeyForCoordinates(candidate.data.coordinates)
            : null;
        const now = Date.now();
        if (
            storedPointKey !== key ||
            reportPointKey !== key ||
            typeof candidate.timestamp !== 'number' ||
            !Number.isFinite(candidate.timestamp) ||
            candidate.timestamp <= 0 ||
            candidate.timestamp > now + MAX_CLOCK_SKEW_MS ||
            now - candidate.timestamp > MAX_OFFLINE_CACHE_AGE_MS ||
            typeof candidate.model !== 'string' ||
            !candidate.data
        ) {
            // A record under the wrong point key must never be returned as
            // local weather. Treat malformed/tampered cache data as a miss.
            discard();
            return null;
        }

        return { key, entry: candidate as CacheEntry };
    } catch {
        discard();
        return null;
    }
};

export const differenceInMinutes = (date1: Date, date2: Date): number => {
    return Math.abs((date1.getTime() - date2.getTime()) / 60000);
};

export const saveToCache = (coordinates: WeatherCacheCoordinates, data: MarineWeatherReport): void => {
    if (!canUsePlaintextWeatherCache()) return;
    purgeRetiredWeatherCacheEntries();
    const key = weatherCacheKeyForCoordinates(coordinates);
    const point = normaliseCoordinates(coordinates);
    const reportKey = data.coordinates ? weatherCacheKeyForCoordinates(data.coordinates) : null;
    if (!key || !point || reportKey !== key) return;

    try {
        const entry: CacheEntry = {
            timestamp: Date.now(),
            coordinates: point,
            data,
            model: data.modelUsed,
        };
        localStorage.setItem(key, JSON.stringify(entry));
        prunePointWeatherCacheEntries();
    } catch {
        // Cache writes are best-effort; a live fetch still succeeds.
    }
};

export const getFromCache = (coordinates: WeatherCacheCoordinates): MarineWeatherReport | null => {
    const cached = readEntry(coordinates);
    if (!cached) return null;

    const ageMinutes = Math.max(0, (Date.now() - cached.entry.timestamp) / 60000);
    const isPrecision = cached.entry.model.includes('stormglass');
    const maxAge = isPrecision ? 60 : 30;
    return ageMinutes < maxAge ? cached.entry.data : null;
};

export const clearCache = (coordinates?: WeatherCacheCoordinates): void => {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return;
    purgeRetiredWeatherCacheEntries();

    if (coordinates) {
        const key = weatherCacheKeyForCoordinates(coordinates);
        try {
            if (key) localStorage.removeItem(key);
        } catch {
            // Best-effort cache cleanup.
        }
        return;
    }

    // A no-argument clear means all weather caches, including any retired
    // version that may have survived an interrupted upgrade.
    const weatherKeys = keysMatching((key) => key.startsWith('marine_weather_cache_'));
    try {
        for (const key of weatherKeys) localStorage.removeItem(key);
        localStorage.removeItem(RETIRED_LAST_REPORT_KEY);
    } catch {
        // Best-effort cache cleanup.
    }
};

/** Result wrapper that includes staleness metadata. */
export interface StaleResult {
    data: MarineWeatherReport;
    stale: boolean;
    /** Always a finite, non-negative age derived from this exact point's record. */
    ageMinutes: number;
}

/**
 * Return cached data for this exact coordinate identity even after its normal
 * live-data TTL. A miss stays a miss; another point's last report is never a
 * valid fallback.
 */
export const getFromCacheOffline = (coordinates: WeatherCacheCoordinates): StaleResult | null => {
    const cached = readEntry(coordinates);
    if (!cached) return null;

    const ageMinutes = Math.max(0, Math.round((Date.now() - cached.entry.timestamp) / 60000));
    const isPrecision = cached.entry.model.includes('stormglass');
    const maxAge = isPrecision ? 60 : 30;
    return { data: cached.entry.data, stale: ageMinutes >= maxAge, ageMinutes };
};
