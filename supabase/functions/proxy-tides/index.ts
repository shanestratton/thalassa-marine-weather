// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-tides — WorldTides API Proxy
 *
 * Proxies tide requests through Supabase Edge so the WorldTides API key
 * never leaves the server. The client sends lat/lon/days; this function
 * appends the secret key and forwards to WorldTides, returning the response.
 *
 * Request: POST with JSON body:
 *   { lat: number, lon: number, days?: number, stations?: boolean, stationDistance?: number }
 *
 * When `stations: true` → returns nearby tide stations (discovery).
 * Otherwise → returns tide extremes (high/low times + heights).
 *
 * Required Supabase Secret:
 *   WORLDTIDES_API_KEY
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });
}

Deno.serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== 'POST' && req.method !== 'GET') {
        return corsResponse(JSON.stringify({ error: 'GET or POST required' }), 405);
    }

    const key = Deno.env.get('WORLDTIDES_API_KEY');
    if (!key) {
        return corsResponse(JSON.stringify({ error: 'WORLDTIDES_API_KEY not configured' }), 500);
    }

    try {
        // Support both GET (query params) and POST (JSON body)
        let lat: number, lon: number, days: number, stations: boolean | undefined, rawDist: number;
        if (req.method === 'GET') {
            const url = new URL(req.url);
            lat = Number(url.searchParams.get('lat'));
            lon = Number(url.searchParams.get('lon'));
            days = Number(url.searchParams.get('days')) || 14;
            stations = url.searchParams.get('stations') === 'true';
            rawDist = Number(url.searchParams.get('stationDistance')) || 100;
        } else {
            const body = await req.json();
            lat = body.lat;
            lon = body.lon;
            days = body.days ?? 14;
            stations = body.stations;
            rawDist = body.stationDistance ?? 100;
        }
        // WorldTides API v3 caps stationDistance at 100km — clamp to avoid 400 errors
        const stationDistance = Math.min(Math.max(0, Number(rawDist) || 100), 100);

        if (typeof lat !== 'number' || typeof lon !== 'number') {
            return corsResponse(JSON.stringify({ error: 'lat and lon are required numbers' }), 400);
        }

        let url: string;

        if (stations) {
            // Station discovery — return nearby tide stations within radius
            url = `https://www.worldtides.info/api/v3?stations&lat=${lat}&lon=${lon}&stationDistance=${stationDistance}&key=${key}`;
        } else {
            // Tide extremes — high/low tide times + heights
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            today.setDate(today.getDate() - 1); // Go back 24h for graph interpolation
            const start = Math.floor(today.getTime() / 1000);
            url = `https://www.worldtides.info/api/v3?extremes&lat=${lat}&lon=${lon}&days=${days}&datum=LAT&stationDistance=${stationDistance}&start=${start}&key=${key}`;
        }

        const res = await fetch(url);
        const data = await res.json();

        if (res.status !== 200 || data.error) {
            console.error(`[proxy-tides] WorldTides error: ${res.status}`, data);
            return corsResponse(JSON.stringify({ error: data.error || `HTTP ${res.status}` }), res.status);
        }

        return corsResponse(JSON.stringify(data), 200);
    } catch (e) {
        console.error('[proxy-tides] Error:', e);
        return corsResponse(JSON.stringify({ error: 'Internal proxy error' }), 500);
    }
});
