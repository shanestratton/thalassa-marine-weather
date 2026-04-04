/**
 * OceanCurrentService — OSCAR surface current data for passage planning.
 *
 * Queries NOAA ERDDAP for OSCAR near-real-time surface currents
 * within a route bounding box. Lightweight JSON response — no NetCDF.
 *
 * Strategy:
 * - Default: OSCAR monthly climatology via ERDDAP (free, bbox query)
 * - "Enhance" button: OSCAR NRT (5-day-old data) for the route corridor
 * - Cached in localStorage per bbox+month
 * - Auto-purge after 30 days
 */

import { createLogger } from '../utils/createLogger';

const log = createLogger('OceanCurrent');

export interface CurrentVector {
    lat: number;
    lon: number;
    u: number; // east velocity m/s
    v: number; // north velocity m/s
    speedKts: number;
    directionDeg: number; // direction current is flowing TO
}

export interface CurrentBriefing {
    vectors: CurrentVector[];
    avgSpeedKts: number;
    maxSpeedKts: number;
    /** Net effect on passage: positive = favourable, negative = adverse */
    netEffectHours: number;
    /** Source: 'climatology' | 'nrt' */
    source: 'climatology' | 'nrt';
    fetchedAt: string;
    /** Segments along route: favourable / adverse / cross */
    segments: Array<{
        type: 'favourable' | 'adverse' | 'cross';
        avgSpeedKts: number;
        label: string;
    }>;
}

const CACHE_KEY_PREFIX = 'thalassa_ocean_currents_';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h for NRT, 7 days for climatology
const PURGE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days auto-purge

/** Convert m/s to knots */
function msToKts(ms: number): number {
    return Math.round(ms * 1.94384 * 100) / 100;
}

/** Calculate direction from u,v components */
function uvToDirection(u: number, v: number): number {
    return ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
}

/** Calculate relative angle between current and course */
function relativeAngle(currentDir: number, courseBearing: number): number {
    let diff = currentDir - courseBearing;
    diff = ((diff + 180) % 360) - 180;
    return Math.abs(diff);
}

function cacheKey(bbox: { north: number; south: number; east: number; west: number }, source: string): string {
    return `${CACHE_KEY_PREFIX}${source}_${bbox.south.toFixed(0)}_${bbox.north.toFixed(0)}_${bbox.west.toFixed(0)}_${bbox.east.toFixed(0)}`;
}

