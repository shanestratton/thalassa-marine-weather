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
 *   { lat: number, lon: number, days?: number }
 *
 * Required Supabase Secret:
 *   WORLDTIDES_API_KEY
 */

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });
}

Deno.serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== "POST") {
        return corsResponse(JSON.stringify({ error: "POST required" }), 405);
    }

    const key = Deno.env.get("WORLDTIDES_API_KEY");
    if (!key) {
        return corsResponse(JSON.stringify({ error: "WORLDTIDES_API_KEY not configured" }), 500);
    }

    try {
        const { lat, lon, days = 14 } = await req.json();

        if (typeof lat !== "number" || typeof lon !== "number") {
            return corsResponse(JSON.stringify({ error: "lat and lon are required numbers" }), 400);
        }

        // Build WorldTides URL — extremes only (saves credits vs heights)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        today.setDate(today.getDate() - 1); // Go back 24h for graph interpolation
        const start = Math.floor(today.getTime() / 1000);

        const url = `https://www.worldtides.info/api/v3?extremes&lat=${lat}&lon=${lon}&days=${days}&datum=LAT&stationDistance=100&start=${start}&key=${key}`;

        const res = await fetch(url);
        const data = await res.json();

        if (res.status !== 200 || data.error) {
            console.error(`[proxy-tides] WorldTides error: ${res.status}`, data);
            return corsResponse(JSON.stringify({ error: data.error || `HTTP ${res.status}` }), res.status);
        }

        return corsResponse(JSON.stringify(data), 200);
    } catch (e) {
        console.error("[proxy-tides] Error:", e);
        return corsResponse(JSON.stringify({ error: "Internal proxy error" }), 500);
    }
});
