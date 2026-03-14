
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { MarineWeatherReport, VoyagePlan, DebugInfo } from '../types';
// geminiService dynamically imported to avoid bundling @google/generative-ai (158KB) in main chunk
import { fetchFastWeather, fetchPrecisionWeather, fetchWeatherByStrategy, parseLocation, reverseGeocode } from '../services/weatherService';
import { fetchWeatherKitRealtime } from '../services/weather/api/weatherkit';
import { isStormglassKeyPresent } from '../services/weather/keys';
import { useSettings, DEFAULT_SETTINGS } from './SettingsContext';
import { calculateDistance, degreesToCardinal } from '../utils';
import { EnvironmentService } from '../services/EnvironmentService';
import { getErrorMessage } from '../utils/logger';
import { toast } from '../components/Toast';
import { GpsService } from '../services/GpsService';
import { LocationStore } from '../stores/LocationStore';

import { saveLargeData, saveLargeDataImmediate, loadLargeData, loadLargeDataSync, deleteLargeData, readCacheVersion, writeCacheVersion, DATA_CACHE_KEY, VOYAGE_CACHE_KEY, HISTORY_CACHE_KEY } from '../services/nativeStorage';

const CACHE_VERSION = 'v19.2-WEATHERKIT-FIX';

// Scheduling logic extracted to WeatherScheduler service
import {
    isBadWeather,
    getUpdateInterval,
    alignToNextInterval,
    INLAND_INTERVAL,
    COASTAL_INTERVAL,
    BAD_WEATHER_INTERVAL,
    SATELLITE_INTERVAL,
    AI_UPDATE_INTERVAL,
    LIVE_OVERLAY_INTERVAL,
} from '../services/WeatherScheduler';

interface WeatherContextType {
    weatherData: MarineWeatherReport | null;
    voyagePlan: VoyagePlan | null;
    loading: boolean;
    loadingMessage: string;
    error: string | null;
    debugInfo: DebugInfo | null;
    quotaUsed: number;
    backgroundUpdating: boolean;
    staleRefresh: boolean;
    nextUpdate: number | null;
    fetchWeather: (location: string, force?: boolean, coords?: { lat: number, lon: number }, showOverlay?: boolean, silent?: boolean) => Promise<void>;
    selectLocation: (location: string, coords?: { lat: number, lon: number }) => Promise<void>;
    refreshData: (silent?: boolean) => void;
    saveVoyagePlan: (plan: VoyagePlan) => void; // Alias for handleSaveVoyagePlan
    handleSaveVoyagePlan: (plan: VoyagePlan) => void;
    clearVoyagePlan: () => void;
    incrementQuota: () => void;
    historyCache: Record<string, MarineWeatherReport>;
    setHistoryCache: React.Dispatch<React.SetStateAction<Record<string, MarineWeatherReport>>>;
}

const WeatherContext = createContext<WeatherContextType | undefined>(undefined);

