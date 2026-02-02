
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { MarineWeatherReport, VoyagePlan, DebugInfo } from '../types';
import { enrichMarineWeather } from '../services/geminiService';
import { fetchFastWeather, fetchPrecisionWeather, fetchFastAirportWeather, parseLocation, reverseGeocode } from '../services/weatherService';
import { attemptGridSearch } from '../services/weather/api/openmeteo';
import { isStormglassKeyPresent } from '../services/stormglassService';
import { useSettings, DEFAULT_SETTINGS } from './SettingsContext';
import { calculateDistance } from '../utils';
import { enhanceWithBeaconData } from '../services/beaconIntegration';
// import { useSmartRefresh } from '../hooks/useSmartRefresh'; // (Commented out if logic is inline, but it was imported before. Keeping import locally if needed, but logic seems inline in previous file)
// Reviewing previous file... Logic WAS inline in lines 439-491. So I will keep it inline for now to minimize risk.

import { saveLargeData, loadLargeData, deleteLargeData, DATA_CACHE_KEY, VOYAGE_CACHE_KEY, HISTORY_CACHE_KEY } from '../services/nativeStorage';

const CACHE_VERSION = 'v19.0-FIX';
// Keys imported from nativeStorage to stay in sync

// INTELLIGENT UPDATE INTERVALS
const INLAND_INTERVAL = 60 * 60 * 1000;        // 60 mins (hourly)
const COASTAL_INTERVAL = 30 * 60 * 1000;       // 30 mins
const BAD_WEATHER_INTERVAL = 10 * 60 * 1000;   // 10 mins
const AI_UPDATE_INTERVAL = 3 * 60 * 60 * 1000; // 3 Hours

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

// Get update interval based on location type and weather
const getUpdateInterval = (locationType: 'inland' | 'coastal' | 'offshore', weather: MarineWeatherReport): number => {
    if (locationType === 'inland') {
        return INLAND_INTERVAL;  // Always hourly for inland
    }

    // Coastal/Offshore: check weather
    if (isBadWeather(weather)) {
        return BAD_WEATHER_INTERVAL;  // 10 min
    }

    return COASTAL_INTERVAL;  // 30 min
};

