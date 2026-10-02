/**
 * Coarse global bathymetry service — client interface to the legacy-named
 * `gebco-depth` Edge Function.
 *
 * The deployed endpoint currently queries NOAA ETOPO at nominal 1 arc-minute
 * (~1.8 km at the equator). It is a coarse corroborating source, not an ENC,
 * hydrographic survey, or navigation clearance. The exported service name is
 * retained for compatibility with existing callers.
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

import { createLogger } from '../utils/createLogger';
import { DeadlineExceeded, withDeadline } from '../utils/deadline';
import { getAuthenticatedFunctionHeaders } from './supabaseAuth';

const log = createLogger('GebcoDepthService');

/** Provenance contract returned by the point-query Edge endpoint. */
export const COARSE_BATHYMETRY_SOURCE_ID = 'noaa_etopo_erddap';
export const COARSE_BATHYMETRY_SOURCE_LABEL = 'NOAA ETOPO global relief';
export const COARSE_BATHYMETRY_NOMINAL_RESOLUTION_M = 1_850;
/** Hard request cap enforced by the legacy-named Edge endpoint. */
export const COARSE_BATHYMETRY_MAX_POINTS_PER_REQUEST = 200;
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

/**
 * Why the satellite relief for a route did not come back whole (2026-10-02).
 * 'offline' only when the phone itself says it is offline: Shane's phone, on
 * Wi-Fi and 4G, was told its satellite check had not run "(offline)" when the
 * request had simply outlasted its deadline.
 */
export type ReliefFailureKind =
    | 'offline'
    | 'timeout'
    | 'network'
    | 'auth'
    | 'quota'
    | 'server'
    | 'bad-answer'
    | 'partial';

export interface ReliefFailure {
    kind: ReliefFailureKind;
    /** The HTTP status, where the edge answered with one. */
    status?: number;
    /** 'timeout': how long each attempt waited. */
    waitedMs?: number;
    /** How many attempts were made, when more than one (the words say the
     *  whole wait, not one attempt's: fix-up review, 2026-10-03). */
    attempts?: number;
    /** The request rode the public key (no session): its daily allowance is
     *  per IP, shared on marina Wi-Fi or a carrier's NAT — not the account's. */
    sharedKey?: boolean;
    /** 'partial': the points that came back without a value, of how many. */
    missing?: number;
    total?: number;
}

export interface RouteReliefResult {
    /** Aligned to the request points; null where no value came back. */
    depths: DepthResult[];
    /** Null when every point has a value. */
    failure: ReliefFailure | null;
    /** Requests made (0: everything came from the cache). */
    requests: number;
}

/**
 * ONE grid request per route box (2026-10-02). The point endpoint asks NOAA
 * ERDDAP ten points at a time: measured from the Mac on 2026-10-02, 86 points
 * took 12.98 s at the edge (13.45 s end to end) — the field route's satellite
 * check timed out at 10 s on every route over ~9 NM. The same edge's bbox mode
 * answers the whole route's box from one ERDDAP request (1.13 s upstream for
 * the 18.3 NM field route's 270 nodes), and the nearest whole-arc-minute node
 * is exactly what ERDDAP returns for a point query (23 of 23 compared).
 */
export const ROUTE_RELIEF_ATTEMPT_MS = 12_000;
/** One retry, after this wait, for a timeout, a dropped connection or a 5xx. */
export const ROUTE_RELIEF_RETRY_DELAYS_MS: readonly number[] = [1_500];
/** At most this many grid nodes per request (an inshore route's box is a few
 *  thousand at most; a 3.3° square is 40,000 — the edge allows 250,000). */
export const ROUTE_RELIEF_MAX_NODES = 40_000;
/** NOAA ETOPO's lattice: a node every arc-minute. */
const RELIEF_NODES_PER_DEG = 60;
const RELIEF_GRID_SOURCE_ID = 'noaa_etopo_erddap_grid';

