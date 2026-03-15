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

import { MarineWeatherReport, VoyagePlan } from '../types';
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
        console.info('[WeatherOrchestrator] Version check starting...');
        try {
            const ver = await readCacheVersion();
            console.info(`[WeatherOrchestrator] Cached version: ${ver}, expected: ${CACHE_VERSION}`);
            if (ver !== CACHE_VERSION) {
                console.info('[WeatherOrchestrator] Version mismatch — clearing caches');
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
            console.warn('[WeatherOrchestrator] Version check failed:', e);
        } finally {
            this.cb.setVersionChecked(true);
            console.info('[WeatherOrchestrator] Version check complete');
        }
    }

    // ── Synchronous Cache Pre-read ─────────────────────────────

    loadInstantCache(): MarineWeatherReport | null {
        const syncCached = loadLargeDataSync(DATA_CACHE_KEY) as MarineWeatherReport | null;
        if (syncCached && syncCached.locationName) {
            console.info(`[WeatherOrchestrator] Instant display: ${syncCached.locationName}`);
            return syncCached;
        }
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
            keysToDelete.forEach((key) => localStorage.removeItem(key));

            // Load cached weather data
            console.info('[WeatherOrchestrator] Loading cached weather data...');
            const cached = await loadLargeData(DATA_CACHE_KEY);
            if (cached && cached.locationName) {
                console.info(
                    `[WeatherOrchestrator] Cache HIT: ${cached.locationName} (generated: ${cached.generatedAt})`,
                );
                this.cb.setWeatherData(cached);
                this.cb.setLoading(false);
                hasCachedData = true;
            } else {
                console.info('[WeatherOrchestrator] Cache MISS: no cached weather data');
            }

            // Load history
            const h = await loadLargeData(HISTORY_CACHE_KEY);
            if (h) this.cb.setHistoryCache(() => h);
            else this.cb.setHistoryCache(() => ({}));
        } catch (e) {
            console.warn('[WeatherOrchestrator] Cache load failed:', e);
            this.cb.setLoading(false);
        } finally {
            this.triggerInitialFetch(hasCachedData);
        }
    }

    private triggerInitialFetch(hasCachedData: boolean): void {
        const settings = this.cb.getSettings();
        if (!settings.defaultLocation) {
            console.info('[WeatherOrchestrator] No default location set');
            this.cb.setLoading(false);
            return;
        }

        const loc = settings.defaultLocation;
        console.info(`[WeatherOrchestrator] Default location: "${loc}"`);

        // Staleness check
        const currentData = this.cb.getWeatherData();
        const cachedAge = currentData?.generatedAt
            ? Date.now() - new Date(currentData.generatedAt).getTime()
            : Infinity;

        if (hasCachedData && cachedAge < STALE_THRESHOLD_MS) {
            console.info(`[WeatherOrchestrator] Cache fresh (${Math.round(cachedAge / 60000)}m old) — skipping fetch`);
            this.cb.setLoading(false);
            return;
        }

        if (hasCachedData && cachedAge >= STALE_THRESHOLD_MS) {
            console.info(
                `[WeatherOrchestrator] Cache stale (${Math.round(cachedAge / 60000)}m old) — blur + background refresh`,
            );
            this.cb.setStaleRefresh(true);
        }

        // Handle GPS-based "Current Location"
        if (loc === 'Current Location') {
            if (!hasCachedData) this.cb.setLoadingMessage('Getting GPS Location...');
            console.info('[WeatherOrchestrator] Requesting GPS position...');
            GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 10 }).then((pos) => {
                if (pos) {
                    console.info(`[WeatherOrchestrator] GPS: ${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)}`);
                    this.fetchWeather(loc, {
                        force: !hasCachedData,
                        coords: { lat: pos.latitude, lon: pos.longitude },
                        showOverlay: false,
                        silent: hasCachedData,
                    });
                } else {
                    console.warn('[WeatherOrchestrator] GPS returned null');
                    if (!hasCachedData) {
                        this.cb.setError('Unable to get GPS location. Please select a location.');
                        this.cb.setLoading(false);
                    }
                }
            });
        } else {
            console.info(`[WeatherOrchestrator] Named location: "${loc}" — scheduling fetch`);
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
        let resolvedLocation = location;
        let resolvedCoords = coords;
        let resolvedTimezone: string | undefined;

        // If no coords provided, resolve from location name
        if (!resolvedCoords) {
            if (location === 'Current Location') {
                this.cb.setLoadingMessage('Getting GPS Location...');
                const pos = await GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 15 });
                if (pos) {
                    return {
                        name: location,
                        coords: { lat: pos.latitude, lon: pos.longitude },
                    };
                }
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
                }
            } catch {
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
                } else {
                    resolvedLocation = this.formatCoords(resolvedCoords);
                }
            } catch {
                resolvedLocation = this.formatCoords(resolvedCoords);
            }
        }

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

        // Prevent concurrent fetches
        if (this.cb.getIsFetching() && !force) return;
        this.cb.setIsFetching(true);

        // Offline check
        if (!navigator.onLine) {
            const historyCache = this.cb.getHistoryCache();
            const currentData = this.cb.getWeatherData();
            if (historyCache[location]) {
                this.cb.setWeatherData(historyCache[location]);
            } else if (!currentData) {
                this.cb.setError('Offline Mode: No Data');
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
        }

        const isBackground = isServingFromCache || !!currentData || silent;
        if (!isBackground) {
            this.cb.setLoading(true);
            this.cb.setLoadingMessage('Fetching Weather Data...');
        } else {
            this.cb.setBackgroundUpdating(true);
        }
        this.cb.setError(null);

        try {
            // Resolve location + coordinates
            let resolved: ResolvedLocation;
            if (coords && location === 'Current Location') {
                // GPS coords already provided — just need reverse geocode
                resolved = await this.resolveLocation(location, coords);
            } else if (coords) {
                resolved = { name: location, coords };
            } else {
                resolved = await this.resolveLocation(location);
            }

            if (!resolved.coords) {
                throw new Error(`Cannot fetch weather for ${resolved.name}: Missing Coordinates`);
            }

            // Fetch weather via strategy orchestrator
            let currentReport = await this.fetchFromStrategy(resolved.coords.lat, resolved.coords.lon, resolved.name);

            // Lock coords if provided explicitly
            if (coords && currentReport) {
                currentReport = { ...currentReport, coordinates: coords };
            }

            if (currentReport) {
                this.cb.setWeatherData(currentReport);
                this.cb.setHistoryCache((prev) => ({ ...prev, [location]: currentReport! }));
                saveLargeDataImmediate(DATA_CACHE_KEY, currentReport);
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
            } else {
                if (!currentData2) this.cb.setError(getErrorMessage(err) || 'Weather Unavailable');
            }
            this.cb.setLoading(false);

            // Reschedule on failure
            const retryTs = Date.now() + 2 * 60 * 1000;
            this.cb.setNextUpdate(retryTs);
            localStorage.setItem('thalassa_next_update', retryTs.toString());
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
        settings: any,
        force: boolean,
    ): Promise<void> {
        const locationType = report.locationType || 'coastal';
        const isCurrentLoc = this.cb.getLocationMode() === 'gps';
        const interval = getUpdateInterval(locationType, report, isCurrentLoc, settings.satelliteMode);
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
                    settings.vessel,
                    settings.units,
                    settings.vesselUnits,
                    settings.aiPersona,
                );
                this.cb.setWeatherData(enriched);
                this.cb.setHistoryCache((prev) => ({ ...prev, [location]: enriched }));
                saveLargeDataImmediate(DATA_CACHE_KEY, enriched);
            } catch (e) {
                console.warn('[WeatherOrchestrator] AI enrichment non-critical:', e);
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
            console.warn('[WeatherOrchestrator] Live metrics patch failed:', e);
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
