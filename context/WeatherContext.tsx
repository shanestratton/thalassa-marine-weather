
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { MarineWeatherReport, VoyagePlan, DebugInfo } from '../types';
import { enrichMarineWeather } from '../services/geminiService';
import { fetchFastWeather, fetchPrecisionWeather, fetchFastAirportWeather, parseLocation, reverseGeocode } from '../services/weatherService';
import { attemptGridSearch } from '../services/weather/api/openmeteo';
import { isStormglassKeyPresent } from '../services/stormglassService';
import { useSettings, DEFAULT_SETTINGS } from './SettingsContext';
import { calculateDistance } from '../utils';
// import { useSmartRefresh } from '../hooks/useSmartRefresh'; // (Commented out if logic is inline, but it was imported before. Keeping import locally if needed, but logic seems inline in previous file)
// Reviewing previous file... Logic WAS inline in lines 439-491. So I will keep it inline for now to minimize risk.

import { saveLargeData, loadLargeData, deleteLargeData } from '../services/nativeStorage';

const CACHE_VERSION = 'v18.1-FILESYSTEM';
const DATA_CACHE_KEY = 'thalassa_weather_cache_v5';
const VOYAGE_CACHE_KEY = 'thalassa_voyage_cache_v2';
const HISTORY_CACHE_KEY = 'thalassa_history_cache_v2';
const BASE_UPDATE_INTERVAL = 30 * 60 * 1000; // 30 mins
const UNSTABLE_UPDATE_INTERVAL = 10 * 60 * 1000; // 10 mins
const AI_UPDATE_INTERVAL = 3 * 60 * 60 * 1000; // 3 Hours

