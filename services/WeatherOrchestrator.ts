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
import {
    findWeatherHistoryReport,
    normalizeWeatherHistoryCache,
    purgeRetiredWeatherCacheEntries,
    recordWeatherHistoryReport,
    weatherHistoryKeyForCoordinates,
    weatherReportMatchesRequest,
    weatherCoordinatesNearby,
} from './weather/cache';
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
    /** Authoritative internet-reachability state maintained by the active
     *  probe. `navigator.onLine` only proves a network interface exists. */
    getIsOffline: () => boolean;
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
        if (!this.isCurrentIdentity() || this.cb.getIsOffline()) return;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.isCurrentIdentity() && !this.cb.getIsOffline()) callback();
        }, delayMs);
        this.timers.add(timer);
    }

    /** An offline app has no truthful provider-refresh appointment. */
    private clearOfflineSchedule(): void {
        if (!this.isCurrentIdentity()) return;
        this.cb.setNextUpdate(null);
        localStorage.removeItem(this.cacheKeys.nextUpdate);
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
                if (this.cb.getIsOffline()) {
                    this.clearOfflineSchedule();
                } else if (cachedNextUpdate) {
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
                message: 'Instant cache hit',
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
            // Retire every unsafe prior/global cache. The point-bound v9
            // records are still used by RoutePlanner/VoyageForm offline paths.
            const retiredCacheCount = purgeRetiredWeatherCacheEntries();
            if (retiredCacheCount > 0) {
                addBreadcrumb({
                    category: 'weather',
                    message: `Clearing ${retiredCacheCount} legacy localStorage caches`,
                    level: 'info',
                });
            }
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
                    message: 'Weather cache hit',
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
                const normalizedHistory = normalizeWeatherHistoryCache(h);
                this.cb.setHistoryCache(() => normalizedHistory);
                addBreadcrumb({
                    category: 'weather',
                    message: 'History cache loaded',
                    level: 'info',
                    data: { count: Object.keys(normalizedHistory).length },
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
        addBreadcrumb({ category: 'weather', message: 'Default location configured', level: 'info' });

        // Staleness check
        const currentData = this.cb.getWeatherData();
        const cachedAge = currentData?.generatedAt
            ? Date.now() - new Date(currentData.generatedAt).getTime()
            : Infinity;

        // Cached readings remain useful offline, but GPS/geocoding/provider
        // startup work and a future-refresh timestamp would both be false
        // promises until the reachability probe recovers.
        if (this.cb.getIsOffline()) {
            this.clearOfflineSchedule();
            this.cb.setBackgroundUpdating(false);
            this.cb.setStaleRefresh(false);
            if (!hasCachedData && !currentData) this.cb.setError('Offline Mode: No Data');
            this.cb.setLoading(false);
            addBreadcrumb({ category: 'weather', message: 'Offline startup using cache only', level: 'warning' });
            return;
        }

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
            // INSTANT PATH (Shane 2026-08-10, mirrored in the wake handler):
            // when a cached report carries its own point, the refresh must not
            // queue behind a cold GPS acquisition — fetch against where the
            // phone was when that report was made, and let the fix arriving in
            // parallel trigger a corrective fetch only on a real move (>2 km).
            const knownCoords = hasCachedData ? this.cb.getWeatherData()?.coordinates : undefined;
            if (knownCoords) {
                log.info('Cached point available — fetching instantly, GPS correcting in parallel');
                addBreadcrumb({
                    category: 'weather',
                    message: 'Instant fetch from cached point; GPS in parallel',
                    level: 'info',
                });
                this.schedule(() => {
                    void this.fetchWeather(loc, {
                        force: false,
                        coords: knownCoords,
                        showOverlay: false,
                        silent: true,
                    });
                }, 100);
            }
            if (!hasCachedData) this.cb.setLoadingMessage('Getting GPS Location...');
            log.info('Requesting GPS position...');
            addBreadcrumb({ category: 'weather', message: 'Requesting GPS position', level: 'info' });
            GpsService.getCurrentPositionIfGranted({ staleLimitMs: 60_000, timeoutSec: 10 }).then((pos) => {
                if (!this.isCurrentIdentity()) return;
                if (pos) {
                    log.info(`GPS: ${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)}`);
                    addBreadcrumb({
                        category: 'weather',
                        message: 'GPS position received',
                        level: 'info',
                        data: { source: 'device-gps' },
                    });
                    const fresh = { lat: pos.latitude, lon: pos.longitude };
                    // Same sky as the instant fetch — a second round of
                    // sources would buy nothing but the blur it causes.
                    if (knownCoords && weatherCoordinatesNearby(knownCoords, fresh)) return;
                    this.fetchWeather(loc, {
                        force: !hasCachedData,
                        coords: fresh,
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
                message: 'Named location configured — scheduling fetch',
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
            message: 'Resolving requested location',
            level: 'info',
            data: { hasInitialCoordinates: !!coords },
        });
        let resolvedLocation = location;
        let resolvedCoords = coords;
        let resolvedTimezone: string | undefined;

        // If no coords provided, resolve from location name
        if (!resolvedCoords) {
            if (location === 'Current Location') {
                this.cb.setLoadingMessage('Getting GPS Location...');
                const pos = await GpsService.getCurrentPositionIfGranted({ staleLimitMs: 60_000, timeoutSec: 15 });
                this.assertCurrent(fetchEpoch);
                if (pos) {
                    addBreadcrumb({
                        category: 'location',
                        message: 'Resolved "Current Location" via GPS',
                        level: 'info',
                        data: { source: 'device-gps' },
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
                        message: 'Parsed requested location name',
                        level: 'info',
                        data: { parseSucceeded: true },
                    });
                }
            } catch (e) {
                if (this.isStaleOperation(e)) throw e;
                addBreadcrumb({
                    category: 'location',
                    message: 'Failed to parse requested location name',
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
            // Same point as the report already on screen → its name still
            // names it. Skipping the Nominatim round trip here matters
            // because this await sits ON the fetch's critical path: the
            // instant wake/boot refresh re-asks about last night's exact
            // coordinates, and holding the weather fetch to re-learn a
            // suburb name we are already displaying is pure blur time.
            const prev = this.cb.getWeatherData();
            const prevName = prev?.locationName?.trim();
            const prevNameReusable =
                !!prevName && prevName !== 'Current Location' && !prevName.startsWith('WP ') && !/^-?\d/.test(prevName);
            if (prevNameReusable && weatherCoordinatesNearby(prev?.coordinates, resolvedCoords)) {
                addBreadcrumb({
                    category: 'location',
                    message: 'Reused on-screen name for same point — reverse geocode skipped',
                    level: 'info',
                });
                return { name: prevName, coords: resolvedCoords, timezone: resolvedTimezone };
            }
            try {
                const name = await reverseGeocode(resolvedCoords.lat, resolvedCoords.lon);
                this.assertCurrent(fetchEpoch);
                if (name) {
                    resolvedLocation = name;
                    addBreadcrumb({
                        category: 'location',
                        message: 'Reverse geocoded requested coordinates',
                        level: 'info',
                        data: { reverseGeocodeSucceeded: true },
                    });
                } else {
                    resolvedLocation = this.formatCoords(resolvedCoords);
                    addBreadcrumb({
                        category: 'location',
                        message: 'Reverse geocode returned no name, formatting coords',
                        level: 'info',
                        data: { reverseGeocodeSucceeded: false },
                    });
                }
            } catch (e) {
                if (this.isStaleOperation(e)) throw e;
                resolvedLocation = this.formatCoords(resolvedCoords);
                addBreadcrumb({
                    category: 'location',
                    message: 'Reverse geocode failed, formatting coords',
                    level: 'warning',
                    data: { error: getErrorMessage(e) },
                });
            }
        }
        addBreadcrumb({
            category: 'location',
            message: 'Requested location resolved',
            level: 'info',
            data: { hasCoordinates: !!resolvedCoords, hasTimezone: !!resolvedTimezone },
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

        const currentAtRequest = this.cb.getWeatherData();
        log.info(
            `fetchWeather request "${location}" force=${force} current="${currentAtRequest?.locationName ?? 'none'}" coords=${coords ? 'yes' : 'no'}`,
        );

        // Several boot paths can converge here while settings, auth, and the
        // async native cache are settling. A non-forced request for the same
        // place must not burn a live provider call when a real, fresh report
        // is already on screen. Manual refreshes and explicit location picks
        // use force=true, so they continue to bypass this guard.
        if (!force) {
            const current = currentAtRequest;
            const generatedAt = current?.generatedAt ? Date.parse(current.generatedAt) : Number.NaN;
            const ageMs = Number.isFinite(generatedAt) ? Date.now() - generatedAt : Infinity;
            const samePoint = weatherReportMatchesRequest(current, location, coords);
            const currentState = current as (MarineWeatherReport & { loading?: boolean; isEstimated?: boolean }) | null;
            const usableCurrent = currentState && !currentState.loading && !currentState.isEstimated;

            if (usableCurrent && ageMs >= 0 && ageMs < STALE_THRESHOLD_MS && samePoint) {
                log.info(`Fresh current report for "${location}" — skipping duplicate fetch`);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Fresh current report, skipping duplicate fetch',
                    level: 'info',
                    data: { ageMinutes: Math.round(ageMs / 60000) },
                });
                this.cb.setLoading(false);
                this.cb.setBackgroundUpdating(false);
                return;
            }
        }

        addBreadcrumb({
            category: 'weather',
            message: 'Weather fetch requested',
            level: 'info',
            data: { force, silent, hasCoords: !!coords },
        });

        // Prevent concurrent fetches
        if (this.cb.getIsFetching() && !force) {
            addBreadcrumb({
                category: 'weather',
                message: 'Preventing concurrent fetch',
                level: 'info',
                data: { force },
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
        if (this.cb.getIsOffline()) {
            this.clearOfflineSchedule();
            addBreadcrumb({ category: 'weather', message: 'Offline mode detected', level: 'warning' });
            const historyCache = this.cb.getHistoryCache();
            const currentData = this.cb.getWeatherData();
            const cachedForPoint = findWeatherHistoryReport(historyCache, location, coords);
            const currentMatchesPoint = weatherReportMatchesRequest(currentData, location, coords);
            if (cachedForPoint) {
                this.cb.setWeatherData(cachedForPoint);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Serving from history cache in offline mode',
                    level: 'info',
                    data: { cached: true },
                });
            } else if (!currentMatchesPoint) {
                // Never leave another location's tactical numbers on screen
                // under the newly requested place while offline.
                if (coords || !currentData) this.cb.setWeatherData(null);
                this.cb.setError('Offline Mode: No Data');
                addBreadcrumb({
                    category: 'weather',
                    message: 'No data available in offline mode',
                    level: 'error',
                    data: { cached: false },
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
        const cachedForPoint = findWeatherHistoryReport(historyCache, location, coords);

        // Cache hit?
        let isServingFromCache = false;
        if (!currentData && cachedForPoint && !force) {
            this.cb.setWeatherData(cachedForPoint);
            isServingFromCache = true;
            addBreadcrumb({
                category: 'weather',
                message: 'Serving requested location from history cache',
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
                    data: { source: 'device-gps' },
                });
            } else if (coords) {
                resolved = { name: location, coords };
                addBreadcrumb({
                    category: 'weather',
                    message: 'Resolved location using provided explicit coords',
                    level: 'info',
                    data: { source: 'explicit-coordinates' },
                });
            } else {
                resolved = await this.resolveLocation(location, undefined, fetchEpoch);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Resolved location from name',
                    level: 'info',
                    data: { source: 'location-name' },
                });
            }
            this.assertCurrent(fetchEpoch);

            if (!resolved.coords) {
                addBreadcrumb({
                    category: 'weather',
                    message: 'Requested location has no coordinates',
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
                    data: { coordinatesLocked: true },
                });
            }

            if (currentReport) {
                this.cb.setWeatherData(currentReport);
                const historyKey = currentReport.coordinates
                    ? weatherHistoryKeyForCoordinates(currentReport.coordinates)
                    : null;
                if (historyKey) this.cb.setHistoryCache((prev) => recordWeatherHistoryReport(prev, currentReport!));
                void saveLargeDataImmediate(this.cacheKeys.data, currentReport);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Weather data updated and cached',
                    level: 'info',
                    data: { generatedAt: currentReport.generatedAt },
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
                void this.scheduleNextAndEnrich(currentReport, settings, force, fetchEpoch).catch((e) => {
                    if (!this.isStaleOperation(e)) log.warn('scheduleNextAndEnrich (post-render):', e);
                });
            }
        } catch (err: unknown) {
            if (!this.isFetchCurrent(fetchEpoch) || this.isStaleOperation(err)) return;
            const currentData2 = this.cb.getWeatherData();
            const historyCache2 = this.cb.getHistoryCache();
            const safeOfflineHistory = findWeatherHistoryReport(historyCache2, location, coords);
            const safeOfflineCurrent = weatherReportMatchesRequest(currentData2, location, coords);
            if (this.cb.getIsOffline() && (safeOfflineCurrent || safeOfflineHistory)) {
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
            if (err instanceof Error && !this.cb.getIsOffline()) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                captureException(err, { tags: { operation: 'fetchWeather' } } as any);
            }

            if (this.cb.getIsOffline()) {
                this.clearOfflineSchedule();
            } else {
                // Only advertise a retry when the WAN probe says a provider
                // request has a chance of running.
                const retryTs = Date.now() + 2 * 60 * 1000;
                this.cb.setNextUpdate(retryTs);
                localStorage.setItem(this.cacheKeys.nextUpdate, retryTs.toString());
                addBreadcrumb({
                    category: 'weather',
                    message: 'Rescheduling weather fetch after error',
                    level: 'info',
                    data: { retryTime: new Date(retryTs).toISOString() },
                });
            }
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
        let premium = false; // entitlement failures must never unlock paid providers
        try {
            premium = await isPremiumUser();
        } catch {
            // Basic weather remains available; only the paid-provider fallback
            // stays locked until this identity is verified.
            log.warn('Subscription check failed, keeping standard weather pipeline');
        }
        this.assertCurrent(fetchEpoch);
        if (this.cb.getIsOffline()) throw new Error('Offline mode detected before weather provider request');

        try {
            const report = await fetchWeatherByStrategy(lat, lon, name, undefined);
            this.assertCurrent(fetchEpoch);
            this.cb.incrementQuota();
            return report;
        } catch (e: unknown) {
            this.assertCurrent(fetchEpoch);
            if (this.isStaleOperation(e)) throw e;
            if (this.cb.getIsOffline()) throw e;
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
        settings: Record<string, unknown>,
        force: boolean,
        fetchEpoch: number,
    ): Promise<void> {
        this.assertCurrent(fetchEpoch);
        if (this.cb.getIsOffline()) {
            this.clearOfflineSchedule();
            return;
        }
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
                if (this.cb.getIsOffline()) {
                    this.clearOfflineSchedule();
                    return;
                }
                const enriched = await enrichMarineWeather(
                    report,
                    settings.vessel as VesselProfile | undefined,
                    settings.units as UnitPreferences | undefined,
                    settings.vesselUnits as VesselDimensionUnits | undefined,
                    settings.aiPersona as number | undefined,
                );
                this.assertCurrent(fetchEpoch);
                if (this.cb.getIsOffline()) {
                    this.clearOfflineSchedule();
                    return;
                }
                this.cb.setWeatherData(enriched);
                const historyKey = enriched.coordinates ? weatherHistoryKeyForCoordinates(enriched.coordinates) : null;
                if (historyKey) this.cb.setHistoryCache((prev) => recordWeatherHistoryReport(prev, enriched));
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
        if (!this.isCurrentIdentity() || this.cb.getIsOffline()) return;
        const liveMetricsEpoch = ++this.liveMetricsEpoch;
        const report = this.cb.getWeatherData();
        if (!report?.coordinates) return;
        if (report.locationType === 'offshore') return;

        const { lat, lon } = report.coordinates;
        try {
            const obs = await fetchWeatherKitRealtime(lat, lon);
            if (!this.isCurrentIdentity() || this.cb.getIsOffline() || liveMetricsEpoch !== this.liveMetricsEpoch)
                return;
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
            if (this.isCurrentIdentity() && !this.cb.getIsOffline() && liveMetricsEpoch === this.liveMetricsEpoch) {
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
        if (!this.isCurrentIdentity() || this.cb.getIsOffline()) return;
        const adviceEpoch = ++this.adviceEpoch;
        const currentData = this.cb.getWeatherData();
        const settings = this.cb.getSettings();
        if (!currentData) return;

        this.cb.setBackgroundUpdating(true);
        try {
            const { enrichMarineWeather } = await import('./geminiService');
            if (!this.isCurrentIdentity() || this.cb.getIsOffline() || adviceEpoch !== this.adviceEpoch) return;
            const enriched = await enrichMarineWeather(
                currentData,
                settings.vessel,
                settings.units,
                settings.vesselUnits,
                settings.aiPersona,
            );
            if (!this.isCurrentIdentity() || this.cb.getIsOffline() || adviceEpoch !== this.adviceEpoch) return;
            const stillCurrent = this.cb.getWeatherData();
            if (
                stillCurrent?.generatedAt !== currentData.generatedAt ||
                stillCurrent.locationName !== currentData.locationName
            ) {
                return;
            }
            this.cb.setWeatherData(enriched);
            void saveLargeDataImmediate(this.cacheKeys.data, enriched);
            const historyKey = enriched.coordinates ? weatherHistoryKeyForCoordinates(enriched.coordinates) : null;
            if (historyKey) this.cb.setHistoryCache((prev) => recordWeatherHistoryReport(prev, enriched));
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
