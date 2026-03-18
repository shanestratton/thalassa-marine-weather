/**
 * AisStreamService — Client for fetching server-side AIS data.
 *
 * Queries the Supabase Edge Function `vessels-nearby` to get
 * AIS vessel positions from the AISStream.io ingestion pipeline.
 *
 * Returns GeoJSON FeatureCollection for map rendering.
 */
import { supabase } from './supabase';

const EDGE_FN_NAME = 'vessels-nearby';
const DEFAULT_RADIUS_NM = 25;
const MIN_FETCH_INTERVAL_MS = 5000; // Don't fetch more than once per 5s

export interface AisStreamQuery {
    lat: number;
    lon: number;
    radiusNm?: number;
    limit?: number;
}

class AisStreamServiceClass {
    private lastFetchAt = 0;
    private lastQuery: AisStreamQuery | null = null;
    private cachedResult: GeoJSON.FeatureCollection | null = null;

    /**
     * Fetch vessels near a point from the Supabase Edge Function.
     * Returns cached result if called too frequently or query is similar.
     */
    async fetchNearby(query: AisStreamQuery): Promise<GeoJSON.FeatureCollection> {
        const now = Date.now();

        // Throttle: return cached if fetched recently and query is similar
        if (
            this.cachedResult &&
            now - this.lastFetchAt < MIN_FETCH_INTERVAL_MS &&
            this.lastQuery &&
            Math.abs(this.lastQuery.lat - query.lat) < 0.01 &&
            Math.abs(this.lastQuery.lon - query.lon) < 0.01
        ) {
            return this.cachedResult;
        }

        if (!supabase) {
            return { type: 'FeatureCollection', features: [] };
        }

        try {
            // Get Supabase project URL and key for direct fetch
             
            const supabaseUrl =
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (supabase as any).supabaseUrl ||
                (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
                '';
             
            const supabaseKey =
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (supabase as any).supabaseKey ||
                (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) ||
                '';

            const params = new URLSearchParams({
                lat: String(query.lat),
                lon: String(query.lon),
                radius: String(query.radiusNm || DEFAULT_RADIUS_NM),
                limit: String(query.limit || 500),
            });

            const url = `${supabaseUrl}/functions/v1/${EDGE_FN_NAME}?${params}`;
            const resp = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${supabaseKey}`,
                    apikey: supabaseKey,
                },
            });

            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
            }

            const geojson = await resp.json();

            this.lastFetchAt = now;
            this.lastQuery = query;
            this.cachedResult = geojson;
            return geojson;
        } catch (e) {
            console.warn('[AisStream] Fetch error:', e);
            return this.cachedResult || { type: 'FeatureCollection', features: [] };
        }
    }

    /** Clear cached results */
    clearCache(): void {
        this.cachedResult = null;
        this.lastFetchAt = 0;
        this.lastQuery = null;
    }
}

export const AisStreamService = new AisStreamServiceClass();
