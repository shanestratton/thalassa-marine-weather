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
import { MarineWeatherReport, VoyagePlan, VesselProfile, UnitPreferences, VesselDimensionUnits } from '../types';
import { fetchPrecisionWeather, fetchWeatherByStrategy, parseLocation, reverseGeocode } from './weatherService';
import { fetchWeatherKitRealtime } from './weather/api/weatherkit';
import { isStormglassKeyPresent } from './weather/keys';
import { degreesToCardinal } from '../utils';
import { EnvironmentService } from './EnvironmentService';
import { getErrorMessage } from '../utils/logger';
import { GpsService } from './GpsService';
import {
    saveLargeData,
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
const log = createLogger('WxOrch');

// ── Types ──────────────────────────────────────────────────────

export const CACHE_VERSION = 'v19.2-WEATHERKIT-FIX';
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

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
    getSettings: () => any;
    getHistoryCache: () => Record<string, MarineWeatherReport>;
    getLocationMode: () => 'gps' | 'selected';
    getIsFetching: () => boolean;
    setIsFetching: (v: boolean) => void;
}

// ── Service ────────────────────────────────────────────────────

export class WeatherOrchestrator {
    private cb: OrchestratorCallbacks;

    constructor(callbacks: OrchestratorCallbacks) {
        this.cb = callbacks;
    }

    // ── Cache Version Check ────────────────────────────────────

    async checkCacheVersion(): Promise<void> {
        log.info('Version check starting...');
        addBreadcrumb({ category: 'weather', message: 'Cache version check', level: 'info' });
        try {
            const ver = await readCacheVersion();
            log.info(`Cached version: ${ver}, expected: ${CACHE_VERSION}`);
            if (ver !== CACHE_VERSION) {
                log.info('Version mismatch — clearing caches');
                addBreadcrumb({
                    category: 'weather',
                    message: 'Cache version mismatch, clearing caches',
                    level: 'warning',
                    data: { cachedVersion: ver, expectedVersion: CACHE_VERSION },
                });
                deleteLargeData(DATA_CACHE_KEY);
                deleteLargeData(HISTORY_CACHE_KEY);
                deleteLargeData(VOYAGE_CACHE_KEY);
                localStorage.removeItem(DATA_CACHE_KEY);
                await writeCacheVersion(CACHE_VERSION);
                this.cb.setWeatherData(null);
                this.cb.setHistoryCache(() => ({}));
            } else {
                const cachedNextUpdate = localStorage.getItem('thalassa_next_update');
                if (cachedNextUpdate) {
                    const nu = parseInt(cachedNextUpdate);
                    if (nu > Date.now()) this.cb.setNextUpdate(nu);
                }
            }
        } catch (e) {
            log.warn('Version check failed:', e);
            captureException(e, { tags: { operation: 'checkCacheVersion' } } as any);
        } finally {
            this.cb.setVersionChecked(true);
            log.info('Version check complete');
        }
    }

    // ── Synchronous Cache Pre-read ─────────────────────────────

    loadInstantCache(): MarineWeatherReport | null {
        const syncCached = loadLargeDataSync(DATA_CACHE_KEY) as MarineWeatherReport | null;
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

            // Load cached weather data
            log.info('Loading cached weather data...');
            addBreadcrumb({ category: 'weather', message: 'Loading cached weather data', level: 'info' });
            const cached = await loadLargeData(DATA_CACHE_KEY);
            if (cached && cached.locationName) {
                console.info(
                    `[WeatherOrchestrator] Cache HIT: ${cached.locationName} (generated: ${cached.generatedAt})`,
                );
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
            const h = await loadLargeData(HISTORY_CACHE_KEY);
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
            log.warn('Cache load failed:', e);
            addBreadcrumb({
                category: 'weather',
                message: 'Cache load failed',
                level: 'error',
                data: { error: getErrorMessage(e) },
            });
            captureException(e, { tags: { operation: 'loadCacheAndInit' } } as any);
            this.cb.setLoading(false);
        } finally {
            this.triggerInitialFetch(hasCachedData);
        }
    }

