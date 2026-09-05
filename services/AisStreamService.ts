/**
 * AisStreamService — Client for fetching server-side AIS data.
 *
 * Queries the Supabase Edge Function `vessels-nearby` to get
 * AIS vessel positions from the AISStream.io ingestion pipeline.
 *
 * Returns GeoJSON FeatureCollection for map rendering.
 */
import { supabase } from './supabase';
import { getAuthenticatedFunctionHeaders } from './supabaseAuth';

import { createLogger } from '../utils/createLogger';
import { withDeadline } from '../utils/deadline';

const log = createLogger('AisStreamService');

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
     * Epoch-ms until which the server has told us to stop asking (429
     * Retry-After). The per-account quota is 720/hour, and two devices each
     * polling every 10 s reach it together — after which every further poll
     * used to fire anyway and get another 429. Honouring the cooldown turns a
     * rate-limited client from a hammer into a client that waits.
     */
    private cooldownUntil = 0;

    /**
     * Fetch vessels near a point from the Supabase Edge Function.
     * Returns cached result if called too frequently or query is similar.
     */
    async fetchNearby(query: AisStreamQuery): Promise<GeoJSON.FeatureCollection> {
        const now = Date.now();
        const radiusNm = query.radiusNm || DEFAULT_RADIUS_NM;
        const limit = query.limit || 250;

        // Throttle: reuse the cache only when it is a SUPERSET of this request.
        // The old check compared lat/lon alone, so a 5 NM result satisfied a
        // 12 NM request inside the 5 s window and the outer ring of vessels
        // silently vanished (audit item 13). A cached result covers this one
        // only if it was fetched for at least as wide a radius AND at least as
        // high a limit — a narrower or smaller cache is not enough, a wider one
        // has extras that a map layer can carry.
        if (
            this.cachedResult &&
            now - this.lastFetchAt < MIN_FETCH_INTERVAL_MS &&
            this.lastQuery &&
            Math.abs(this.lastQuery.lat - query.lat) < 0.01 &&
            Math.abs(this.lastQuery.lon - query.lon) < 0.01 &&
            (this.lastQuery.radiusNm || DEFAULT_RADIUS_NM) >= radiusNm &&
            (this.lastQuery.limit || 250) >= limit
        ) {
            return this.cachedResult;
        }

        // The server asked us to wait. Serve what we have and do not spend the
        // request — this is the difference between backing off a busy quota and
        // grinding against it.
        if (now < this.cooldownUntil) {
            return this.cachedResult || { type: 'FeatureCollection', features: [] };
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

            const params = new URLSearchParams({
                lat: String(query.lat),
                lon: String(query.lon),
                radius: String(radiusNm),
                limit: String(limit),
            });

            const url = `${supabaseUrl}/functions/v1/${EDGE_FN_NAME}?${params}`;
            const authHeaders = await withDeadline(getAuthenticatedFunctionHeaders(), 5_000, 'AIS authentication');
            const resp = await withDeadline(
                fetch(url, {
                    headers: authHeaders,
                    signal: AbortSignal.timeout(10_000),
                }),
                10_000,
                'AIS vessel request',
            );

            if (resp.status === 429) {
                // Quota exhausted. Respect Retry-After (seconds); default to
                // the window the edge function sends (60 s) so we do not guess.
                const retryAfterS = Number(resp.headers.get('Retry-After')) || 60;
                this.cooldownUntil = now + retryAfterS * 1000;
                log.warn(`[AisStream] rate-limited; backing off ${retryAfterS}s`);
                return this.cachedResult || { type: 'FeatureCollection', features: [] };
            }
            if (!resp.ok) {
                throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
            }

            const geojson = await withDeadline(resp.json(), 5_000, 'AIS vessel response body');

            this.lastFetchAt = now;
            // Store the EFFECTIVE query — the radius/limit actually fetched —
            // so the superset check above compares like with like.
            this.lastQuery = { ...query, radiusNm, limit };
            this.cachedResult = geojson;
            return geojson;
        } catch (e) {
            log.warn('[AisStream] Fetch error:', e);
            return this.cachedResult || { type: 'FeatureCollection', features: [] };
        }
    }

    /** Clear cached results */
    clearCache(): void {
        this.cachedResult = null;
        this.lastFetchAt = 0;
        this.lastQuery = null;
        this.cooldownUntil = 0;
    }
}

export const AisStreamService = new AisStreamServiceClass();
