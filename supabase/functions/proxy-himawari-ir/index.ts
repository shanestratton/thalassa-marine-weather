// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-himawari-ir — NASA GIBS Himawari-9 Enhanced IR Tile Proxy
 *
 * Proxies near-real-time infrared satellite tiles from NASA GIBS.
 * Layer: Himawari_AHI_Band13_Clean_Infrared (10.4µm clean IR window)
 * Updates: Every 10–20 minutes, ~40 min latency.
 * Cyclones appear as bright white/colored spirals 24/7.
 *
 * Uses the KVP WMTS endpoint (wmts.cgi) which is the working format.
 *
 * GET /proxy-himawari-ir?z=5&y=17&x=29
 *   → Returns the latest available IR tile PNG from GIBS.
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi';

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'GET required' }), {
            status: 405,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const url = new URL(req.url);
    const z = url.searchParams.get('z');
    const y = url.searchParams.get('y');
    const x = url.searchParams.get('x');

    if (!z || !y || !x) {
        return new Response(JSON.stringify({ error: 'Missing z/y/x params' }), {
            status: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    // Try today first, then fallback to yesterday and day before
    const dates: string[] = [];
    for (let daysAgo = 0; daysAgo < 3; daysAgo++) {
        const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
        dates.push(d.toISOString().split('T')[0]);
    }

    for (const dateStr of dates) {
        // KVP WMTS format — the working endpoint for Himawari IR
        const tileUrl = `${GIBS_BASE}?` + new URLSearchParams({
            Service: 'WMTS',
            Request: 'GetTile',
            Version: '1.0.0',
            Layer: 'Himawari_AHI_Band13_Clean_Infrared',
            Style: 'default',
            TileMatrixSet: 'GoogleMapsCompatible_Level6',
            TileMatrix: z,
            TileRow: y,
            TileCol: x,
            Format: 'image/png',
            Time: dateStr,
        }).toString();

        try {
            const res = await fetch(tileUrl, {
                headers: { 'User-Agent': 'Thalassa-Marine-Weather/1.0' },
            });

            if (res.ok) {
                const body = await res.arrayBuffer();
                const contentType = res.headers.get('Content-Type') || 'image/png';
                return new Response(body, {
                    status: 200,
                    headers: {
                        ...CORS,
                        'Content-Type': contentType,
                        'Cache-Control': 'public, max-age=600', // Cache tiles 10 min
                    },
                });
            }

            if (res.status === 404) continue;

            return new Response(JSON.stringify({ error: `GIBS: ${res.status}` }), {
                status: res.status,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        } catch (err) {
            console.error(`[proxy-himawari-ir] Fetch error for ${dateStr}:`, err);
            continue;
        }
    }

    return new Response(JSON.stringify({ error: 'No tiles available from GIBS' }), {
        status: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
});
