// GEBCO / ETOPO Depth Query Edge Function
//
// Queries bathymetric data for depth values at specified coordinates.
// Uses NOAA ETOPO via ERDDAP (reliable, free, no auth required).
//
// Endpoints:
//   POST /gebco-depth — batch query depths for an array of lat/lon points
//
// Request body:
//   { points: Array<{ lat: number; lon: number }> }
//
// Response:
//   { depths: Array<{ lat: number; lon: number; depth_m: number }>, elapsed_ms: number }
//
// Depth values:
//   - Negative = below sea level (ocean depth)
//   - Positive = above sea level (land)
//   - null = query failed for that point

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    parseBoundedInteger,
    parseCoordinate,
    parseGeoBounds,
    readJsonObject,
    readResponseTextLimited,
} from '../_shared/http-security.ts';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// NOAA ETOPO ERDDAP endpoint — global bathymetry + topography
// Grid resolution: ~1 arc-minute (~1.8 km)
// Coverage: global, -90 to 90 lat, -180 to 180 lon
const ERDDAP_BASE = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.json';

interface DepthPoint {
    lat: number;
    lon: number;
}

interface DepthResult {
    lat: number;
    lon: number;
    depth_m: number | null;
}

/**
 * Query depth at a single point via NOAA ETOPO ERDDAP.
 *
 * ERDDAP returns altitude in metres:
 *   - Negative = ocean depth below sea level
 *   - Positive = land elevation above sea level
 */
async function queryDepthSingle(lat: number, lon: number): Promise<number | null> {
    // ERDDAP constraint syntax: altitude[(lat)][(lon)]
    const url = `${ERDDAP_BASE}?altitude%5B(${lat})%5D%5B(${lon})%5D`;

    try {
        const resp = await fetchWithTimeout(url, {}, 10_000);

        if (!resp.ok) {
            console.error(`[Depth] ERDDAP error ${resp.status} for (${lat}, ${lon})`);
            return null;
        }

        const text = await readResponseTextLimited(resp, 250_000);
        if (text === null) return null;
        const data = JSON.parse(text);
        const rows = data?.table?.rows;
        if (rows && rows.length > 0 && rows[0].length >= 3) {
            const depth = rows[0][2];
            return typeof depth === 'number' && Number.isFinite(depth) ? depth : null;
        }
        return null;
    } catch (err) {
        console.error(`[Depth] Query failed for (${lat}, ${lon}):`, err);
        return null;
    }
}

/**
 * Batch query depths for multiple points.
 *
 * Strategy:
 * - For ≤ 5 points: individual parallel queries (fast, simple)
 * - For > 5 points: group into small batches with ERDDAP range queries
 */
async function queryDepthBatch(points: DepthPoint[]): Promise<DepthResult[]> {
    if (points.length === 0) return [];

    // For all batch sizes, use parallel individual queries with concurrency limit
    // ERDDAP is fast enough and this avoids complex grid interpolation
    const CONCURRENCY = 10;
    const results: DepthResult[] = new Array(points.length);

    for (let i = 0; i < points.length; i += CONCURRENCY) {
        const batch = points.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(async (pt) => ({
                lat: pt.lat,
                lon: pt.lon,
                depth_m: await queryDepthSingle(pt.lat, pt.lon),
            })),
        );
        for (let j = 0; j < batchResults.length; j++) {
            results[i + j] = batchResults[j];
        }
    }

    return results;
}

// ── HTTP Handler ─────────────────────────────────────────────────

