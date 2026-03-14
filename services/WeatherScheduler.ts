/**
 * WeatherScheduler — Pure scheduling logic for weather update intervals.
 *
 * Extracted from WeatherContext.tsx to enable direct testing and reuse.
 * All functions are pure (no React, no side effects).
 */

import type { MarineWeatherReport } from '../types';

// ── INTELLIGENT UPDATE INTERVALS ──
// All snapped to clock boundaries (:00, :10, :20, :30, :40, :50)
export const INLAND_INTERVAL = 60 * 60 * 1000;        // 60 mins (hourly) — top of hour
export const OFFSHORE_INTERVAL = 60 * 60 * 1000;      // 60 mins (hourly) — top of hour
export const COASTAL_INTERVAL = 30 * 60 * 1000;       // 30 mins — :00 or :30
export const BAD_WEATHER_INTERVAL = 10 * 60 * 1000;   // 10 mins — :00/:10/:20/:30/:40/:50
export const SATELLITE_INTERVAL = 3 * 60 * 60 * 1000; // 3 hours — satellite/Iridium GO! bandwidth conservation
export const AI_UPDATE_INTERVAL = 3 * 60 * 60 * 1000; // 3 Hours
export const LIVE_OVERLAY_INTERVAL = 5 * 60 * 1000;   // 5 mins — lightweight temp/conditions poll

// ── Bad Weather Detection ──

/**
 * Determines if current conditions or near-term forecast indicate bad weather.
 *
 * Triggers include:
 * - Active weather alerts
 * - Wind or gusts > 25 kts
 * - Wave height > 2.5m
 * - Heavy rain > 5 mm/h
 * - Visibility < 2 nm
 * - Forecast wind > 30 kts in next 12 hours
 */
export const isBadWeather = (weather: MarineWeatherReport): boolean => {
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

// ── Update Interval Selection ──

/**
 * Get update interval based on location type, weather conditions, and whether
 * this is the user's current GPS location.
 *
 * Priority chain:
 * 1. Satellite mode → 3h (always)
 * 2. Non-current location → 60 min (always)
 * 3. Bad weather → 10 min (any location type)
 * 4. Location-specific: inland=60m, coastal=30m, offshore=60m
 */
export const getUpdateInterval = (
    locationType: 'inland' | 'coastal' | 'offshore',
    weather: MarineWeatherReport,
    isCurrentLocation: boolean = true,
    satelliteMode: boolean = false
): number => {
    // 0. SATELLITE MODE OVERRIDE — 3h for all locations
    if (satelliteMode) {
        return SATELLITE_INTERVAL;
    }

    // 1. Non-current-location override — always hourly regardless of type/weather
    if (!isCurrentLocation) {
        return INLAND_INTERVAL; // 60 mins
    }

    // 2. Bad weather override — any location type gets 10m refresh
    if (isBadWeather(weather)) {
        return BAD_WEATHER_INTERVAL;
    }

    // 3. Location-specific intervals (normal weather)
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

// ── Smart Clock Alignment ──

/**
 * Snaps the next update time to a clean clock boundary.
 *
 * - Hourly (inland/offshore): aligns to :00
 * - 30min (coastal): aligns to :00 or :30
 * - 10min (bad weather): aligns to :00/:10/:20/:30/:40/:50
 */
export const alignToNextInterval = (intervalMs: number): number => {
    const now = Date.now();
    const date = new Date(now);

    // Hourly (inland/offshore): align to top of next hour (:00)
    if (intervalMs >= INLAND_INTERVAL) {
        date.setMinutes(0, 0, 0);
        date.setHours(date.getHours() + 1);
        return date.getTime();
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
        return date.getTime();
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
        return date.getTime();
    }

    // Fallback: raw offset
    return now + intervalMs;
};
