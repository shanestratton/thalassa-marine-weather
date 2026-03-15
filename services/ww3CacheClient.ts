/**
 * WW3 Cache Client — Fetch pre-cached WaveWatch III data from Supabase Storage
 *
 * The ww3_precache.py cron job uploads JSON shards per forecast hour.
 * This service fetches the relevant shards for a given passage timeframe
 * and converts them into a WindGrid-compatible format for the WindParticleLayer.
 *
 * Pipeline:
 *   1. Fetch ww3_latest.json (metadata) to find the current cycle
 *   2. Download shards for needed forecast hours
 *   3. Build a WindGrid from wave data (U/V from wave direction + height)
 *   4. Feed into WindStore for the passage map's particle layer
 */

import type { WindGrid } from '../services/weather/windField';

// ── Types ─────────────────────────────────────────────────────────

interface WW3Metadata {
    cycle: string;
    valid_from: string;
    valid_to: string;
    hours_available: number[];
    total_hours: number;
    bucket: string;
    file_pattern: string;
}

interface WW3Shard {
    cycle: string;
    forecast_hour: number;
    valid_time: string;
    grid: {
        nlat: number;
        nlon: number;
        lat_min: number;
        lat_max: number;
        lon_min: number;
        lon_max: number;
        resolution_deg: number;
    };
    data: {
        wave_ht_m?: number[];
        peak_period_s?: number[];
        wave_dir_deg?: number[];
        wind_wave_ht_m?: number[];
        swell_ht_m?: number[];
    };
}

/** Wave conditions at a specific location and time */
export interface WaveConditions {
    wave_ht_m: number;
    peak_period_s: number;
    wave_dir_deg: number;
    wind_wave_ht_m: number;
    swell_ht_m: number;
}

// ── Config ────────────────────────────────────────────────────────

const getSupabaseUrl = (): string => (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

const STORAGE_BUCKET = 'ww3-cache';

// ── Cache ─────────────────────────────────────────────────────────

let metadataCache: WW3Metadata | null = null;
let metadataFetchedAt = 0;
const shardCache = new Map<string, WW3Shard>();
const METADATA_TTL = 10 * 60 * 1000; // 10 min

// ── Fetch Helpers ─────────────────────────────────────────────────

async function fetchMetadata(): Promise<WW3Metadata | null> {
    const now = Date.now();
    if (metadataCache && now - metadataFetchedAt < METADATA_TTL) {
        return metadataCache;
    }

    const url = `${getSupabaseUrl()}/storage/v1/object/public/${STORAGE_BUCKET}/ww3_latest.json`;

    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!resp.ok) return null;
        metadataCache = await resp.json();
        metadataFetchedAt = now;
        return metadataCache;
    } catch (e) {
        console.warn('[ww3Cache]', e);
        return null;
    }
}

async function fetchShard(cycle: string, forecastHour: number): Promise<WW3Shard | null> {
    const key = `${cycle}_f${forecastHour.toString().padStart(3, '0')}`;
    if (shardCache.has(key)) return shardCache.get(key)!;

    const filename = `ww3_${key}.json`;
    const url = `${getSupabaseUrl()}/storage/v1/object/public/${STORAGE_BUCKET}/${filename}`;

    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!resp.ok) return null;
        const shard: WW3Shard = await resp.json();
        shardCache.set(key, shard);
        return shard;
    } catch (e) {
        console.warn('[ww3Cache]', e);
        return null;
    }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Fetch WW3 wave data for the passage timeframe and convert to WindGrid format.
 *
 * The WindParticleLayer expects a WindGrid with U/V arrays. We synthesize
 * pseudo-wind vectors from wave direction + height so the particles
 * visualize wave propagation direction and intensity.
 *
 * @param durationHours How many hours of forecast to fetch
 * @returns WindGrid or null if WW3 data unavailable
 */
