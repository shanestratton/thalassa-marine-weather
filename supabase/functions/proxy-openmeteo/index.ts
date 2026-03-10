// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-openmeteo — Open-Meteo Commercial API Proxy
 *
 * Proxies weather requests so the commercial API key never leaves the server.
 * The client sends the full query params; this function appends the apikey.
 *
 * Request: POST with JSON body:
 *   { endpoint: string, params: Record<string, string> }
 *   e.g. { endpoint: "forecast", params: { latitude: "-27.4", longitude: "153.1", hourly: "uv_index,cape" } }
 *
 * Required Supabase Secret:
 *   OPEN_METEO_API_KEY
 */

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

function corsResponse(body: BodyInit | null, status: number) {
    return new Response(body, { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const BASE_URL = "https://customer-api.open-meteo.com/v1";

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== "POST") {
        return corsResponse(JSON.stringify({ error: "POST required" }), 405);
    }

    const key = Deno.env.get("OPEN_METEO_API_KEY");
    if (!key) {
        return corsResponse(JSON.stringify({ error: "OPEN_METEO_API_KEY not configured" }), 500);
    }

    try {
        const { endpoint, params } = await req.json();

        if (!endpoint || typeof endpoint !== "string") {
            return corsResponse(JSON.stringify({ error: "endpoint is required" }), 400);
        }

        // Only allow known Open-Meteo endpoints
        const allowedEndpoints = ["forecast", "marine", "air-quality", "elevation"];
        if (!allowedEndpoints.includes(endpoint)) {
            return corsResponse(JSON.stringify({ error: "Invalid endpoint" }), 400);
        }

        // Build query string, injecting the API key server-side
        const allParams = { ...params, apikey: key };
        const queryString = Object.entries(allParams)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join("&");

        const url = `${BASE_URL}/${endpoint}?${queryString}`;

        const res = await fetch(url);
        const data = await res.json();

        if (res.status !== 200) {
            console.error(`[proxy-openmeteo] Open-Meteo error: ${res.status}`, data);
        }

        return corsResponse(JSON.stringify(data), res.status);
    } catch (e) {
        console.error("[proxy-openmeteo] Error:", e);
        return corsResponse(JSON.stringify({ error: "Internal proxy error" }), 500);
    }
});
