/**
 * waveField.ts — Multi-point wave/swell forecast fetcher for routing.
 *
 * Hits Open-Meteo Marine API with batched comma-separated lat/lon to
 * get wave height + direction + period across a sparse grid spanning
 * the route bounding box. The result is consumed by the
 * WaveFieldAdapter which interpolates over (lat, lon, time) and feeds
 * the isochrone engine's polar-with-waves slowdown calculation.
 *
 * Why a sparse grid (5×5) and not the full route polyline:
 *   - Wave fields have large spatial autocorrelation length (~50 NM)
 *   - 25 batched points cover a passage area well enough for routing
 *   - Single API call is fast and cheap on Open-Meteo's quota
 *   - Hourly resolution per point gives the isochrone engine
 *     point-in-time data for any (lat, lon, t) it queries
 *
 * Cache: in-memory keyed by route bbox + departure date. Fresh for
 * 30 minutes (the underlying GFS-Wave / ECMWF wave models don't
 * update faster than that).
 */

import { createLogger } from '../../utils/createLogger';

const log = createLogger('WaveField');

export interface WaveSample {
    /** Sample point latitude. */
    lat: number;
    /** Sample point longitude. */
    lon: number;
    /** Hourly wave heights (m) starting at the response's reference time. */
    heightM: number[];
    /** Hourly wave directions FROM (deg true). */
    directionFromDeg: number[];
    /** Hourly wave periods (seconds). */
    periodS: number[];
}

export interface WaveFieldData {
    /** ISO 8601 reference time — index 0 of each sample's hourly arrays. */
    referenceTimeIso: string;
    /** Total hours of forecast (typically 168 = 7 days). */
    totalHours: number;
    /** Sparse sample grid — typically 5×5 = 25 points over the route bbox. */
    samples: WaveSample[];
}

// In-memory cache. Wave forecasts don't change faster than ~30 min.
const cache = new Map<string, { data: WaveFieldData; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function cacheKey(north: number, south: number, east: number, west: number, baseDate: string): string {
    return `${north.toFixed(1)}_${south.toFixed(1)}_${east.toFixed(1)}_${west.toFixed(1)}_${baseDate}`;
}

/**
 * Build a 5×5 lat/lon grid covering the bounding box.
 * Endpoints are inset slightly to avoid land-edge points where the
 * marine API often returns null.
 */
function buildGrid(
    north: number,
    south: number,
    east: number,
    west: number,
    nLat = 5,
    nLon = 5,
): { lat: number; lon: number }[] {
    const points: { lat: number; lon: number }[] = [];
    const dLat = (north - south) / (nLat - 1);
    const dLon = (east - west) / (nLon - 1);
    for (let i = 0; i < nLat; i++) {
        for (let j = 0; j < nLon; j++) {
            points.push({
                lat: south + i * dLat,
                lon: west + j * dLon,
            });
        }
    }
    return points;
}

/**
 * Fetch wave field data for a route bounding box.
 *
 * Returns null on any failure so the caller (isochroneEnhancer) can
 * route without wave penalty — the engine treats null as "no wave
 * data, polar gives raw boat speed".
 */
export async function fetchWaveField(
    bbox: { north: number; south: number; east: number; west: number },
    departureTime: string,
): Promise<WaveFieldData | null> {
    const baseDate = departureTime.split('T')[0];
    const key = cacheKey(bbox.north, bbox.south, bbox.east, bbox.west, baseDate);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
        log.info('cache hit');
        return hit.data;
    }

    const points = buildGrid(bbox.north, bbox.south, bbox.east, bbox.west);
    const lats = points.map((p) => p.lat.toFixed(3)).join(',');
    const lons = points.map((p) => p.lon.toFixed(3)).join(',');

    try {
        // Try the customer endpoint first if a key is available
        const { getOpenMeteoKey } = await import('./keys');
        const omKey = getOpenMeteoKey();
        const keyParam = omKey ? `&apikey=${omKey}` : '';
        const baseUrl = omKey
            ? 'https://customer-marine-api.open-meteo.com/v1/marine'
            : 'https://marine-api.open-meteo.com/v1/marine';

        const url =
            `${baseUrl}?` +
            `latitude=${lats}&longitude=${lons}` +
            `&hourly=wave_height,wave_direction,wave_period` +
            `&forecast_days=7&timezone=UTC${keyParam}`;

        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) {
            log.warn(`fetch failed: HTTP ${res.status}`);
            return null;
        }
        const data = await res.json();

        // Open-Meteo returns either a single object (one point) or an
        // array (multiple points). Normalise to array.
        const arr: unknown[] = Array.isArray(data) ? data : [data];
        if (arr.length !== points.length) {
            log.warn(`expected ${points.length} points, got ${arr.length}`);
        }

        const samples: WaveSample[] = [];
        let referenceTimeIso = '';
        let totalHours = 0;

        for (let i = 0; i < arr.length; i++) {
            const row = arr[i] as {
                latitude?: number;
                longitude?: number;
                hourly?: {
                    time?: string[];
                    wave_height?: (number | null)[];
                    wave_direction?: (number | null)[];
                    wave_period?: (number | null)[];
                };
            };
            const hourly = row?.hourly;
            if (!hourly?.time || !hourly.wave_height || !hourly.wave_direction || !hourly.wave_period) continue;

            // Use the first valid time as reference
            if (!referenceTimeIso && hourly.time[0]) {
                referenceTimeIso = hourly.time[0];
                totalHours = hourly.time.length;
            }

            samples.push({
                lat: row.latitude ?? points[i]?.lat ?? 0,
                lon: row.longitude ?? points[i]?.lon ?? 0,
                heightM: hourly.wave_height.map((v) => (v == null || isNaN(v) ? 0 : v)),
                directionFromDeg: hourly.wave_direction.map((v) => (v == null || isNaN(v) ? 0 : v)),
                periodS: hourly.wave_period.map((v) => (v == null || isNaN(v) ? 8 : v)),
            });
        }

        if (samples.length === 0) {
            log.warn('no usable samples returned');
            return null;
        }

        const result: WaveFieldData = {
            referenceTimeIso,
            totalHours,
            samples,
        };
        cache.set(key, { data: result, fetchedAt: Date.now() });
        log.info(`loaded ${samples.length} sample points × ${totalHours}h`);
        return result;
    } catch (e) {
        log.warn('fetch threw:', e);
        return null;
    }
}
