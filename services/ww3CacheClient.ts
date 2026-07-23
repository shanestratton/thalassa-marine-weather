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
import {
    cycleToEpochMs,
    findWW3TemporalBracket,
    interpolateWaveConditions,
    sampleWW3Shard,
    validateWW3Metadata,
    validateWW3Shard,
    WW3_CACHE_BUCKET,
    WW3_METADATA_FILE,
    type ValidatedWW3Shard,
    type WaveConditions,
    type WW3Metadata,
} from '../supabase/functions/_shared/ww3';

import { createLogger } from '../utils/createLogger';

const log = createLogger('ww3CacheClient');

export type { WaveConditions };

// ── Config ────────────────────────────────────────────────────────

const getSupabaseUrl = (): string => (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

// ── Cache ─────────────────────────────────────────────────────────

let metadataCache: WW3Metadata | null = null;
let metadataFetchedAt = 0;
const shardCache = new Map<string, ValidatedWW3Shard>();
const METADATA_TTL = 10 * 60 * 1000; // 10 min

// ── Fetch Helpers ─────────────────────────────────────────────────

async function parseBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
    const advertisedSize = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(advertisedSize) && advertisedSize > maxBytes) {
        throw new Error('WW3 cache payload exceeds its safe size limit');
    }
    if (!response.body) throw new Error('WW3 cache payload is empty');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                throw new Error('WW3 cache payload exceeds its safe size limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function fetchMetadata(): Promise<WW3Metadata | null> {
    const now = Date.now();
    if (metadataCache && now - metadataFetchedAt < METADATA_TTL) {
        try {
            return validateWW3Metadata(metadataCache, now);
        } catch {
            metadataCache = null;
        }
    }

    const supabaseUrl = getSupabaseUrl();
    if (!supabaseUrl) return null;
    const url = `${supabaseUrl}/storage/v1/object/public/${WW3_CACHE_BUCKET}/${WW3_METADATA_FILE}?v=${now}`;

    try {
        const resp = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
        if (!resp.ok) return null;
        const metadata = validateWW3Metadata(await parseBoundedJson(resp, 64 * 1024), now);
        if (metadataCache?.cycle && metadataCache.cycle !== metadata.cycle) {
            shardCache.clear();
        }
        metadataCache = metadata;
        metadataFetchedAt = now;
        return metadataCache;
    } catch (e) {
        log.warn('[ww3Cache]', e);
        return null;
    }
}

