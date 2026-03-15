import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { MarineWeatherReport, VoyagePlan } from '../types';
import { useSettings } from './SettingsContext';
import { toast } from '../components/Toast';
import { GpsService } from '../services/GpsService';
import { LocationStore } from '../stores/LocationStore';
import { reverseGeocode } from '../services/weatherService';
import {
    saveLargeData,
    saveLargeDataImmediate,
    deleteLargeData,
    DATA_CACHE_KEY,
    VOYAGE_CACHE_KEY,
    HISTORY_CACHE_KEY,
} from '../services/nativeStorage';
import { getUpdateInterval, alignToNextInterval, LIVE_OVERLAY_INTERVAL } from '../services/WeatherScheduler';
import {
    WeatherOrchestrator,
    type OrchestratorCallbacks,
    type FetchWeatherOptions,
} from '../services/WeatherOrchestrator';

// ── Context Type (unchanged — zero consumer impact) ──────────

interface WeatherContextType {
    weatherData: MarineWeatherReport | null;
    voyagePlan: VoyagePlan | null;
    loading: boolean;
    loadingMessage: string;
    error: string | null;
    debugInfo: import('../types').DebugInfo | null;
    quotaUsed: number;
    backgroundUpdating: boolean;
    staleRefresh: boolean;
    nextUpdate: number | null;
    fetchWeather: (
        location: string,
        force?: boolean,
        coords?: { lat: number; lon: number },
        showOverlay?: boolean,
        silent?: boolean,
    ) => Promise<void>;
    selectLocation: (location: string, coords?: { lat: number; lon: number }) => Promise<void>;
    refreshData: (silent?: boolean) => void;
    saveVoyagePlan: (plan: VoyagePlan) => void;
    handleSaveVoyagePlan: (plan: VoyagePlan) => void;
    clearVoyagePlan: () => void;
    incrementQuota: () => void;
    historyCache: Record<string, MarineWeatherReport>;
    setHistoryCache: React.Dispatch<React.SetStateAction<Record<string, MarineWeatherReport>>>;
}

const WeatherContext = createContext<WeatherContextType | undefined>(undefined);

// ── Provider (thin React wrapper around WeatherOrchestrator) ─

