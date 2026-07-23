/**
 * WeatherOrchestrator — Framework-agnostic weather data orchestration service
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted from WeatherContext.tsx to separate data-fetching, location
 * resolution, caching, and AI enrichment from React state management.
 *
 * Usage:
 *   const orchestrator = new WeatherOrchestrator(callbacks);
 *   await orchestrator.fetchWeather('Sydney, NSW', { force: true });
 */

import { createLogger } from '../utils/createLogger';
import { MarineWeatherReport, VesselProfile, UnitPreferences, VesselDimensionUnits } from '../types';
import { fetchPrecisionWeather, fetchWeatherByStrategy, parseLocation, reverseGeocode } from './weatherService';
import { fetchWeatherKitRealtime } from './weather/api/weatherkit';
import { isStormglassKeyPresent } from './weather/keys';
import { degreesToCardinal } from '../utils';
import { EnvironmentService } from './EnvironmentService';
import { getErrorMessage } from '../utils/createLogger';
import { GpsService } from './GpsService';
import {
    saveLargeDataImmediate,
    loadLargeData,
    loadLargeDataSync,
    deleteLargeData,
    readCacheVersion,
    writeCacheVersion,
    DATA_CACHE_KEY,
    VOYAGE_CACHE_KEY,
    HISTORY_CACHE_KEY,
} from './nativeStorage';
import { getUpdateInterval, alignToNextInterval, AI_UPDATE_INTERVAL } from './WeatherScheduler';
import { addBreadcrumb, captureException } from './sentry';
import { isPremiumUser } from '../managers/SubscriptionManager';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
const log = createLogger('WxOrch');

// ── Types ──────────────────────────────────────────────────────

export const CACHE_VERSION = 'v19.2-WEATHERKIT-FIX';

// Two separate thresholds so the UI doesn't double-up a loader:
// - REFETCH: how old cached data can be before we trigger a background
//   refresh. Keep at 30min to preserve hourly-ish freshness.
// - BLUR: how old cached data has to be before the big "Updating…"
//   blur overlay covers The Glass. 30min was too aggressive — data
//   that's half an hour old is still fine for tactical decisions, and
//   the blur made the app feel like it was loading twice on every
//   cold start. Lift to 2h — below that we background-refresh silently
//   (the sync badge at the bottom already indicates the fetch).
/**
 * THE staleness rule: how old a cached report may be before it is worth
 * fetching again. Exported so the Glass's location switch answers the same
 * question the same way — before, boot honoured this and picking a location
 * ignored it, so tapping a port you had opened two minutes earlier still cost
 * a full fetch (Shane 2026-07-22: "if the data is fresh, it does not need to
 * be re-freshed, we have a rule somewhere").
 */
export const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — refetch trigger
const BLUR_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 h — UI blur trigger
export const NEXT_UPDATE_CACHE_KEY = 'thalassa_next_update';
const CACHE_VERSION_STORAGE_KEY = 'thalassa_weather_cache_schema';

export interface WeatherCacheKeys {
    data: string;
    voyage: string;
    history: string;
    nextUpdate: string;
    version: string;
}

/** Resolve every location-bearing weather cache into one exact auth namespace. */
export function weatherCacheKeysForScope(scope: AuthIdentityScope = getAuthIdentityScope()): WeatherCacheKeys {
    return {
        data: authScopedStorageKey(DATA_CACHE_KEY, scope),
        voyage: authScopedStorageKey(VOYAGE_CACHE_KEY, scope),
        history: authScopedStorageKey(HISTORY_CACHE_KEY, scope),
        nextUpdate: authScopedStorageKey(NEXT_UPDATE_CACHE_KEY, scope),
        version: authScopedStorageKey(CACHE_VERSION_STORAGE_KEY, scope),
    };
}

/**
 * Safe first-paint cache lookup. Legacy unscoped weather can only belong to
 * the public anonymous experience; authenticated accounts fail closed.
 */
export function loadWeatherCacheSyncForScope(scope: AuthIdentityScope): MarineWeatherReport | null {
    if (!isAuthIdentityScopeCurrent(scope)) return null;
    const scopedKey = weatherCacheKeysForScope(scope).data;
    const scoped = loadLargeDataSync(scopedKey) as MarineWeatherReport | null;
    if (scoped?.locationName) return scoped;
    if (scope.userId !== null) return null;

    const legacy = loadLargeDataSync(DATA_CACHE_KEY) as MarineWeatherReport | null;
    if (!legacy?.locationName) return null;
    return legacy;
}

export interface Coords {
    lat: number;
    lon: number;
}

export interface FetchWeatherOptions {
    force?: boolean;
    coords?: Coords;
    showOverlay?: boolean;
    silent?: boolean;
}

export interface ResolvedLocation {
    name: string;
    coords: Coords | undefined;
    timezone?: string;
}

/** Callbacks that the orchestrator uses to push state updates to the consumer (React context) */
export interface OrchestratorCallbacks {
    setWeatherData: (data: MarineWeatherReport | null) => void;
    setLoading: (v: boolean) => void;
    setLoadingMessage: (msg: string) => void;
    setBackgroundUpdating: (v: boolean) => void;
    setStaleRefresh: (v: boolean) => void;
    setError: (err: string | null) => void;
    setNextUpdate: (ts: number | null) => void;
    setHistoryCache: (
        updater: (prev: Record<string, MarineWeatherReport>) => Record<string, MarineWeatherReport>,
    ) => void;
    setVersionChecked: (v: boolean) => void;
    incrementQuota: () => void;

