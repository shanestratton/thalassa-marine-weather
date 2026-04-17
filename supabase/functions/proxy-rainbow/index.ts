// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-rainbow — Rainbow.ai API Proxy (Tiles + Nowcast)
 *
 * Five modes:
 *   1. Snapshot:  GET /proxy-rainbow?action=snapshot&layer=precip|precip-global|clouds
 *                 → Fetches current snapshot ID from Rainbow.ai
 *   2. Tile:     GET /proxy-rainbow?action=tile&snapshot=<id>&forecast=<secs>&z=<z>&x=<x>&y=<y>&layer=precip|precip-global|clouds
 *                 → Proxies tile PNG with token injected server-side
 *   3. Nowcast:  GET /proxy-rainbow?action=nowcast&lat=<lat>&lon=<lon>
 *                 → Direct JSON precipitation forecast via Rainbow Global Nowcast API
 *                 → Returns minute-by-minute precipRate + precipType for 4 hours
 *   4. Point:    GET /proxy-rainbow?action=point&lat=<lat>&lon=<lon>
 *                 → Legacy alias for nowcast (backward compatible)
 *
 * Required Supabase Secret:
 *   RAINBOW_API_KEY
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

const RAINBOW_TILES = 'https://api.rainbow.ai/tiles/v1';
const RAINBOW_NOWCAST = 'https://api.rainbow.ai/nowcast/v1';

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

    const key = Deno.env.get('RAINBOW_API_KEY');
    if (!key) {
        return new Response(JSON.stringify({ error: 'RAINBOW_API_KEY not configured' }), {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }

    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    try {
        // ═══ ACTION: SNAPSHOT ═══
        if (action === 'snapshot') {
            const layer = url.searchParams.get('layer') || 'precip';
            const res = await fetch(`${RAINBOW_TILES}/snapshot?token=${key}&layer=${layer}`);
            const data = await res.json();
            return new Response(JSON.stringify(data), {
                status: res.status,
                headers: { ...CORS, 'Content-Type': 'application/json' },
            });
        }

        // ═══ ACTION: NOWCAST (new Nowcast API — direct JSON) ═══
        if (action === 'nowcast') {
            const lat = url.searchParams.get('lat');
            const lon = url.searchParams.get('lon');

            if (!lat || !lon) {
                return new Response(JSON.stringify({ error: 'lat and lon required' }), {
                    status: 400,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }

            // Nowcast API: /nowcast/v1/precip-global/{longitude}/{latitude}
            // NOTE: longitude comes FIRST in the path!
            const nowcastUrl = `${RAINBOW_NOWCAST}/precip-global/${lon}/${lat}?token=${key}`;
            const res = await fetch(nowcastUrl);
            const data = await res.json();

            return new Response(JSON.stringify(data), {
                status: res.status,
                headers: {
                    ...CORS,
                    'Content-Type': 'application/json',
                    'Cache-Control': 'public, max-age=300',
                },
            });
        }

        // ═══ ACTION: TILE ═══
        if (action === 'tile') {
            const snapshot = url.searchParams.get('snapshot');
            const forecast = url.searchParams.get('forecast');
            const z = url.searchParams.get('z');
            const x = url.searchParams.get('x');
            const y = url.searchParams.get('y');
            const color = url.searchParams.get('color') || '';
            const layer = url.searchParams.get('layer') || 'precip'; // precip | precip-global | clouds

            if (!snapshot || !z || !x || !y) {
                return new Response(JSON.stringify({ error: 'Missing tile params' }), {
                    status: 400,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }

            // Cloud tiles don't have a forecast time parameter
            let tileUrl: string;
            if (layer === 'clouds') {
                tileUrl = `${RAINBOW_TILES}/clouds/${snapshot}/${z}/${x}/${y}?token=${key}`;
            } else {
                if (!forecast) {
                    return new Response(JSON.stringify({ error: 'forecast param required for precip tiles' }), {
                        status: 400,
                        headers: { ...CORS, 'Content-Type': 'application/json' },
                    });
                }
                tileUrl = `${RAINBOW_TILES}/${layer}/${snapshot}/${forecast}/${z}/${x}/${y}?token=${key}`;
                if (color) tileUrl += `&color=${color}`;
            }

            const res = await fetch(tileUrl);

            if (!res.ok) {
                return new Response(JSON.stringify({ error: `Rainbow API: ${res.status}` }), {
                    status: res.status,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }

            const body = await res.arrayBuffer();
            const contentType = res.headers.get('Content-Type') || 'image/png';
            return new Response(body, {
                status: 200,
                headers: {
                    ...CORS,
                    'Content-Type': contentType,
                    'Cache-Control': 'public, max-age=300',
                },
            });
        }

        // ═══ ACTION: POINT (legacy — redirects to nowcast) ═══
        if (action === 'point') {
            const lat = url.searchParams.get('lat');
            const lon = url.searchParams.get('lon');

            if (!lat || !lon) {
                return new Response(JSON.stringify({ error: 'lat and lon required' }), {
                    status: 400,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }

            // Use the Nowcast API directly — much faster than tile decoding
            const nowcastUrl = `${RAINBOW_NOWCAST}/precip-global/${lon}/${lat}?token=${key}`;
            const res = await fetch(nowcastUrl);

            if (!res.ok) {
                return new Response(JSON.stringify({ error: `Nowcast API: ${res.status}` }), {
                    status: res.status,
                    headers: { ...CORS, 'Content-Type': 'application/json' },
                });
            }

            const nowcastData = await res.json();

            // Map to legacy point format for backward compatibility
            const forecast = nowcastData.forecast || [];
            const data = forecast
                .filter((_: unknown, i: number) => i % 10 === 0 || i < 60) // Sample: every minute for 1h, every 10m after
                .map((f: { precipRate: number; precipType?: string; timestampBegin: number }) => ({
                    forecastMinutes: Math.round(
                        (f.timestampBegin - (forecast[0]?.timestampBegin ?? f.timestampBegin)) / 60,
                    ),
                    intensity: Math.round((f.precipRate ?? 0) * 100) / 100,
                    precipType: f.precipType || undefined,
                }));

            return new Response(
                JSON.stringify({
                    lat: parseFloat(lat),
                    lon: parseFloat(lon),
                    data,
                    nowcast: nowcastData, // Also include the raw Nowcast API response
                }),
                {
                    status: 200,
                    headers: {
                        ...CORS,
                        'Content-Type': 'application/json',
                        'Cache-Control': 'public, max-age=300',
                    },
                },
            );
        }

        return new Response(
            JSON.stringify({
                error: 'Unknown action. Use action=snapshot, action=tile, action=nowcast, or action=point',
            }),
            { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } },
        );
    } catch (e) {
        console.error('[proxy-rainbow] Error:', e);
        return new Response(JSON.stringify({ error: 'Internal proxy error' }), {
            status: 500,
            headers: { ...CORS, 'Content-Type': 'application/json' },
        });
    }
});

// PNG pixel extraction and dBZ conversion removed — the Nowcast API
// now returns precipitation data directly as JSON. The tile endpoint
// still serves PNG images for map visualization, but point queries
// use /nowcast/v1/precip-global/{lon}/{lat} which is orders of
// magnitude faster and returns precipType (rain/snow/mixed) too.
