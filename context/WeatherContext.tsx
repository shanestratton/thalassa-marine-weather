
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { MarineWeatherReport, VoyagePlan, DebugInfo } from '../types';
import { enrichMarineWeather } from '../services/geminiService';
import { fetchFastWeather, fetchPrecisionWeather } from '../services/weatherService';
import { attemptGridSearch } from '../services/weather/api/openmeteo';
import { reverseGeocode } from '../services/weather/api/geocoding';
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
const WEATHER_UPDATE_INTERVAL = 60 * 60 * 1000; // 1 Hour
const AI_UPDATE_INTERVAL = 3 * 60 * 60 * 1000; // 3 Hours

interface WeatherContextType {
    weatherData: MarineWeatherReport | null;
    voyagePlan: VoyagePlan | null;
    loading: boolean;
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
            console.log("Cache version mismatch. Clearing old data.");

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
    useEffect(() => {
        const loadCache = async () => {
            try {
                console.log("[Context] Initializing Cache from Filesystem...");
                const [d, v, h] = await Promise.all([
                    loadLargeData(DATA_CACHE_KEY),
                    loadLargeData(VOYAGE_CACHE_KEY),
                    loadLargeData(HISTORY_CACHE_KEY)
                ]);

                if (d) {
                    setWeatherData(d);

                    // SMART REFRESH CHECK (If cache > 60m old, refresh in background)
                    const age = Date.now() - (d.generatedAt ? new Date(d.generatedAt).getTime() : 0);
                    if (age > 60 * 60 * 1000 && navigator.onLine) {
                        console.log(`[Context] Cache is stale (${Math.floor(age / 60000)}m old). Triggering refresh.`);
                        // We use a small timeout to let the state settle
                        setTimeout(() => {
                            const loc = d.locationName || settingsRef.current.defaultLocation || '';
                            if (loc) {
                                fetchWeather(loc, true, d.coordinates, false, true);
                            }
                        }, 2000);
                    }
                }

                if (v) setVoyagePlan(v);
                if (h) setHistoryCache(h);
                else setHistoryCache({});

            } catch (e) {
                console.error("[Context] Failed to load cache", e);
            } finally {
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

        console.log("Regenerating Captain's Log...");
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
            console.log(`[Cache] Cache Hit for ${location}`);
            setWeatherData(historyCache[location]);
            isServingFromCache = true;
        }

        const isBackground = isServingFromCache || ((!!weatherDataRef.current && !force) || silent) && !showOverlay;
        if (!isBackground) setLoading(true);
        else setBackgroundUpdating(true);
        setError(null);

        try {
            const useStormglass = isStormglassKeyPresent();

            // REVERSE GEOCODE CHECK
            let resolvedLocation = location;
            // Matches "-33.123, 150.123" pattern
            if (location.trim().match(/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/)) {
                if (coords) {
                    const foundName = await reverseGeocode(coords.lat, coords.lon);
                    if (foundName) {
                        console.log(`[Fetch] Geo Success: ${location} -> ${foundName}`);
                        resolvedLocation = foundName;
                    }
                }
            }

            // 1. FETCH BASE
            let currentReport = await fetchFastWeather(resolvedLocation, coords, currentSettings.preferredModel);

            // Name Correction
            if (resolvedLocation !== location && currentReport.locationName === location) {
                currentReport.locationName = resolvedLocation;
            }

            if (!useStormglass && !isBackground) {
                if (currentReport.isLandlocked && currentReport.coordinates) {
                    const marine = await attemptGridSearch(currentReport.coordinates.lat, currentReport.coordinates.lon, currentReport.locationName);
                    if (marine) currentReport = marine;
                }
                setWeatherData(currentReport);
                setHistoryCache(prev => ({ ...prev, [location]: currentReport }));
                saveLargeData(DATA_CACHE_KEY, currentReport);
                setLoading(false);
            }

            // 2. PRECISION
            const alreadyHasSG = currentReport.modelUsed?.toLowerCase().includes('stormglass') || currentReport.modelUsed?.toLowerCase().includes('sg');
            if (useStormglass && !alreadyHasSG) {
                try {
                    // Use resolved name!
                    currentReport = await fetchPrecisionWeather(resolvedLocation, currentReport.coordinates);
                    incrementQuota();
                } catch (e: any) {
                    console.warn("Precision Upgrade Failed", e);
                    currentReport.modelUsed += " (SG Err)";
                }
            }

            // 3. COORD LOCK
            if (coords) {
                currentReport.coordinates = coords;
                if (force && weatherDataRef.current?.locationName) {
                    // Start of discussion: Do we keep old name?
                    // currentReport.locationName = weatherDataRef.current.locationName;
                }
            }

            setWeatherData(currentReport);
            setHistoryCache(prev => ({ ...prev, [location]: currentReport }));
            saveLargeData(DATA_CACHE_KEY, currentReport);
            setHistoryCache(prev => ({ ...prev, [location]: currentReport }));
            saveLargeData(DATA_CACHE_KEY, currentReport);
            if (!isBackground) setLoading(false);

            // 5. CALCULATE NEXT UPDATE TIME
            // Unstable = Gust > 15 OR Rain > 0
            const maxGust = Math.max(...(currentReport.hourly?.slice(0, 24).map(h => h.windGust || 0) || [0]));
            const maxRain = Math.max(...(currentReport.hourly?.slice(0, 24).map(h => h.precipitation || 0) || [0]));
            const isUnstable = maxGust > 15 || maxRain > 0;

            const nowTs = Date.now();
            const intervalMs = isUnstable ? (10 * 60 * 1000) : (30 * 60 * 1000);

            // Calculate next clean interval (00, 10, 20... or 00, 30)
            // Logic: ceil(now / interval) * interval
            let nextTs = Math.ceil(nowTs / intervalMs) * intervalMs;

            // If calculated time is basically "now" (within 5 seconds), push it to next interval
            if (nextTs - nowTs < 5000) {
                nextTs += intervalMs;
            }

            setNextUpdate(nextTs);
            localStorage.setItem('thalassa_next_update', nextTs.toString());
            const now = nowTs;
            const lastAI = weatherDataRef.current?.aiGeneratedAt ? new Date(weatherDataRef.current.aiGeneratedAt).getTime() : 0;
            const timeExpired = (now - lastAI) > AI_UPDATE_INTERVAL;
            const locationChanged = weatherDataRef.current?.locationName !== currentReport.locationName;

            if (timeExpired || force || locationChanged || !weatherDataRef.current?.boatingAdvice) {
                try {
                    currentReport = await enrichMarineWeather(
                        currentReport,
                        currentSettings.vessel,
                        currentSettings.units,
                        currentSettings.vesselUnits,
                        currentSettings.aiPersona
                    );
                    setWeatherData(currentReport);
                    setHistoryCache(prev => ({ ...prev, [location]: currentReport }));
                    saveLargeData(DATA_CACHE_KEY, currentReport);
                } catch (e) { }
            } else {
                if (weatherDataRef.current?.boatingAdvice) {
                    currentReport.boatingAdvice = weatherDataRef.current.boatingAdvice;
                    currentReport.aiGeneratedAt = weatherDataRef.current.aiGeneratedAt;
                    setWeatherData(currentReport);
                    saveLargeData(DATA_CACHE_KEY, currentReport);
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
        console.log("Manual Refresh", loc);
        fetchWeather(loc, true, data?.coordinates, false, silent);
    }, [fetchWeather]);

    const selectLocation = useCallback(async (location: string, coords?: { lat: number, lon: number }) => {
        console.log("Select Location", location);
        const isCurrent = location === "Current Location";
        isTrackingCurrentLocation.current = isCurrent;

        if (historyCache[location]) {
            setWeatherData(historyCache[location]);
            await fetchWeather(location, false, coords, false, true);
        } else {
            setWeatherData(null);
            await fetchWeather(location, false, coords, true);
        }
    }, [fetchWeather, historyCache]);

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
                console.log("Smart Refresh Trigger");
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