export const WeatherProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { settings, updateSettings, loading: settingsLoading } = useSettings();

    const [loading, setLoading] = useState(true);
    const [loadingMessage, setLoadingMessage] = useState("Initializing Weather Data...");
    const [backgroundUpdating, setBackgroundUpdating] = useState(false);
    const [staleRefresh, setStaleRefresh] = useState(false);
    const [locationMode, setLocationMode] = useState<'gps' | 'selected'>('gps');
    const [error, setError] = useState<string | null>(null);
    const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
    const [quotaUsed, setQuotaUsed] = useState(0);
    const [nextUpdate, setNextUpdate] = useState<number | null>(null);
    const [versionChecked, setVersionChecked] = useState(false); // Gate: init waits for version check

    const [weatherData, _setWeatherData] = useState<MarineWeatherReport | null>(null);

    // Wrapper: every weather update also feeds the environment detection service
    const setWeatherData = useCallback((data: MarineWeatherReport | null) => {
        _setWeatherData(data);
        if (data) {
            EnvironmentService.updateFromWeatherData({
                locationType: data.locationType,
                isLandlocked: data.isLandlocked,
                elevation: '_elevation' in data ? (data as MarineWeatherReport & { _elevation?: number })._elevation : undefined,
            });
        }
    }, []);
    const [voyagePlan, setVoyagePlan] = useState<VoyagePlan | null>(null);

    // FILESYSTEM BACKED CACHE
    const [historyCache, setHistoryCache] = useState<Record<string, MarineWeatherReport>>({});

    const historyCacheRef = useRef<Record<string, MarineWeatherReport>>({});
    const weatherDataRef = useRef<MarineWeatherReport | null>(null);
    const settingsRef = useRef(settings);
    const isFirstRender = useRef(true);
    const isTrackingCurrentLocation = useRef(settings.defaultLocation === "Current Location");
    const isFetchingRef = useRef(false); // Prevent concurrent fetches
    const nextUpdateRef = useRef<number | null>(null); // Synced via effect below

    // Sync Refs
    useEffect(() => { weatherDataRef.current = weatherData; }, [weatherData]);
    useEffect(() => { settingsRef.current = settings; }, [settings]);
    useEffect(() => { historyCacheRef.current = historyCache; }, [historyCache]);

    const incrementQuota = useCallback(() => setQuotaUsed(p => p + 1), []);

    // --- INSTANT DISPLAY: Synchronous pre-read from localStorage ---
    // This fires BEFORE any async operations (version check, filesystem).
    // On iOS, this eliminates the 2-3s spinner caused by Capacitor bridge latency.
    // If localStorage was evicted, we fall through to the async filesystem load.
    useEffect(() => {
        const syncCached = loadLargeDataSync(DATA_CACHE_KEY) as MarineWeatherReport | null;
        if (syncCached && syncCached.locationName) {
            console.info(`[WeatherContext] Instant display: ${syncCached.locationName}`);
            setWeatherData(syncCached);
            setLoading(false);

            // Sync to LocationStore so the Map tab centers on the user's WX location
            // instead of the hardcoded Brisbane default
            const coords = syncCached.coordinates;
            if (coords && (coords.lat !== 0 || coords.lon !== 0)) {
                const locState = LocationStore.getState();
                if (locState.source === 'initial') {
                    LocationStore.setState({
                        lat: coords.lat,
                        lon: coords.lon,
                        name: syncCached.locationName,
                        source: 'search',
                    });
                }
            }
        }
    }, []);

    // --- CACHE VERSION CHECK (FILESYSTEM-BACKED) ---
    // Uses filesystem instead of localStorage to survive iOS localStorage eviction.
    // Without this, iOS clearing localStorage would nuke all valid filesystem caches.
    useEffect(() => {
        const checkVersion = async () => {
            console.info('[WeatherContext] Version check starting...');
            try {
                const ver = await readCacheVersion();
                console.info(`[WeatherContext] Cached version: ${ver}, expected: ${CACHE_VERSION}`);
                if (ver !== CACHE_VERSION) {
                    // Version mismatch — clear all caches and start fresh
                    console.info('[WeatherContext] Version mismatch — clearing caches');
                    deleteLargeData(DATA_CACHE_KEY);
                    deleteLargeData(HISTORY_CACHE_KEY);
                    deleteLargeData(VOYAGE_CACHE_KEY);

                    // Clean localStorage too just in case
                    localStorage.removeItem(DATA_CACHE_KEY);

                    await writeCacheVersion(CACHE_VERSION);
                    setWeatherData(null);
                    setHistoryCache({});
                } else {
                    // Restore nextUpdate
                    const cachedNextUpdate = localStorage.getItem('thalassa_next_update');
                    if (cachedNextUpdate) {
                        const nu = parseInt(cachedNextUpdate);
                        if (nu > Date.now()) setNextUpdate(nu);
                    }
                }
            } catch (e) {
                console.warn('[WeatherContext] Version check failed:', e);
            } finally {
                setVersionChecked(true);
                console.info('[WeatherContext] Version check complete');
            }
        };
        checkVersion();
    }, []);

    // --- INITIALIZATION (ASYNC LOAD) ---
    // STALE-WHILE-REVALIDATE: Show cached data instantly, refresh in background
    // Waits for both settings AND version check to complete before loading cache.
    useEffect(() => {
        // RACE CONDITION FIX: Wait for settings to finish loading
        if (settingsLoading) {
            return;
        }
        // RACE CONDITION FIX: Wait for version check to complete
        // Without this, init could load cache data that the version check then nukes.
        if (!versionChecked) {
            return;
        }

        console.info('[WeatherContext] Init starting (settings loaded, version checked)');

        const loadCache = async () => {
            let hasCachedData = false;

            try {
                // CLEAR LEGACY LOCALSTORAGE CACHE (one-time cleanup)
                const keysToDelete: string[] = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith('marine_weather_cache_')) {
                        keysToDelete.push(key);
                    }
                }
                keysToDelete.forEach(key => localStorage.removeItem(key));

                // 1. PRIMARY PATH: Load cached weather data for INSTANT display
                console.info('[WeatherContext] Loading cached weather data...');
                const cached = await loadLargeData(DATA_CACHE_KEY);
                if (cached && cached.locationName) {
                    console.info(`[WeatherContext] Cache HIT: ${cached.locationName} (generated: ${cached.generatedAt})`);
                    setWeatherData(cached);
                    setLoading(false); // UI renders INSTANTLY with stale data
                    hasCachedData = true;
                } else {
                    console.info('[WeatherContext] Cache MISS: no cached weather data');
                }

                // 2. SECONDARY PATH: History (Background)
                const h = await loadLargeData(HISTORY_CACHE_KEY);
                if (h) setHistoryCache(h);
                else setHistoryCache({});

            } catch (e) {
                console.warn('[WeatherContext] Cache load failed:', e);
                setLoading(false);
            } finally {
                // Trigger fetch for fresh data
                if (settingsRef.current.defaultLocation) {
                    const loc = settingsRef.current.defaultLocation;
                    console.info(`[WeatherContext] Default location: "${loc}"`);

                    // STALENESS CHECK: Skip fetch if cached data is recent (< 30 min)
                    const cachedAge = weatherDataRef.current?.generatedAt
                        ? Date.now() - new Date(weatherDataRef.current.generatedAt).getTime()
                        : Infinity;
                    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

                    if (hasCachedData && cachedAge < STALE_THRESHOLD_MS) {
                        console.info(`[WeatherContext] Cache fresh (${Math.round(cachedAge / 60000)}m old) — skipping fetch`);
                        setLoading(false);
                        return;
                    }

                    // BLUR ON STARTUP: If we have stale cached data, blur the dashboard
                    // so the punter doesn't act on outdated info while we fetch fresh data.
                    if (hasCachedData && cachedAge >= STALE_THRESHOLD_MS) {
                        console.info(`[WeatherContext] Cache stale (${Math.round(cachedAge / 60000)}m old) — blur + background refresh`);
                        setStaleRefresh(true);
                    }


                    // Handle GPS-based "Current Location" specially
                    if (loc === "Current Location") {
                        if (!hasCachedData) setLoadingMessage("Getting GPS Location...");
                        console.info('[WeatherContext] Requesting GPS position...');
                        GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 10 }).then((pos) => {
                            if (pos) {
                                console.info(`[WeatherContext] GPS: ${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)}`);
                                fetchWeather(loc, !hasCachedData, {
                                    lat: pos.latitude,
                                    lon: pos.longitude
                                }, false, hasCachedData);
                            } else {
                                console.warn('[WeatherContext] GPS returned null');
                                if (!hasCachedData) {
                                    setError("Unable to get GPS location. Please select a location.");
                                    setLoading(false);
                                }
                            }
                        });
                    } else {
                        // Named location
                        console.info(`[WeatherContext] Named location: "${loc}" — scheduling fetch`);
                        setLoading(false);
                        setTimeout(() => {
                            fetchWeather(loc, !hasCachedData, undefined, false, hasCachedData);
                        }, 100);
                    }
                } else {
                    // No default location - done loading
                    console.info('[WeatherContext] No default location set');
                    setLoading(false);
                }
            }
        };
        loadCache();
    }, [settingsLoading, versionChecked]);

    // --- PERSISTENCE (IMMEDIATE for primary cache) ---
    // Uses saveLargeDataImmediate to ensure data survives iOS app closure.
    // The debounced saveLargeData was causing data loss when the user swiped
    // the app closed before the 1-second setTimeout could fire.
    useEffect(() => {
        if (weatherData) {
            saveLargeDataImmediate(DATA_CACHE_KEY, weatherData);
        }
    }, [weatherData]);

    // Persist History
    useEffect(() => {
        if (Object.keys(historyCache).length > 0) {
            saveLargeData(HISTORY_CACHE_KEY, historyCache);
        }
    }, [historyCache]);

    const handleSaveVoyagePlan = useCallback((plan: VoyagePlan) => {
        setVoyagePlan(plan);
        // Transient: Do not save to disk
        // saveLargeData(VOYAGE_CACHE_KEY, plan);
    }, []);

    const clearVoyagePlan = useCallback(() => {
        setVoyagePlan(null);
        deleteLargeData(VOYAGE_CACHE_KEY);
    }, []);

    // --- HELPER: Regenerate Advice ---
    const regenerateAdvice = useCallback(async () => {
        const currentData = weatherDataRef.current;
        const currentSettings = settingsRef.current;
        if (!currentData) return;


        setBackgroundUpdating(true);
        try {
            const { enrichMarineWeather } = await import('../services/geminiService');
            const enriched = await enrichMarineWeather(
                currentData,
                currentSettings.vessel,
                currentSettings.units,
                currentSettings.vesselUnits,
                currentSettings.aiPersona
            );
            setWeatherData(enriched);
            saveLargeDataImmediate(DATA_CACHE_KEY, enriched);
            // Also update history
            if (enriched.locationName) {
                setHistoryCache(prev => ({ ...prev, [enriched.locationName]: enriched }));
            }
        } catch (e) {
        } finally {
            setBackgroundUpdating(false);
        }
    }, []);

    // --- FETCH WEATHER ---
    const fetchWeather = useCallback(async (location: string, force = false, coords?: { lat: number, lon: number }, showOverlay = false, silent = false) => {
        if (!location) return;

        // Prevent concurrent fetches
        if (isFetchingRef.current && !force) {
            return;
        }
        isFetchingRef.current = true;

        // OFFLINE CHECK
        if (!navigator.onLine) {
            if (historyCacheRef.current[location]) { setWeatherData(historyCacheRef.current[location]); }
            else if (!weatherDataRef.current) setError("Offline Mode: No Data");
            setLoading(false);
            isFetchingRef.current = false;
            return;
        }

        const currentSettings = settingsRef.current;

        // CACHE HIT?
        let isServingFromCache = false;
        if (!weatherDataRef.current && historyCacheRef.current[location] && !force) {
            setWeatherData(historyCacheRef.current[location]);
            isServingFromCache = true;
        }

        const isBackground = isServingFromCache || !!weatherDataRef.current || silent;
        if (!isBackground) {
            setLoading(true);
            setLoadingMessage("Fetching Weather Data...");
        }
        else setBackgroundUpdating(true);
        setError(null);

        try {
            const useStormglass = isStormglassKeyPresent();

            // 0. PRE-FLIGHT: RESOLVE COORDINATES (Crucial for Parallel Fetching)
            let resolvedLocation = location;
            let resolvedCoords = coords;
            let resolvedTimezone: string | undefined;

            // If we don't have coords (e.g. from Favorites string), resolve them NOW 
            // so we can fire the Fast Airport Fetch immediately.
            if (!resolvedCoords) {
                // SPECIAL CASE: "Current Location" requires GPS coordinates
                // If coords weren't provided, we can't proceed - need to trigger GPS
                if (location === "Current Location") {
                    setLoadingMessage("Getting GPS Location...");

                    const pos = await GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 15 });
                    if (pos) {
                        return fetchWeather(location, force, {
                            lat: pos.latitude,
                            lon: pos.longitude
                        }, showOverlay, silent);
                    } else {
                        setError("Unable to get GPS location. Please select a location or enable location services.");
                        setLoading(false);
                        return;
                    }
                }

                try {
                    const parsed = await parseLocation(location);
                    // 0,0 check if invalid
                    if (parsed.lat !== 0 || parsed.lon !== 0) {
                        resolvedCoords = { lat: parsed.lat, lon: parsed.lon };
                        // Use the friendly name if available and better
                        if (parsed.name && parsed.name !== location && parsed.name !== "Invalid Location") {
                            resolvedLocation = parsed.name;
                        }
                        if (parsed.timezone) resolvedTimezone = parsed.timezone;
                    }
                } catch (e) {
                    // We continue, but fetchFastWeather will likely fail too or handle it
                }
            }
            // IF Coords exist but Location is generic ("Current Location" or "0,0") OR looks like raw coords, Reverse Geocode immediately
            // This ensures GPS injections get a friendly name (e.g. "Townsville") instead of "WP ..."
            if (resolvedCoords && (
                location === "Current Location" ||
                location === "0,0" ||
                location === "0, 0" ||
                location.startsWith("WP ") ||
                /^-?\d/.test(location)  // Starts with digit or minus
            )) {
                try {
                    const name = await reverseGeocode(resolvedCoords.lat, resolvedCoords.lon);
                    if (name) {
                        resolvedLocation = name;
                    } else {
                        // Fallback: If Geocoding fails (e.g. Deep Ocean), use nice Coordinate string
                        // instead of "Current Location"
                        const latStr = Math.abs(resolvedCoords.lat).toFixed(2) + '°' + (resolvedCoords.lat >= 0 ? 'N' : 'S');
                        const lonStr = Math.abs(resolvedCoords.lon).toFixed(2) + '°' + (resolvedCoords.lon >= 0 ? 'E' : 'W');
                        resolvedLocation = `${latStr}, ${lonStr}`;
                    }
                } catch (e) {
                    // Fallback on error too
                    const latStr = Math.abs(resolvedCoords.lat).toFixed(2) + '°' + (resolvedCoords.lat >= 0 ? 'N' : 'S');
                    const lonStr = Math.abs(resolvedCoords.lon).toFixed(2) + '°' + (resolvedCoords.lon >= 0 ? 'E' : 'W');
                    resolvedLocation = `${latStr}, ${lonStr}`;
                }
            }

            // --- LOCATION-TYPE-AWARE API STRATEGY ---
            let currentReport: MarineWeatherReport | null = null;

            if (!resolvedCoords) {
                throw new Error(`Cannot fetch weather for ${resolvedLocation}: Missing Coordinates`);
            }

            try {
                // Use the new strategy-based orchestrator:
                // Tier 2 (Inland/Coastal ≤20nm): WeatherKit atmo + StormGlass marine
                // Tier 3 (Offshore >20nm): StormGlass 100%
                // Forecast backbone: Open-Meteo (all locations)
                currentReport = await fetchWeatherByStrategy(
                    resolvedCoords.lat,
                    resolvedCoords.lon,
                    resolvedLocation,
                    // NOTE: Do NOT pass weatherDataRef.current?.locationType here.
                    // It creates a self-perpetuating cycle where a stale 'offshore' from
                    // cache prevents all future fetches from reclassifying correctly.
                    undefined
                );
                incrementQuota();
            } catch (e: unknown) {
                // Strategy failed — try legacy StormGlass-only as final fallback
                if (isStormglassKeyPresent()) {
                    try {
                        currentReport = await fetchPrecisionWeather(
                            resolvedLocation,
                            resolvedCoords,
                            false,
                            undefined
                        );
                        incrementQuota();
                    } catch (e) {
                        console.warn('[WeatherContext]', e);
                        throw e; // Original error if fallback also fails
                    }
                } else {
                    throw e;
                }
            }

            // COORD LOCK & FINAL RENDER (immutable)
            if (coords && currentReport) {
                currentReport = { ...currentReport, coordinates: coords };
            }

            // BEACON ENHANCEMENT — DISABLED
            // Buoy data was too unreliable. WeatherKit handles atmospheric data,
            // StormGlass handles marine data (waves, swell, water temp, currents).
            // if (currentReport && currentReport.coordinates) {
            //     currentReport = await enhanceWithBeaconData(currentReport, currentReport.coordinates);
            // }

            if (currentReport) {
                setWeatherData(currentReport);
                const validReport = currentReport;
                setHistoryCache(prev => ({ ...prev, [location]: validReport }));
                saveLargeDataImmediate(DATA_CACHE_KEY, validReport);
                if (!isBackground) setLoading(false);
            }

            // 5. CALCULATE NEXT UPDATE TIME using intelligent intervals
            if (currentReport) {
                const reportLocationType = currentReport.locationType || 'coastal';
                const isCurrentLoc = locationMode === 'gps';
                const interval = getUpdateInterval(reportLocationType, currentReport, isCurrentLoc, settingsRef.current.satelliteMode);
                const nextTs = alignToNextInterval(interval);

                setNextUpdate(nextTs);
                localStorage.setItem('thalassa_next_update', nextTs.toString());
                const now = Date.now();
                const lastAI = weatherDataRef.current?.aiGeneratedAt ? new Date(weatherDataRef.current.aiGeneratedAt).getTime() : 0;
                const timeExpired = (now - lastAI) > AI_UPDATE_INTERVAL;
                const locationChanged = weatherDataRef.current?.locationName !== currentReport.locationName;

                if (timeExpired || force || locationChanged || !weatherDataRef.current?.boatingAdvice) {
                    try {
                        const { enrichMarineWeather } = await import('../services/geminiService');
                        const enriched = await enrichMarineWeather(
                            currentReport,
                            currentSettings.vessel,
                            currentSettings.units,
                            currentSettings.vesselUnits,
                            currentSettings.aiPersona
                        );
                        setWeatherData(enriched);
                        setHistoryCache(prev => ({ ...prev, [location]: enriched }));
                        saveLargeDataImmediate(DATA_CACHE_KEY, enriched);
                    } catch (e) { console.warn('[WeatherContext] non-critical: previous weather data already set:', e); }
                } else {
                    if (weatherDataRef.current?.boatingAdvice) {
                        const reportWithAdvice = {
                            ...currentReport,
                            boatingAdvice: weatherDataRef.current.boatingAdvice,
                            aiGeneratedAt: weatherDataRef.current.aiGeneratedAt
                        };
                        setWeatherData(reportWithAdvice);
                        saveLargeDataImmediate(DATA_CACHE_KEY, reportWithAdvice);
                    }
                }
            }

        } catch (err: unknown) {
            if (!navigator.onLine && (weatherDataRef.current || historyCacheRef.current[location])) {
                // OK — offline fallback
            } else {
                if (!weatherDataRef.current) setError(getErrorMessage(err) || "Weather Unavailable");
            }
            setLoading(false);

            // FIX: ALWAYS reschedule nextUpdate on failure
            // Without this, the countdown hits 0 → shows "Updating..." → fetch fails → never recovers
            const retryInterval = 2 * 60 * 1000; // Retry in 2 minutes on failure
            const retryTs = Date.now() + retryInterval;
            setNextUpdate(retryTs);
            localStorage.setItem('thalassa_next_update', retryTs.toString());
        } finally {
            isFetchingRef.current = false; // Release fetch lock
            setBackgroundUpdating(false);
            setStaleRefresh(false); // Clear stale blur on EVERY fetch completion
            setLoading(false);
        }
    }, [incrementQuota]);

    // --- REFRESH / SELECT ---
    const refreshData = useCallback((silent = false) => {
        if (!navigator.onLine) { toast.error("Offline"); return; }
        const data = weatherDataRef.current;
        const loc = data?.locationName || settingsRef.current.defaultLocation || '';

        fetchWeather(loc, true, data?.coordinates, false, silent);
    }, [fetchWeather]);

    const selectLocation = useCallback(async (location: string, coords?: { lat: number, lon: number }) => {

        const isCurrent = location === "Current Location";

        // SET LOCATION MODE: GPS tracking vs Fixed location
        setLocationMode(isCurrent ? 'gps' : 'selected');
        isTrackingCurrentLocation.current = isCurrent;

        // PERSISTENCE FIX: Identify and Save User Intent
        // We must update the default location immediately so any subsequent reloads/syncs
        // respect this choice and don't revert to the previous one.
        if (location && location !== settingsRef.current.defaultLocation) {
            updateSettings({ defaultLocation: location });
        }

        // --- SMOOTH TRANSITION STRATEGY ---
        // Instead of flashing an optimistic stub (which causes the layout to jump
        // between offshore/coastal/inland), we keep the PREVIOUS location's data
        // visible on screen while the new data loads in the background.
        // Only swap to a stub if there is absolutely nothing on screen.

        const cache = historyCacheRef.current;

        // NULL ISLAND BUG guard: reject poisoned 0,0 cache entries
        const cached = cache[location];
        const isCacheValid = cached && cached?.coordinates && (cached.coordinates.lat !== 0 || cached.coordinates.lon !== 0);

        // BLUR ON LOCATION CHANGE: Blur if cache is missing or stale (>30 min)
        const STALE_LOC_MS = 30 * 60 * 1000; // 30 minutes
        const cachedAge = isCacheValid && cached?.generatedAt
            ? Date.now() - new Date(cached.generatedAt).getTime()
            : Infinity;
        const needsBlur = !isCacheValid || cachedAge >= STALE_LOC_MS;

        if (needsBlur && weatherDataRef.current) {
            // There IS data on screen (from previous location) — blur it while we fetch
            setStaleRefresh(true);
        }

        if (isCacheValid) {
            // Best case: we have a real cached report for this location — swap instantly
            setWeatherData(cached);
        } else if (!weatherDataRef.current) {
            // Cold start: nothing on screen at all — show a minimal stub so the UI isn't blank
            const optimisticData = {
                locationName: location,
                coordinates: coords || { lat: 0, lon: 0 },
                locationType: 'coastal' as const,
                timeZone: 'UTC',
                generatedAt: new Date().toISOString(),
                isEstimated: true,
                alerts: [],
                loading: true,
                current: {
                    windSpeed: null, windGust: null, windDirection: "---",
                    waveHeight: null, swellPeriod: null,
                    airTemperature: null, waterTemperature: null,
                    condition: "Loading...", uvIndex: 0, visibility: null,
                    humidity: null, pressure: null, cloudCover: null,
                    precipitation: null, description: "Loading marine data...",
                    feelsLike: null, dewPoint: null
                },
                forecast: [], hourly: [], tides: [], tideHourly: [],
                boatingAdvice: "Generating advice...",
                modelUsed: "Loading..."
            } as unknown as MarineWeatherReport;
            setWeatherData(optimisticData);
        }
        // else: keep the CURRENT location's data visible — no flicker!

        // Show background updating indicator
        setBackgroundUpdating(true);

        if (cached) {
            await fetchWeather(location, false, coords, false, true);
        } else {
            await fetchWeather(location, false, coords, !weatherDataRef.current);
        }
    }, [fetchWeather, updateSettings]);

    // --- WATCHDOG: Ensure nextUpdate is set if data exists ---
    useEffect(() => {
        if (weatherData && !nextUpdate) {
            const watchdogLocationType = weatherData.locationType || 'coastal';
            const isCurrentLoc = locationMode === 'gps';
            const interval = getUpdateInterval(watchdogLocationType, weatherData, isCurrentLoc, settingsRef.current.satelliteMode);
            const gen = new Date(weatherData.generatedAt).getTime();
            const target = gen + interval;
            const now = Date.now();

            if (target > now) {
                setNextUpdate(target);
            } else {
                // Expired: use proper clock-aligned interval instead of aggressive 30s fallback
                const nextTarget = alignToNextInterval(interval);
                setNextUpdate(nextTarget);
            }
        }
    }, [weatherData, nextUpdate, locationMode]);

    // --- SMART REFRESH TIMER ---
    useEffect(() => {
        // nextUpdateRef is synced via a separate useEffect below

        const checkInterval = setInterval(() => {
            if (document.hidden) return; // Battery: skip when backgrounded
            if (!navigator.onLine) return;
            if (isFetchingRef.current) return; // Don't stack fetches

            // Safety 2hr check - but don't bypass countdown, just set it if missing
            const data = weatherDataRef.current;
            if (data) {
                const age = Date.now() - (data.generatedAt ? new Date(data.generatedAt).getTime() : 0);
                if (age > 7200000 && !nextUpdateRef.current) {
                    setNextUpdate(Date.now() + 5000); // Set update for 5s from now
                    return;
                }
            }

            if (!nextUpdateRef.current) return;
            if (Date.now() >= nextUpdateRef.current) {

                // Immediately push nextUpdate forward so the countdown shows
                // "Updating..." instead of "Overdue Xm" while the fetch runs.
                // The actual nextUpdate will be properly set when fetch completes.
                const tempNext = Date.now() + 90000; // 90s grace window
                nextUpdateRef.current = tempNext;
                setNextUpdate(tempNext);

                // INTELLIGENT GPS vs SELECTED MODE
                if (locationMode === 'gps') {
                    // GPS Mode: Get fresh coordinates via efficient native plugin
                    GpsService.getCurrentPosition({ staleLimitMs: 30_000 }).then((pos) => {
                        if (pos) {
                            fetchWeather("Current Location", true, { lat: pos.latitude, lon: pos.longitude }, false, true);
                        } else {
                            // Fallback to last known location
                            const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                            const coords = weatherDataRef.current?.coordinates;
                            if (loc) fetchWeather(loc, false, coords, false, true);
                        }
                    });
                } else {
                    // Selected Mode: Keep location FIXED — never touch GPS, always use stored coords
                    const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                    const storedCoords = weatherDataRef.current?.coordinates;
                    if (loc && storedCoords) {
                        fetchWeather(loc, false, storedCoords, false, true); // Silent refresh with fixed coords
                    } else if (loc) {
                        fetchWeather(loc, false, undefined, false, true); // Resolve from name
                    }
                }
            }
        }, 30_000);  // PERF FIX: Was 10s — 30s reduces GPS+countdown check overhead 3x

        // WAKE FROM SLEEP — when iPhone/device resumes, check if data is stale
        // and trigger an immediate refresh. The setInterval above is frozen while
        // the phone sleeps, so we can't rely on it to catch multi-hour gaps.
        const STALE_ON_WAKE_MS = 30 * 60 * 1000; // 30 min — blur when returning from background with stale data
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (isFetchingRef.current) return;

            const data = weatherDataRef.current;
            const dataAge = data?.generatedAt
                ? Date.now() - new Date(data.generatedAt).getTime()
                : Infinity;

            // If data is older than 30 minutes, blur + refresh
            if (dataAge > STALE_ON_WAKE_MS) {
                console.info(`[WeatherContext] Wake: data is ${Math.round(dataAge / 60000)}m old — refreshing`);
                setStaleRefresh(true); // Signal dashboard to blur
                // Small delay so the device has time to re-establish network
                setTimeout(() => {
                    if (isFetchingRef.current) return;
                    const loc = data?.locationName || settingsRef.current.defaultLocation;
                    if (!loc) return;

                    if (locationMode === 'gps') {
                        GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 10 }).then((pos) => {
                            if (pos) {
                                fetchWeather('Current Location', true, { lat: pos.latitude, lon: pos.longitude }, false, true);
                            } else {
                                fetchWeather(loc, true, data?.coordinates, false, true);
                            }
                        });
                    } else {
                        fetchWeather(loc, true, data?.coordinates, false, true);
                    }
                }, 2000);
            } else {
                // Data is recent — just nudge the countdown timer if it expired while asleep
                const now = Date.now();
                const target = nextUpdateRef.current;
                if (target && now >= target) {
                    const wakeNext = now + 5000;
                    nextUpdateRef.current = wakeNext;
                    setNextUpdate(wakeNext);
                }
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            clearInterval(checkInterval);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [fetchWeather, locationMode]);

    // Keep nextUpdateRef in sync with nextUpdate state
    useEffect(() => {
        nextUpdateRef.current = nextUpdate;
    }, [nextUpdate]);

    // --- GPS DRIFT DETECTOR (30s) ---
    // Two-tier: name-only update for short moves, full weather refresh for long moves
    useEffect(() => {
        if (locationMode !== 'gps') return; // Only active in GPS/"Current Location" mode

        const NAME_CHECK_NM = 0.5;    // Suburb change threshold (filter GPS jitter)
        const WEATHER_REFRESH_NM = 5;  // Full weather refresh threshold
        const POLL_MS = 30_000;  // PERF FIX: Was 10s — GPS drift check every 30s is plenty

        const haversineNM = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
            const R = 3440.065; // Earth radius in nautical miles
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(a));
        };

        const driftCheck = setInterval(() => {
            if (document.hidden) return; // Battery: skip GPS when backgrounded
            if (!navigator.onLine || isFetchingRef.current) return;

            const current = weatherDataRef.current?.coordinates;
            if (!current) return;

            GpsService.getCurrentPosition({ staleLimitMs: 10_000 }).then(async (pos) => {
                if (!pos) return;
                const { latitude, longitude } = pos;
                const dist = haversineNM(current.lat, current.lon, latitude, longitude);

                if (dist < NAME_CHECK_NM) return; // GPS jitter — discard

                // Reverse geocode the new position
                let name = `${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`;
                try {
                    const geo = await reverseGeocode(latitude, longitude);
                    if (geo) name = geo;
                } catch (e) { console.warn('[WeatherContext] fallback to cardinal coords:', e); }

                if (dist >= WEATHER_REFRESH_NM) {
                    // TIER 2: Moved ≥5nm — full location + weather update
                    selectLocation(name, { lat: latitude, lon: longitude });
                } else if (name !== weatherDataRef.current?.locationName) {
                    // TIER 1: Moved 0.5–5nm + suburb changed — name-only update (no weather fetch)
                    const existing = weatherDataRef.current;
                    if (existing) {
                        setWeatherData({
                            ...existing,
                            locationName: name,
                            coordinates: { lat: latitude, lon: longitude }
                        });
                        updateSettings({ defaultLocation: name });
                    }
                }
                // else: moved but same suburb name — do nothing
            });
        }, POLL_MS);

        return () => clearInterval(driftCheck);
    }, [locationMode, selectLocation, setWeatherData, updateSettings]);

    // --- LIVE OVERLAY (5min) ---
    // Lightweight temp/conditions poll using Apple WeatherKit.
    // Patches current metrics without triggering full StormGlass/OpenMeteo refresh.
    useEffect(() => {
        const liveTimer = setInterval(async () => {
            if (document.hidden) return; // Battery: skip when backgrounded
            if (!navigator.onLine) return;
            if (isFetchingRef.current) return;

            const report = weatherDataRef.current;
            if (!report?.coordinates) return;
            // Skip for offshore — WeatherKit has no ocean station data there
            if (report.locationType === 'offshore') return;

            const { lat, lon } = report.coordinates;
            try {
                const obs = await fetchWeatherKitRealtime(lat, lon);
                if (!obs || obs.temperature === null) return;

                // Only patch if we still have the same report (no full refresh happened)
                const current = weatherDataRef.current;
                if (!current) return;

                const patched = { ...current.current } as any;
                const sources = { ...(patched.sources || {}) };

                const wkSource = (val: number | null) => ({
                    value: val,
                    source: 'weatherkit' as const,
                    sourceColor: 'emerald',
                    sourceName: 'Apple Weather',
                });

                // Patch ALL live metrics from WeatherKit observation
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

                // Wind — was missing! Wind stayed stale from initial fetch.
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

                // Cloud cover, visibility, UV
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

                // Condition + description
                if (obs.condition && obs.condition !== 'Unknown') {
                    patched.condition = obs.condition;
                    patched.description = `${obs.condition}. Wind ${patched.windSpeed ?? '--'} kts ${patched.windDirection || ''}`;
                }

                // Precipitation intensity
                if (obs.precipitationIntensity !== null) {
                    patched.precipitation = obs.precipitationIntensity;
                    sources['precipitation'] = wkSource(obs.precipitationIntensity);
                }

                patched.sources = sources;
                setWeatherData({ ...current, current: patched });
            } catch (e) {
                console.warn('[WeatherContext]', e);
                // Silently ignore — full refresh will pick it up
            }
        }, LIVE_OVERLAY_INTERVAL);

        return () => clearInterval(liveTimer);
    }, [setWeatherData]);

    // Model Change Effect
    const prevModelRef = useRef(settings.preferredModel);
    useEffect(() => {
        if (prevModelRef.current !== settings.preferredModel) {
            prevModelRef.current = settings.preferredModel;
            const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
            if (loc) fetchWeather(loc, true);
        }
    }, [settings.preferredModel, fetchWeather]);

    // PERFORMANCE: Memoize context value to prevent consumer re-renders
    const contextValue = React.useMemo(() => ({
        weatherData,
        voyagePlan,
        loading,
        loadingMessage,
        error,
        debugInfo,
        quotaUsed,
        backgroundUpdating,
        staleRefresh,
        nextUpdate,
        fetchWeather,
        refreshData,
        selectLocation,
        saveVoyagePlan: handleSaveVoyagePlan,
        handleSaveVoyagePlan,
        clearVoyagePlan,
        incrementQuota,
        historyCache,
        setHistoryCache
    }), [
        weatherData,
        voyagePlan,
        loading,
        loadingMessage,
        error,
        debugInfo,
        quotaUsed,
        backgroundUpdating,
        staleRefresh,
        nextUpdate,
        fetchWeather,
        refreshData,
        selectLocation,
        handleSaveVoyagePlan,
        clearVoyagePlan,
        incrementQuota,
        historyCache,
        setHistoryCache
    ]);

    return (
        <WeatherContext.Provider value={contextValue}>
            {children}
        </WeatherContext.Provider>
    );
};

export const useWeather = () => {
    const context = useContext(WeatherContext);
    if (context === undefined) throw new Error('useWeather must be used within a WeatherProvider');
    return context;
};

// Scheduling internals now imported from services/WeatherScheduler.ts
// Import directly: import { isBadWeather, getUpdateInterval, ... } from '../services/WeatherScheduler'
