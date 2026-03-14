/**
 * SeamarkService — Global IALA Navigation Aid Fetcher
 *
 * Fetches structured seamark data from OpenStreetMap (via proxy-overpass edge
 * function) for any harbour in the world. Returns typed, classified GeoJSON
 * ready for the ChannelRouter and map rendering.
 *
 * Features:
 *   - Global coverage via Overpass API
 *   - IALA classification (port, starboard, cardinal, safe_water, etc.)
 *   - Browser Cache API with 24hr TTL
 *   - IALA Region detection (A vs B) for correct mark interpretation
 *   - Typed output with SeamarkFeature interface
 *
 * Usage:
 *   const seamarks = await SeamarkService.fetchNearby(-27.37, 153.17, 5);
 *   const lateral = SeamarkService.filterByClass(seamarks, ['port', 'starboard']);
 */

import { createLogger } from '../utils/createLogger';

const log = createLogger('SeamarkService');

// ── Types ──────────────────────────────────────────────────────

/** IALA classification for a seamark */
export type SeamarkClass =
    | 'port'           // Lateral — port side (red in Region A, green in Region B)
    | 'starboard'      // Lateral — starboard side (green in Region A, red in Region B)
    | 'lateral'        // Lateral — unclassified side
    | 'cardinal_n'     // Cardinal — pass north of hazard
    | 'cardinal_s'     // Cardinal — pass south
    | 'cardinal_e'     // Cardinal — pass east
    | 'cardinal_w'     // Cardinal — pass west
    | 'cardinal'       // Cardinal — unclassified direction
    | 'safe_water'     // Safe water — deep water, mid-channel
    | 'danger'         // Isolated danger / rocks / wrecks
    | 'special'        // Special purpose
    | 'light_major'    // Major navigation light
    | 'light_minor'    // Minor navigation light
    | 'light'          // Generic light
    | 'landmark'       // Visual landmark
    | 'mooring'        // Mooring buoy
    | 'berth'          // Berth
    | 'anchorage'      // Anchorage area
    | 'harbour'        // Harbour mark
    | 'fairway'        // Fairway buoy
    | 'gate'           // Gate/barrier
    | 'other';         // Unclassified

/** A single seamark feature with typed properties */
export interface SeamarkFeature {
    type: 'Feature';
    geometry: {
        type: 'Point';
        coordinates: [number, number]; // [lng, lat]
    };
    properties: {
        _type: string;      // Original seamark:type value
        _class: SeamarkClass;
        /** Light characteristics e.g. "Fl.G.5s" */
        'light:character'?: string;
        'light:colour'?: string;
        'light:period'?: string;
        /** Mark name/label */
        name?: string;
        [key: string]: string | undefined;
    };
}

/** Collection of seamarks with metadata */
export interface SeamarkCollection {
    type: 'FeatureCollection';
    features: SeamarkFeature[];
    metadata: {
        center: [number, number];
        radiusNM: number;
        fetchedAt: string;
        count: number;
        ialaRegion: 'A' | 'B';
    };
}

/** IALA Region — determines how lateral marks are interpreted */
export type IALARegion = 'A' | 'B';

// ── Config ─────────────────────────────────────────────────────

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY as string;
const CACHE_NAME = 'thalassa-seamark-cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── IALA Region Detection ──────────────────────────────────────

/**
 * Determine IALA Buoyage Region for a given position.
 *
 * Region A (red = port): Europe, Africa, Asia, Oceania (incl. Australia/NZ)
 * Region B (red = starboard): Americas, Japan, South Korea, Philippines
 *
 * This is a simplified heuristic — for edge cases near boundaries,
 * the channel router should validate against local chart data.
 */
export function detectIALARegion(lat: number, lon: number): IALARegion {
    // Americas: roughly -180 to -25 longitude (Western Hemisphere)
    if (lon >= -180 && lon < -25) return 'B';

    // Japan, South Korea, Philippines (also Region B)
    if (lon >= 120 && lon <= 150 && lat >= 10 && lat <= 50) {
        // Japan: ~129-146°E, 24-46°N → Region B
        if (lon >= 129 && lon <= 146 && lat >= 24 && lat <= 46) return 'B';
        // South Korea: ~125-130°E, 33-39°N → Region B
        if (lon >= 125 && lon <= 130 && lat >= 33 && lat <= 39) return 'B';
        // Philippines: ~117-127°E, 5-21°N → Region B
        if (lon >= 117 && lon <= 127 && lat >= 5 && lat <= 21) return 'B';
    }

    // Everything else is Region A (Europe, Africa, most of Asia, Oceania)
    return 'A';
}

// ── Cache Helpers ──────────────────────────────────────────────

function cacheKey(lat: number, lon: number, radiusNM: number): string {
    // Round to 0.01° (~1.1km) for cache grouping
    const rLat = Math.round(lat * 100) / 100;
    const rLon = Math.round(lon * 100) / 100;
    return `seamark:${rLat}:${rLon}:${radiusNM}`;
}