const nodeKey = (lat: number, lon: number): string =>
    `${Math.round(lat * RELIEF_NODES_PER_DEG)},${Math.round(lon * RELIEF_NODES_PER_DEG)}`;

/** The phone says it is offline (never inferred from a failed request). */
const deviceOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Pure: the failure an HTTP status means (`sharedKey`: the public key asked). */
function statusFailure(status: number, sharedKey = false): ReliefFailure {
    if (status === 401 || status === 403) return { kind: 'auth', status };
    if (status === 429) return { kind: 'quota', status, ...(sharedKey ? { sharedKey: true } : {}) };
    if (status >= 500) return { kind: 'server', status };
    return { kind: 'bad-answer', status };
}

const retryable = (failure: ReliefFailure | null): boolean =>
    !!failure && (failure.kind === 'timeout' || failure.kind === 'network' || failure.kind === 'server');

/** The box a run of points needs, one node beyond each side, in node units. */
function nodeBox(points: readonly DepthPoint[]): { s: number; n: number; w: number; e: number } {
    let s = Infinity;
    let n = -Infinity;
    let w = Infinity;
    let e = -Infinity;
    for (const { lat, lon } of points) {
        const la = Math.round(lat * RELIEF_NODES_PER_DEG);
        const lo = Math.round(lon * RELIEF_NODES_PER_DEG);
        if (la < s) s = la;
        if (la > n) n = la;
        if (lo < w) w = lo;
        if (lo > e) e = lo;
    }
    return { s: s - 1, n: n + 1, w: w - 1, e: e + 1 };
}

const boxNodes = (b: { s: number; n: number; w: number; e: number }): number => (b.n - b.s + 1) * (b.e - b.w + 1);

/**
 * Pure: the points in route order, cut into runs whose box stays within
 * ROUTE_RELIEF_MAX_NODES — one run for any inshore route.
 */
