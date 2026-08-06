import { Capacitor } from '@capacitor/core';

/**
 * Weather payloads below carry a requested point, a route corridor, or a
 * forecast derived for one of those locations. They remain useful as bounded
 * browser caches, but must never survive in WebKit localStorage inside the iOS
 * app. Native durable weather storage has a separate encrypted implementation.
 */
export const PLAINTEXT_WEATHER_CACHE_PREFIXES = Object.freeze([
    'marine_weather_cache_',
    'thalassa_apicache_',
    'thalassa_rain_',
    'thalassa_ocean_currents_',
    'thalassa_weather_windows',
]);

export const PLAINTEXT_WEATHER_CACHE_KEYS = Object.freeze(['last_marine_report']);

export function isIosPlaintextWeatherCacheBlocked(): boolean {
    try {
        const platform = Capacitor.getPlatform();
        if (platform === 'ios') return true;
        if (platform === 'web' || platform === 'android') return false;
        return Capacitor.isNativePlatform();
    } catch {
        // If Capacitor cannot identify a native runtime, fail closed. A cache
        // miss only costs a network fetch; guessing web could retain a precise
        // position in plaintext on a device.
        try {
            return Capacitor.isNativePlatform();
        } catch {
            return true;
        }
    }
}

/** Shared matcher for account deletion and platform-specific cleanup. */
export function isPlaintextWeatherCacheKey(key: string): boolean {
    return (
        PLAINTEXT_WEATHER_CACHE_KEYS.includes(key) ||
        PLAINTEXT_WEATHER_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))
    );
}

/** Remove every known current and retired direct weather localStorage family. */
export function scrubIosPlaintextWeatherCaches(): number {
    if (!isIosPlaintextWeatherCacheBlocked() || typeof localStorage === 'undefined') return 0;

    const keys: string[] = [];
    try {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key && isPlaintextWeatherCacheKey(key)) keys.push(key);
        }
    } catch {
        return 0;
    }

    let removed = 0;
    for (const key of keys) {
        try {
            localStorage.removeItem(key);
            removed += 1;
        } catch {
            // Access remains denied below even if WebKit refuses cleanup.
        }
    }
    return removed;
}

/**
 * Gate direct localStorage caches at every read and write. On iOS, checking the
 * gate also opportunistically erases any value left by an older app build.
 */
export function canUsePlaintextWeatherCache(): boolean {
    if (!isIosPlaintextWeatherCacheBlocked()) return true;
    scrubIosPlaintextWeatherCaches();
    return false;
}

export function readPlaintextWeatherCacheItem(key: string): string | null {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return null;
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function writePlaintextWeatherCacheItem(key: string, value: string): boolean {
    if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return false;
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}