export const OceanCurrentService = {
    /**
     * Fetch current data for a route bounding box.
     *
     * @param bbox — Route corridor bounding box
     * @param courseBearing — Overall course bearing (degrees)
     * @param distanceNM — Total route distance
     * @param speedKts — Expected vessel speed
     * @param enhance — If true, fetch near-real-time data
     */
    async fetchCurrents(
        bbox: { north: number; south: number; east: number; west: number },
        courseBearing: number,
        distanceNM: number,
        speedKts: number,
        enhance = false,
    ): Promise<CurrentBriefing> {
        const source = enhance ? 'nrt' : 'climatology';
        const key = cacheKey(bbox, source);

        // Check cache
        try {
            const cached = localStorage.getItem(key);
            if (cached) {
                const data = JSON.parse(cached) as CurrentBriefing & { _cachedAt: number };
                const ttl = source === 'nrt' ? CACHE_TTL : 7 * CACHE_TTL;
                if (Date.now() - data._cachedAt < ttl) {
                    log.info(`Using cached ${source} current data`);
                    return data;
                }
            }
        } catch {
            /* ignore */
        }

        try {
            // OSCAR ERDDAP — 1/3° resolution, global coverage
            // Dataset: 'jplOscar_LonPM180' for climatology
            // NRT dataset: 'jplOscar_LonPM180' with recent time constraint
            const paddedBbox = {
                south: Math.max(-80, bbox.south - 1),
                north: Math.min(80, bbox.north + 1),
                west: bbox.west - 1,
                east: bbox.east + 1,
            };

            // Build ERDDAP query — request latest available data
            const baseUrl = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplOscar_LonPM180.json';

            const query = `?u[(last)][(${paddedBbox.south.toFixed(1)}):(${paddedBbox.north.toFixed(1)})][(${paddedBbox.west.toFixed(1)}):(${paddedBbox.east.toFixed(1)})],v[(last)][(${paddedBbox.south.toFixed(1)}):(${paddedBbox.north.toFixed(1)})][(${paddedBbox.west.toFixed(1)}):(${paddedBbox.east.toFixed(1)})]`;

            const url = baseUrl + query;
            log.info(
                `Fetching OSCAR ${source} currents: ${paddedBbox.south}–${paddedBbox.north}°N, ${paddedBbox.west}–${paddedBbox.east}°E`,
            );

            const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!res.ok) throw new Error(`ERDDAP ${res.status}`);

            const data = await res.json();
            const rows = data.table?.rows || [];

            // Parse rows into vectors — ERDDAP returns [time, lat, lon, u, v]
            const vectors: CurrentVector[] = [];

            for (const row of rows) {
                const [_time, lat, lon, u, v] = row;
                if (u != null && v != null && !isNaN(u) && !isNaN(v)) {
                    const speed = Math.sqrt(u * u + v * v);
                    vectors.push({
                        lat,
                        lon,
                        u,
                        v,
                        speedKts: msToKts(speed),
                        directionDeg: uvToDirection(u, v),
                    });
                }
            }

            // Analyse segments relative to course bearing
            const segments: CurrentBriefing['segments'] = [];
            if (vectors.length > 0) {
                // Sort by latitude (rough N-S ordering along route)
                vectors.sort((a, b) => b.lat - a.lat);

                // Group into 3 segments
                const chunkSize = Math.max(1, Math.floor(vectors.length / 3));
                for (let i = 0; i < 3; i++) {
                    const chunk = vectors.slice(i * chunkSize, (i + 1) * chunkSize);
                    if (chunk.length === 0) continue;

                    const avgSpeed = chunk.reduce((s, v) => s + v.speedKts, 0) / chunk.length;
                    const avgDir = chunk.reduce((s, v) => s + v.directionDeg, 0) / chunk.length;
                    const relAngle = relativeAngle(avgDir, courseBearing);

                    let type: 'favourable' | 'adverse' | 'cross';
                    if (relAngle < 60) type = 'favourable';
                    else if (relAngle > 120) type = 'adverse';
                    else type = 'cross';

                    segments.push({
                        type,
                        avgSpeedKts: Math.round(avgSpeed * 10) / 10,
                        label: `${type === 'favourable' ? '↗️' : type === 'adverse' ? '↙️' : '↔️'} ${avgSpeed.toFixed(1)}kt ${type}`,
                    });
                }
            }

            // Calculate net effect on passage time
            const avgCurrentSpeed =
                vectors.length > 0 ? vectors.reduce((s, v) => s + v.speedKts, 0) / vectors.length : 0;
            const maxCurrentSpeed = vectors.length > 0 ? Math.max(...vectors.map((v) => v.speedKts)) : 0;

            // Simplified net effect: favourable segments reduce time, adverse increase
            const favourableCount = segments.filter((s) => s.type === 'favourable').length;
            const adverseCount = segments.filter((s) => s.type === 'adverse').length;
            const passageHours = distanceNM / speedKts;
            const netFactor = (favourableCount - adverseCount) / Math.max(1, segments.length);
            const netEffectHours = -Math.round(((passageHours * avgCurrentSpeed * netFactor) / speedKts) * 10) / 10;

            const briefing: CurrentBriefing = {
                vectors,
                avgSpeedKts: Math.round(avgCurrentSpeed * 10) / 10,
                maxSpeedKts: Math.round(maxCurrentSpeed * 10) / 10,
                netEffectHours,
                source,
                fetchedAt: new Date().toISOString(),
                segments,
            };

            // Cache
            try {
                localStorage.setItem(key, JSON.stringify({ ...briefing, _cachedAt: Date.now() }));
            } catch {
                /* ignore */
            }

            return briefing;
        } catch (err) {
            log.error('OSCAR current fetch failed:', err);

            // Return cached if available
            try {
                const cached = localStorage.getItem(key);
                if (cached) return JSON.parse(cached);
            } catch {
                /* ignore */
            }

            // Return empty briefing
            return {
                vectors: [],
                avgSpeedKts: 0,
                maxSpeedKts: 0,
                netEffectHours: 0,
                source,
                fetchedAt: new Date().toISOString(),
                segments: [],
            };
        }
    },

    /** Purge all current caches older than 30 days */
    purgeStale(): void {
        try {
            const keys = Object.keys(localStorage).filter((k) => k.startsWith(CACHE_KEY_PREFIX));
            for (const key of keys) {
                const raw = localStorage.getItem(key);
                if (!raw) continue;
                const data = JSON.parse(raw);
                if (data._cachedAt && Date.now() - data._cachedAt > PURGE_TTL) {
                    localStorage.removeItem(key);
                    log.info(`Purged stale current cache: ${key}`);
                }
            }
        } catch {
            /* ignore */
        }
    },
};
