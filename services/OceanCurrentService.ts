/**
 * OceanCurrentService — NOAA CoastWatch surface current data for passage planning.
 *
 * Queries NOAA ERDDAP surface-current datasets within a route bounding
 * box. Lightweight JSON response — no NetCDF.
 *
 * Strategy:
 * - Query NOAA CoastWatch ERDDAP datasets in a bounded fallback chain
 * - "Enhance" requests the near-real-time mode for the route corridor
 * - Cache only provider-confirmed responses; outages never become zero current
 * - Auto-purge after 30 days
 */

import { createLogger } from '../utils/createLogger';
import { withDeadline } from '../utils/deadline';
import { passageDataFingerprint } from './passageEnvironmentReadiness';

const log = createLogger('OceanCurrent');

export interface CurrentVector {
    lat: number;
    lon: number;
    u: number; // east velocity m/s
    v: number; // north velocity m/s
    speedKts: number;
    directionDeg: number; // direction current is flowing TO
}

export interface CurrentSegment {
    type: 'favourable' | 'adverse' | 'cross';
    avgSpeedKts: number;
    label: string;
}

interface CurrentBriefingBase {
    vectors: CurrentVector[];
    /** Requested briefing mode: standard or near-real-time enhancement. */
    source: 'climatology' | 'nrt';
    fetchedAt: string;
    provider: 'NOAA CoastWatch ERDDAP';
    providerDataset: string | null;
    /** Timestamp carried by the provider's current field, when supplied. */
    dataTime: string | null;
    /** Whether this response came from the network or a still-valid cache. */
    retrieval: 'live' | 'cached';
    segments: CurrentSegment[];
}

export interface AvailableCurrentBriefing extends CurrentBriefingBase {
    availability: 'available';
    avgSpeedKts: number;
    maxSpeedKts: number;
    /** Net effect on passage: positive = favourable, negative = adverse */
    netEffectHours: number;
    /** Provider-confirmed field state. Empty is not a substituted zero field. */
    coverage: 'data' | 'calm' | 'empty';
    dataFingerprint: string;
}

export interface UnavailableCurrentBriefing extends CurrentBriefingBase {
    availability: 'unavailable';
    avgSpeedKts: null;
    maxSpeedKts: null;
    netEffectHours: null;
    coverage: 'unavailable';
    dataFingerprint: null;
    errorMessage: string;
}

export type CurrentBriefing = AvailableCurrentBriefing | UnavailableCurrentBriefing;

interface CachedCurrentBriefing extends AvailableCurrentBriefing {
    _cachedAt: number;
}

interface ErddapPayload {
    table?: { rows?: unknown[][] };
}

function unavailableBriefing(source: 'climatology' | 'nrt', message: string): UnavailableCurrentBriefing {
    return {
        availability: 'unavailable',
        vectors: [],
        avgSpeedKts: null,
        maxSpeedKts: null,
        netEffectHours: null,
        source,
        fetchedAt: new Date().toISOString(),
        provider: 'NOAA CoastWatch ERDDAP',
        providerDataset: null,
        dataTime: null,
        retrieval: 'live',
        coverage: 'unavailable',
        dataFingerprint: null,
        errorMessage: message,
        segments: [],
    };
}

function parseCachedBriefing(raw: string | null): CachedCurrentBriefing | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<CachedCurrentBriefing>;
        if (
            value.availability !== 'available' ||
            !Array.isArray(value.vectors) ||
            !Array.isArray(value.segments) ||
            typeof value.dataFingerprint !== 'string' ||
            typeof value._cachedAt !== 'number' ||
            !Number.isFinite(value._cachedAt)
        ) {
            return null;
        }
        return value as CachedCurrentBriefing;
    } catch {
        return null;
    }
}

function currentCacheKey(
    bbox: { north: number; south: number; east: number; west: number },
    source: string,
    courseBearing: number,
    distanceNm: number,
    speedKts: number,
): string {
    return `${CACHE_KEY_PREFIX}${passageDataFingerprint('current-query', {
        bbox,
        source,
        courseBearing,
        distanceNm,
        speedKts,
    })}`;
}

