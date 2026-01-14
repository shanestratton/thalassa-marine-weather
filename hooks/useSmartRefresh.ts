import { useRef, useEffect } from 'react';
import { MarineWeatherReport, UserSettings } from '../types';

interface UseSmartRefreshProps {
    weatherData: MarineWeatherReport | null;
    settings: UserSettings;
    nextUpdate: number | null;
    setNextUpdate: (time: number) => void;
    fetchWeather: (location: string, force: boolean, coords?: { lat: number; lon: number }) => void;
    safeSetItem: (key: string, value: string) => void;
}

export const useSmartRefresh = ({
    weatherData,
    settings,
    nextUpdate,
    setNextUpdate,
    fetchWeather,
    safeSetItem
}: UseSmartRefreshProps) => {

    // Track Refs for internal loop usage
    const weatherDataRef = useRef(weatherData);
    const settingsRef = useRef(settings);
    const isTrackingCurrentLocation = useRef(settings.defaultLocation === "Current Location");

    // Sync Refs
    useEffect(() => { weatherDataRef.current = weatherData; }, [weatherData]);
    useEffect(() => { settingsRef.current = settings; }, [settings]);
    useEffect(() => { isTrackingCurrentLocation.current = settings.defaultLocation === "Current Location"; }, [settings.defaultLocation]);

    // CALCULATE NEXT UPDATE TIME
    useEffect(() => {
        if (!weatherData) return;

        const scheduleNextUpdate = () => {
            const currentReport = weatherData;
            const nowTime = Date.now();

            // 1. Top of Hour (Universal Base)
            const nextHour = new Date(nowTime);
            nextHour.setMinutes(0, 0, 0);
            nextHour.setHours(nextHour.getHours() + 1);
            let targetTime = nextHour.getTime();

            // 2. Coastal Checks (30m Interval)
            // Definition: Not Inland AND Has Tides (or Ocean Point etc)
            const isCoastal = !currentReport.isLandlocked && (currentReport.tides && currentReport.tides.length > 0);

            if (isCoastal) {
                // Check if we can hit the :30 mark before the next hour
                const currentMinute = new Date(nowTime).getMinutes();
                if (currentMinute < 30) {
                    const halfHour = new Date(nowTime);
                    halfHour.setMinutes(30, 0, 0);
                    // If we are currently at 15m, target 30m. If we are at 45m, target next hour (already set).
                    targetTime = halfHour.getTime();
                }

                // 3. Unstable Weather Check (10 min Override)
                const isUnstable = (
                    (currentReport.current.windSpeed && currentReport.current.windSpeed > 20) ||
                    (currentReport.current.windGust && currentReport.current.windGust > 25) ||
                    (currentReport.current.pressure && currentReport.current.pressure < 990) ||
                    (currentReport.current.precipitation && currentReport.current.precipitation > 5) || // > 5mm/hr
                    (currentReport.current.visibility && currentReport.current.visibility < 1)
                );

                if (isUnstable) {
                    const tenMins = nowTime + (10 * 60 * 1000);
                    if (tenMins < targetTime) {
                        targetTime = tenMins;
                        console.log(`[Smart Refresh] ⚠️ Unstable Conditions (Coastal). Scheduling update in 10 mins.`);
                    }
                }
            }

            setNextUpdate(targetTime);
            safeSetItem('thalassa_next_update', targetTime.toString());
            console.log(`[Smart Refresh] Next update at ${new Date(targetTime).toLocaleTimeString()} (${((targetTime - Date.now()) / 60000).toFixed(1)} mins)`);
        };

        scheduleNextUpdate();

    }, [weatherData?.generatedAt]); // Triggers when new data arrives


    // MONITOR LOOP (Ticks every 10s)
    useEffect(() => {
        const checkInterval = setInterval(() => {
            if (!navigator.onLine) return;

            // Safety check: specific override for really old data (2 hours)
            // just in case smart logic fails
            const data = weatherDataRef.current;
            if (data) {
                const age = Date.now() - (data.generatedAt ? new Date(data.generatedAt).getTime() : 0);
                if (age > (2 * 60 * 60 * 1000)) {
                    console.log("[Smart Refresh] Safety Net: Data > 2hrs old. Forcing update.");
                    const loc = data.locationName || settingsRef.current.defaultLocation;
                    if (loc) fetchWeather(loc, false);
                    return;
                }
            }

            if (!nextUpdate) return;

            // Trigger window
            if (Date.now() >= nextUpdate) {
                console.log("[Smart Refresh] Triggering scheduled update.");

                // RE-GEOLOCATE CHECK
                if (isTrackingCurrentLocation.current && navigator.geolocation) {
                    console.log("[Smart Refresh] Tracking GPS -> Re-acquiring position...");
                    navigator.geolocation.getCurrentPosition(
                        (pos) => {
                            const { latitude, longitude } = pos.coords;
                            // Update Location AND Data
                            fetchWeather("Current Location", true, { lat: latitude, lon: longitude });
                        },
                        (err) => {
                            console.warn("GPS Refresh failed, falling back to static refresh.", err);
                            const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                            if (loc) fetchWeather(loc, false);
                        },
                        { timeout: 10000, enableHighAccuracy: true }
                    );
                } else {
                    // Static Refresh (Data Only)
                    const loc = weatherDataRef.current?.locationName || settingsRef.current.defaultLocation;
                    if (loc) {
                        console.log("[Smart Refresh] Static Location -> Refreshing Data Only.");
                        fetchWeather(loc, false);
                    }
                }
            }
        }, 10000);

        return () => clearInterval(checkInterval);
    }, [nextUpdate, fetchWeather]);
};