    // Ref getters — orchestrator reads current state without subscribing
    getWeatherData: () => MarineWeatherReport | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSettings: () => any;
    getHistoryCache: () => Record<string, MarineWeatherReport>;
    getLocationMode: () => 'gps' | 'selected';
    getIsFetching: () => boolean;
    setIsFetching: (v: boolean) => void;
}

// ── Service ────────────────────────────────────────────────────

class StaleWeatherOperationError extends Error {
    constructor() {
        super('Weather operation belongs to an inactive identity');
        this.name = 'StaleWeatherOperationError';
    }
}

export class WeatherOrchestrator {
    private readonly cb: OrchestratorCallbacks;
    private readonly scope: AuthIdentityScope;
    private readonly cacheKeys: WeatherCacheKeys;
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private disposed = false;
    private fetchEpoch = 0;
    private adviceEpoch = 0;
    private liveMetricsEpoch = 0;

    constructor(callbacks: OrchestratorCallbacks, scope: AuthIdentityScope = getAuthIdentityScope()) {
        this.cb = callbacks;
        this.scope = scope;
        this.cacheKeys = weatherCacheKeysForScope(scope);
    }

    /** Stop timers and fence every promise created by this instance. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.fetchEpoch += 1;
        this.adviceEpoch += 1;
        this.liveMetricsEpoch += 1;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
    }

    isCurrentIdentity(): boolean {
        return !this.disposed && isAuthIdentityScopeCurrent(this.scope);
    }

    private isFetchCurrent(epoch: number): boolean {
        return this.isCurrentIdentity() && epoch === this.fetchEpoch;
    }

    private assertCurrent(epoch?: number): void {
        if (!this.isCurrentIdentity() || (epoch !== undefined && epoch !== this.fetchEpoch)) {
            throw new StaleWeatherOperationError();
        }
    }

    private isStaleOperation(error: unknown): boolean {
        return error instanceof StaleWeatherOperationError || !this.isCurrentIdentity();
    }

    private schedule(callback: () => void, delayMs: number): void {
        if (!this.isCurrentIdentity()) return;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.isCurrentIdentity()) callback();
        }, delayMs);
        this.timers.add(timer);
    }

    private async loadScopedCache<T>(scopedKey: string, legacyKey: string): Promise<T | null> {
        const scoped = (await loadLargeData(scopedKey)) as T | null;
        this.assertCurrent();
        if (scoped !== null) return scoped;
        if (this.scope.userId !== null) return null;

        // Unscoped caches pre-date account isolation. They have no trustworthy
        // owner, so only the deliberately public anonymous scope may adopt them.
        const legacy = (await loadLargeData(legacyKey)) as T | null;
        this.assertCurrent();
        if (legacy !== null) await saveLargeDataImmediate(scopedKey, legacy);
        this.assertCurrent();
        return legacy;
    }

    // ── Cache Version Check ────────────────────────────────────

    async checkCacheVersion(): Promise<void> {
        if (!this.isCurrentIdentity()) return;
        log.info('Version check starting...');
        addBreadcrumb({ category: 'weather', message: 'Cache version check', level: 'info' });
        try {
            let ver = (await loadLargeData(this.cacheKeys.version)) as string | null;
            this.assertCurrent();
            if (ver === null && this.scope.userId === null) {
                // Anonymous users may retain the pre-account-isolation schema
                // marker. Signed-in users must never inherit it.
                ver = await readCacheVersion();
                this.assertCurrent();
            }
            this.assertCurrent();
            log.info(`Cached version: ${ver}, expected: ${CACHE_VERSION}`);
            if (ver !== CACHE_VERSION) {
                log.info('Version mismatch — clearing caches');
                addBreadcrumb({
                    category: 'weather',
                    message: 'Cache version mismatch, clearing caches',
                    level: 'warning',
                    data: { cachedVersion: ver, expectedVersion: CACHE_VERSION },
                });
                await Promise.all([
                    deleteLargeData(this.cacheKeys.data),
                    deleteLargeData(this.cacheKeys.history),
                    deleteLargeData(this.cacheKeys.voyage),
                ]);
                this.assertCurrent();
                localStorage.removeItem(this.cacheKeys.nextUpdate);
                if (this.scope.userId === null) {
                    // Legacy weather was never attributable to a signed-in
                    // owner. It is safe to retire only while anonymous.
                    await Promise.all([
                        deleteLargeData(DATA_CACHE_KEY),
                        deleteLargeData(HISTORY_CACHE_KEY),
                        deleteLargeData(VOYAGE_CACHE_KEY),
                    ]);
                    localStorage.removeItem(NEXT_UPDATE_CACHE_KEY);
                    this.assertCurrent();
                }
                await saveLargeDataImmediate(this.cacheKeys.version, CACHE_VERSION);
                if (this.scope.userId === null) await writeCacheVersion(CACHE_VERSION);
                this.assertCurrent();
                this.cb.setWeatherData(null);
                this.cb.setHistoryCache(() => ({}));
            } else {
                if (loadLargeDataSync(this.cacheKeys.version) === null) {
                    await saveLargeDataImmediate(this.cacheKeys.version, CACHE_VERSION);
                    this.assertCurrent();
                }
                const cachedNextUpdate = localStorage.getItem(this.cacheKeys.nextUpdate);
                if (cachedNextUpdate) {
                    const nu = Number.parseInt(cachedNextUpdate, 10);
                    if (nu > Date.now()) this.cb.setNextUpdate(nu);
                }
            }
        } catch (e) {
            if (this.isStaleOperation(e)) return;
            log.warn('Version check failed:', e);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            captureException(e, { tags: { operation: 'checkCacheVersion' } } as any);
        } finally {
            if (this.isCurrentIdentity()) {
                this.cb.setVersionChecked(true);
                log.info('Version check complete');
            }
        }
    }

    // ── Synchronous Cache Pre-read ─────────────────────────────

    loadInstantCache(): MarineWeatherReport | null {
        if (!this.isCurrentIdentity()) return null;
        const syncCached = loadWeatherCacheSyncForScope(this.scope);
        if (syncCached && syncCached.locationName) {
            log.info(`Instant display: ${syncCached.locationName}`);
            addBreadcrumb({
                category: 'weather',
                message: `Instant cache hit: ${syncCached.locationName}`,
                level: 'info',
            });
            return syncCached;
        }
        addBreadcrumb({ category: 'weather', message: 'Instant cache miss', level: 'info' });
        return null;
    }

    // ── Async Cache Load + Init Fetch ──────────────────────────

    async loadCacheAndInit(): Promise<void> {
        if (!this.isCurrentIdentity()) return;
        let hasCachedData = false;

        try {
            // Clear legacy localStorage cache
            const keysToDelete: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('marine_weather_cache_')) {
                    keysToDelete.push(key);
                }
            }
            if (keysToDelete.length > 0) {
                addBreadcrumb({
                    category: 'weather',
                    message: `Clearing ${keysToDelete.length} legacy localStorage caches`,
                    level: 'info',
                });
            }
            keysToDelete.forEach((key) => localStorage.removeItem(key));
            this.assertCurrent();

            // Load cached weather data
            log.info('Loading cached weather data...');
            addBreadcrumb({ category: 'weather', message: 'Loading cached weather data', level: 'info' });
            const cached = await this.loadScopedCache<MarineWeatherReport>(this.cacheKeys.data, DATA_CACHE_KEY);
            this.assertCurrent();
            if (cached && cached.locationName) {
                log.info(`[WeatherOrchestrator] Cache HIT: ${cached.locationName} (generated: ${cached.generatedAt})`);
                addBreadcrumb({
                    category: 'weather',
                    message: `Cache HIT: ${cached.locationName}`,
                    level: 'info',
                    data: { generatedAt: cached.generatedAt },
                });
                this.cb.setWeatherData(cached);
                this.cb.setLoading(false);
                hasCachedData = true;
            } else {
                log.info('Cache MISS: no cached weather data');
                addBreadcrumb({ category: 'weather', message: 'Cache MISS: no weather data', level: 'info' });
            }

            // Load history
            const h = await this.loadScopedCache<Record<string, MarineWeatherReport>>(
                this.cacheKeys.history,
                HISTORY_CACHE_KEY,
            );
            this.assertCurrent();
            if (h) {
                this.cb.setHistoryCache(() => h);
                addBreadcrumb({
                    category: 'weather',
                    message: 'History cache loaded',
                    level: 'info',
                    data: { count: Object.keys(h).length },
                });
            } else {
                this.cb.setHistoryCache(() => ({}));
                addBreadcrumb({ category: 'weather', message: 'History cache empty', level: 'info' });
            }
        } catch (e) {
            if (this.isStaleOperation(e)) return;
            log.warn('Cache load failed:', e);
            addBreadcrumb({
                category: 'weather',
                message: 'Cache load failed',
                level: 'error',
                data: { error: getErrorMessage(e) },
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            captureException(e, { tags: { operation: 'loadCacheAndInit' } } as any);
            this.cb.setLoading(false);
        } finally {
            if (this.isCurrentIdentity()) this.triggerInitialFetch(hasCachedData);
        }
    }

    private triggerInitialFetch(hasCachedData: boolean): void {
        if (!this.isCurrentIdentity()) return;
        const settings = this.cb.getSettings();
        if (!settings.defaultLocation) {
            log.info('No default location set');
            addBreadcrumb({ category: 'weather', message: 'No default location set', level: 'info' });
            this.cb.setLoading(false);
            return;
        }

        const loc = settings.defaultLocation;
        log.info(`Default location: "${loc}"`);
        addBreadcrumb({ category: 'weather', message: `Default location: "${loc}"`, level: 'info' });

        // Staleness check
        const currentData = this.cb.getWeatherData();
        const cachedAge = currentData?.generatedAt
            ? Date.now() - new Date(currentData.generatedAt).getTime()
            : Infinity;

        if (hasCachedData && cachedAge < STALE_THRESHOLD_MS) {
            log.info(`Cache fresh (${Math.round(cachedAge / 60000)}m old) — skipping fetch`);
            addBreadcrumb({
                category: 'weather',
                message: 'Cache fresh, skipping fetch',
                level: 'info',
                data: { ageMinutes: Math.round(cachedAge / 60000) },
            });
            this.cb.setLoading(false);
            return;
        }

        if (hasCachedData && cachedAge >= STALE_THRESHOLD_MS) {
            // Between 30min and 2h: background refresh silently. Above
            // 2h: flip staleRefresh so the blur overlay covers The Glass
            // — at that age data is potentially misleading for marine
            // decisions and the user needs a clear "hold, updating" cue.
            const shouldBlur = cachedAge >= BLUR_THRESHOLD_MS;
            log.info(
                `[WeatherOrchestrator] Cache stale (${Math.round(cachedAge / 60000)}m old) — ${shouldBlur ? 'blur + ' : ''}background refresh`,
            );
            addBreadcrumb({
                category: 'weather',
                message: shouldBlur ? 'Cache very stale, blur + refresh' : 'Cache stale, silent refresh',
                level: 'info',
                data: { ageMinutes: Math.round(cachedAge / 60000) },
            });
            if (shouldBlur) this.cb.setStaleRefresh(true);
        }

        // Handle GPS-based "Current Location"
        if (loc === 'Current Location') {
            if (!hasCachedData) this.cb.setLoadingMessage('Getting GPS Location...');
            log.info('Requesting GPS position...');
            addBreadcrumb({ category: 'weather', message: 'Requesting GPS position', level: 'info' });
            GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 10 }).then((pos) => {
                if (!this.isCurrentIdentity()) return;
                if (pos) {
                    log.info(`GPS: ${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)}`);
                    addBreadcrumb({
                        category: 'weather',
                        message: 'GPS position received',
                        level: 'info',
                        data: { lat: pos.latitude, lon: pos.longitude },
                    });
                    this.fetchWeather(loc, {
                        force: !hasCachedData,
                        coords: { lat: pos.latitude, lon: pos.longitude },
                        showOverlay: false,
                        silent: hasCachedData,
                    });
                } else {
                    log.warn('GPS returned null');
                    addBreadcrumb({ category: 'weather', message: 'GPS returned null', level: 'warning' });
                    if (!hasCachedData) {
                        // GPS is a dead end here (plain-http Pi page can
                        // NEVER get it — not a secure context; or the user
                        // denied it). Fall back to the home-port coords
                        // saved at onboarding rather than a blocking error
                        // card (Shane 2026-07-11, calypso.local:3001).
                        const fallbackCoords = settings.defaultLocationCoords as Coords | undefined;
                        const fallbackName =
                            typeof settings.defaultLocation === 'string' &&
                            settings.defaultLocation !== 'Current Location'
                                ? settings.defaultLocation
                                : null;
                        if (fallbackCoords) {
                            log.warn('GPS unavailable — falling back to saved home-port coords');
                            this.fetchWeather(fallbackName ?? 'Home port', {
                                force: true,
                                coords: fallbackCoords,
                                showOverlay: false,
                            });
                        } else {
                            this.cb.setError(
                                typeof window !== 'undefined' && window.isSecureContext === false
                                    ? 'GPS is unavailable on this connection (http) — search or pick a location instead.'
                                    : 'Unable to get GPS location. Please select a location.',
                            );
                            this.cb.setLoading(false);
                        }
                    }
                }
            });
        } else {
            log.info(`Named location: "${loc}" — scheduling fetch`);
            addBreadcrumb({
                category: 'weather',
                message: `Named location: "${loc}" — scheduling fetch`,
                level: 'info',
            });
            this.cb.setLoading(false);
            // Prefer saved coordinates for the home port over re-geocoding
            // the name. Names like "Newport" match six cities worldwide;
            // whichever one the geocoder returned first could be a
            // different one than the user originally picked during
            // onboarding ("Old Aust Road, England" for a user who meant
            // Newport, QLD). The saved coords were captured at pick-time
            // so they're authoritative.
            const savedCoords = settings.defaultLocationCoords as Coords | undefined;
            this.schedule(() => {
                void this.fetchWeather(loc, {
                    force: !hasCachedData,
                    coords: savedCoords,
                    showOverlay: false,
                    silent: hasCachedData,
                });
            }, 100);
        }
    }

    // ── Location Resolution ────────────────────────────────────

    async resolveLocation(location: string, coords?: Coords, fetchEpoch?: number): Promise<ResolvedLocation> {
        this.assertCurrent(fetchEpoch);
        addBreadcrumb({
            category: 'location',
            message: `Resolving location: ${location}`,
            level: 'info',
            data: { initialCoords: coords },
        });
        let resolvedLocation = location;
        let resolvedCoords = coords;
        let resolvedTimezone: string | undefined;

        // If no coords provided, resolve from location name
        if (!resolvedCoords) {
            if (location === 'Current Location') {
                this.cb.setLoadingMessage('Getting GPS Location...');
                const pos = await GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 15 });
                this.assertCurrent(fetchEpoch);
                if (pos) {
                    addBreadcrumb({
                        category: 'location',
                        message: 'Resolved "Current Location" via GPS',
                        level: 'info',
                        data: { lat: pos.latitude, lon: pos.longitude },
                    });
                    return {
                        name: location,
                        coords: { lat: pos.latitude, lon: pos.longitude },
                    };
                }
                addBreadcrumb({
                    category: 'location',
                    message: 'Failed to get GPS for "Current Location"',
                    level: 'error',
                });
                // Same fallback ladder as the boot path: home-port coords
                // beat a fatal throw (http origins can never get GPS).
                const s = this.cb.getSettings();
                const fbCoords = s?.defaultLocationCoords as Coords | undefined;
                if (fbCoords) {
                    const fbName =
                        typeof s.defaultLocation === 'string' && s.defaultLocation !== 'Current Location'
                            ? s.defaultLocation
                            : 'Home port';
                    log.warn('resolveLocation: GPS unavailable — using saved home-port coords');
                    return { name: fbName, coords: fbCoords };
                }
                throw new Error(
                    typeof window !== 'undefined' && window.isSecureContext === false
                        ? 'GPS is unavailable on this connection (http) — search or pick a location instead.'
                        : 'Unable to get GPS location. Please select a location or enable location services.',
                );
            }

            try {
                const parsed = await parseLocation(location);
                this.assertCurrent(fetchEpoch);
                if (parsed.lat !== 0 || parsed.lon !== 0) {
                    resolvedCoords = { lat: parsed.lat, lon: parsed.lon };
                    if (parsed.name && parsed.name !== location && parsed.name !== 'Invalid Location') {
                        resolvedLocation = parsed.name;
                    }
                    if (parsed.timezone) resolvedTimezone = parsed.timezone;
                    addBreadcrumb({
                        category: 'location',
                        message: `Parsed location name: ${location}`,
                        level: 'info',
                        data: { parsedName: parsed.name, lat: parsed.lat, lon: parsed.lon },
                    });
                }
            } catch (e) {
                if (this.isStaleOperation(e)) throw e;
                addBreadcrumb({
                    category: 'location',
                    message: `Failed to parse location name: ${location}`,
                    level: 'warning',
                    data: { error: getErrorMessage(e) },
                });
                // Continue — fetchWeatherByStrategy will handle it
            }
        }

        // Reverse geocode if location looks generic
        if (
            resolvedCoords &&
            (location === 'Current Location' ||
                location === '0,0' ||
                location === '0, 0' ||
                location.startsWith('WP ') ||
                /^-?\d/.test(location))
        ) {
            try {
                const name = await reverseGeocode(resolvedCoords.lat, resolvedCoords.lon);
                this.assertCurrent(fetchEpoch);
                if (name) {
                    resolvedLocation = name;
                    addBreadcrumb({
                        category: 'location',
                        message: `Reverse geocoded coords to: ${name}`,
                        level: 'info',
                        data: { lat: resolvedCoords.lat, lon: resolvedCoords.lon },
                    });
                } else {
                    resolvedLocation = this.formatCoords(resolvedCoords);
                    addBreadcrumb({
                        category: 'location',
                        message: 'Reverse geocode returned no name, formatting coords',
                        level: 'info',
                        data: { lat: resolvedCoords.lat, lon: resolvedCoords.lon },
                    });
                }
            } catch (e) {
                if (this.isStaleOperation(e)) throw e;
                resolvedLocation = this.formatCoords(resolvedCoords);
                addBreadcrumb({
                    category: 'location',
                    message: 'Reverse geocode failed, formatting coords',
                    level: 'warning',
                    data: { lat: resolvedCoords.lat, lon: resolvedCoords.lon, error: getErrorMessage(e) },
                });
            }
        }
        addBreadcrumb({
            category: 'location',
            message: `Location resolved to: ${resolvedLocation}`,
            level: 'info',
            data: { finalCoords: resolvedCoords, timezone: resolvedTimezone },
        });
        this.assertCurrent(fetchEpoch);
        return { name: resolvedLocation, coords: resolvedCoords, timezone: resolvedTimezone };
    }

    private formatCoords(coords: Coords): string {
        const latStr = Math.abs(coords.lat).toFixed(2) + '°' + (coords.lat >= 0 ? 'N' : 'S');
        const lonStr = Math.abs(coords.lon).toFixed(2) + '°' + (coords.lon >= 0 ? 'E' : 'W');
        return `${latStr}, ${lonStr}`;
    }

    // ── Core Fetch ─────────────────────────────────────────────

    async fetchWeather(location: string, options: FetchWeatherOptions = {}): Promise<void> {
        const { force = false, coords, showOverlay: _showOverlay = false, silent = false } = options;

        if (!location || !this.isCurrentIdentity()) return;

        addBreadcrumb({
            category: 'weather',
            message: `fetchWeather: ${location}`,
            level: 'info',
            data: { force, silent, hasCoords: !!coords },
        });

        // Prevent concurrent fetches
        if (this.cb.getIsFetching() && !force) {
            addBreadcrumb({
                category: 'weather',
                message: 'Preventing concurrent fetch',
                level: 'info',
                data: { location, force },
            });
            return;
        }
        const fetchEpoch = ++this.fetchEpoch;
        // A live patch or manual advice generation that started against the
        // previous report may not be applied after this location fetch begins.
        this.liveMetricsEpoch += 1;
        this.adviceEpoch += 1;
        this.cb.setIsFetching(true);

        // Offline check
        if (!navigator.onLine) {
            addBreadcrumb({ category: 'weather', message: 'Offline mode detected', level: 'warning' });
            const historyCache = this.cb.getHistoryCache();
            const currentData = this.cb.getWeatherData();
            if (historyCache[location]) {
                this.cb.setWeatherData(historyCache[location]);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Serving from history cache in offline mode',
                    level: 'info',
                    data: { location },
                });
            } else if (!currentData) {
                this.cb.setError('Offline Mode: No Data');
                addBreadcrumb({
                    category: 'weather',
                    message: 'No data available in offline mode',
                    level: 'error',
                    data: { location },
                });
            }
            if (this.isFetchCurrent(fetchEpoch)) {
                this.cb.setLoading(false);
                this.cb.setIsFetching(false);
            }
            return;
        }

        const settings = this.cb.getSettings();
        const currentData = this.cb.getWeatherData();
        const historyCache = this.cb.getHistoryCache();

        // Cache hit?
        let isServingFromCache = false;
        if (!currentData && historyCache[location] && !force) {
            this.cb.setWeatherData(historyCache[location]);
            isServingFromCache = true;
            addBreadcrumb({
                category: 'weather',
                message: `Serving from history cache for ${location}`,
                level: 'info',
            });
        }

        const isBackground = isServingFromCache || !!currentData || silent;
        if (!isBackground) {
            this.cb.setLoading(true);
            this.cb.setLoadingMessage('Fetching Weather Data...');
            addBreadcrumb({ category: 'weather', message: 'Showing loading overlay', level: 'info' });
        } else {
            this.cb.setBackgroundUpdating(true);
            addBreadcrumb({ category: 'weather', message: 'Background updating', level: 'info' });
        }
        this.cb.setError(null);

        try {
            // Resolve location + coordinates
            let resolved: ResolvedLocation;
            if (coords && location === 'Current Location') {
                // GPS coords already provided — just need reverse geocode
                resolved = await this.resolveLocation(location, coords, fetchEpoch);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Resolved location using provided GPS coords for Current Location',
                    level: 'info',
                    data: { location, coords },
                });
            } else if (coords) {
                resolved = { name: location, coords };
                addBreadcrumb({
                    category: 'weather',
                    message: 'Resolved location using provided explicit coords',
                    level: 'info',
                    data: { location, coords },
                });
            } else {
                resolved = await this.resolveLocation(location, undefined, fetchEpoch);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Resolved location from name',
                    level: 'info',
                    data: { location },
                });
            }
            this.assertCurrent(fetchEpoch);

            if (!resolved.coords) {
                addBreadcrumb({
                    category: 'weather',
                    message: `Missing coordinates for ${resolved.name}`,
                    level: 'error',
                });
                throw new Error(`Cannot fetch weather for ${resolved.name}: Missing Coordinates`);
            }

            // Fetch weather via strategy orchestrator
            let currentReport = await this.fetchFromStrategy(
                resolved.coords.lat,
                resolved.coords.lon,
                resolved.name,
                fetchEpoch,
            );
            this.assertCurrent(fetchEpoch);
            addBreadcrumb({
                category: 'weather',
                message: 'Fetched weather from strategy',
                level: 'info',
                data: {
                    lat: resolved.coords.lat,
                    lon: resolved.coords.lon,
                    name: resolved.name,
                    reportPresent: !!currentReport,
                },
            });

            // Lock coords if provided explicitly
            if (coords && currentReport) {
                currentReport = { ...currentReport, coordinates: coords };
                addBreadcrumb({
                    category: 'weather',
                    message: 'Locked report coordinates to explicit input',
                    level: 'info',
                    data: { lat: coords.lat, lon: coords.lon },
                });
            }

            if (currentReport) {
                this.cb.setWeatherData(currentReport);
                this.cb.setHistoryCache((prev) => ({ ...prev, [location]: currentReport! }));
                void saveLargeDataImmediate(this.cacheKeys.data, currentReport);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Weather data updated and cached',
                    level: 'info',
                    data: { location: currentReport.locationName, generatedAt: currentReport.generatedAt },
                });
                if (!isBackground) this.cb.setLoading(false);
            }

            // Schedule next update + AI enrichment. We deliberately DON'T
            // await this — the Gemini enrichment call inside takes 2-5s
            // and holding isFetching during that window would silently
            // drop pull-to-refresh taps and scheduled background updates.
            // The function sets the base weather data + nextUpdate timer
            // synchronously at the top, then kicks off the AI call in the
            // background. When AI completes it re-fires setWeatherData
            // with the enriched payload, which triggers a re-render.
            // Errors from the AI path are non-critical; we swallow them
            // at the outer level so fire-and-forget doesn't leak promise
            // rejections.
            if (currentReport) {
                void this.scheduleNextAndEnrich(currentReport, location, settings, force, fetchEpoch).catch((e) => {
                    if (!this.isStaleOperation(e)) log.warn('scheduleNextAndEnrich (post-render):', e);
                });
            }
        } catch (err: unknown) {
            if (!this.isFetchCurrent(fetchEpoch) || this.isStaleOperation(err)) return;
            const currentData2 = this.cb.getWeatherData();
            const historyCache2 = this.cb.getHistoryCache();
            if (!navigator.onLine && (currentData2 || historyCache2[location])) {
                // Offline fallback — OK
                addBreadcrumb({
                    category: 'weather',
                    message: 'Fetch failed, but offline fallback available',
                    level: 'warning',
                    data: { error: getErrorMessage(err) },
                });
            } else {
                // Surface the failure when there is nothing to show OR when
                // the user explicitly asked for THIS place (force). Keeping
                // quiet because stale data happens to be on screen is how
                // "I picked Townsville and got Newport" looked like a crash:
                // the pick saved, the page navigated, and the previous
                // location's numbers simply stayed put with no error at all.
                // A silent background refresh may fail quietly; a tap may not.
                if (!currentData2 || force) {
                    this.cb.setError(getErrorMessage(err) || `Couldn't load weather for ${location}`);
                }
                addBreadcrumb({
                    category: 'weather',
                    message: 'Fetch failed, no fallback',
                    level: 'error',
                    data: { error: getErrorMessage(err), force },
                });
            }
            this.cb.setLoading(false);

            // Report fetch failures to Sentry
            if (err instanceof Error) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                captureException(err, { tags: { operation: 'fetchWeather', location } } as any);
            }

            // Reschedule on failure
            const retryTs = Date.now() + 2 * 60 * 1000;
            this.cb.setNextUpdate(retryTs);
            localStorage.setItem(this.cacheKeys.nextUpdate, retryTs.toString());
            addBreadcrumb({
                category: 'weather',
                message: `Rescheduling fetch due to error for ${location}`,
                level: 'info',
                data: { retryTime: new Date(retryTs).toISOString() },
            });
        } finally {
            if (this.isFetchCurrent(fetchEpoch)) {
                this.cb.setIsFetching(false);
                this.cb.setBackgroundUpdating(false);
                this.cb.setStaleRefresh(false);
                this.cb.setLoading(false);
            }
        }
    }

    private async fetchFromStrategy(
        lat: number,
        lon: number,
        name: string,
        fetchEpoch: number,
    ): Promise<MarineWeatherReport | null> {
        // --- SUBSCRIPTION TIER ROUTING ---
        // Premium users get the full multi-source pipeline (WeatherKit + StormGlass + GRIB).
        // Free/expired users get standard resolution only (OpenMeteo GFS).
        let premium = true; // default to full pipeline if check fails
        try {
            premium = await isPremiumUser();
        } catch {
            // If subscription check fails, don't block weather — give full pipeline
            log.warn('Subscription check failed, defaulting to premium pipeline');
        }
        this.assertCurrent(fetchEpoch);

        try {
            const report = await fetchWeatherByStrategy(lat, lon, name, undefined);
            this.assertCurrent(fetchEpoch);
            this.cb.incrementQuota();
            return report;
        } catch (e: unknown) {
            this.assertCurrent(fetchEpoch);
            if (this.isStaleOperation(e)) throw e;
            // Premium fallback: try StormGlass high-res if available
            if (premium && isStormglassKeyPresent()) {
                try {
                    const report = await fetchPrecisionWeather(name, { lat, lon }, false, undefined);
                    this.assertCurrent(fetchEpoch);
                    this.cb.incrementQuota();
                    return report;
                } catch (fallbackError) {
                    this.assertCurrent(fetchEpoch);
                    if (this.isStaleOperation(fallbackError)) throw fallbackError;
                    throw e;
                }
            }
            // Free users: no StormGlass fallback — save API credits
            throw e;
        }
    }

    private async scheduleNextAndEnrich(
        report: MarineWeatherReport,
        location: string,
        settings: Record<string, unknown>,
        force: boolean,
        fetchEpoch: number,
    ): Promise<void> {
        this.assertCurrent(fetchEpoch);
        const locationType = report.locationType || 'coastal';
        const isCurrentLoc = this.cb.getLocationMode() === 'gps';
        const interval = getUpdateInterval(
            locationType,
            report,
            isCurrentLoc,
            settings.satelliteMode as boolean | undefined,
        );
        const nextTs = alignToNextInterval(interval);
        this.cb.setNextUpdate(nextTs);
        localStorage.setItem(this.cacheKeys.nextUpdate, nextTs.toString());

        // AI enrichment
        const currentData = this.cb.getWeatherData();
        const lastAI = currentData?.aiGeneratedAt ? new Date(currentData.aiGeneratedAt).getTime() : 0;
        const timeExpired = Date.now() - lastAI > AI_UPDATE_INTERVAL;
        const locationChanged = currentData?.locationName !== report.locationName;

        if (timeExpired || force || locationChanged || !currentData?.boatingAdvice) {
            try {
                const { enrichMarineWeather } = await import('./geminiService');
                this.assertCurrent(fetchEpoch);
                const enriched = await enrichMarineWeather(
                    report,
                    settings.vessel as VesselProfile | undefined,
                    settings.units as UnitPreferences | undefined,
                    settings.vesselUnits as VesselDimensionUnits | undefined,
                    settings.aiPersona as number | undefined,
                );
                this.assertCurrent(fetchEpoch);
                this.cb.setWeatherData(enriched);
                this.cb.setHistoryCache((prev) => ({ ...prev, [location]: enriched }));
                void saveLargeDataImmediate(this.cacheKeys.data, enriched);
            } catch (e) {
                if (this.isStaleOperation(e)) throw e;
                log.warn('AI enrichment non-critical:', e);
            }
        } else {
            // Carry forward existing advice
            if (currentData?.boatingAdvice) {
                const withAdvice = {
                    ...report,
                    boatingAdvice: currentData.boatingAdvice,
                    aiGeneratedAt: currentData.aiGeneratedAt,
                };
                this.assertCurrent(fetchEpoch);
                this.cb.setWeatherData(withAdvice);
                void saveLargeDataImmediate(this.cacheKeys.data, withAdvice);
            }
        }
    }

    // ── Live Metrics Patch (WeatherKit Realtime) ───────────────

    async patchLiveMetrics(): Promise<void> {
        if (!this.isCurrentIdentity()) return;
        const liveMetricsEpoch = ++this.liveMetricsEpoch;
        const report = this.cb.getWeatherData();
        if (!report?.coordinates) return;
        if (report.locationType === 'offshore') return;

        const { lat, lon } = report.coordinates;
        try {
            const obs = await fetchWeatherKitRealtime(lat, lon);
            if (!this.isCurrentIdentity() || liveMetricsEpoch !== this.liveMetricsEpoch) return;
            if (!obs || obs.temperature === null) return;

            const current = this.cb.getWeatherData();
            if (!current) return;
            if (
                current.generatedAt !== report.generatedAt ||
                current.locationName !== report.locationName ||
                current.coordinates?.lat !== lat ||
                current.coordinates?.lon !== lon
            ) {
                return;
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const patched = { ...current.current } as any;
            const sources = { ...(patched.sources || {}) };

            const wkSource = (val: number | null) => ({
                value: val,
                source: 'weatherkit' as const,
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            });

            // Patch all live metrics from WeatherKit
            if (obs.temperature !== null) {
                patched.airTemperature = obs.temperature;
                sources['airTemperature'] = wkSource(obs.temperature);
            }
            if (obs.temperatureApparent !== null) {
                patched.feelsLike = obs.temperatureApparent;
                sources['feelsLike'] = wkSource(obs.temperatureApparent);
            }
            if (obs.humidity !== null) {
                patched.humidity = obs.humidity;
                sources['humidity'] = wkSource(obs.humidity);
            }
            if (obs.dewPoint !== null) {
                patched.dewPoint = obs.dewPoint;
                sources['dewPoint'] = wkSource(obs.dewPoint);
            }
            if (obs.pressure !== null) {
                patched.pressure = obs.pressure;
                sources['pressure'] = wkSource(obs.pressure);
            }
            if (obs.windSpeed !== null) {
                patched.windSpeed = parseFloat(obs.windSpeed.toFixed(1));
                sources['windSpeed'] = wkSource(patched.windSpeed);
            }
            if (obs.windGust !== null) {
                patched.windGust = parseFloat(obs.windGust.toFixed(1));
                sources['windGust'] = wkSource(patched.windGust);
            }
            if (obs.windDirection !== null) {
                patched.windDegree = obs.windDirection;
                patched.windDirection = degreesToCardinal(obs.windDirection);
                sources['windDirection'] = wkSource(obs.windDirection);
            }
            if (obs.cloudCover !== null) {
                patched.cloudCover = obs.cloudCover;
                sources['cloudCover'] = wkSource(obs.cloudCover);
            }
            if (obs.visibility !== null) {
                patched.visibility = obs.visibility;
                sources['visibility'] = wkSource(obs.visibility);
            }
            if (obs.uvIndex !== null) {
                patched.uvIndex = obs.uvIndex;
                sources['uvIndex'] = wkSource(obs.uvIndex);
            }
            if (obs.condition && obs.condition !== 'Unknown') {
                patched.condition = obs.condition;
                patched.description = `${obs.condition}. Wind ${patched.windSpeed ?? '--'} kts ${patched.windDirection || ''}`;
            }
            if (obs.precipitationIntensity !== null) {
                patched.precipitation = obs.precipitationIntensity;
                sources['precipitation'] = wkSource(obs.precipitationIntensity);
            }

            patched.sources = sources;
            if (this.isCurrentIdentity() && liveMetricsEpoch === this.liveMetricsEpoch) {
                this.cb.setWeatherData({ ...current, current: patched });
            }
        } catch (e) {
            if (this.isCurrentIdentity() && liveMetricsEpoch === this.liveMetricsEpoch) {
                log.warn('Live metrics patch failed:', e);
            }
        }
    }

    // ── AI Enrichment ──────────────────────────────────────────

    async regenerateAdvice(): Promise<void> {
        if (!this.isCurrentIdentity()) return;
        const adviceEpoch = ++this.adviceEpoch;
        const currentData = this.cb.getWeatherData();
        const settings = this.cb.getSettings();
        if (!currentData) return;

        this.cb.setBackgroundUpdating(true);
        try {
            const { enrichMarineWeather } = await import('./geminiService');
            if (!this.isCurrentIdentity() || adviceEpoch !== this.adviceEpoch) return;
            const enriched = await enrichMarineWeather(
                currentData,
                settings.vessel,
                settings.units,
                settings.vesselUnits,
                settings.aiPersona,
            );
            if (!this.isCurrentIdentity() || adviceEpoch !== this.adviceEpoch) return;
            const stillCurrent = this.cb.getWeatherData();
            if (
                stillCurrent?.generatedAt !== currentData.generatedAt ||
                stillCurrent.locationName !== currentData.locationName
            ) {
                return;
            }
            this.cb.setWeatherData(enriched);
            void saveLargeDataImmediate(this.cacheKeys.data, enriched);
            if (enriched.locationName) {
                this.cb.setHistoryCache((prev) => ({ ...prev, [enriched.locationName]: enriched }));
            }
        } catch {
            // Non-critical
        } finally {
            if (this.isCurrentIdentity() && adviceEpoch === this.adviceEpoch) {
                this.cb.setBackgroundUpdating(false);
            }
        }
    }

    // ── Environment Detection ──────────────────────────────────

    static updateEnvironment(data: MarineWeatherReport): void {
        EnvironmentService.updateFromWeatherData({
            locationType: data.locationType,
            isLandlocked: data.isLandlocked,
            elevation:
                '_elevation' in data ? (data as MarineWeatherReport & { _elevation?: number })._elevation : undefined,
        });
    }
}
