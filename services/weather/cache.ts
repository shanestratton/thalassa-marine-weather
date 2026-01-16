
import { MarineWeatherReport } from '../../types';

const CACHE_KEY_PREFIX = 'marine_weather_cache_v6_';

interface CacheEntry {
    timestamp: number;
    data: MarineWeatherReport;
    model: string;
}

export const differenceInMinutes = (date1: Date, date2: Date): number => {
    return Math.abs((date1.getTime() - date2.getTime()) / 60000);
};

export const saveToCache = (locationName: string, data: MarineWeatherReport): void => {
    try {
        const key = CACHE_KEY_PREFIX + locationName.replace(/\s+/g, '_').toLowerCase();
        const entry: CacheEntry = {
            timestamp: Date.now(),
            data: data,
            model: data.modelUsed
        };
        localStorage.setItem(key, JSON.stringify(entry));
        // Also cache generic "last_report" for potential recovery
        localStorage.setItem('last_marine_report', JSON.stringify(data));
    } catch (e) {
        console.warn('Cache Save Failed', e);
    }
};

export const getFromCache = (locationName: string): MarineWeatherReport | null => {
    try {
        const key = CACHE_KEY_PREFIX + locationName.replace(/\s+/g, '_').toLowerCase();
        const raw = localStorage.getItem(key);
        if (!raw) return null;

        const entry: CacheEntry = JSON.parse(raw);
        const ageMinutes = (Date.now() - entry.timestamp) / 60000;

        // Validity Rules:
        // 1. If Precision Model (SG), valid for 60 mins.
        // 2. If Fast Model (OpenMeteo), valid for 30 mins.

        const isPrecision = entry.model && entry.model.includes('stormglass');
        const maxAge = isPrecision ? 60 : 30;

        if (ageMinutes < maxAge) {

            return entry.data;
        } else {

            return null;
        }
    } catch (e) {
        return null; // Corrupt cache
    }
};

export const clearCache = (locationName?: string) => {
    if (locationName) {
        const key = CACHE_KEY_PREFIX + locationName.replace(/\s+/g, '_').toLowerCase();
        localStorage.removeItem(key);
    } else {
        // Clear all (Iterate keys? Risk affecting other apps? No, we use prefix)
        // Simple: just leave it, LRU is browser managed.
    }
};