const CACHE_KEY_PREFIX = 'thalassa_ocean_currents_';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h for NRT, 7 days for climatology
const PURGE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days auto-purge
const CURRENT_FETCH_BUDGET_MS = 20_000;
const CURRENT_HOP_TIMEOUT_MS = 8_000;

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
        const key = currentCacheKey(bbox, source, courseBearing, distanceNM, speedKts);
        const ttl = source === 'nrt' ? CACHE_TTL : 7 * CACHE_TTL;

        // Check cache
        try {
            const data = parseCachedBriefing(localStorage.getItem(key));
            if (data && Date.now() - data._cachedAt < ttl) {
                log.info(`Using cached ${source} current data`);
                return { ...data, retrieval: 'cached' };
            }
        } catch {
            /* ignore */
        }

        try {
            // Surface currents via NOAA CoastWatch ERDDAP. The original
            // jplOscar_LonPM180 dataset was retired during NASA's
            // PODAAC migration (~2024-2025). Try the current dataset
            // ID first, then fall back through known alternates. A failed
            // chain is explicitly unavailable; it must never be converted to
            // an apparent zero-current field.
            const paddedBbox = {
                south: Math.max(-80, bbox.south - 1),
                north: Math.min(80, bbox.north + 1),
                west: bbox.west - 1,
                east: bbox.east + 1,
            };

            // Build ERDDAP query — request latest available data
            const query = `?u[(last)][(${paddedBbox.south.toFixed(1)}):(${paddedBbox.north.toFixed(1)})][(${paddedBbox.west.toFixed(1)}):(${paddedBbox.east.toFixed(1)})],v[(last)][(${paddedBbox.south.toFixed(1)}):(${paddedBbox.north.toFixed(1)})][(${paddedBbox.west.toFixed(1)}):(${paddedBbox.east.toFixed(1)})]`;

            // Datasets to try in order. The first hit wins.
            const datasets = [
                'noaacwL3SCcurNRTL3', // NOAA L3 NRT currents
                'jplOscar_LonPM180', // legacy OSCAR (kept for back-compat if revived)
                'noaacwL3Scur5dayL3', // NOAA 5-day composite
            ];

            log.info(
                `Fetching ${source} currents: ${paddedBbox.south}–${paddedBbox.north}°N, ${paddedBbox.west}–${paddedBbox.east}°E`,
            );

            let data: ErddapPayload | null = null;
            let providerDataset: string | null = null;
            const providerFailures: string[] = [];
            const fetchDeadlineAt = Date.now() + CURRENT_FETCH_BUDGET_MS;
            for (const ds of datasets) {
                const remainingMs = fetchDeadlineAt - Date.now();
                if (remainingMs <= 0) break;
                const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/${ds}.json${query}`;
                try {
                    // AbortSignal is ignored by Capacitor's native fetch
                    // bridge, so the JS deadline is the real on-device bound.
                    const hopTimeoutMs = Math.min(CURRENT_HOP_TIMEOUT_MS, remainingMs);
                    const res = await withDeadline(
                        fetch(url, { signal: AbortSignal.timeout(hopTimeoutMs) }),
                        hopTimeoutMs,
                        `ocean-current dataset ${ds}`,
                    );
                    if (res.ok) {
                        const candidate = (await withDeadline(
                            res.json(),
                            Math.max(1, fetchDeadlineAt - Date.now()),
                            `ocean-current response ${ds}`,
                        )) as ErddapPayload;
                        if (candidate.table && Array.isArray(candidate.table.rows)) {
                            data = candidate;
                            providerDataset = ds;
                            log.info(`Ocean currents fetched from dataset "${ds}"`);
                            break;
                        }
                        providerFailures.push(`${ds}: malformed response`);
                    } else {
                        providerFailures.push(`${ds}: HTTP ${res.status}`);
                    }
                } catch (error) {
                    providerFailures.push(`${ds}: ${error instanceof Error ? error.message : 'request failed'}`);
                }
            }
            if (!data) {
                const detail = providerFailures.length ? ` (${providerFailures.join('; ')})` : '';
                log.warn(`Ocean-current provider unavailable${detail}`);
                return unavailableBriefing(
                    source,
                    'NOAA CoastWatch could not provide a current field for this route. Retry when connected.',
                );
            }

            // ERDDAP rows come back typed as `unknown[]` because the
            // surrounding response is loose — typed-narrow them locally
            // so the destructure + arithmetic compiles under strict TS.
            const rows = (data.table?.rows ?? []) as Array<[string, number, number, number, number]>;

            // Parse rows into vectors — ERDDAP returns [time, lat, lon, u, v]
            const vectors: CurrentVector[] = [];

            for (const row of rows) {
                const [, lat, lon, u, v] = row;
                if ([lat, lon, u, v].every((value) => typeof value === 'number' && Number.isFinite(value))) {
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

            if (rows.length > 0 && vectors.length === 0) {
                log.warn(`Ocean-current dataset "${providerDataset}" returned rows without valid vectors`);
                return unavailableBriefing(
                    source,
                    'NOAA CoastWatch returned an unreadable current field. No zero-current assumption was made.',
                );
            }

            // Analyse segments relative to course bearing
            const segments: CurrentSegment[] = [];
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
            const safeSpeedKts = Number.isFinite(speedKts) && speedKts > 0 ? speedKts : 6;
            const safeDistanceNm = Number.isFinite(distanceNM) && distanceNM >= 0 ? distanceNM : 0;
            const passageHours = safeDistanceNm / safeSpeedKts;
            const netFactor = (favourableCount - adverseCount) / Math.max(1, segments.length);
            const netEffectHours = -Math.round(((passageHours * avgCurrentSpeed * netFactor) / safeSpeedKts) * 10) / 10;

            const dataTime =
                rows
                    .map((row) => row[0])
                    .find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
            const dataFingerprint = passageDataFingerprint('ocean-current-field', {
                providerDataset,
                dataTime,
                vectors,
            });
            const coverage: AvailableCurrentBriefing['coverage'] =
                vectors.length === 0 ? 'empty' : vectors.every((vector) => vector.speedKts <= 0.01) ? 'calm' : 'data';
            const briefing: AvailableCurrentBriefing = {
                availability: 'available',
                vectors,
                avgSpeedKts: Math.round(avgCurrentSpeed * 10) / 10,
                maxSpeedKts: Math.round(maxCurrentSpeed * 10) / 10,
                netEffectHours,
                source,
                fetchedAt: new Date().toISOString(),
                provider: 'NOAA CoastWatch ERDDAP',
                providerDataset,
                dataTime,
                retrieval: 'live',
                coverage,
                dataFingerprint,
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
            log.error('Ocean-current fetch failed:', err);
            return unavailableBriefing(
                source,
                'Ocean-current data is unavailable. No zero-current assumption was made; retry when connected.',
            );
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