// Smart time alignment for update intervals
const alignToNextInterval = (intervalMs: number): number => {
    const now = Date.now();
    const date = new Date(now);

    // Hourly: align to top of hour (e.g., 12:00, 13:00)
    if (intervalMs === INLAND_INTERVAL) {
        date.setMinutes(0, 0, 0);
        date.setHours(date.getHours() + 1);
        return date.getTime();
    }

    // 30min: align to :00 or :30
    if (intervalMs === COASTAL_INTERVAL) {
        const mins = date.getMinutes();
        if (mins < 30) {
            date.setMinutes(30, 0, 0);
        } else {
            date.setHours(date.getHours() + 1);
            date.setMinutes(0, 0, 0);
        }
        return date.getTime();
    }

    // Bad weather (10min): immediate, no alignment
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
    const { settings, updateSettings } = useSettings();

    const [loading, setLoading] = useState(true);
    const [loadingMessage, setLoadingMessage] = useState("Initializing Weather Data...");
    const [backgroundUpdating, setBackgroundUpdating] = useState(false);
    const [locationMode, setLocationMode] = useState<'gps' | 'selected'>('gps');
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
                    // Enhance with beacon/source tracking
                    if (d.coordinates) {
                        enhanceWithBeaconData(d, d.coordinates).then(enhanced => {
                            setWeatherData(enhanced);
                        });
                    }
                    // Unblock UI immediately if we have data
                    setLoading(false);

                    // SET LOCATION MODE on startup
                    const isCurrent = d.locationName === "Current Location";
                    setLocationMode(isCurrent ? 'gps' : 'selected');

                    // SMART REFRESH CHECK (If cache > 60m old, refresh in background)
                    const age = Date.now() - (d.generatedAt ? new Date(d.generatedAt).getTime() : 0);
                    if (age > 60 * 60 * 1000 && navigator.onLine) {
                        // Trigger immediate background refresh
                        const loc = d.locationName || settingsRef.current.defaultLocation || '';
                        if (loc) {
                            // Use setTimeout 0 to push to next tick, keeping this execution frame light
                            setTimeout(() => {
                                // If GPS mode, get fresh coordinates
                                if (isCurrent && navigator.geolocation) {
                                    navigator.geolocation.getCurrentPosition(
                                        (pos) => fetchWeather(loc, true, { lat: pos.coords.latitude, lon: pos.coords.longitude }, false, true),
                                        () => fetchWeather(loc, true, d.coordinates, false, true)  // Fallback to cached coords
                                    );
                                } else {
                                    fetchWeather(loc, true, d.coordinates, false, true);
                                }
                            }, 0);
                        }
                    }
                }

                // 2. SECONDARY PATH: History (Background)
                const h = await loadLargeData(HISTORY_CACHE_KEY);

                // NOTE: Voyage Plan is now transient (Session only). We do NOT load it from disk per user request.
                // if (v) setVoyagePlan(v); 

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

    // Persist History
    useEffect(() => {
        if (Object.keys(historyCache).length > 0) {
            saveLargeData(HISTORY_CACHE_KEY, historyCache);
        }
    }, [historyCache]);

    const handleSaveVoyagePlan = (plan: VoyagePlan) => {
        setVoyagePlan(plan);
        // Transient: Do not save to disk
        // saveLargeData(VOYAGE_CACHE_KEY, plan);
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
                    const finalCoords = currentReport?.coordinates || resolvedCoords;

                    if (!finalCoords) {
                        throw new Error(`Cannot fetch precision weather for ${targetName}: Missing Coordinates`);
                    }

                    const precisionReport = await fetchPrecisionWeather(
                        targetName,
                        finalCoords,
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

            // 4. BEACON ENHANCEMENT & MULTI-SOURCE LOGGING  
            // Fetch NOAA buoy data (if within 10nm) and log source breakdown
            if (currentReport && currentReport.coordinates) {
                currentReport = await enhanceWithBeaconData(currentReport, currentReport.coordinates);
            }

            if (currentReport) {
                setWeatherData(currentReport);
                // Clean up non-null assertion
                const validReport = currentReport;
                setHistoryCache(prev => ({ ...prev, [location]: validReport }));
                saveLargeData(DATA_CACHE_KEY, validReport);
                if (!isBackground) setLoading(false);
            }

            // 5. CALCULATE NEXT UPDATE TIME using intelligent intervals
            if (currentReport) {
                const locationType = currentReport.locationType || 'coastal';
                const interval = getUpdateInterval(locationType, currentReport);
                const nextTs = alignToNextInterval(interval);

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

        // SET LOCATION MODE: GPS tracking vs Fixed location
        setLocationMode(isCurrent ? 'gps' : 'selected');
        isTrackingCurrentLocation.current = isCurrent;

        // PERSISTENCE FIX: Identify and Save User Intent
        // We must update the default location immediately so any subsequent reloads/syncs
        // respect this choice and don't revert to the previous one.
        if (location && location !== settingsRef.current.defaultLocation) {
            updateSettings({ defaultLocation: location });
        }

        // OPTIMISTIC UPDATE: Update UI immediately with target name
        // We construct a temporary "Loading..." report to show INSTANT feedback
        // Logic: specific "WP" check for offshore optimistic typing
        // This hides the Tide Graph immediately for offshore points
        const isOptimisticOffshore = location.startsWith("WP");

        const optimisticData = historyCache[location] || {
            // RESET DATA: Do not inherit old metrics. Start fresh to show "--" in UI.
            locationName: location,
            coordinates: coords || { lat: 0, lon: 0 },
            locationType: isOptimisticOffshore ? 'offshore' : 'coastal',
            timeZone: 'UTC', // Default until loaded
            generatedAt: new Date().toISOString(),
            isEstimated: true,
            alerts: [],
            loading: true,

            // Blank Metrics to force "--" display
            current: {
                windSpeed: null,
                windGust: null,
                windDirection: "---",
                waveHeight: null,
                swellPeriod: null,
                airTemperature: null,
                waterTemperature: null,
                condition: "Loading...",
                uvIndex: 0,
                visibility: null,
                humidity: null,
                pressure: null,
                cloudCover: null,
                precipitation: null,
                description: "Loading marine data...",
                feelsLike: null,
                dewPoint: null
            },
            forecast: [],
            hourly: [],
            tides: [],
            tideHourly: [],
            boatingAdvice: "Generating advice...",
            modelUsed: "Loading..."
        } as unknown as MarineWeatherReport;

        // Force update the state immediately
        // FIX: NULL ISLAND BUG (Refined)
        // Check for validity of cache data. Previous bugs may have poisoned the cache with 0,0.
        // If the cache exists but has 0,0 coordinates, we treat it as INVALID and wait for a fresh fetch.
        const cached = historyCache[location];
        const isCacheValid = cached && cached?.coordinates && (cached.coordinates.lat !== 0 || cached.coordinates.lon !== 0);

        if (isCacheValid || coords) {
            setWeatherData(optimisticData);
        }

        setLoading(true); // OVERLAY: Force "Updating..." blur immediately

        if (historyCache[location]) {
            // If we have full cache, we stick with it, but trigger a silent background refresh
            await fetchWeather(location, false, coords, false, true);
        } else {
            // New location: Fetch freshly
            await fetchWeather(location, false, coords, true);
        }
    }, [fetchWeather, historyCache, updateSettings]);

    // --- WATCHDOG: Ensure nextUpdate is set if data exists ---
    useEffect(() => {
        if (weatherData && !nextUpdate) {
            const locationType = weatherData.locationType || 'coastal';
            const interval = getUpdateInterval(locationType, weatherData);
            const gen = new Date(weatherData.generatedAt).getTime();
            const target = gen + interval;
            const now = Date.now();

            if (target > now) {
                setNextUpdate(target);
            } else {
                // Expired: trigger immediate update
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

                // INTELLIGENT GPS vs SELECTED MODE
                if (locationMode === 'gps' && navigator.geolocation) {
                    // GPS Mode: Get fresh coordinates
                    navigator.geolocation.getCurrentPosition(
                        (pos) => fetchWeather("Current Location", true, { lat: pos.coords.latitude, lon: pos.coords.longitude }, false, true),
                        (error) => {
                            console.warn('[AutoRefresh] GPS failed:', error);
                            // Fallback to last known location
                            const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                            const coords = weatherDataRef.current?.coordinates;
                            if (loc) fetchWeather(loc, false, coords, false, true);
                        }
                    );
                } else {
                    // Selected Mode: Keep location fixed, don't update GPS
                    const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                    const coords = weatherDataRef.current?.locationName === loc ? weatherDataRef.current?.coordinates : undefined;
                    if (loc) {
                        console.log(`[AutoRefresh] Refreshing ${loc} with coords:`, coords);
                        fetchWeather(loc, false, coords, false, true); // Silent refresh
                    }
                }
            }
        }, 10000);
        return () => clearInterval(checkInterval);
    }, [nextUpdate, fetchWeather, locationMode]);

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
