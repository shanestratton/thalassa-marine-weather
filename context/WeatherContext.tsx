
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { MarineWeatherReport, VoyagePlan, DebugInfo } from '../types';
import { enrichMarineWeather } from '../services/geminiService';
import { fetchFastWeather, fetchPrecisionWeather, attemptGridSearch } from '../services/weatherService';
import { isStormglassKeyPresent } from '../services/stormglassService';
import { useSettings, DEFAULT_SETTINGS } from './SettingsContext';

const CACHE_VERSION = 'v11.7-SETTINGS-SPLIT';
const DATA_CACHE_KEY = 'thalassa_weather_cache'; 
const VOYAGE_CACHE_KEY = 'thalassa_voyage_cache';
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
    fetchWeather: (location: string, force?: boolean, coords?: { lat: number, lon: number }) => Promise<void>;
    refreshData: () => void;
    saveVoyagePlan: (plan: VoyagePlan) => void;
    incrementQuota: () => void;
}

const WeatherContext = createContext<WeatherContextType | undefined>(undefined);

export const WeatherProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { settings, updateSettings } = useSettings();
    
    const [loading, setLoading] = useState(false);
    const [backgroundUpdating, setBackgroundUpdating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
    const [quotaUsed, setQuotaUsed] = useState(0);
    const [nextUpdate, setNextUpdate] = useState<number | null>(null);
    const [weatherData, setWeatherData] = useState<MarineWeatherReport | null>(null);
    const [voyagePlan, setVoyagePlan] = useState<VoyagePlan | null>(() => {
        try {
            const cached = localStorage.getItem(VOYAGE_CACHE_KEY);
            return cached ? JSON.parse(cached) : null;
        } catch { return null; }
    });

    const weatherDataRef = useRef(weatherData);
    const settingsRef = useRef(settings);
    const isFirstRender = useRef(true);

    useEffect(() => { weatherDataRef.current = weatherData; }, [weatherData]);
    useEffect(() => { settingsRef.current = settings; }, [settings]);

    const incrementQuota = useCallback(() => setQuotaUsed(p => p + 1), []);

    // Handle Cache & Versioning
    useEffect(() => {
        const ver = localStorage.getItem('thalassa_cache_version');
        if (ver !== CACHE_VERSION) {
            localStorage.clear(); // Safe clear of old data structure
            localStorage.setItem('thalassa_cache_version', CACHE_VERSION);
            // Restore default settings if cleared, but SettingsContext handles its own init.
            // We just ensure data cache is clean.
            updateSettings(DEFAULT_SETTINGS);
        } else {
            // Restore weather data if valid
            try {
                const cachedData = localStorage.getItem(DATA_CACHE_KEY);
                if (cachedData) {
                    setWeatherData(JSON.parse(cachedData));
                }
            } catch (e) {
                console.warn("Failed to load cached weather data");
            }
        }
    }, []);

    // Helper to regenerate advice without refetching weather data
    const regenerateAdvice = useCallback(async () => {
        const currentData = weatherDataRef.current;
        const currentSettings = settingsRef.current;
        
        if (!currentData) return;

        console.log("Regenerating Captain's Log due to settings change...");
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
            localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(enriched));
        } catch (e) {
            console.error("Auto-update advice failed", e);
        } finally {
            setBackgroundUpdating(false);
        }
    }, []);

    // Watch for specific settings changes (Persona, Units) to trigger advice update
    useEffect(() => {
        if (isFirstRender.current) {
            isFirstRender.current = false;
            return;
        }
        
        if (!weatherDataRef.current) return;

        // Debounce to avoid spamming Gemini while sliding the persona slider
        const t = setTimeout(() => {
            regenerateAdvice();
        }, 2000);

        return () => clearTimeout(t);
    }, [
        settings.aiPersona,
        settings.units.speed,
        settings.units.temp,
        settings.units.length, // wave unit
        settings.vessel?.type, // vessel type affects advice tone/content
        settings.vessel?.length
    ]);

    const handleSaveVoyagePlan = (plan: VoyagePlan) => {
        setVoyagePlan(plan);
        localStorage.setItem(VOYAGE_CACHE_KEY, JSON.stringify(plan));
    };

    const fetchWeather = useCallback(async (location: string, force = false, coords?: { lat: number, lon: number }) => {
        if (!location) return;
        
        const currentSettings = settingsRef.current;
        const isBackground = !!weatherDataRef.current && !force;
        
        if (!isBackground) setLoading(true);
        else setBackgroundUpdating(true);
        
        setError(null);
        
        try {
            const useStormglass = currentSettings.isPro && isStormglassKeyPresent();
            
            // Step 1: Base Data
            let currentReport = await fetchFastWeather(location, coords);

            if (!useStormglass && !isBackground) {
                if (currentReport.isLandlocked && currentReport.coordinates) {
                    const marine = await attemptGridSearch(currentReport.coordinates.lat, currentReport.coordinates.lon, currentReport.locationName);
                    if (marine) currentReport = marine;
                }
                setWeatherData(currentReport);
                setLoading(false);
            }

            // Step 2: Precision Upgrade
            if (useStormglass) {
                try {
                    currentReport = await fetchPrecisionWeather(location, currentReport);
                    incrementQuota();
                } catch (sgError: any) {
                    console.warn("Precision Upgrade Failed (Using Base Data as Fallback):", sgError);
                }
                setWeatherData(currentReport);
                if (!isBackground) setLoading(false);
            }

            // Step 3: AI ENRICHMENT
            const now = Date.now();
            const lastAI = weatherDataRef.current?.aiGeneratedAt ? new Date(weatherDataRef.current.aiGeneratedAt).getTime() : 0;
            const timeExpired = (now - lastAI) > AI_UPDATE_INTERVAL;
            const locationChanged = weatherDataRef.current?.locationName !== currentReport.locationName;

            // We check if the advice is missing OR if we are forcing an update OR if time/location changed.
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
                    localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(currentReport));
                } catch (enrichErr) {
                    // Fallback to existing advice if enrichment fails
                }
            } else {
                currentReport.boatingAdvice = weatherDataRef.current.boatingAdvice;
                currentReport.aiGeneratedAt = weatherDataRef.current.aiGeneratedAt;
                setWeatherData(currentReport); 
                localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(currentReport));
            }

            setNextUpdate(Date.now() + WEATHER_UPDATE_INTERVAL);

        } catch (err: any) {
            if (!weatherDataRef.current) setError(err.message || "Weather Unavailable");
            setLoading(false); 
        } finally {
            setBackgroundUpdating(false);
            setLoading(false);
        }
    }, [incrementQuota]); 

    // Auto-Refresh Loop
    useEffect(() => {
        const checkInterval = setInterval(() => {
            const data = weatherDataRef.current;
            if (!data) return;

            const now = Date.now();
            const lastWeather = data.generatedAt ? new Date(data.generatedAt).getTime() : 0;
            
            if ((now - lastWeather) > WEATHER_UPDATE_INTERVAL) {
                console.log("Auto-Refresh: Weather data expired (1hr). Updating...");
                const loc = data.locationName || settingsRef.current.defaultLocation;
                if (loc) fetchWeather(loc, false); 
            }
        }, 60000);

        return () => clearInterval(checkInterval);
    }, [fetchWeather]);

    const refreshData = () => fetchWeather(weatherData?.locationName || settings.defaultLocation || '', true);

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
            saveVoyagePlan: handleSaveVoyagePlan,
            incrementQuota
        }}>
            {children}
        </WeatherContext.Provider>
    );
};

export const useWeather = () => {
    const context = useContext(WeatherContext);
    if (context === undefined) {
        throw new Error('useWeather must be used within a WeatherProvider');
    }
    return context;
};