async function fetchShard(cycle: string, forecastHour: number, cacheResult = true): Promise<ValidatedWW3Shard | null> {
    const key = `${cycle}_f${forecastHour.toString().padStart(3, '0')}`;
    if (shardCache.has(key)) return shardCache.get(key)!;

    const filename = `ww3_${key}.json`;
    const supabaseUrl = getSupabaseUrl();
    if (!supabaseUrl) return null;
    const url = `${supabaseUrl}/storage/v1/object/public/${WW3_CACHE_BUCKET}/${filename}`;

    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!resp.ok) return null;
        const shard = validateWW3Shard(await parseBoundedJson(resp, 32 * 1024 * 1024), cycle, forecastHour);
        if (cacheResult) {
            if (shardCache.size >= 8) {
                const oldest = shardCache.keys().next().value;
                if (oldest) shardCache.delete(oldest);
            }
            shardCache.set(key, shard);
        }
        return shard;
    } catch (e) {
        log.warn('[ww3Cache]', e);
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
    if (!Number.isFinite(durationHours) || durationHours < 0 || durationHours > 240) return null;
    const meta = await fetchMetadata();
    if (!meta) {
        return null;
    }

    // Determine which forecast hours to fetch (3-hourly, capped by duration)
    const hoursNeeded = meta.hours_available.filter((h) => h <= durationHours);
    if (hoursNeeded.length === 0) return null;

    let lats: number[] | null = null;
    let lons: number[] | null = null;
    let width = 0;
    let height = 0;
    const uArrays: Float32Array[] = [];
    const vArrays: Float32Array[] = [];
    const speedArrays: Float32Array[] = [];
    let missingDataMask: Uint8Array | null = null;

    // Process one validated global shard at a time. Retaining only the compact
    // Float32 frame keeps peak memory bounded even for a 120-hour forecast.
    for (const forecastHour of hoursNeeded) {
        const shard = await fetchShard(meta.cycle, forecastHour, false);
        if (!shard) return null;

        const shardLats = Array.from(
            { length: shard.latAxis.count },
            (_, index) => shard.latAxis.first + index * shard.latAxis.step,
        ).sort((a, b) => a - b);
        const normalizeLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
        const shardLons = Array.from({ length: shard.lonAxis.count }, (_, index) =>
            normalizeLon(shard.lonAxis.first + index * shard.lonAxis.step),
        ).sort((a, b) => a - b);

        if (!lats || !lons) {
            lats = shardLats;
            lons = shardLons;
            height = lats.length;
            width = lons.length;
            missingDataMask = new Uint8Array(width * height);
        } else if (
            shardLats.length !== height ||
            shardLons.length !== width ||
            shardLats.some((lat, index) => Math.abs(lat - lats![index]) > 1e-6) ||
            shardLons.some((lon, index) => Math.abs(lon - lons![index]) > 1e-6)
        ) {
            return null;
        }

        const size = width * height;
        const u = new Float32Array(size);
        const v = new Float32Array(size);
        const speed = new Float32Array(size);

        for (let row = 0; row < height; row++) {
            for (let column = 0; column < width; column++) {
                const index = row * width + column;
                const sample = sampleWW3Shard(shard, lats[row], lons[column]);
                if (!sample || sample.wave_dir_deg === undefined) {
                    missingDataMask![index] = 1;
                    continue;
                }

                // This grid is a wave-particle visualisation. Magnitude is
                // deliberately derived from measured wave height, never wind.
                const pseudoSpeed = sample.wave_ht_m * 5;
                const toRad = (((sample.wave_dir_deg + 180) % 360) * Math.PI) / 180;
                u[index] = pseudoSpeed * Math.sin(toRad);
                v[index] = pseudoSpeed * Math.cos(toRad);
                speed[index] = pseudoSpeed;
            }
        }

        uArrays.push(u);
        vArrays.push(v);
        speedArrays.push(speed);
    }

    if (!lats || !lons || uArrays.length !== hoursNeeded.length) return null;
    const grid: WindGrid = {
        u: uArrays,
        v: vArrays,
        speed: speedArrays,
        width,
        height,
        lats,
        lons,
        north: lats[lats.length - 1],
        south: lats[0],
        west: lons[0],
        east: lons[lons.length - 1],
        totalHours: hoursNeeded.length,
        refTime: meta.valid_from,
        landMask: missingDataMask ?? undefined,
        hourOffsets: hoursNeeded,
        stepHours: hoursNeeded,
    };

    return grid;
}

/**
 * Sample wave conditions at a specific lat/lon from the cached shards.
 * Uses bilinear spatial and bracketed temporal interpolation. It returns null
 * rather than extending the first/last model frame or inventing missing cells.
 */
export async function sampleWaveAt(lat: number, lon: number, forecastHour: number = 0): Promise<WaveConditions | null> {
    if (
        !Number.isFinite(lat) ||
        lat < -90 ||
        lat > 90 ||
        !Number.isFinite(lon) ||
        lon < -180 ||
        lon > 180 ||
        !Number.isFinite(forecastHour) ||
        forecastHour < 0 ||
        forecastHour > 240
    ) {
        return null;
    }
    const meta = await fetchMetadata();
    if (!meta) return null;

    const timestampMs = cycleToEpochMs(meta.cycle) + forecastHour * 60 * 60 * 1000;
    const bracket = findWW3TemporalBracket(meta, timestampMs);
    if (!bracket) return null;

    const lowerShard = await fetchShard(meta.cycle, bracket.lowerHour);
    if (!lowerShard) return null;
    const lower = sampleWW3Shard(lowerShard, lat, lon);
    if (!lower) return null;

    if (bracket.upperHour === bracket.lowerHour) return lower;
    const upperShard = await fetchShard(meta.cycle, bracket.upperHour);
    if (!upperShard) return null;
    const upper = sampleWW3Shard(upperShard, lat, lon);
    if (!upper) return null;

    return interpolateWaveConditions(lower, upper, bracket.fraction);
}