async function getFromCache(key: string): Promise<SeamarkCollection | null> {
    try {
        const cache = await caches.open(CACHE_NAME);
        const response = await cache.match(key);
        if (!response) return null;

        // Check TTL
        const data = await response.json();
        const fetchedAt = new Date(data.metadata?.fetchedAt).getTime();
        if (Date.now() - fetchedAt > CACHE_TTL_MS) {
            await cache.delete(key);
            return null;
        }

        log.info(`[Cache HIT] ${key} — ${data.features.length} seamarks`);
        return data as SeamarkCollection;
    } catch {
        return null;
    }
}

async function putToCache(key: string, data: SeamarkCollection): Promise<void> {
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(key, new Response(JSON.stringify(data), {
            headers: { 'Content-Type': 'application/json' },
        }));
    } catch {
        // Cache write failures are non-critical
    }
}

// ── Service ────────────────────────────────────────────────────

export const SeamarkService = {
    /**
     * Fetch seamarks near a position. Uses cache when available.
     *
     * @param lat     Latitude of the harbour/approach area
     * @param lon     Longitude
     * @param radiusNM Search radius in nautical miles (default 5, max 15)
     * @returns Typed SeamarkCollection with IALA classifications
     */
    async fetchNearby(
        lat: number,
        lon: number,
        radiusNM: number = 5,
    ): Promise<SeamarkCollection> {
        const key = cacheKey(lat, lon, radiusNM);

        // Check cache first
        const cached = await getFromCache(key);
        if (cached) return cached;

        log.info(`Fetching seamarks within ${radiusNM}NM of [${lat.toFixed(3)}, ${lon.toFixed(3)}]`);

        try {
            const response = await fetch(`${SUPABASE_URL}/functions/v1/proxy-overpass`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                },
                body: JSON.stringify({ lat, lon, radiusNM }),
            });

            if (!response.ok) {
                throw new Error(`proxy-overpass returned ${response.status}`);
            }

            const geojson = await response.json();
            const region = detectIALARegion(lat, lon);

            const collection: SeamarkCollection = {
                ...geojson,
                metadata: {
                    ...geojson.metadata,
                    ialaRegion: region,
                },
            };

            log.info(`Found ${collection.features.length} seamarks (IALA Region ${region})`);

            // Cache for 24 hours
            await putToCache(key, collection);

            return collection;
        } catch (err) {
            log.error('Failed to fetch seamarks:', err);

            // Return empty collection on failure (graceful degradation)
            return {
                type: 'FeatureCollection',
                features: [],
                metadata: {
                    center: [lon, lat],
                    radiusNM,
                    fetchedAt: new Date().toISOString(),
                    count: 0,
                    ialaRegion: detectIALARegion(lat, lon),
                },
            };
        }
    },

    /**
     * Filter seamarks by IALA class.
     */
    filterByClass(
        collection: SeamarkCollection,
        classes: SeamarkClass[],
    ): SeamarkFeature[] {
        const classSet = new Set(classes);
        return collection.features.filter(f => classSet.has(f.properties._class));
    },

    /**
     * Get lateral marks (port + starboard) — the ones that define channel edges.
     */
    getLateralMarks(collection: SeamarkCollection): SeamarkFeature[] {
        return this.filterByClass(collection, ['port', 'starboard', 'lateral']);
    },

    /**
     * Get safe-water marks — mid-channel / harbour entrance markers.
     */
    getSafeWaterMarks(collection: SeamarkCollection): SeamarkFeature[] {
        return this.filterByClass(collection, ['safe_water', 'fairway']);
    },

    /**
     * Get all navigation-critical marks for channel routing.
     */
    getNavigationMarks(collection: SeamarkCollection): SeamarkFeature[] {
        return this.filterByClass(collection, [
            'port', 'starboard', 'lateral',
            'cardinal_n', 'cardinal_s', 'cardinal_e', 'cardinal_w', 'cardinal',
            'safe_water', 'fairway', 'light_major', 'light_minor',
        ]);
    },

    /**
     * Get danger marks — areas to avoid.
     */
    getDangerMarks(collection: SeamarkCollection): SeamarkFeature[] {
        return this.filterByClass(collection, ['danger']);
    },

    /**
     * Find the outermost navigation mark from a given position.
     * This is the "sea buoy" — the transition point between channel and ocean routing.
     */
    findOutermostMark(
        collection: SeamarkCollection,
        fromLat: number,
        fromLon: number,
    ): SeamarkFeature | null {
        const navMarks = this.getNavigationMarks(collection);
        if (navMarks.length === 0) return null;

        let farthest: SeamarkFeature | null = null;
        let maxDist = 0;

        for (const mark of navMarks) {
            const [mLon, mLat] = mark.geometry.coordinates;
            const dlat = mLat - fromLat;
            const dlon = (mLon - fromLon) * Math.cos(fromLat * Math.PI / 180);
            const distSq = dlat * dlat + dlon * dlon;
            if (distSq > maxDist) {
                maxDist = distSq;
                farthest = mark;
            }
        }

        return farthest;
    },
};
