// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * proxy-rainbow — Rainbow.ai Tile API Proxy
 *
 * Two modes:
 *   1. Snapshot:   GET /proxy-rainbow?action=snapshot
 *                  → Fetches current snapshot ID from Rainbow.ai
 *   2. Tile:      GET /proxy-rainbow?action=tile&snapshot=<id>&forecast=<secs>&z=<z>&x=<x>&y=<y>&color=<color>
 *                  → Proxies tile PNG with token injected server-side
 *
 * Required Supabase Secret:
 *   RAINBOW_API_KEY
 */

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

const RAINBOW_BASE = "https://api.rainbow.ai/tiles/v1";

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
    }

    if (req.method !== "GET") {
        return new Response(JSON.stringify({ error: "GET required" }), {
            status: 405,
            headers: { ...CORS, "Content-Type": "application/json" },
        });
    }

    const key = Deno.env.get("RAINBOW_API_KEY");
    if (!key) {
        return new Response(JSON.stringify({ error: "RAINBOW_API_KEY not configured" }), {
            status: 500,
            headers: { ...CORS, "Content-Type": "application/json" },
        });
    }

    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    try {
        if (action === "snapshot") {
            // Fetch latest snapshot ID
            const res = await fetch(`${RAINBOW_BASE}/snapshot?token=${key}`);
            const data = await res.json();
            return new Response(JSON.stringify(data), {
                status: res.status,
                headers: { ...CORS, "Content-Type": "application/json" },
            });
        }

        if (action === "tile") {
            // Proxy tile request
            const snapshot = url.searchParams.get("snapshot");
            const forecast = url.searchParams.get("forecast");
            const z = url.searchParams.get("z");
            const x = url.searchParams.get("x");
            const y = url.searchParams.get("y");
            const color = url.searchParams.get("color") || "dbz_u8";

            if (!snapshot || !forecast || !z || !x || !y) {
                return new Response(JSON.stringify({ error: "Missing tile params" }), {
                    status: 400,
                    headers: { ...CORS, "Content-Type": "application/json" },
                });
            }

            const tileUrl = `${RAINBOW_BASE}/precip/${snapshot}/${forecast}/${z}/${x}/${y}?token=${key}&color=${color}`;
            const res = await fetch(tileUrl);

            if (!res.ok) {
                return new Response(JSON.stringify({ error: `Rainbow API: ${res.status}` }), {
                    status: res.status,
                    headers: { ...CORS, "Content-Type": "application/json" },
                });
            }

            // Forward tile PNG/image
            const body = await res.arrayBuffer();
            const contentType = res.headers.get("Content-Type") || "image/png";
            return new Response(body, {
                status: 200,
                headers: {
                    ...CORS,
                    "Content-Type": contentType,
                    "Cache-Control": "public, max-age=300", // Cache tiles 5 min
                },
            });
        }

        return new Response(JSON.stringify({ error: "Unknown action. Use action=snapshot or action=tile" }), {
            status: 400,
            headers: { ...CORS, "Content-Type": "application/json" },
        });
    } catch (e) {
        console.error("[proxy-rainbow] Error:", e);
        return new Response(JSON.stringify({ error: "Internal proxy error" }), {
            status: 500,
            headers: { ...CORS, "Content-Type": "application/json" },
        });
    }
});