export function reliefChunks<T extends DepthPoint>(points: readonly T[]): T[][] {
    const chunks: T[][] = [];
    let current: T[] = [];
    type NodeBox = { s: number; n: number; w: number; e: number };
    let box: NodeBox | null = null;
    for (const point of points) {
        const own = nodeBox([point]);
        const grown: NodeBox = box
            ? {
                  s: Math.min(box.s, own.s),
                  n: Math.max(box.n, own.n),
                  w: Math.min(box.w, own.w),
                  e: Math.max(box.e, own.e),
              }
            : own;
        if (current.length > 0 && boxNodes(grown) > ROUTE_RELIEF_MAX_NODES) {
            chunks.push(current);
            current = [];
            box = own;
        } else box = grown;
        current.push(point);
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

// ── Helpers ───────────────────────────────────────────────────────

const getSupabaseUrl = (): string =>
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
    'https://pcisdplnodrphauixcau.supabase.co';

const getSupabaseKey = (): string =>
    (typeof import.meta !== 'undefined' &&
        (import.meta.env?.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_KEY)) ||
    '';

// ── In-memory cache ──────────────────────────────────────────────

/** Cache key: "lat,lon" rounded to 3 decimal places (~110m precision) */
function cacheKey(lat: number, lon: number): string {
    return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

const depthCache = new Map<string, number | null>();
/** Bound the depth cache (burn-down: it grew unbounded across a planning
 *  session's route recalcs). ~20k entries ≈ several full long-route
 *  validations; insertion-order eviction, same pattern as the ENC caches. */
const DEPTH_CACHE_MAX = 20_000;

function putDepth(key: string, depth: number | null): void {
    depthCache.set(key, depth);
    while (depthCache.size > DEPTH_CACHE_MAX) {
        const oldest = depthCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        depthCache.delete(oldest);
    }
}

/**
 * Align an edge `depths` response to the REQUEST points, trusting a depth ONLY
 * where the echoed coords still identify the point we asked about, at cache-key
 * precision (closing audit 2026-07-18 #5: the response was trusted
 * POSITIONALLY — `depths[j]` assigned to request point j by index — so a
 * reordered or mismatched same-length array silently gave a neighbour's depth
 * to a shoal sample on the weakest-data coarse-bathymetry fallback water). The legacy-named gebco-depth
 * edge echoes the request lat/lon verbatim (supabase/functions/gebco-depth:
 * queryDepthBatch), so a correct response matches exactly; any misalignment
 * (reorder, short/long array, corruption) drops THAT point to the loud no-data
 * path. The result stays aligned to `points` — order, length, and REQUEST
 * coords — so the caller caches each depth under the same key it looked up.
 */
export function alignDepthsToRequest(points: DepthPoint[], depths: DepthResult[]): DepthResult[] {
    let mismatches = 0;
    const aligned = points.map((pt, j) => {
        const d = depths[j] as DepthResult | undefined;
        const coordsMatch = d != null && cacheKey(d.lat, d.lon) === cacheKey(pt.lat, pt.lon);
        if (!coordsMatch) mismatches++;
        // Only trust the depth when the echoed coords still name THIS point.
        const depth_m = coordsMatch && Number.isFinite(d!.depth_m) ? (d!.depth_m as number) : null;
        return { lat: pt.lat, lon: pt.lon, depth_m };
    });
    if (mismatches > 0) {
        log.warn(
            `[GebcoDepth] ${mismatches}/${points.length} depth point(s) misaligned with the request — ` +
                `dropped to no-data (positional-trust guard)`,
        );
    }
    return aligned;
}

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

        // Fetch uncached points. Keep the endpoint's 200-point cap here at the
        // service boundary so every caller gets the same safe behaviour; one
        // oversized route must not turn the entire coarse-depth pass into nulls.
        if (uncachedPoints.length > 0) {
            const fetched: DepthResult[] = [];
            for (let start = 0; start < uncachedPoints.length; start += COARSE_BATHYMETRY_MAX_POINTS_PER_REQUEST) {
                fetched.push(
                    ...(await this._fetchFromEdge(
                        uncachedPoints.slice(start, start + COARSE_BATHYMETRY_MAX_POINTS_PER_REQUEST),
                    )),
                );
            }

            for (let j = 0; j < fetched.length; j++) {
                const idx = uncachedIndices[j];
                results[idx] = fetched[j];

                // Cache REAL depths only. ETOPO is global relief — a null
                // here always means the FETCH failed (edge error / offline),
                // never "no data exists at this point". Caching the null
                // poisoned the session: one transient outage degraded every
                // affected point to source:'none'/advisory-only until restart
                // (mission audit). Uncached → retried on the next query.
                if (fetched[j].depth_m !== null) {
                    const key = cacheKey(fetched[j].lat, fetched[j].lon);
                    putDepth(key, fetched[j].depth_m);
                }
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
     * The satellite relief along a route, for the land check (2026-10-02): the
     * cache first, then ONE bbox grid request per box of points (see
     * ROUTE_RELIEF_ATTEMPT_MS), each point read at its nearest node. A
     * timeout, a dropped connection or a 5xx is retried after a short wait; a
     * 401 / 403, a 429 or an answer it cannot read is not. Whatever is missing
     * at the end is said in `failure`, never guessed: 'offline' only when the
     * phone says so, and then nothing is asked.
     */
    async queryRouteRelief(
        points: DepthPoint[],
        opts: { attemptMs?: number; retryDelaysMs?: readonly number[] } = {},
    ): Promise<RouteReliefResult> {
        const attemptMs = opts.attemptMs ?? ROUTE_RELIEF_ATTEMPT_MS;
        const retryDelaysMs = opts.retryDelaysMs ?? ROUTE_RELIEF_RETRY_DELAYS_MS;
        const depths: DepthResult[] = points.map(({ lat, lon }) => {
            const key = cacheKey(lat, lon);
            return { lat, lon, depth_m: depthCache.has(key) ? depthCache.get(key)! : null };
        });
        const wanted = points.flatMap((p, i) => (depths[i].depth_m === null ? [{ ...p, i }] : []));
        let failure: ReliefFailure | null = null;
        let requests = 0;
        if (wanted.length > 0 && deviceOffline()) failure = { kind: 'offline' };
        else
            for (const chunk of reliefChunks(wanted)) {
                const got = await this._fetchReliefGrid(nodeBox(chunk), attemptMs, retryDelaysMs);
                requests += got.requests;
                if (!got.nodes) {
                    failure ??= got.failure;
                    continue;
                }
                for (const p of chunk) {
                    const depth = got.nodes.get(nodeKey(p.lat, p.lon));
                    if (depth === undefined || !Number.isFinite(depth)) continue;
                    depths[p.i] = { lat: p.lat, lon: p.lon, depth_m: depth };
                    putDepth(cacheKey(p.lat, p.lon), depth);
                }
            }
        const missing = depths.filter((d) => d.depth_m === null).length;
        if (!failure && missing > 0) failure = { kind: 'partial', missing, total: points.length };
        return { depths, failure: missing > 0 ? failure : null, requests };
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

    /** The signed-in session's headers, else the public key's (lower quota,
     *  per IP) — and which one it is. */
    private async _edgeAuth(): Promise<{ headers: Record<string, string>; sharedKey: boolean }> {
        try {
            return { headers: await getAuthenticatedFunctionHeaders(), sharedKey: false };
        } catch {
            const supabaseKey = getSupabaseKey();
            return {
                headers: {
                    'Content-Type': 'application/json',
                    ...(supabaseKey
                        ? {
                              Authorization: `Bearer ${supabaseKey}`,
                              apikey: supabaseKey,
                          }
                        : {}),
                },
                sharedKey: true,
            };
        }
    }

    /** The signed-in session's headers, else the public key's (lower quota). */
    private async _edgeHeaders(): Promise<Record<string, string>> {
        return (await this._edgeAuth()).headers;
    }

    /** One box of the ETOPO grid, retried as queryRouteRelief says. */
    private async _fetchReliefGrid(
        box: { s: number; n: number; w: number; e: number },
        attemptMs: number,
        retryDelaysMs: readonly number[],
    ): Promise<{ nodes: Map<string, number> | null; failure: ReliefFailure | null; requests: number }> {
        for (let attempt = 0; ; attempt++) {
            const got = await this._fetchReliefGridOnce(box, attemptMs);
            if (got.nodes || !retryable(got.failure) || attempt >= retryDelaysMs.length)
                return {
                    ...got,
                    // The words say the whole wait, not one attempt's.
                    failure: got.failure && attempt > 0 ? { ...got.failure, attempts: attempt + 1 } : got.failure,
                    requests: attempt + 1,
                };
            log.warn(
                `[GebcoDepth] grid attempt ${attempt + 1} failed (${got.failure?.kind}${got.failure?.status ? ` ${got.failure.status}` : ''}) — retrying in ${retryDelaysMs[attempt]} ms`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
            if (deviceOffline()) return { nodes: null, failure: { kind: 'offline' }, requests: attempt + 1 };
        }
    }

    private async _fetchReliefGridOnce(
        box: { s: number; n: number; w: number; e: number },
        attemptMs: number,
    ): Promise<{ nodes: Map<string, number> | null; failure: ReliefFailure | null }> {
        const url = `${getSupabaseUrl()}/functions/v1/gebco-depth`;
        const t0 = Date.now();
        let sharedKey = false;
        try {
            // withDeadline, not AbortSignal: see _fetchFromEdge. The session
            // lookup is inside the attempt's deadline too.
            const resp = await withDeadline(
                (async () => {
                    const auth = await this._edgeAuth();
                    sharedKey = auth.sharedKey;
                    return fetch(url, {
                        method: 'POST',
                        headers: auth.headers,
                        body: JSON.stringify({
                            bbox: {
                                south: box.s / RELIEF_NODES_PER_DEG,
                                north: box.n / RELIEF_NODES_PER_DEG,
                                west: box.w / RELIEF_NODES_PER_DEG,
                                east: box.e / RELIEF_NODES_PER_DEG,
                                stride: 1,
                            },
                        }),
                    });
                })(),
                attemptMs,
                'gebco-depth grid',
            );
            if (!resp.ok) {
                log.warn(`[GebcoDepth] grid request answered HTTP ${resp.status}`);
                return { nodes: null, failure: statusFailure(resp.status, sharedKey) };
            }
            const data = (await withDeadline(
                resp.json(),
                Math.max(1, attemptMs - (Date.now() - t0)),
                'gebco-depth grid body',
            )) as { source?: unknown; grid?: { table?: { columnNames?: unknown; rows?: unknown } } } | null;
            const table = data?.grid?.table;
            const names = Array.isArray(table?.columnNames) ? (table.columnNames as unknown[]) : [];
            const [la, lo, z] = ['latitude', 'longitude', 'altitude'].map((name) => names.indexOf(name));
            if (data?.source !== RELIEF_GRID_SOURCE_ID || la < 0 || lo < 0 || z < 0 || !Array.isArray(table?.rows)) {
                log.error(`[GebcoDepth] grid answer unreadable (source ${String(data?.source)}) — dropping it`);
                return { nodes: null, failure: { kind: 'bad-answer' } };
            }
            const nodes = new Map<string, number>();
            for (const row of table.rows as unknown[]) {
                if (!Array.isArray(row)) continue;
                const [lat, lon, alt] = [row[la], row[lo], row[z]];
                if (
                    typeof lat === 'number' &&
                    typeof lon === 'number' &&
                    typeof alt === 'number' &&
                    Number.isFinite(alt)
                )
                    nodes.set(nodeKey(lat, lon), alt);
            }
            return { nodes, failure: null };
        } catch (err) {
            if (err instanceof DeadlineExceeded)
                return { nodes: null, failure: { kind: 'timeout', waitedMs: attemptMs } };
            log.warn('[GebcoDepth] grid request failed:', err);
            return { nodes: null, failure: deviceOffline() ? { kind: 'offline' } : { kind: 'network' } };
        }
    }

    private async _fetchFromEdge(points: DepthPoint[]): Promise<DepthResult[]> {
        const supabaseUrl = getSupabaseUrl();
        const url = `${supabaseUrl}/functions/v1/gebco-depth`;

        try {
            const authHeaders = await this._edgeHeaders();
            // withDeadline, not AbortSignal: the CapacitorHttp fetch patch
            // ignores options.signal on device (native default 600 s), so
            // an AbortSignal.timeout here is a no-op exactly where it
            // matters — stalled marine-LTE sockets. See utils/deadline.ts.
            const resp = await withDeadline(
                fetch(url, {
                    method: 'POST',
                    headers: authHeaders,
                    body: JSON.stringify({ points }),
                }),
                30_000,
                'gebco-depth',
            );

            if (!resp.ok) {
                log.error(`[GebcoDepth] Edge function error ${resp.status}`);
                return points.map((pt) => ({ lat: pt.lat, lon: pt.lon, depth_m: null }));
            }

            // Body read bounded separately — a trickling LTE body resets
            // WKWebView's request timer byte-by-byte and can stall too.
            const data: DepthQueryResponse = await withDeadline(resp.json(), 15_000, 'gebco-depth body');
            if (data?.source !== COARSE_BATHYMETRY_SOURCE_ID) {
                log.error(
                    `[GebcoDepth] Unexpected bathymetry source ${String(data?.source)} — ` +
                        `expected ${COARSE_BATHYMETRY_SOURCE_ID}; dropping response to no-data`,
                );
                return points.map((pt) => ({ lat: pt.lat, lon: pt.lon, depth_m: null }));
            }
            return alignDepthsToRequest(points, Array.isArray(data?.depths) ? data.depths : []);
        } catch (err) {
            log.error('[GebcoDepth] Fetch error:', err);
            return points.map((pt) => ({ lat: pt.lat, lon: pt.lon, depth_m: null }));
        }
    }
}

// Singleton
export const GebcoDepthService = new GebcoDepthServiceClass();
