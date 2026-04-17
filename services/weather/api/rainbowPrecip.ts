/**
 * rainbowPrecip — Rainbow.ai point precipitation forecast.
 *
 * Fetches precipitation intensity at a specific lat/lon over the next 4 hours
 * using Rainbow.ai's tile API via the Supabase edge proxy.
 *
 * Server-side: proxy-rainbow edge function decodes tiles and returns JSON.
 * Fallback: client-side tile pixel reading via Canvas API.
 *
 * Returns MinutelyRain[] compatible with RainForecastCard.
 */

import { createLogger } from '../../../utils/createLogger';
import { piCache } from '../../PiCacheService';

const log = createLogger('RainbowPrecip');

/** Same interface as WeatherKit's MinutelyRain */
export interface RainbowMinutelyRain {
    time: string; // ISO timestamp
    intensity: number; // mm/hr
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

// ── Tile math (Web Mercator) ──────────────────────────────────

function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
    const n = Math.pow(2, zoom);
    const x = Math.floor(((lon + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
    return { x, y };
}

function latLonToPixelInTile(
    lat: number,
    lon: number,
    zoom: number,
    tileX: number,
    tileY: number,
): { px: number; py: number } {
    const n = Math.pow(2, zoom);
    const px = Math.floor((((lon + 180) / 360) * n - tileX) * 256);
    const latRad = (lat * Math.PI) / 180;
    const py = Math.floor((((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n - tileY) * 256);
    return { px: Math.max(0, Math.min(255, px)), py: Math.max(0, Math.min(255, py)) };
}

/**
 * Convert dBZ u8 pixel value to mm/hr using Z-R relationship.
 * Rainbow.ai dbz_u8: pixel 0-11 = no rain, 12-83 = light→heavy precip.
 * Uses Marshall-Palmer Z = 200 * R^1.6
 */
function dbzU8ToMmHr(pixel: number): number {
    if (pixel < 12) return 0;
    // Map pixel 12-83 → dBZ 5-55 (typical reflectivity range)
    const dBZ = 5 + ((pixel - 12) * 50) / 71;
    const Z = Math.pow(10, dBZ / 10);
    const R = Math.pow(Z / 200, 1 / 1.6);
    return Math.round(R * 100) / 100;
}

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
 * Uses server-side proxy (action=point) which decodes tiles on the edge.
 * Falls back to client-side Canvas pixel reading if proxy doesn't support point action.
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
        // ── Strategy 1: Server-side point forecast (proxy-rainbow action=point) ──
        const pointUrl = `${supabaseUrl}/functions/v1/proxy-rainbow?action=point&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;

        let pointData: { snapshot: number; data: { forecastMinutes: number; intensity: number }[] } | null = null;

        // Try Pi Cache first for offline support
        if (piCache.isAvailable()) {
            try {
                const piUrl = piCache.passthroughUrl(pointUrl, 5 * 60 * 1000, 'rainbow-point');
                if (piUrl) {
                    const piRes = await fetch(piUrl, { signal: AbortSignal.timeout(8000) });
                    if (piRes.ok) {
                        pointData = await piRes.json();
                        log.info('Rainbow.ai point forecast served from Pi Cache');
                    }
                }
            } catch {
                // Pi failed — try direct
            }
        }

        if (!pointData) {
            const key = getSupabaseKey();
            const res = await fetch(pointUrl, {
                headers: key ? { Authorization: `Bearer ${key}` } : {},
                signal: AbortSignal.timeout(15000),
            });

            if (res.ok) {
                pointData = await res.json();
            } else if (res.status === 400) {
                // Proxy doesn't support point action yet — fall through to client-side
                log.info('Proxy point action not available, falling back to client-side tile reading');
            } else {
                log.warn(`Rainbow.ai point fetch HTTP ${res.status}`);
            }
        }

        if (pointData?.data) {
            const rain = interpolateToMinutely(pointData.data);
            const result: RainbowPrecipResult = {
                rain,
                summary: buildSummary(rain),
                source: 'rainbow.ai',
                forecastHours: 4,
            };
            cached = { data: result, fetchedAt: Date.now(), key: cacheKey };
            return result;
        }

        // ── Strategy 2: Client-side tile pixel reading ──
        return await fetchRainbowPrecipClientSide(lat, lon, supabaseUrl);
    } catch (err) {
        log.error('Rainbow.ai precipitation fetch failed:', err);
        return null;
    }
}

// ── Client-side tile reading fallback ──────────────────────────

async function fetchRainbowPrecipClientSide(
    lat: number,
    lon: number,
    supabaseUrl: string,
): Promise<RainbowPrecipResult | null> {
    try {
        // 1. Get snapshot
        const snapRes = await fetch(`${supabaseUrl}/functions/v1/proxy-rainbow?action=snapshot`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!snapRes.ok) return null;
        const { snapshot } = await snapRes.json();
        if (!snapshot) return null;

        // 2. Calculate tile coordinates (zoom 10 — good balance of resolution vs tile count)
        const zoom = 10;
        const { x: tileX, y: tileY } = latLonToTile(lat, lon, zoom);
        const { px: pixelX, py: pixelY } = latLonToPixelInTile(lat, lon, zoom, tileX, tileY);

        // 3. Forecast time steps: 0-60 min every 10 min, then 80-240 min for extended
        const forecastMinutes = [0, 10, 20, 30, 40, 50, 60, 80, 100, 120, 150, 180, 210, 240];

        // Create shared canvas for pixel reading
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
            log.error('Canvas 2D context not available');
            return null;
        }

        // 4. Fetch tiles in parallel (batch of 4 for network friendliness)
        const rawPoints: { forecastMinutes: number; intensity: number }[] = [];
        const BATCH_SIZE = 4;

        for (let batch = 0; batch < forecastMinutes.length; batch += BATCH_SIZE) {
            const batchMins = forecastMinutes.slice(batch, batch + BATCH_SIZE);
            const batchResults = await Promise.allSettled(
                batchMins.map(async (min) => {
                    const secs = min * 60;
                    const tileUrl =
                        `${supabaseUrl}/functions/v1/proxy-rainbow?action=tile` +
                        `&snapshot=${snapshot}&forecast=${secs}&z=${zoom}&x=${tileX}&y=${tileY}&color=dbz_u8`;

                    const res = await fetch(tileUrl, { signal: AbortSignal.timeout(8000) });
                    if (!res.ok) throw new Error(`Tile HTTP ${res.status}`);

                    const blob = await res.blob();
                    const url = URL.createObjectURL(blob);
                    try {
                        const img = new Image();
                        img.crossOrigin = 'anonymous';
                        await new Promise<void>((resolve, reject) => {
                            img.onload = () => resolve();
                            img.onerror = () => reject(new Error('Image load failed'));
                            img.src = url;
                        });

                        ctx.clearRect(0, 0, 256, 256);
                        ctx.drawImage(img, 0, 0);
                        const pixel = ctx.getImageData(pixelX, pixelY, 1, 1).data;
                        return { forecastMinutes: min, intensity: dbzU8ToMmHr(pixel[0]) };
                    } finally {
                        URL.revokeObjectURL(url);
                    }
                }),
            );

            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    rawPoints.push(result.value);
                }
            }
        }

        // Clean up canvas
        canvas.remove();

        if (rawPoints.length === 0) {
            log.warn('No tile data retrieved from Rainbow.ai');
            return null;
        }

        // Sort by time
        rawPoints.sort((a, b) => a.forecastMinutes - b.forecastMinutes);

        // 5. Interpolate to minute-by-minute
        const rain = interpolateToMinutely(rawPoints);
        const result: RainbowPrecipResult = {
            rain,
            summary: buildSummary(rain),
            source: 'rainbow.ai',
            forecastHours: 4,
        };
        cached = { data: result, fetchedAt: Date.now(), key: `${lat.toFixed(3)},${lon.toFixed(3)}` };
        log.info(`Rainbow.ai client-side: ${rawPoints.length} tiles → ${rain.length} minute points`);
        return result;
    } catch (err) {
        log.error('Client-side Rainbow.ai pixel reading failed:', err);
        return null;
    }
}

// ── Interpolation ──────────────────────────────────────────────

/**
 * Interpolate sparse forecast points to minute-by-minute resolution.
 * Covers the full 240-minute (4 hour) forecast, but the first 60 points
 * are compatible with the WeatherKit MinutelyRain interface.
 */
function interpolateToMinutely(points: { forecastMinutes: number; intensity: number }[]): RainbowMinutelyRain[] {
    if (points.length === 0) return [];

    const now = Date.now();
    const maxMin = Math.max(...points.map((p) => p.forecastMinutes), 60);
    const result: RainbowMinutelyRain[] = [];

    for (let m = 0; m <= maxMin; m++) {
        const time = new Date(now + m * 60000).toISOString();

        // Find bracketing data points
        const before = points.filter((p) => p.forecastMinutes <= m).slice(-1)[0];
        const after = points.find((p) => p.forecastMinutes > m);

        if (!before) {
            result.push({ time, intensity: 0 });
        } else if (!after || before.forecastMinutes === m) {
            result.push({ time, intensity: before.intensity });
        } else {
            // Linear interpolation
            const t = (m - before.forecastMinutes) / (after.forecastMinutes - before.forecastMinutes);
            const intensity = before.intensity + t * (after.intensity - before.intensity);
            result.push({ time, intensity: Math.round(intensity * 100) / 100 });
        }
    }

    return result;
}
