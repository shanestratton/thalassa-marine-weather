/**
 * GEBCO Depth Service — Client-side interface to the gebco-depth Edge Function.
 *
 * Provides depth-at-point queries for the routing engine.
 * Caches results in-memory per session to avoid redundant network calls.
 *
 * Usage:
 *   const depths = await GebcoDepthService.queryDepths([
 *     { lat: -27.4, lon: 153.1 },
 *     { lat: -27.5, lon: 153.2 },
 *   ]);
 *
 * Values:
 *   - Negative = ocean depth (e.g., -45 = 45m below sea level)
 *   - Positive = land elevation
 *   - null = query failed
 */

// ── Types ─────────────────────────────────────────────────────────

export interface DepthPoint {
    lat: number;
    lon: number;
}

export interface DepthResult {
    lat: number;
    lon: number;
    depth_m: number | null;
}

export interface DepthQueryResponse {
    depths: DepthResult[];
    elapsed_ms: number;
    source: string;
}

// ── Helpers ───────────────────────────────────────────────────────

const getSupabaseUrl = (): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
    'https://pcisdplnodrphauixcau.supabase.co';

const getSupabaseKey = (): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

// ── In-memory cache ──────────────────────────────────────────────

/** Cache key: "lat,lon" rounded to 3 decimal places (~110m precision) */
function cacheKey(lat: number, lon: number): string {
    return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

const depthCache = new Map<string, number | null>();

// ── Service ──────────────────────────────────────────────────────

class GebcoDepthServiceClass {
    /**
     * Query depths for an array of points.
     * Returns cached results where available, only fetches missing points.
     */
    async queryDepths(points: DepthPoint[]): Promise<DepthResult[]> {
        if (points.length === 0) return [];

        // Separate cached from uncached
        const results: DepthResult[] = new Array(points.length);
        const uncachedIndices: number[] = [];
        const uncachedPoints: DepthPoint[] = [];

        for (let i = 0; i < points.length; i++) {
            const key = cacheKey(points[i].lat, points[i].lon);
            if (depthCache.has(key)) {
                results[i] = {
                    lat: points[i].lat,
                    lon: points[i].lon,
                    depth_m: depthCache.get(key)!,
                };
            } else {
                uncachedIndices.push(i);
                uncachedPoints.push(points[i]);
            }
        }

        // Fetch uncached points
        if (uncachedPoints.length > 0) {
            const fetched = await this._fetchFromEdge(uncachedPoints);

            for (let j = 0; j < fetched.length; j++) {
                const idx = uncachedIndices[j];
                results[idx] = fetched[j];

                // Cache the result
                const key = cacheKey(fetched[j].lat, fetched[j].lon);
                depthCache.set(key, fetched[j].depth_m);
            }
        }

        return results;
    }

    /**
     * Query depth at a single point (convenience method).
     */
    async queryDepth(lat: number, lon: number): Promise<number | null> {
        const results = await this.queryDepths([{ lat, lon }]);
        return results[0]?.depth_m ?? null;
    }

    /**
     * Query depths along a route (array of lat/lon pairs).
     * Automatically decimates if there are too many points.
     */
    async queryRouteDepths(routePoints: DepthPoint[], maxPoints: number = 200): Promise<DepthResult[]> {
        let points = routePoints;

        // Decimate if too many points
        if (routePoints.length > maxPoints) {
            const step = (routePoints.length - 1) / (maxPoints - 1);
            points = [];
            for (let i = 0; i < maxPoints; i++) {
                points.push(routePoints[Math.round(i * step)]);
            }
        }

        return this.queryDepths(points);
    }

    /**
     * Calculate depth safety classification for a given depth and vessel draft.
     *
     * Returns:
     *   'safe'    — depth > 3× draft (comfortable margin)
     *   'caution' — depth > 1.5× draft (navigate with care)
     *   'danger'  — depth ≤ 1.5× draft (risk of grounding)
     *   'land'    — depth ≥ 0 (land / above sea level)
     *   null      — no depth data
     */
    classifyDepth(depth_m: number | null, vesselDraft_m: number): 'safe' | 'caution' | 'danger' | 'land' | null {
        if (depth_m === null) return null;
        if (depth_m >= 0) return 'land';

        const absDepth = Math.abs(depth_m);
        if (absDepth <= 1.5 * vesselDraft_m) return 'danger';
        if (absDepth <= 3 * vesselDraft_m) return 'caution';
        return 'safe';
    }

    /**
     * Calculate routing cost penalty based on depth.
     *
     * Returns a multiplier (1.0 = no penalty, higher = more costly).
     * Used by the routing engine to penalise shallow water.
     *
     * Penalty curve:
     *   - depth > 3× draft → 1.0 (no penalty)
     *   - depth 2-3× draft → 1.5 (mild avoidance)
     *   - depth 1.5-2× draft → 3.0 (strong avoidance)
     *   - depth ≤ 1.5× draft → 10.0 (near-impassable)
     *   - land → Infinity (impassable)
     *   - null → 1.2 (slight penalty for unknown depth)
     */
    depthCostPenalty(depth_m: number | null, vesselDraft_m: number): number {
        if (depth_m === null) return 1.2; // Unknown depth — slight caution
        if (depth_m >= 0) return Infinity; // Land — impassable

        const absDepth = Math.abs(depth_m);
        const ratio = absDepth / vesselDraft_m;

        if (ratio > 3) return 1.0; // Deep water — no penalty
        if (ratio > 2) return 1.5; // Getting shallow — mild avoidance
        if (ratio > 1.5) return 3.0; // Tight — strong avoidance
        return 10.0; // Very tight — near-impassable
    }

    /**
     * Clear the depth cache (e.g., when switching regions).
     */
    clearCache(): void {
        depthCache.clear();
    }

    /** Number of cached depth lookups. */
    get cacheSize(): number {
        return depthCache.size;
    }

    // ── Private ──────────────────────────────────────────────────

    private async _fetchFromEdge(points: DepthPoint[]): Promise<DepthResult[]> {
        const supabaseUrl = getSupabaseUrl();
        const supabaseKey = getSupabaseKey();
        const url = `${supabaseUrl}/functions/v1/gebco-depth`;

        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
                },
                body: JSON.stringify({ points }),
                signal: AbortSignal.timeout(30_000),
            });

            if (!resp.ok) {
                console.error(`[GebcoDepth] Edge function error ${resp.status}`);
                return points.map((pt) => ({ lat: pt.lat, lon: pt.lon, depth_m: null }));
            }

            const data: DepthQueryResponse = await resp.json();
            return data.depths;
        } catch (err) {
            console.error('[GebcoDepth] Fetch error:', err);
            return points.map((pt) => ({ lat: pt.lat, lon: pt.lon, depth_m: null }));
        }
    }
}

// Singleton
export const GebcoDepthService = new GebcoDepthServiceClass();
