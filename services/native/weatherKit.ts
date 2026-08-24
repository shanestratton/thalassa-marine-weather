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
import { withTimeout } from '../../utils/deadline';

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
/**
 * The native call gets a hard deadline. Measured 2026-08-20 (simulator, but
 * the failure mode is Apple's, not the simulator's): a WeatherKit fetch that
 * cannot authenticate does not reject — it HANGS silently. Both consumers
 * sit in front of the Glass page's first paint inside an 8 s source budget,
 * and unified never reached its Supabase fallback at all, so a hung native
 * call cost the full budget twice (`weatherkit=8003! unified=8000!`). A
 * healthy on-device answer arrives in well under a second; three gives a
 * cold first call room without letting a hang eat the fetch.
 */
const NATIVE_DEADLINE_MS = 3_000;

export async function fetchWeatherKitNative(lat: number, lon: number): Promise<unknown | null> {
    if (!Capacitor.isNativePlatform()) return null;
    try {
        const result = await withTimeout<unknown | null>(
            WeatherKitNative.fetch({ lat, lon }),
            null,
            NATIVE_DEADLINE_MS,
        );
        if (result === null) {
            log.warn(`native fetch exceeded ${NATIVE_DEADLINE_MS}ms — falling back to Supabase`);
            return null;
        }
        if (!result || typeof result !== 'object') {
            log.warn('native fetch returned unexpected payload');
            return null;
        }
        return result;
    } catch (err) {
        // Most common reason: WeatherKit capability not granted (entitlement
        // missing or Apple Dev portal capability not enabled). Caller falls
        // back to the Supabase path transparently.
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('native WeatherKit unavailable — falling back to Supabase:', msg);
        return null;
    }
}
