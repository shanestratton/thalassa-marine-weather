/**
 * weatherKit — Native Apple WeatherKit bridge.
 *
 * Calls the `WeatherKit` Capacitor plugin (ios/App/App/WeatherKitPlugin.swift)
 * which wraps Apple's native WeatherKit framework. Returns a JSON payload
 * that matches the WeatherKit REST API shape (currentWeather /
 * forecastHourly / forecastDaily / forecastNextHour) so the existing
 * client-side mappers in services/weather/api/weatherkit.ts can consume it
 * unchanged.
 *
 * Why this file exists: the Supabase edge-function path adds 500ms-1s of
 * cold start latency on every first call. Going native saves all of that
 * by authenticating through the device's App Store identity instead of
 * signing a JWT with an Apple private key on the server.
 *
 * Gated on Capacitor.isNativePlatform() — web users continue through the
 * Supabase REST path because browsers can't use the native framework.
 *
 * Gracefully returns null if the native call fails (e.g. WeatherKit
 * capability not yet enabled in Xcode / Apple Developer portal). Callers
 * fall back to the Supabase path on null.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('weatherKitNative');

interface WeatherKitNativePlugin {
    fetch(options: { lat: number; lon: number }): Promise<unknown>;
}

const WeatherKitNative = registerPlugin<WeatherKitNativePlugin>('WeatherKit');

/**
 * Try to fetch via the native WeatherKit framework. Returns the raw
 * REST-shaped JSON on success, or null if unavailable (non-native
 * platform, missing entitlement, network error, etc.). Callers should
 * fall back to the Supabase REST path on null.
 */
export async function fetchWeatherKitNative(lat: number, lon: number): Promise<unknown | null> {
    if (!Capacitor.isNativePlatform()) {
        return null;
    }
    try {
        const result = await WeatherKitNative.fetch({ lat, lon });
        if (!result || typeof result !== 'object') {
            log.warn('Native fetch returned unexpected payload');
            return null;
        }
        // log.info is a no-op in production builds; using log.warn so the
        // success line shows up in Xcode Console when verifying the native
        // path is active. Not an actual warning, just routing around the
        // createLogger prod filter.
        log.warn('Native WeatherKit hit:', Object.keys(result as Record<string, unknown>).join(','));
        return result;
    } catch (err) {
        // Most common reason: WeatherKit capability not yet enabled in
        // Xcode / Apple Developer portal. Caller falls back to Supabase.
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('Native WeatherKit unavailable — falling back to Supabase:', msg);
        return null;
    }
}