serve(async (req: Request) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'POST required' }), {
            status: 405,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
    }

    const caller = await requireAuthenticatedOrPublicQuota(req, 'gebco_depth', 120, 12, 86400);
    if (caller instanceof Response) return withCors(caller, CORS_HEADERS);

    const t0 = performance.now();

    try {
        const body = await readJsonObject(req, 32_768);
        if (!body) {
            return new Response(JSON.stringify({ error: 'Invalid JSON request body' }), {
                status: 400,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
        }

        // ── Mode 1: Bounding box grid query (for BathymetryCache) ──
        if (body.bbox !== undefined) {
            if (!body.bbox || typeof body.bbox !== 'object' || Array.isArray(body.bbox)) {
                return new Response(JSON.stringify({ error: 'Invalid bbox' }), {
                    status: 400,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            const bbox = body.bbox as Record<string, unknown>;
            const bounds = parseGeoBounds(bbox);
            const stride = parseBoundedInteger(bbox.stride ?? 15, 1, 120);
            if (!bounds || stride === null || bounds.east <= bounds.west) {
                return new Response(JSON.stringify({ error: 'Invalid bbox bounds or stride' }), {
                    status: 400,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            const { south, north, west, east } = bounds;
            const estimatedRows = Math.ceil((bounds.latSpan * 60) / stride) + 1;
            const estimatedColumns = Math.ceil((bounds.lonSpan * 60) / stride) + 1;
            if (estimatedRows * estimatedColumns > 250_000) {
                return new Response(JSON.stringify({ error: 'Requested bathymetry grid is too large' }), {
                    status: 413,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }

            // Fetch grid from ERDDAP — single server-side call (no CORS issue)
            const gridUrl = `${ERDDAP_BASE}?altitude%5B(${south}):${stride}:(${north})%5D%5B(${west}):${stride}:(${east})%5D`;
            console.info(`[Depth] Grid query: ${gridUrl}`);

            const resp = await fetchWithTimeout(gridUrl, {}, 30_000);
            if (!resp.ok) {
                return new Response(JSON.stringify({ error: 'Bathymetry upstream failed' }), {
                    status: 502,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }

            const text = await readResponseTextLimited(resp, 20_000_000);
            if (text === null) {
                return new Response(JSON.stringify({ error: 'Bathymetry upstream response is too large' }), {
                    status: 502,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            const data = JSON.parse(text);
            const elapsed_ms = Math.round(performance.now() - t0);

            return new Response(JSON.stringify({ grid: data, elapsed_ms, source: 'noaa_etopo_erddap_grid' }), {
                status: 200,
                headers: {
                    ...CORS_HEADERS,
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=86400',
                },
            });
        }

        // ── Mode 2: Individual points query (original behaviour) ──
        const points = body.points;

        if (!Array.isArray(points) || points.length === 0) {
            return new Response(JSON.stringify({ error: 'points array or bbox required' }), {
                status: 400,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
        }

        // Cap at 200 points per request
        if (points.length > 200) {
            return new Response(JSON.stringify({ error: 'Max 200 points per request' }), {
                status: 400,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
        }
        const validatedPoints: DepthPoint[] = [];
        for (const point of points) {
            if (!point || typeof point !== 'object' || Array.isArray(point)) {
                return new Response(JSON.stringify({ error: 'Each point must contain valid lat/lon coordinates' }), {
                    status: 400,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            const record = point as Record<string, unknown>;
            const lat = parseCoordinate(record.lat, 'lat');
            const lon = parseCoordinate(record.lon, 'lon');
            if (lat === null || lon === null) {
                return new Response(JSON.stringify({ error: 'Each point must contain valid lat/lon coordinates' }), {
                    status: 400,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }
            validatedPoints.push({ lat, lon });
        }

        const depths = await queryDepthBatch(validatedPoints);
        const elapsed_ms = Math.round(performance.now() - t0);

        return new Response(JSON.stringify({ depths, elapsed_ms, source: 'noaa_etopo_erddap' }), {
            status: 200,
            headers: {
                ...CORS_HEADERS,
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=86400',
            },
        });
    } catch (err) {
        console.error('[Depth] Handler error:', err);
        return new Response(JSON.stringify({ error: 'Bathymetry request failed' }), {
            status: 502,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
    }
});
