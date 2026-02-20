
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { MarineWeatherReport, VoyagePlan, DebugInfo } from '../types';
// geminiService dynamically imported to avoid bundling @google/generative-ai (158KB) in main chunk
import { fetchFastWeather, fetchPrecisionWeather, fetchWeatherByStrategy, parseLocation, reverseGeocode } from '../services/weatherService';
import { fetchTomorrowIoRealtime } from '../services/weather/api/tomorrowio';
import { attemptGridSearch } from '../services/weather/api/openmeteo';
import { isStormglassKeyPresent } from '../services/weather/keys';
import { useSettings, DEFAULT_SETTINGS } from './SettingsContext';
import { calculateDistance } from '../utils';
import { enhanceWithBeaconData } from '../services/beaconIntegration';
import { EnvironmentService } from '../services/EnvironmentService';
import { getErrorMessage } from '../utils/logger';

import { saveLargeData, loadLargeData, deleteLargeData, DATA_CACHE_KEY, VOYAGE_CACHE_KEY, HISTORY_CACHE_KEY } from '../services/nativeStorage';

const CACHE_VERSION = 'v19.1-CACHE-CLEAR';
// Keys imported from nativeStorage to stay in sync

// INTELLIGENT UPDATE INTERVALS
// Minimum 10 min (extreme weather), 30 min (coastal), 60 min (offshore/inland)
// All snapped to clock boundaries (:00, :10, :20, :30, :40, :50)
const INLAND_INTERVAL = 60 * 60 * 1000;        // 60 mins (hourly) — top of hour
const OFFSHORE_INTERVAL = 60 * 60 * 1000;      // 60 mins (hourly) — top of hour
const COASTAL_INTERVAL = 30 * 60 * 1000;       // 30 mins — :00 or :30
const BAD_WEATHER_INTERVAL = 10 * 60 * 1000;   // 10 mins — :00/:10/:20/:30/:40/:50
const AI_UPDATE_INTERVAL = 3 * 60 * 60 * 1000; // 3 Hours
const LIVE_OVERLAY_INTERVAL = 5 * 60 * 1000;   // 5 mins — lightweight temp/conditions poll

// Bad Weather Detection
const isBadWeather = (weather: MarineWeatherReport): boolean => {
    const current = weather.current;
    const next12 = weather.hourly?.slice(0, 12) || [];

    const hasAlerts = weather.alerts && weather.alerts.length > 0;
    const highWind = (current.windGust || current.windSpeed || 0) > 25;  // kts
    const highWaves = (current.waveHeight || 0) > 2.5;  // meters
    const heavyRain = (current.precipitation || 0) > 5;  // mm/h
    const poorVisibility = (current.visibility ?? 10) < 2;  // nm (default 10 if undefined)
    const forecastHighWind = Math.max(...next12.map(h => h.windGust || h.windSpeed || 0)) > 30;

    return hasAlerts || highWind || highWaves || heavyRain || poorVisibility || forecastHighWind;
};

// Get update interval based on location type, weather, and whether this is the user's current GPS location
const getUpdateInterval = (locationType: 'inland' | 'coastal' | 'offshore', weather: MarineWeatherReport, isCurrentLocation: boolean = true): number => {
    // 0. Non-current-location override — always hourly regardless of type/weather
    if (!isCurrentLocation) {
        return INLAND_INTERVAL; // 60 mins
    }

    // 1. Bad weather override — any location type gets 10m refresh
    if (isBadWeather(weather)) {
        return BAD_WEATHER_INTERVAL;
    }

    // 2. Location-specific intervals (normal weather)
    switch (locationType) {
        case 'inland':
            return INLAND_INTERVAL;
        case 'offshore':
            return OFFSHORE_INTERVAL;
        case 'coastal':
        default:
            return COASTAL_INTERVAL;
    }
};