export const WeatherProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { settings, updateSettings, loading: settingsLoading } = useSettings();

    // ── React State ─────────────────────────────────────────
    const [loading, setLoading] = useState(true);
    const [loadingMessage, setLoadingMessage] = useState('Initializing Weather Data...');
    const [backgroundUpdating, setBackgroundUpdating] = useState(false);
    const [staleRefresh, setStaleRefresh] = useState(false);
    const [locationMode, setLocationMode] = useState<'gps' | 'selected'>('gps');
    const [error, setError] = useState<string | null>(null);
    const [debugInfo] = useState<import('../types').DebugInfo | null>(null);
    const [quotaUsed, setQuotaUsed] = useState(0);
    const [nextUpdate, setNextUpdate] = useState<number | null>(null);
    const [versionChecked, setVersionChecked] = useState(false);
    const [weatherData, _setWeatherData] = useState<MarineWeatherReport | null>(null);
    const [voyagePlan, setVoyagePlan] = useState<VoyagePlan | null>(null);
    const [historyCache, setHistoryCache] = useState<Record<string, MarineWeatherReport>>({});

    // ── Refs ─────────────────────────────────────────────────
    const historyCacheRef = useRef<Record<string, MarineWeatherReport>>({});
    const weatherDataRef = useRef<MarineWeatherReport | null>(null);
    const settingsRef = useRef(settings);
    const isTrackingCurrentLocation = useRef(settings.defaultLocation === 'Current Location');
    const isFetchingRef = useRef(false);
    const nextUpdateRef = useRef<number | null>(null);
    const locationModeRef = useRef(locationMode);

    // Wrapper: every weather update also feeds the environment detection service
    const setWeatherData = useCallback((data: MarineWeatherReport | null) => {
        _setWeatherData(data);
        if (data) WeatherOrchestrator.updateEnvironment(data);
    }, []);

    // Sync Refs
    useEffect(() => {
        weatherDataRef.current = weatherData;
    }, [weatherData]);
    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);
    useEffect(() => {
        historyCacheRef.current = historyCache;
    }, [historyCache]);
    useEffect(() => {
        nextUpdateRef.current = nextUpdate;
    }, [nextUpdate]);
    useEffect(() => {
        locationModeRef.current = locationMode;
    }, [locationMode]);

    const incrementQuota = useCallback(() => setQuotaUsed((p) => p + 1), []);

    // ── Orchestrator Instance ───────────────────────────────
    const orchestratorRef = useRef<WeatherOrchestrator | null>(null);

    // Create orchestrator with stable callback refs
    if (!orchestratorRef.current) {
        const callbacks: OrchestratorCallbacks = {
            setWeatherData: (data) => {
                _setWeatherData(data);
                if (data) WeatherOrchestrator.updateEnvironment(data);
            },
            setLoading,
            setLoadingMessage,
            setBackgroundUpdating,
            setStaleRefresh,
            setError,
            setNextUpdate,
            setHistoryCache: (updater) => setHistoryCache(updater),
            setVersionChecked,
            incrementQuota: () => setQuotaUsed((p) => p + 1),
            getWeatherData: () => weatherDataRef.current,
            getSettings: () => settingsRef.current,
            getHistoryCache: () => historyCacheRef.current,
            getLocationMode: () => locationModeRef.current,
            getIsFetching: () => isFetchingRef.current,
            setIsFetching: (v) => {
                isFetchingRef.current = v;
            },
        };
        orchestratorRef.current = new WeatherOrchestrator(callbacks);
    }
    const orchestrator = orchestratorRef.current;

    // ── INSTANT DISPLAY: Synchronous pre-read from localStorage ─
    useEffect(() => {
        const syncCached = orchestrator.loadInstantCache();
        if (syncCached) {
            setWeatherData(syncCached);
            setLoading(false);
            // Sync to LocationStore for Map tab
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

    // ── CACHE VERSION CHECK ─────────────────────────────────
    useEffect(() => {
        orchestrator.checkCacheVersion();
    }, []);

    // ── INITIALIZATION ──────────────────────────────────────
    useEffect(() => {
        if (settingsLoading) return;
        if (!versionChecked) return;
        console.info('[WeatherContext] Init starting (settings loaded, version checked)');
        orchestrator.loadCacheAndInit();
    }, [settingsLoading, versionChecked]);

    // ── PERSISTENCE ─────────────────────────────────────────
    useEffect(() => {
        if (weatherData) saveLargeDataImmediate(DATA_CACHE_KEY, weatherData);
    }, [weatherData]);

    useEffect(() => {
        if (Object.keys(historyCache).length > 0) saveLargeData(HISTORY_CACHE_KEY, historyCache);
    }, [historyCache]);

    // ── Voyage Plan ─────────────────────────────────────────
    const handleSaveVoyagePlan = useCallback((plan: VoyagePlan) => {
        setVoyagePlan(plan);
    }, []);

    const clearVoyagePlan = useCallback(() => {
        setVoyagePlan(null);
        deleteLargeData(VOYAGE_CACHE_KEY);
    }, []);

    // ── FETCH WEATHER (delegates to orchestrator) ───────────
    const fetchWeather = useCallback(
        async (
            location: string,
            force = false,
            coords?: { lat: number; lon: number },
            showOverlay = false,
            silent = false,
        ) => {
            await orchestrator.fetchWeather(location, { force, coords, showOverlay, silent });
        },
        [],
    );

    // ── REFRESH / SELECT ────────────────────────────────────
    const refreshData = useCallback(
        (silent = false) => {
            if (!navigator.onLine) {
                toast.error('Offline');
                return;
            }
            const data = weatherDataRef.current;
            const loc = data?.locationName || settingsRef.current.defaultLocation || '';
            fetchWeather(loc, true, data?.coordinates, false, silent);
        },
        [fetchWeather],
    );

    const selectLocation = useCallback(
        async (location: string, coords?: { lat: number; lon: number }) => {
            const isCurrent = location === 'Current Location';
            setLocationMode(isCurrent ? 'gps' : 'selected');
            isTrackingCurrentLocation.current = isCurrent;

            // Persist user intent
            if (location && location !== settingsRef.current.defaultLocation) {
                updateSettings({ defaultLocation: location });
            }

            // Smooth transition strategy
            const cache = historyCacheRef.current;
            const cached = cache[location];
            const isCacheValid =
                cached && cached?.coordinates && (cached.coordinates.lat !== 0 || cached.coordinates.lon !== 0);

            const STALE_LOC_MS = 30 * 60 * 1000;
            const cachedAge =
                isCacheValid && cached?.generatedAt ? Date.now() - new Date(cached.generatedAt).getTime() : Infinity;
            const needsBlur = !isCacheValid || cachedAge >= STALE_LOC_MS;

            if (needsBlur && weatherDataRef.current) setStaleRefresh(true);

            if (isCacheValid) {
                setWeatherData(cached);
            } else if (!weatherDataRef.current) {
                // Cold start stub
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
                        windSpeed: null,
                        windGust: null,
                        windDirection: '---',
                        waveHeight: null,
                        swellPeriod: null,
                        airTemperature: null,
                        waterTemperature: null,
                        condition: 'Loading...',
                        uvIndex: 0,
                        visibility: null,
                        humidity: null,
                        pressure: null,
                        cloudCover: null,
                        precipitation: null,
                        description: 'Loading marine data...',
                        feelsLike: null,
                        dewPoint: null,
                    },
                    forecast: [],
                    hourly: [],
                    tides: [],
                    tideHourly: [],
                    boatingAdvice: 'Generating advice...',
                    modelUsed: 'Loading...',
                } as unknown as MarineWeatherReport;
                setWeatherData(optimisticData);
            }

            setBackgroundUpdating(true);
            if (cached) {
                await fetchWeather(location, false, coords, false, true);
            } else {
                await fetchWeather(location, false, coords, !weatherDataRef.current);
            }
        },
        [fetchWeather, updateSettings, setWeatherData],
    );

    // ── WATCHDOG: Ensure nextUpdate is set if data exists ───
    useEffect(() => {
        if (weatherData && !nextUpdate) {
            const lt = weatherData.locationType || 'coastal';
            const isCurrentLoc = locationMode === 'gps';
            const interval = getUpdateInterval(lt, weatherData, isCurrentLoc, settingsRef.current.satelliteMode);
            const gen = new Date(weatherData.generatedAt).getTime();
            const target = gen + interval;
            if (target > Date.now()) {
                setNextUpdate(target);
            } else {
                setNextUpdate(alignToNextInterval(interval));
            }
        }
    }, [weatherData, nextUpdate, locationMode]);

    // ── SMART REFRESH TIMER ─────────────────────────────────
    useEffect(() => {
        const checkInterval = setInterval(() => {
            if (document.hidden) return;
            if (!navigator.onLine) return;
            if (isFetchingRef.current) return;

            const data = weatherDataRef.current;
            if (data) {
                const age = Date.now() - (data.generatedAt ? new Date(data.generatedAt).getTime() : 0);
                if (age > 7200000 && !nextUpdateRef.current) {
                    setNextUpdate(Date.now() + 5000);
                    return;
                }
            }

            if (!nextUpdateRef.current) return;
            if (Date.now() >= nextUpdateRef.current) {
                const tempNext = Date.now() + 90000;
                nextUpdateRef.current = tempNext;
                setNextUpdate(tempNext);

                if (locationMode === 'gps') {
                    GpsService.getCurrentPosition({ staleLimitMs: 30_000 }).then((pos) => {
                        if (pos) {
                            fetchWeather(
                                'Current Location',
                                true,
                                { lat: pos.latitude, lon: pos.longitude },
                                false,
                                true,
                            );
                        } else {
                            const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                            const coords = weatherDataRef.current?.coordinates;
                            if (loc) fetchWeather(loc, false, coords, false, true);
                        }
                    });
                } else {
                    const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                    const storedCoords = weatherDataRef.current?.coordinates;
                    if (loc && storedCoords) fetchWeather(loc, false, storedCoords, false, true);
                    else if (loc) fetchWeather(loc, false, undefined, false, true);
                }
            }
        }, 30_000);

        // Wake from sleep handler
        const STALE_ON_WAKE_MS = 30 * 60 * 1000;
        const handleVisibilityChange = () => {
            if (document.visibilityState !== 'visible') return;
            if (isFetchingRef.current) return;

            const data = weatherDataRef.current;
            const dataAge = data?.generatedAt ? Date.now() - new Date(data.generatedAt).getTime() : Infinity;

            if (dataAge > STALE_ON_WAKE_MS) {
                console.info(`[WeatherContext] Wake: data is ${Math.round(dataAge / 60000)}m old — refreshing`);
                setStaleRefresh(true);
                setTimeout(() => {
                    if (isFetchingRef.current) return;
                    const loc = data?.locationName || settingsRef.current.defaultLocation;
                    if (!loc) return;

                    if (locationMode === 'gps') {
                        GpsService.getCurrentPosition({ staleLimitMs: 60_000, timeoutSec: 10 }).then((pos) => {
                            if (pos) {
                                fetchWeather(
                                    'Current Location',
                                    true,
                                    { lat: pos.latitude, lon: pos.longitude },
                                    false,
                                    true,
                                );
                            } else {
                                fetchWeather(loc, true, data?.coordinates, false, true);
                            }
                        });
                    } else {
                        fetchWeather(loc, true, data?.coordinates, false, true);
                    }
                }, 2000);
            } else {
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

    // ── GPS DRIFT DETECTOR ──────────────────────────────────
    useEffect(() => {
        if (locationMode !== 'gps') return;

        const NAME_CHECK_NM = 0.5;
        const WEATHER_REFRESH_NM = 5;
        const POLL_MS = 30_000;

        const haversineNM = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
            const R = 3440.065;
            const dLat = ((lat2 - lat1) * Math.PI) / 180;
            const dLon = ((lon2 - lon1) * Math.PI) / 180;
            const a =
                Math.sin(dLat / 2) ** 2 +
                Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(a));
        };

        const driftCheck = setInterval(() => {
            if (document.hidden) return;
            if (!navigator.onLine || isFetchingRef.current) return;

            const current = weatherDataRef.current?.coordinates;
            if (!current) return;

            GpsService.getCurrentPosition({ staleLimitMs: 10_000 }).then(async (pos) => {
                if (!pos) return;
                const { latitude, longitude } = pos;
                const dist = haversineNM(current.lat, current.lon, latitude, longitude);

                if (dist < NAME_CHECK_NM) return;

                let name = `${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`;
                try {
                    const geo = await reverseGeocode(latitude, longitude);
                    if (geo) name = geo;
                } catch (e) {
                    console.warn('[WeatherContext] fallback to cardinal coords:', e);
                }

                if (dist >= WEATHER_REFRESH_NM) {
                    selectLocation(name, { lat: latitude, lon: longitude });
                } else if (name !== weatherDataRef.current?.locationName) {
                    const existing = weatherDataRef.current;
                    if (existing) {
                        setWeatherData({
                            ...existing,
                            locationName: name,
                            coordinates: { lat: latitude, lon: longitude },
                        });
                        updateSettings({ defaultLocation: name });
                    }
                }
            });
        }, POLL_MS);

        return () => clearInterval(driftCheck);
    }, [locationMode, selectLocation, setWeatherData, updateSettings]);

    // ── LIVE OVERLAY (delegates to orchestrator) ────────────
    useEffect(() => {
        const liveTimer = setInterval(() => {
            if (document.hidden) return;
            if (!navigator.onLine) return;
            if (isFetchingRef.current) return;
            orchestrator.patchLiveMetrics();
        }, LIVE_OVERLAY_INTERVAL);

        return () => clearInterval(liveTimer);
    }, []);

    // ── Model Change Effect ─────────────────────────────────
    const prevModelRef = useRef(settings.preferredModel);
    useEffect(() => {
        if (prevModelRef.current !== settings.preferredModel) {
            prevModelRef.current = settings.preferredModel;
            const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
            if (loc) fetchWeather(loc, true);
        }
    }, [settings.preferredModel, fetchWeather]);

    // ── CONTEXT VALUE (memoized) ────────────────────────────
    const contextValue = React.useMemo(
        () => ({
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
            setHistoryCache,
        }),
        [
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
            setHistoryCache,
        ],
    );

    return <WeatherContext.Provider value={contextValue}>{children}</WeatherContext.Provider>;
};

export const useWeather = () => {
    const context = useContext(WeatherContext);
    if (context === undefined) throw new Error('useWeather must be used within a WeatherProvider');
    return context;
};

// Scheduling internals now imported from services/WeatherScheduler.ts
// Import directly: import { isBadWeather, getUpdateInterval, ... } from '../services/WeatherScheduler'