    private triggerInitialFetch(hasCachedData: boolean): void {
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
            console.info(
                `[WeatherOrchestrator] Cache stale (${Math.round(cachedAge / 60000)}m old) — blur + background refresh`,
            );
            addBreadcrumb({
                category: 'weather',
                message: 'Cache stale, background refresh',
                level: 'info',
                data: { ageMinutes: Math.round(cachedAge / 60000) },
            });
            this.cb.setStaleRefresh(true);
        }

        // Handle GPS-based "Current Location"
        if (loc === 'Current Location') {
            if (!hasCachedData) this.cb.setLoadingMessage('Getting GPS Location...');
            log.info('Requesting GPS position...');
            addBreadcrumb({ category: 'weather', message: 'Requesting GPS position', level: 'info' });
            GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 10 }).then((pos) => {
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
                        this.cb.setError('Unable to get GPS location. Please select a location.');
                        this.cb.setLoading(false);
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
            setTimeout(() => {
                this.fetchWeather(loc, {
                    force: !hasCachedData,
                    showOverlay: false,
                    silent: hasCachedData,
                });
            }, 100);
        }
    }

    // ── Location Resolution ────────────────────────────────────

    async resolveLocation(location: string, coords?: Coords): Promise<ResolvedLocation> {
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
                throw new Error('Unable to get GPS location. Please select a location or enable location services.');
            }

            try {
                const parsed = await parseLocation(location);
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
        return { name: resolvedLocation, coords: resolvedCoords, timezone: resolvedTimezone };
    }

    private formatCoords(coords: Coords): string {
        const latStr = Math.abs(coords.lat).toFixed(2) + '°' + (coords.lat >= 0 ? 'N' : 'S');
        const lonStr = Math.abs(coords.lon).toFixed(2) + '°' + (coords.lon >= 0 ? 'E' : 'W');
        return `${latStr}, ${lonStr}`;
    }

    // ── Core Fetch ─────────────────────────────────────────────

    async fetchWeather(location: string, options: FetchWeatherOptions = {}): Promise<void> {
        const { force = false, coords, showOverlay = false, silent = false } = options;

        if (!location) return;

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
            this.cb.setLoading(false);
            this.cb.setIsFetching(false);
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
                resolved = await this.resolveLocation(location, coords);
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
                resolved = await this.resolveLocation(location);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Resolved location from name',
                    level: 'info',
                    data: { location },
                });
            }

            if (!resolved.coords) {
                addBreadcrumb({
                    category: 'weather',
                    message: `Missing coordinates for ${resolved.name}`,
                    level: 'error',
                });
                throw new Error(`Cannot fetch weather for ${resolved.name}: Missing Coordinates`);
            }

            // Fetch weather via strategy orchestrator
            let currentReport = await this.fetchFromStrategy(resolved.coords.lat, resolved.coords.lon, resolved.name);
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
                saveLargeDataImmediate(DATA_CACHE_KEY, currentReport);
                addBreadcrumb({
                    category: 'weather',
                    message: 'Weather data updated and cached',
                    level: 'info',
                    data: { location: currentReport.locationName, generatedAt: currentReport.generatedAt },
                });
                if (!isBackground) this.cb.setLoading(false);
            }

            // Schedule next update + AI enrichment
            if (currentReport) {
                await this.scheduleNextAndEnrich(currentReport, location, settings, force);
            }
        } catch (err: unknown) {
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
                if (!currentData2) this.cb.setError(getErrorMessage(err) || 'Weather Unavailable');
                addBreadcrumb({
                    category: 'weather',
                    message: 'Fetch failed, no fallback',
                    level: 'error',
                    data: { error: getErrorMessage(err) },
                });
            }
            this.cb.setLoading(false);

            // Report fetch failures to Sentry
            if (err instanceof Error) {
                captureException(err, { tags: { operation: 'fetchWeather', location } } as any);
            }

            // Reschedule on failure
            const retryTs = Date.now() + 2 * 60 * 1000;
            this.cb.setNextUpdate(retryTs);
            localStorage.setItem('thalassa_next_update', retryTs.toString());
            addBreadcrumb({
                category: 'weather',
                message: `Rescheduling fetch due to error for ${location}`,
                level: 'info',
                data: { retryTime: new Date(retryTs).toISOString() },
            });
        } finally {
            this.cb.setIsFetching(false);
            this.cb.setBackgroundUpdating(false);
            this.cb.setStaleRefresh(false);
            this.cb.setLoading(false);
        }
    }

    private async fetchFromStrategy(lat: number, lon: number, name: string): Promise<MarineWeatherReport | null> {
        try {
            const report = await fetchWeatherByStrategy(lat, lon, name, undefined);
            this.cb.incrementQuota();
            return report;
        } catch (e: unknown) {
            // Fallback to legacy StormGlass-only
            if (isStormglassKeyPresent()) {
                try {
                    const report = await fetchPrecisionWeather(name, { lat, lon }, false, undefined);
                    this.cb.incrementQuota();
                    return report;
                } catch {
                    throw e;
                }
            }
            throw e;
        }
    }

    private async scheduleNextAndEnrich(
        report: MarineWeatherReport,
        location: string,
        settings: Record<string, unknown>,
        force: boolean,
    ): Promise<void> {
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
        localStorage.setItem('thalassa_next_update', nextTs.toString());

        // AI enrichment
        const currentData = this.cb.getWeatherData();
        const lastAI = currentData?.aiGeneratedAt ? new Date(currentData.aiGeneratedAt).getTime() : 0;
        const timeExpired = Date.now() - lastAI > AI_UPDATE_INTERVAL;
        const locationChanged = currentData?.locationName !== report.locationName;

        if (timeExpired || force || locationChanged || !currentData?.boatingAdvice) {
            try {
                const { enrichMarineWeather } = await import('./geminiService');
                const enriched = await enrichMarineWeather(
                    report,
                    settings.vessel as VesselProfile | undefined,
                    settings.units as UnitPreferences | undefined,
                    settings.vesselUnits as VesselDimensionUnits | undefined,
                    settings.aiPersona as number | undefined,
                );
                this.cb.setWeatherData(enriched);
                this.cb.setHistoryCache((prev) => ({ ...prev, [location]: enriched }));
                saveLargeDataImmediate(DATA_CACHE_KEY, enriched);
            } catch (e) {
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
                this.cb.setWeatherData(withAdvice);
                saveLargeDataImmediate(DATA_CACHE_KEY, withAdvice);
            }
        }
    }

    // ── Live Metrics Patch (WeatherKit Realtime) ───────────────

    async patchLiveMetrics(): Promise<void> {
        const report = this.cb.getWeatherData();
        if (!report?.coordinates) return;
        if (report.locationType === 'offshore') return;

        const { lat, lon } = report.coordinates;
        try {
            const obs = await fetchWeatherKitRealtime(lat, lon);
            if (!obs || obs.temperature === null) return;

            const current = this.cb.getWeatherData();
            if (!current) return;

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
            this.cb.setWeatherData({ ...current, current: patched });
        } catch (e) {
            log.warn('Live metrics patch failed:', e);
        }
    }

    // ── AI Enrichment ──────────────────────────────────────────

    async regenerateAdvice(): Promise<void> {
        const currentData = this.cb.getWeatherData();
        const settings = this.cb.getSettings();
        if (!currentData) return;

        this.cb.setBackgroundUpdating(true);
        try {
            const { enrichMarineWeather } = await import('./geminiService');
            const enriched = await enrichMarineWeather(
                currentData,
                settings.vessel,
                settings.units,
                settings.vesselUnits,
                settings.aiPersona,
            );
            this.cb.setWeatherData(enriched);
            saveLargeDataImmediate(DATA_CACHE_KEY, enriched);
            if (enriched.locationName) {
                this.cb.setHistoryCache((prev) => ({ ...prev, [enriched.locationName]: enriched }));
            }
        } catch {
            // Non-critical
        } finally {
            this.cb.setBackgroundUpdating(false);
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