// Smart time alignment — all intervals snap to clean clock boundaries
const alignToNextInterval = (intervalMs: number): number => {
    const now = Date.now();
    const date = new Date(now);

    // Hourly (inland/offshore): align to top of next hour (:00)
    if (intervalMs >= INLAND_INTERVAL) {
        date.setMinutes(0, 0, 0);
        date.setHours(date.getHours() + 1);
        const target = date.getTime();
        return target;
    }

    // 30min (coastal): align to :00 or :30
    if (intervalMs === COASTAL_INTERVAL) {
        const mins = date.getMinutes();
        if (mins < 30) {
            date.setMinutes(30, 0, 0);
        } else {
            date.setHours(date.getHours() + 1);
            date.setMinutes(0, 0, 0);
        }
        const target = date.getTime();
        return target;
    }

    // Bad weather (10min): align to :00/:10/:20/:30/:40/:50
    if (intervalMs === BAD_WEATHER_INTERVAL) {
        const mins = date.getMinutes();
        const nextSlot = Math.ceil((mins + 1) / 10) * 10; // next 10-min boundary
        if (nextSlot >= 60) {
            date.setHours(date.getHours() + 1);
            date.setMinutes(0, 0, 0);
        } else {
            date.setMinutes(nextSlot, 0, 0);
        }
        const target = date.getTime();
        return target;
    }

    // Fallback: raw offset
    return now + intervalMs;
};

interface WeatherContextType {
    weatherData: MarineWeatherReport | null;
    voyagePlan: VoyagePlan | null;
    loading: boolean;
    loadingMessage: string;
    error: string | null;
    debugInfo: DebugInfo | null;
    quotaUsed: number;
    backgroundUpdating: boolean;
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
    const [locationMode, setLocationMode] = useState<'gps' | 'selected'>('gps');
    const [error, setError] = useState<string | null>(null);
    const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
    const [quotaUsed, setQuotaUsed] = useState(0);
    const [nextUpdate, setNextUpdate] = useState<number | null>(null);

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

    // Sync Refs
    useEffect(() => { weatherDataRef.current = weatherData; }, [weatherData]);
    useEffect(() => { settingsRef.current = settings; }, [settings]);
    useEffect(() => { historyCacheRef.current = historyCache; }, [historyCache]);

    const incrementQuota = useCallback(() => setQuotaUsed(p => p + 1), []);

