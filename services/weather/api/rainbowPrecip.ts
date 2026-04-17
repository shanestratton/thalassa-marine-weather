/**
 * rainbowPrecip — Rainbow.ai Global Nowcast precipitation forecast.
 *
 * Fetches minute-by-minute precipitation at a specific lat/lon over the next
 * 4 hours using Rainbow.ai's Nowcast API via the Supabase edge proxy.
 *
 * Rainbow Global blends 5 geostationary satellites + ~800 radars worldwide
 * for 1km² resolution, 1-minute temporal granularity, global coverage.
 *
 * Returns MinutelyRain[] with precipType (rain/snow/mixed) for RainForecastCard.
 */

import { createLogger } from '../../../utils/createLogger';
import { piCache } from '../../PiCacheService';

const log = createLogger('RainbowPrecip');

/** Same interface as WeatherKit's MinutelyRain, extended with precipType */
export interface RainbowMinutelyRain {
    time: string; // ISO timestamp
    intensity: number; // mm/hr
    precipType?: string; // 'rain' | 'snow' | 'mixed' etc. (from Rainbow Global)
}

export interface RainbowPrecipResult {
    rain: RainbowMinutelyRain[];
    summary: string;
    source: 'rainbow.ai';
    /** Number of forecast hours covered (up to 4) */
    forecastHours: number;
}

// ── Supabase helpers ──────────────────────────────────────────

function getSupabaseUrl(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) {
        return import.meta.env.VITE_SUPABASE_URL;
    }
    return '';
}

function getSupabaseKey(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) {
        return import.meta.env.VITE_SUPABASE_KEY;
    }
    return '';
}

// ── Cache ─────────────────────────────────────────────────────

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let cached: { data: RainbowPrecipResult; fetchedAt: number; key: string } | null = null;

// ── Intensity helpers ──────────────────────────────────────────

function getIntensityLabel(mmHr: number): string {
    if (mmHr < 0.1) return 'Clear';
    if (mmHr < 1) return 'Drizzle';
    if (mmHr < 4) return 'Light Rain';
    if (mmHr < 16) return 'Moderate Rain';
    if (mmHr < 50) return 'Heavy Rain';
    return 'Extreme Rain';
}

function buildSummary(data: RainbowMinutelyRain[]): string {
    if (!data || data.length === 0) return 'No data available';

    const THRESHOLD = 0.1;
    const now = Date.now();
    const firstRain = data.find((d) => d.intensity >= THRESHOLD);
    const isRaining = data[0]?.intensity >= THRESHOLD;

    if (!firstRain) return 'No precipitation expected next 4 hours';

    if (isRaining) {
        const dryEntry = data.find((d, i) => i > 0 && d.intensity < THRESHOLD);
        if (dryEntry) {
            const minsUntilDry = Math.max(1, Math.round((new Date(dryEntry.time).getTime() - now) / 60000));
            return `${getIntensityLabel(data[0].intensity)} stopping in ~${minsUntilDry} min`;
        }
        return `${getIntensityLabel(Math.max(...data.map((d) => d.intensity)))} continuing`;
    }

    const minsUntilRain = Math.max(1, Math.round((new Date(firstRain.time).getTime() - now) / 60000));
    if (minsUntilRain <= 60) {
        return `${getIntensityLabel(firstRain.intensity)} in ${minsUntilRain} min`;
    }
    const hours = Math.round(minsUntilRain / 60);
    return `${getIntensityLabel(firstRain.intensity)} in ~${hours}h`;
}

// ── Main fetcher ──────────────────────────────────────────────

/**
 * Fetch point precipitation forecast from Rainbow.ai.
 *
 * Uses the Rainbow Global Nowcast API via the proxy-rainbow edge function.
 * The Nowcast API returns minute-by-minute JSON directly — no tile decoding needed.
 * Includes precipType (rain/snow/mixed) for each minute.
 */
export async function fetchRainbowPrecip(lat: number, lon: number): Promise<RainbowPrecipResult | null> {
    const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (cached && cached.key === cacheKey && Date.now() - cached.fetchedAt < CACHE_TTL) {
        return cached.data;
    }

    const supabaseUrl = getSupabaseUrl();
    if (!supabaseUrl) {
        log.warn('No Supabase URL configured — cannot fetch Rainbow.ai data');
        return null;
    }

    try {
        // ── Rainbow Global Nowcast API (via proxy) ──
        const nowcastUrl = `${supabaseUrl}/functions/v1/proxy-rainbow?action=nowcast&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;

        let nowcastData: {
            forecast?: { precipRate: number; precipType?: string; timestampBegin: number; timestampEnd: number }[];
            summary?: { intensity: string };
        } | null = null;

        // Try Pi Cache first for offline support
        if (piCache.isAvailable()) {
            try {
                const piUrl = piCache.passthroughUrl(nowcastUrl, 5 * 60 * 1000, 'rainbow-nowcast');
                if (piUrl) {
                    const piRes = await fetch(piUrl, { signal: AbortSignal.timeout(8000) });
                    if (piRes.ok) {
                        nowcastData = await piRes.json();
                        log.info('Rainbow.ai nowcast served from Pi Cache');
                    }
                }
            } catch {
                // Pi failed — try direct
            }
        }

        if (!nowcastData) {
            const key = getSupabaseKey();
            const res = await fetch(nowcastUrl, {
                headers: key ? { Authorization: `Bearer ${key}`, apikey: key } : {},
                signal: AbortSignal.timeout(15000),
            });

            if (res.ok) {
                nowcastData = await res.json();
            } else {
                log.warn(`Rainbow.ai nowcast fetch HTTP ${res.status}`);
                return null;
            }
        }

        const forecast = nowcastData?.forecast;
        if (!forecast || forecast.length === 0) {
            log.info('Rainbow.ai nowcast: no forecast data returned');
            return null;
        }

        // Map Rainbow's native minute-by-minute format
        const rain: RainbowMinutelyRain[] = forecast.map((f) => ({
            time: new Date(f.timestampBegin * 1000).toISOString(),
            intensity: Math.round((f.precipRate ?? 0) * 100) / 100,
            precipType: f.precipType || undefined,
        }));

        const result: RainbowPrecipResult = {
            rain,
            summary: buildSummary(rain),
            source: 'rainbow.ai',
            forecastHours: 4,
        };

        // Use Rainbow's intensity classification if available
        if (nowcastData?.summary?.intensity && nowcastData.summary.intensity !== 'none') {
            const intensity = nowcastData.summary.intensity;
            result.summary = `${intensity.charAt(0).toUpperCase() + intensity.slice(1)} precipitation`;
        }

        cached = { data: result, fetchedAt: Date.now(), key: cacheKey };
        log.info(`Rainbow.ai nowcast: ${rain.length} minute points`);
        return result;
    } catch (err) {
        log.error('Rainbow.ai precipitation fetch failed:', err);
        return null;
    }
}

// ── REMOVED: Client-side tile reading, Canvas pixel extraction,
// Web Mercator tile math, dBZ→mm/hr conversion, interpolation ──
//
// The Rainbow Global Nowcast API (/nowcast/v1/precip-global/{lon}/{lat})
// returns minute-by-minute precipitation data as JSON directly.
// No more fetching 14 PNG tiles, decoding pixels, and interpolating.
// This also gives us precipType (rain/snow/mixed) which tiles couldn't.