export async function fetchWW3Grid(durationHours: number = 120): Promise<WindGrid | null> {
    const meta = await fetchMetadata();
    if (!meta) {
        return null;
    }

    // Determine which forecast hours to fetch (3-hourly, capped by duration)
    const hoursNeeded = meta.hours_available.filter((h) => h <= durationHours);
    if (hoursNeeded.length === 0) return null;

    // Fetch all shards in parallel (capped at 10 concurrent)
    const shards: (WW3Shard | null)[] = [];
    const batchSize = 10;

    for (let i = 0; i < hoursNeeded.length; i += batchSize) {
        const batch = hoursNeeded.slice(i, i + batchSize);
        const results = await Promise.all(batch.map((h) => fetchShard(meta.cycle, h)));
        shards.push(...results);
    }

    // Filter successful shards
    const validShards = shards.filter(Boolean) as WW3Shard[];
    if (validShards.length === 0) {
        return null;
    }

    // Use first shard's grid info
    const gridInfo = validShards[0].grid;
    const width = gridInfo.nlon;
    const height = gridInfo.nlat;
    const size = width * height;

    // Build lats/lons arrays
    const lats: number[] = [];
    const lons: number[] = [];
    const res = gridInfo.resolution_deg;
    for (let j = 0; j < height; j++) {
        lats.push(gridInfo.lat_min + j * res);
    }
    for (let i = 0; i < width; i++) {
        lons.push(gridInfo.lon_min + i * res);
    }

    // Convert each shard to U/V wind-like arrays
    // We use wave_dir + wave_ht to create pseudo-wind vectors
    // that show the particle layer visualizing wave propagation
    const uArrays: Float32Array[] = [];
    const vArrays: Float32Array[] = [];
    const speedArrays: Float32Array[] = [];

    for (const shard of validShards) {
        const u = new Float32Array(size);
        const v = new Float32Array(size);
        const speed = new Float32Array(size);

        const waveHt = shard.data.wave_ht_m;
        const waveDir = shard.data.wave_dir_deg;

        if (waveHt && waveDir) {
            for (let i = 0; i < size; i++) {
                const ht = waveHt[i] || 0;
                const dir = waveDir[i] || 0;

                // Convert wave height to pseudo wind speed (scale factor)
                // 1m wave ≈ 5 m/s effective "particle speed"
                const pseudoSpeed = ht * 5;

                // Direction FROM → direction TO (add 180°)
                const toRad = (((dir + 180) % 360) * Math.PI) / 180;

                u[i] = pseudoSpeed * Math.sin(toRad);
                v[i] = pseudoSpeed * Math.cos(toRad);
                speed[i] = pseudoSpeed;
            }
        }

        uArrays.push(u);
        vArrays.push(v);
        speedArrays.push(speed);
    }

    const grid: WindGrid = {
        u: uArrays,
        v: vArrays,
        speed: speedArrays,
        width,
        height,
        lats,
        lons,
        north: gridInfo.lat_max,
        south: gridInfo.lat_min,
        west: gridInfo.lon_min,
        east: gridInfo.lon_max,
        totalHours: validShards.length,
    };

    return grid;
}

/**
 * Sample wave conditions at a specific lat/lon from the cached shards.
 * Uses bilinear interpolation on the nearest forecast hour.
 */
export async function sampleWaveAt(lat: number, lon: number, forecastHour: number = 0): Promise<WaveConditions | null> {
    const meta = await fetchMetadata();
    if (!meta) return null;

    // Find nearest available hour
    const nearest = meta.hours_available.reduce((prev, curr) =>
        Math.abs(curr - forecastHour) < Math.abs(prev - forecastHour) ? curr : prev,
    );

    const shard = await fetchShard(meta.cycle, nearest);
    if (!shard) return null;

    const { grid, data } = shard;

    // Grid indices
    const latIdx = Math.round((lat - grid.lat_min) / grid.resolution_deg);
    const lonIdx = Math.round((lon - grid.lon_min) / grid.resolution_deg);

    if (latIdx < 0 || latIdx >= grid.nlat || lonIdx < 0 || lonIdx >= grid.nlon) {
        return null;
    }

    const flatIdx = latIdx * grid.nlon + lonIdx;

    return {
        wave_ht_m: data.wave_ht_m?.[flatIdx] ?? 0,
        peak_period_s: data.peak_period_s?.[flatIdx] ?? 0,
        wave_dir_deg: data.wave_dir_deg?.[flatIdx] ?? 0,
        wind_wave_ht_m: data.wind_wave_ht_m?.[flatIdx] ?? 0,
        swell_ht_m: data.swell_ht_m?.[flatIdx] ?? 0,
    };
}