    // --- CACHE VERSION CHECK ---
    useEffect(() => {
        const ver = localStorage.getItem('thalassa_cache_version');
        if (ver !== CACHE_VERSION) {


            // Allow nativeStorage to handle migration if needed, but here we enforce versioning
            // We can delete the files to start fresh for this major version
            // But if we want to migrate, we should do it in nativeStorage.
            // Since this is v18-FILESYSTEM, let's start fresh to avoid conflicts.
            deleteLargeData(DATA_CACHE_KEY);
            deleteLargeData(HISTORY_CACHE_KEY);
            deleteLargeData(VOYAGE_CACHE_KEY);

            // Clean localStorage too just in case
            localStorage.removeItem(DATA_CACHE_KEY);

            localStorage.setItem('thalassa_cache_version', CACHE_VERSION);
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
    }, []);

    // --- INITIALIZATION (ASYNC LOAD) ---
    // STALE-WHILE-REVALIDATE: Show cached data instantly, refresh in background
    useEffect(() => {
        // RACE CONDITION FIX: Wait for settings to finish loading
        if (settingsLoading) {
            return;
        }

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
                const cached = await loadLargeData(DATA_CACHE_KEY);
                if (cached && cached.locationName) {
                    setWeatherData(cached);
                    setLoading(false); // UI renders INSTANTLY with stale data
                    hasCachedData = true;
                }

                // 2. SECONDARY PATH: History (Background)
                const h = await loadLargeData(HISTORY_CACHE_KEY);
                if (h) setHistoryCache(h);
                else setHistoryCache({});

            } catch (e) {
                setLoading(false);
            } finally {
                // Trigger fetch for fresh data
                if (settingsRef.current.defaultLocation) {
                    const loc = settingsRef.current.defaultLocation;

                    // STALENESS CHECK: Skip fetch if cached data is recent (< 30 min)
                    const cachedAge = weatherDataRef.current?.generatedAt
                        ? Date.now() - new Date(weatherDataRef.current.generatedAt).getTime()
                        : Infinity;
                    const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

                    if (hasCachedData && cachedAge < STALE_THRESHOLD_MS) {
                        setLoading(false);
                        return;
                    }


                    // Handle GPS-based "Current Location" specially
                    if (loc === "Current Location" && navigator.geolocation) {
                        if (!hasCachedData) setLoadingMessage("Getting GPS Location...");
                        navigator.geolocation.getCurrentPosition(
                            (pos) => {
                                // If we have cached data, this runs as BACKGROUND (silent) refresh
                                // because weatherDataRef.current is already set
                                fetchWeather(loc, !hasCachedData, {
                                    lat: pos.coords.latitude,
                                    lon: pos.coords.longitude
                                }, false, hasCachedData); // silent=true if we have cache
                            },
                            (error) => {
                                if (!hasCachedData) {
                                    setError("Unable to get GPS location. Please select a location.");
                                    setLoading(false);
                                }
                            },
                            {
                                enableHighAccuracy: true,
                                timeout: 10000,
                                maximumAge: 60000
                            }
                        );
                    } else {
                        // Named location
                        setLoading(false);
                        setTimeout(() => {
                            fetchWeather(loc, !hasCachedData, undefined, false, hasCachedData);
                        }, 100);
                    }
                } else {
                    // No default location - done loading
                    setLoading(false);
                }
            }
        };
        loadCache();
    }, [settingsLoading]);

    // --- PERSISTENCE ---
    useEffect(() => {
        if (weatherData) {
            saveLargeData(DATA_CACHE_KEY, weatherData);
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
            saveLargeData(DATA_CACHE_KEY, enriched);
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

                    // Try to get GPS coordinates
                    if (navigator.geolocation) {
                        return new Promise<void>((resolve) => {
                            navigator.geolocation.getCurrentPosition(
                                (pos) => {
                                    // Success - retry fetch with coords
                                    fetchWeather(location, force, {
                                        lat: pos.coords.latitude,
                                        lon: pos.coords.longitude
                                    }, showOverlay, silent);
                                    resolve();
                                },
                                (error) => {
                                    setError("Unable to get GPS location. Please select a location or enable location services.");
                                    setLoading(false);
                                    resolve();
                                },
                                { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
                            );
                        });
                    } else {
                        setError("Location services not available. Please select a location.");
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
                // Inland/Coastal: Tomorrow.io live + Open-Meteo forecast
                // Offshore: StormGlass live + Open-Meteo forecast
                // Marine forecast: StormGlass (coastal/offshore)
                currentReport = await fetchWeatherByStrategy(
                    resolvedCoords.lat,
                    resolvedCoords.lon,
                    resolvedLocation
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
                    } catch {
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

            // BEACON ENHANCEMENT & MULTI-SOURCE LOGGING  
            // Fetch NOAA buoy data (if within 10nm) and log source breakdown
            if (currentReport && currentReport.coordinates) {
                currentReport = await enhanceWithBeaconData(currentReport, currentReport.coordinates);
            }

            if (currentReport) {
                setWeatherData(currentReport);
                const validReport = currentReport;
                setHistoryCache(prev => ({ ...prev, [location]: validReport }));
                saveLargeData(DATA_CACHE_KEY, validReport);
                if (!isBackground) setLoading(false);
            }

            // 5. CALCULATE NEXT UPDATE TIME using intelligent intervals
            if (currentReport) {
                const reportLocationType = currentReport.locationType || 'coastal';
                const isCurrentLoc = locationMode === 'gps';
                const interval = getUpdateInterval(reportLocationType, currentReport, isCurrentLoc);
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
                        saveLargeData(DATA_CACHE_KEY, enriched);
                    } catch { /* non-critical: previous weather data already set */ }
                } else {
                    if (weatherDataRef.current?.boatingAdvice) {
                        const reportWithAdvice = {
                            ...currentReport,
                            boatingAdvice: weatherDataRef.current.boatingAdvice,
                            aiGeneratedAt: weatherDataRef.current.aiGeneratedAt
                        };
                        setWeatherData(reportWithAdvice);
                        saveLargeData(DATA_CACHE_KEY, reportWithAdvice);
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
            setLoading(false);
        }
    }, [incrementQuota]);

    // --- REFRESH / SELECT ---
    const refreshData = useCallback((silent = false) => {
        if (!navigator.onLine) { alert("Offline"); return; }
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
            const interval = getUpdateInterval(watchdogLocationType, weatherData, isCurrentLoc);
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
        const nextUpdateRef = { current: nextUpdate }; // Capture for closure

        const checkInterval = setInterval(() => {
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
                if (locationMode === 'gps' && navigator.geolocation) {
                    // GPS Mode: Get fresh coordinates
                    navigator.geolocation.getCurrentPosition(
                        (pos) => fetchWeather("Current Location", true, { lat: pos.coords.latitude, lon: pos.coords.longitude }, false, true),
                        (error) => {
                            // Fallback to last known location
                            const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                            const coords = weatherDataRef.current?.coordinates;
                            if (loc) fetchWeather(loc, false, coords, false, true);
                        }
                    );
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
        }, 10000);

        // WAKE FROM SLEEP — when iPhone/device resumes, check if nextUpdate is stale
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (isFetchingRef.current) return;

            const now = Date.now();
            const target = nextUpdateRef.current;

            // If nextUpdate is in the past, schedule an immediate refresh
            if (target && now >= target) {
                console.log('[WeatherContext] Wake from sleep — scheduling refresh');
                const wakeNext = now + 5000; // 5s grace to let the device stabilize
                nextUpdateRef.current = wakeNext;
                setNextUpdate(wakeNext);
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Update ref when nextUpdate changes
        nextUpdateRef.current = nextUpdate;

        return () => {
            clearInterval(checkInterval);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [fetchWeather, locationMode]); // Removed nextUpdate to prevent interval recreation

    // --- GPS DRIFT DETECTOR (30s) ---
    // Two-tier: name-only update for short moves, full weather refresh for long moves
    useEffect(() => {
        if (locationMode !== 'gps') return; // Only active in GPS/"Current Location" mode

        const NAME_CHECK_NM = 0.5;    // Suburb change threshold (filter GPS jitter)
        const WEATHER_REFRESH_NM = 5;  // Full weather refresh threshold
        const POLL_MS = 10_000;

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
            if (!navigator.onLine || isFetchingRef.current) return;
            if (!navigator.geolocation) return;

            const current = weatherDataRef.current?.coordinates;
            if (!current) return;

            navigator.geolocation.getCurrentPosition(async (pos) => {
                const { latitude, longitude } = pos.coords;
                const dist = haversineNM(current.lat, current.lon, latitude, longitude);

                if (dist < NAME_CHECK_NM) return; // GPS jitter — discard

                // Reverse geocode the new position
                let name = `${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`;
                try {
                    const geo = await reverseGeocode(latitude, longitude);
                    if (geo) name = geo;
                } catch { /* fallback to cardinal coords */ }

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
            }, () => { /* GPS error — skip silently */ }, {
                enableHighAccuracy: false,
                timeout: 10_000,
                maximumAge: 15_000
            });
        }, POLL_MS);

        return () => clearInterval(driftCheck);
    }, [locationMode, selectLocation, setWeatherData, updateSettings]);

    // --- LIVE OVERLAY (5min) ---
    // Lightweight temp/conditions poll using Tomorrow.io only.
    // Patches current metrics without triggering full StormGlass/OpenMeteo refresh.
    useEffect(() => {
        const liveTimer = setInterval(async () => {
            if (!navigator.onLine) return;
            if (isFetchingRef.current) return;

            const report = weatherDataRef.current;
            if (!report?.coordinates) return;
            // Skip for offshore — Tomorrow.io has no station data there
            if (report.locationType === 'offshore') return;

            const { lat, lon } = report.coordinates;
            try {
                const obs = await fetchTomorrowIoRealtime(lat, lon);
                if (!obs || obs.temperature === null) return;

                // Only patch if we still have the same report (no full refresh happened)
                const current = weatherDataRef.current;
                if (!current) return;

                const patched = { ...current.current } as any;
                const sources = { ...(patched.sources || {}) };

                const tioSource = (val: number | null) => ({
                    value: val,
                    source: 'tomorrow' as const,
                    sourceColor: 'sky',
                    sourceName: 'Tomorrow.io',
                });

                // Patch live metrics
                if (obs.temperature !== null) {
                    patched.airTemperature = obs.temperature;
                    sources['airTemperature'] = tioSource(obs.temperature);
                }
                if (obs.temperatureApparent !== null) {
                    patched.feelsLike = obs.temperatureApparent;
                    sources['feelsLike'] = tioSource(obs.temperatureApparent);
                }
                if (obs.humidity !== null) {
                    patched.humidity = obs.humidity;
                    sources['humidity'] = tioSource(obs.humidity);
                }
                if (obs.dewPoint !== null) {
                    patched.dewPoint = obs.dewPoint;
                    sources['dewPoint'] = tioSource(obs.dewPoint);
                }
                if (obs.pressure !== null) {
                    patched.pressure = obs.pressure;
                    sources['pressure'] = tioSource(obs.pressure);
                }
                if (obs.condition && obs.condition !== 'Unknown') {
                    patched.condition = obs.condition;
                }

                patched.sources = sources;
                setWeatherData({ ...current, current: patched });
            } catch {
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