// Helper to calculate aligned update time
const calculateNextUpdateTime = (unstable: boolean = false) => {
    const now = Date.now();
    const interval = unstable ? UNSTABLE_UPDATE_INTERVAL : BASE_UPDATE_INTERVAL;

    // Align to next bucket
    // E.g. if interval 30m, and now is 12:05, next is 12:30.
    const remainder = now % interval;
    const padding = interval - remainder;

    // Add minimal buffer (e.g. 10s) to avoid immediate re-trigger if logic is fast
    const target = now + padding + 10000;
    return target;
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
    const { settings } = useSettings();

    const [loading, setLoading] = useState(true);
    const [loadingMessage, setLoadingMessage] = useState("Updating Marine Data...");
    const [backgroundUpdating, setBackgroundUpdating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
    const [quotaUsed, setQuotaUsed] = useState(0);
    const [nextUpdate, setNextUpdate] = useState<number | null>(null);

    const [weatherData, setWeatherData] = useState<MarineWeatherReport | null>(null);
    const [voyagePlan, setVoyagePlan] = useState<VoyagePlan | null>(null);

    // FILESYSTEM BACKED CACHE
    const [historyCache, setHistoryCache] = useState<Record<string, MarineWeatherReport>>({});

    const weatherDataRef = useRef<MarineWeatherReport | null>(null);
    const settingsRef = useRef(settings);
    const isFirstRender = useRef(true);
    const isTrackingCurrentLocation = useRef(settings.defaultLocation === "Current Location");

    // Sync Refs
    useEffect(() => { weatherDataRef.current = weatherData; }, [weatherData]);
    useEffect(() => { settingsRef.current = settings; }, [settings]);

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
    // --- INITIALIZATION (ASYNC LOAD) ---
    useEffect(() => {
        const loadCache = async () => {
            try {
                // 1. CRITICAL PATH: Current Weather Data
                // Load this first and unblock UI immediately
                const d = await loadLargeData(DATA_CACHE_KEY);

                if (d) {
                    setWeatherData(d);
                    // Unblock UI immediately if we have data
                    setLoading(false);

                    // SMART REFRESH CHECK (If cache > 60m old, refresh in background)
                    const age = Date.now() - (d.generatedAt ? new Date(d.generatedAt).getTime() : 0);
                    if (age > 60 * 60 * 1000 && navigator.onLine) {
                        // Trigger immediate background refresh (No artificial delay)
                        const loc = d.locationName || settingsRef.current.defaultLocation || '';
                        if (loc) {
                            // Use setTimeout 0 to push to next tick, keeping this execution frame light
                            setTimeout(() => {
                                fetchWeather(loc, true, d.coordinates, false, true);
                            }, 0);
                        }
                    }
                }

                // 2. SECONDARY PATH: History & Voyage (Background)
                // We don't block the UI for this
                const [v, h] = await Promise.all([
                    loadLargeData(VOYAGE_CACHE_KEY),
                    loadLargeData(HISTORY_CACHE_KEY)
                ]);

                if (v) setVoyagePlan(v);
                if (h) setHistoryCache(h);
                else setHistoryCache({});

            } catch (e) {
                console.error("[Context] Failed to load cache", e);
            } finally {
                // Ensure loading is false essentially
                setLoading(false);
            }
        };
        loadCache();
    }, []);

    // --- PERSISTENCE ---
    useEffect(() => {
        if (weatherData) {
            saveLargeData(DATA_CACHE_KEY, weatherData);
        }
    }, [weatherData]);

    // Persist History when it changes (Debounce could be good, but direct write is OK for now)
    useEffect(() => {
        if (Object.keys(historyCache).length > 0) {
            saveLargeData(HISTORY_CACHE_KEY, historyCache);
        }
    }, [historyCache]);

    const handleSaveVoyagePlan = (plan: VoyagePlan) => {
        setVoyagePlan(plan);
        saveLargeData(VOYAGE_CACHE_KEY, plan);
    };

    const clearVoyagePlan = () => {
        setVoyagePlan(null);
        deleteLargeData(VOYAGE_CACHE_KEY);
    };

    // --- HELPER: Regenerate Advice ---
    const regenerateAdvice = useCallback(async () => {
        const currentData = weatherDataRef.current;
        const currentSettings = settingsRef.current;
        if (!currentData) return;


        setBackgroundUpdating(true);
        try {
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
            console.error("Auto-update advice failed", e);
        } finally {
            setBackgroundUpdating(false);
        }
    }, []);

    // --- FETCH WEATHER ---
    const fetchWeather = useCallback(async (location: string, force = false, coords?: { lat: number, lon: number }, showOverlay = false, silent = false) => {
        if (!location) return;

        // OFFLINE CHECK
        if (!navigator.onLine) {
            if (historyCache[location]) { setWeatherData(historyCache[location]); return; }
            if (!weatherDataRef.current) setError("Offline Mode: No Data");
            setLoading(false);
            return;
        }

        const currentSettings = settingsRef.current;

        // CACHE HIT?
        let isServingFromCache = false;
        if (!weatherDataRef.current && historyCache[location] && !force) {

            setWeatherData(historyCache[location]);
            isServingFromCache = true;
        }

        const isBackground = isServingFromCache || ((!!weatherDataRef.current && !force) || silent) && !showOverlay;
        if (!isBackground) {
            setLoading(true);
            setLoadingMessage("Updating Marine Data...");
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
                    console.warn("Pre-flight Geocode Failed", e);
                    // We continue, but fetchFastWeather will likely fail too or handle it
                }
            }
            // IF Coords exist but Location is generic ("Current Location" or "0,0") OR looks like raw coords, Reverse Geocode immediately
            // This ensures GPS injections get a friendly name (e.g. "Townsville") instead of "WP ..."
            if (resolvedCoords && (
                location === "Current Location" ||
                location === "0,0" ||
                location === "0, 0" ||
                /^-?\d/.test(location)  // Starts with digit or minus
            )) {
                try {
                    console.log("[FastLoad] Reverse Geocoding Coordinates:", resolvedCoords);
                    const name = await reverseGeocode(resolvedCoords.lat, resolvedCoords.lon);
                    if (name) {
                        resolvedLocation = name;
                        console.log("[FastLoad] Resolved Name:", name);
                    } else {
                        // Fallback: If Geocoding fails (e.g. Deep Ocean), use nice Coordinate string
                        // instead of "Current Location"
                        resolvedLocation = `WP ${resolvedCoords.lat.toFixed(4)}, ${resolvedCoords.lon.toFixed(4)}`;
                        console.log("[FastLoad] Geocoding Failed. Fallback to Coords:", resolvedLocation);
                    }
                } catch (e) {
                    console.warn("Reverse Geocode Failed", e);
                    // Fallback on error too
                    resolvedLocation = `WP ${resolvedCoords.lat.toFixed(4)}, ${resolvedCoords.lon.toFixed(4)}`;
                }
            }

            // 0a. IMMEDIATE: AIRPORT DATA (The Epiphany)
            // Paint the "Now" card instantly with real data while models crunch numbers
            const isWaypoint = /^(Location|WP|waypoint)|^-?[0-9]|\b\d+°/i.test(resolvedLocation);

            let currentReport: MarineWeatherReport | null = null;

            if (!isBackground && resolvedCoords && !isWaypoint) {
                const tStart = Date.now();
                console.log("[FastLoad] 1. Triggering Airport Fetch for", resolvedLocation);
                currentReport = await fetchFastAirportWeather(resolvedLocation, resolvedCoords);

                const tEnd = Date.now();
                console.log(`[FastLoad] 2. Airport Fetch DONE in ${tEnd - tStart}ms.`);

                if (currentReport) {
                    if (!weatherDataRef.current || weatherDataRef.current.locationName !== resolvedLocation) {
                        console.log("[FastLoad] 3. APPLYING Fast Data (Unblocking UI)");
                        setWeatherData(currentReport);
                        setLoading(false); // <--- UNBLOCK UI IMMEDIATELY
                    }
                } else {
                    if (!isBackground) setLoadingMessage("No nearby airport. Fetching StormGlass...");
                }
            }

            // 1. SKIP "FAST BASE" (OpenMeteo) PER USER REQUEST ("No OpenMeteo")
            // We rely strictly on Airport Data (if available) + StormGlass (Precision).

            // 2. PRECISION (STORMGLASS)
            // Fetch if:
            // a) We have NO data yet (currentReport is null)
            // b) We have data logic demanding it (always fetch SG to fill blanks)
            // c) Or explicit force refresh
            // const useStormglass = isStormglassKeyPresent(); // Already declared at top

            if (useStormglass) {
                // If we have currentReport (Airport), use its coords/name
                // If not, use resolved vars
                const targetName = currentReport?.locationName || resolvedLocation;
                // If currentReport has a locationType, pass it? Airport returns 'isLandlocked' but not 'locationType'.
                // 'offshore' type is usually derived from SG.

                try {
                    const precisionReport = await fetchPrecisionWeather(
                        targetName,
                        currentReport?.coordinates || resolvedCoords || { lat: 0, lon: 0 }, // Coords are needed. Resolving above handles it.
                        false,
                        undefined // Let SG determine type or use existing?
                    );
                    incrementQuota();

                    // STABILIZATION / MERGE
                    if (currentReport && currentReport.current) {
                        const airport = currentReport.current; // THE TRUTH
                        const sg = precisionReport.current;

                        // Force Airport Values over SG Values
                        // We trust Airport for: Temp, Wind, Pressure, Vis, Cloud, Precip, Condition.
                        if (airport.airTemperature !== null) sg.airTemperature = airport.airTemperature;
                        if (airport.humidity !== null) sg.humidity = airport.humidity;
                        if (airport.pressure) sg.pressure = airport.pressure;
                        if (airport.windSpeed !== null) {
                            sg.windSpeed = airport.windSpeed;
                            sg.windGust = airport.windGust;
                            sg.windDirection = airport.windDirection;
                            sg.windDegree = airport.windDegree;
                        }
                        if (airport.visibility !== null) sg.visibility = airport.visibility;
                        if (airport.cloudCover !== null) sg.cloudCover = airport.cloudCover;
                        if (airport.precipitation !== null) sg.precipitation = airport.precipitation;
                        if (airport.condition) sg.condition = airport.condition;

                        // Keep station ID
                        if (airport.stationId) sg.stationId = airport.stationId;

                        precisionReport.current = sg;
                        precisionReport.groundingSource = `METAR (${airport.stationId}) + StormGlass`;
                    } else {
                        // No Airport data. Precision Report is valid on its own.
                    }

                    if (currentReport?.timeZone && !precisionReport.timeZone) {
                        precisionReport.timeZone = currentReport.timeZone;
                    }

                    currentReport = precisionReport;

                } catch (e: any) {
                    console.warn("Precision Upgrade Failed", e);
                    if (!currentReport) throw e; // If we have nothing, throw.
                    // If we have Airport data, keep it? 
                    // But Airport data lacks Forecast/Hourly.
                    // So effectively useless for charts.
                    // But good for "Now".
                }
            } else {
                // No Stormglass Key? User said "No OpenMeteo".
                // So if no SG key, do we fail?
                // Or fallback? User said "standard edition later".
                // I'll assume SG Key is present as this is "Pro".
                if (!currentReport) setLoadingMessage("Please add StormGlass Key.");
            }

            // 2. PRECISION
            // 3. COORD LOCK & FINAL RENDER
            if (coords && currentReport) {
                currentReport.coordinates = coords;
            }

            if (currentReport) {
                setWeatherData(currentReport);
                // Clean up non-null assertion
                const validReport = currentReport;
                setHistoryCache(prev => ({ ...prev, [location]: validReport }));
                saveLargeData(DATA_CACHE_KEY, validReport);
                if (!isBackground) setLoading(false);
            }

            // 5. CALCULATE NEXT UPDATE TIME
            // Check instability (Alerts present OR high wind/rain)
            // Ensure currentReport exists
            if (currentReport) {
                const hasAlerts = currentReport.alerts && currentReport.alerts.length > 0;
                const maxGust = Math.max(...(currentReport.hourly?.slice(0, 12).map(h => h.windGust || 0) || [0]));
                const isUnstable = hasAlerts || maxGust > 20;

                const nextTs = calculateNextUpdateTime(isUnstable);

                setNextUpdate(nextTs);
                localStorage.setItem('thalassa_next_update', nextTs.toString());
                const now = Date.now();
                const lastAI = weatherDataRef.current?.aiGeneratedAt ? new Date(weatherDataRef.current.aiGeneratedAt).getTime() : 0;
                const timeExpired = (now - lastAI) > AI_UPDATE_INTERVAL;
                const locationChanged = weatherDataRef.current?.locationName !== currentReport.locationName;

                if (timeExpired || force || locationChanged || !weatherDataRef.current?.boatingAdvice) {
                    try {
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
                    } catch (e) { }
                } else {
                    if (weatherDataRef.current?.boatingAdvice) {
                        currentReport.boatingAdvice = weatherDataRef.current.boatingAdvice;
                        currentReport.aiGeneratedAt = weatherDataRef.current.aiGeneratedAt;
                        setWeatherData(currentReport);
                        saveLargeData(DATA_CACHE_KEY, currentReport);
                    }
                }
            }

        } catch (err: any) {
            if (!navigator.onLine && (weatherDataRef.current || historyCache[location])) {
                // OK
            } else {
                if (!weatherDataRef.current) setError(err.message || "Weather Unavailable");
            }
            setLoading(false);
        } finally {
            setBackgroundUpdating(false);
            setLoading(false);
        }
    }, [incrementQuota, historyCache]);

    // --- REFRESH / SELECT ---
    const refreshData = useCallback((silent = false) => {
        if (!navigator.onLine) { alert("Offline"); return; }
        const data = weatherDataRef.current;
        const loc = data?.locationName || settingsRef.current.defaultLocation || '';

        fetchWeather(loc, true, data?.coordinates, false, silent);
    }, [fetchWeather]);

    const selectLocation = useCallback(async (location: string, coords?: { lat: number, lon: number }) => {

        const isCurrent = location === "Current Location";
        isTrackingCurrentLocation.current = isCurrent;

        // OPTIMISTIC UPDATE: Update UI immediately with target name
        // We construct a temporary "Loading..." report to show INSTANT feedback
        // Logic: specific "WP" check for offshore optimistic typing
        // This hides the Tide Graph immediately for offshore points
        const isOptimisticOffshore = location.startsWith("WP");

        const optimisticData = historyCache[location] || {
            ...(weatherDataRef.current || {}), // Keep existing data if possible
            locationName: location,
            coordinates: coords || weatherDataRef.current?.coordinates || { lat: 0, lon: 0 },
            locationType: isOptimisticOffshore ? 'offshore' : 'coastal',
            generatedAt: new Date().toISOString(),
            isEstimated: true, // Flag as estimated
            alerts: [],
            loading: true // Custom flag if we want to show spinner
        } as MarineWeatherReport;

        // Force update the state immediately
        setWeatherData(optimisticData);
        setLoading(false); // Ensure we don't show full-screen loader, just let UI update

        if (historyCache[location]) {
            // If we have full cache, we stick with it, but trigger a silent background refresh
            await fetchWeather(location, false, coords, false, true);
        } else {
            // New location: Fetch freshly
            await fetchWeather(location, false, coords, true);
        }
    }, [fetchWeather, historyCache]);

    // --- WATCHDOG: Ensure nextUpdate is set if data exists ---
    useEffect(() => {
        if (weatherData && !nextUpdate) {
            // Check if unstable
            const hasAlerts = weatherData.alerts && weatherData.alerts.length > 0;
            const maxGust = Math.max(...(weatherData.hourly?.slice(0, 12).map(h => h.windGust || 0) || [0]));
            const isUnstable = hasAlerts || maxGust > 20;

            // Recalculate based on existing generation time IS WRONG.
            // We should calculate based on NOW relative to GENERATED?
            // Actually, we want to snap to the NEXT slot.
            // If data generated 20 mins ago (Stable -> 30m interval).
            // Next update should be generation + 30m.

            const gen = new Date(weatherData.generatedAt).getTime();
            const now = Date.now();

            // Logic: Target = gen + interval.
            // We use the same interval logic as fresh fetch
            const interval = isUnstable ? UNSTABLE_UPDATE_INTERVAL : BASE_UPDATE_INTERVAL;
            const target = gen + interval;

            if (target > now) {

                setNextUpdate(target);
            } else {
                // Expired. Set to immediate future to trigger refresh on next loop

                setNextUpdate(now + 1000);
            }
        }
    }, [weatherData, nextUpdate]);

    // --- SMART REFRESH TIMER ---
    useEffect(() => {
        const checkInterval = setInterval(() => {
            if (!navigator.onLine) return;
            // Safety 2hr check
            const data = weatherDataRef.current;
            if (data) {
                const age = Date.now() - (data.generatedAt ? new Date(data.generatedAt).getTime() : 0);
                if (age > 7200000) {
                    const loc = data.locationName || settingsRef.current.defaultLocation;
                    if (loc) fetchWeather(loc, false);
                    return;
                }
            }

            if (!nextUpdate) return;
            if (Date.now() >= nextUpdate) {

                if (isTrackingCurrentLocation.current && navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                        (pos) => fetchWeather("Current Location", true, { lat: pos.coords.latitude, lon: pos.coords.longitude }),
                        () => { }
                    );
                } else {
                    const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                    if (loc) fetchWeather(loc, false);
                }
            }
        }, 10000);
        return () => clearInterval(checkInterval);
    }, [nextUpdate, fetchWeather]);

    // Model Change Effect
    const prevModelRef = useRef(settings.preferredModel);
    useEffect(() => {
        if (prevModelRef.current !== settings.preferredModel) {
            prevModelRef.current = settings.preferredModel;
            const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
            if (loc) fetchWeather(loc, true);
        }
    }, [settings.preferredModel, fetchWeather]);

    return (
        <WeatherContext.Provider value={{
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
        }}>
            {children}
        </WeatherContext.Provider>
    );
};

export const useWeather = () => {
    const context = useContext(WeatherContext);
    if (context === undefined) throw new Error('useWeather must be used within a WeatherProvider');
    return context;
};
