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
        const resp = await fetch(url, {
            signal: AbortSignal.timeout(10_000),
        });

        if (!resp.ok) {
            console.error(`[Depth] ERDDAP error ${resp.status} for (${lat}, ${lon})`);
            return null;
        }

        const data = await resp.json();
        const rows = data?.table?.rows;
        if (rows && rows.length > 0 && rows[0].length >= 3) {
            return rows[0][2]; // altitude column
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

    const t0 = performance.now();

    try {
        const body = await req.json();

        // ── Mode 1: Bounding box grid query (for BathymetryCache) ──
        if (body.bbox) {
            const { south, north, west, east, stride = 15 } = body.bbox;
            if (south == null || north == null || west == null || east == null) {
                return new Response(JSON.stringify({ error: 'bbox requires south, north, west, east' }), {
                    status: 400,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }

            // Fetch grid from ERDDAP — single server-side call (no CORS issue)
            const gridUrl = `${ERDDAP_BASE}?altitude%5B(${south}):${stride}:(${north})%5D%5B(${west}):${stride}:(${east})%5D`;
            console.info(`[Depth] Grid query: ${gridUrl}`);

            const resp = await fetch(gridUrl, { signal: AbortSignal.timeout(30_000) });
            if (!resp.ok) {
                const errText = await resp.text().catch(() => '');
                return new Response(JSON.stringify({ error: `ERDDAP returned ${resp.status}`, details: errText }), {
                    status: 502,
                    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
                });
            }

            const data = await resp.json();
            const elapsed_ms = Math.round(performance.now() - t0);

            return new Response(JSON.stringify({ grid: data, elapsed_ms, source: 'noaa_etopo_erddap_grid' }), {
                status: 200,
                headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
            });
        }

        // ── Mode 2: Individual points query (original behaviour) ──
        const points: DepthPoint[] = body.points;

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

        const depths = await queryDepthBatch(points);
        const elapsed_ms = Math.round(performance.now() - t0);

        return new Response(JSON.stringify({ depths, elapsed_ms, source: 'noaa_etopo_erddap' }), {
            status: 200,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
    } catch (err) {
        console.error('[Depth] Handler error:', err);
        return new Response(JSON.stringify({ error: 'Internal error', details: String(err) }), {
            status: 500,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
    }
});
