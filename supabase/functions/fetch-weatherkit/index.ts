// deno-lint-ignore-file
/* eslint-disable @typescript-eslint/no-namespace */
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * fetch-weatherkit — Apple WeatherKit JWT Proxy
 *
 * Generates an ES256 JWT using Apple's .p8 private key,
 * fetches weather data from Apple WeatherKit API, and
 * returns clean JSON to the frontend with CORS headers.
 *
 * Request: POST with JSON body:
 *   { lat: number, lon: number, language?: string, dataSets?: string[] }
 *
 * Response: JSON (WeatherKit response)
 *
 * Required Supabase Secrets:
 *   APPLE_WEATHERKIT_P8_KEY    — PEM-encoded EC private key (.p8 file contents)
 *   APPLE_WEATHERKIT_KEY_ID    — 10-char Key ID from Apple Developer
 *   APPLE_WEATHERKIT_TEAM_ID   — 10-char Team ID
 *   APPLE_WEATHERKIT_SERVICE_ID — reverse-domain Service ID
 */

// ── CORS ──────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

// ── Base64url encoding ────────────────────────────────────────

function base64url(data: Uint8Array): string {
    let binary = "";
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlEncode(str: string): string {
    return base64url(new TextEncoder().encode(str));
}

// ── PEM → CryptoKey ───────────────────────────────────────────

async function importP8Key(pem: string): Promise<CryptoKey> {
    // Strip PEM headers/footers and whitespace
    const pemBody = pem
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\s/g, "");

    // Decode base64 to binary
    const binaryStr = atob(pemBody);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }

    // Import as ECDSA P-256 private key
    return await crypto.subtle.importKey(
        "pkcs8",
        bytes.buffer,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
    );
}

// ── JWT Generation ────────────────────────────────────────────

async function generateWeatherKitJWT(
    privateKey: CryptoKey,
    keyId: string,
    teamId: string,
    serviceId: string,
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    // Apple WeatherKit JWT Header
    const header = {
        alg: "ES256",
        kid: keyId,
        id: `${teamId}.${serviceId}`,
    };

    // Apple WeatherKit JWT Payload
    const payload = {
        iss: teamId,
        iat: now,
        exp: now + 3600, // 1 hour expiry
        sub: serviceId,
    };

    // Encode header and payload
    const headerB64 = base64urlEncode(JSON.stringify(header));
    const payloadB64 = base64urlEncode(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;

    // Sign with ES256 (ECDSA P-256 + SHA-256)
    const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        new TextEncoder().encode(signingInput),
    );

    // The Web Crypto API returns the signature in IEEE P1363 format (r || s),
    // which is exactly what JWT ES256 expects. No DER conversion needed.
    const signatureB64 = base64url(new Uint8Array(signature));

    return `${signingInput}.${signatureB64}`;
}

// ── Cache JWT for reuse ───────────────────────────────────────

let cachedToken: { jwt: string; expiresAt: number } | null = null;

async function getOrCreateJWT(
    privateKey: CryptoKey,
    keyId: string,
    teamId: string,
    serviceId: string,
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    // Reuse cached JWT if it has > 5 minutes left
    if (cachedToken && cachedToken.expiresAt > now + 300) {
        return cachedToken.jwt;
    }

    const jwt = await generateWeatherKitJWT(privateKey, keyId, teamId, serviceId);
    cachedToken = { jwt, expiresAt: now + 3600 };
    return jwt;
}

// ── Types ─────────────────────────────────────────────────────

interface WeatherKitRequest {
    lat: number;
    lon: number;
    language?: string;   // e.g. "en-AU", defaults to "en"
    dataSets?: string[]; // defaults to currentWeather + forecastHourly + forecastDaily + forecastNextHour
}

// ── Main handler ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return corsResponse(null, 204);
    }

    if (req.method !== "POST") {
        return corsResponse(
            JSON.stringify({ error: "POST required" }),
            405,
            { "Content-Type": "application/json" },
        );
    }

    try {
        // ── Read secrets (try both naming conventions) ──
        const p8Key = Deno.env.get("APPLE_WEATHERKIT_P8_KEY") || Deno.env.get("WEATHERKIT_PRIVATE_KEY");
        const keyId = Deno.env.get("APPLE_WEATHERKIT_KEY_ID") || Deno.env.get("WEATHERKIT_KEY_ID");
        const teamId = Deno.env.get("APPLE_WEATHERKIT_TEAM_ID") || Deno.env.get("WEATHERKIT_TEAM_ID");
        const serviceId = Deno.env.get("APPLE_WEATHERKIT_SERVICE_ID") || Deno.env.get("WEATHERKIT_SERVICE_ID") || (teamId ? `com.thalassa.weatherkit` : undefined);

        console.log(`[fetch-weatherkit] Secrets check: P8=${p8Key ? 'YES' : 'MISSING'}, KeyID=${keyId ? 'YES' : 'MISSING'}, TeamID=${teamId ? 'YES' : 'MISSING'}, ServiceID=${serviceId ? 'YES' : 'MISSING'}`);

        if (!p8Key || !keyId || !teamId || !serviceId) {
            console.error("[fetch-weatherkit] Missing required secrets");
            return corsResponse(
                JSON.stringify({
                    error: "WeatherKit not configured",
                    missing: [
                        !p8Key && "APPLE_WEATHERKIT_P8_KEY / WEATHERKIT_PRIVATE_KEY",
                        !keyId && "APPLE_WEATHERKIT_KEY_ID / WEATHERKIT_KEY_ID",
                        !teamId && "APPLE_WEATHERKIT_TEAM_ID / WEATHERKIT_TEAM_ID",
                        !serviceId && "APPLE_WEATHERKIT_SERVICE_ID / WEATHERKIT_SERVICE_ID",
                    ].filter(Boolean),
                }),
                500,
                { "Content-Type": "application/json" },
            );
        }

        // ── Parse request ──
        const body: WeatherKitRequest = await req.json();
        const { lat, lon } = body;

        if (typeof lat !== "number" || typeof lon !== "number") {
            return corsResponse(
                JSON.stringify({ error: "lat and lon are required numbers" }),
                400,
                { "Content-Type": "application/json" },
            );
        }

        const language = body.language || "en";
        const dataSets = body.dataSets || [
            "currentWeather",
            "forecastHourly",
            "forecastDaily",
            "forecastNextHour",
        ];

        // ── Generate JWT ──
        const privateKey = await importP8Key(p8Key);
        const jwt = await getOrCreateJWT(privateKey, keyId, teamId, serviceId);

        // ── Fetch from Apple WeatherKit ──
        const dataSetsParam = dataSets.join(",");
        const url = `https://weatherkit.apple.com/api/v1/weather/${language}/${lat}/${lon}?dataSets=${dataSetsParam}`;

        console.log(`[fetch-weatherkit] Fetching: ${url}`);

        const upstream = await fetch(url, {
            headers: {
                Authorization: `Bearer ${jwt}`,
            },
        });

        if (!upstream.ok) {
            const errText = await upstream.text().catch(() => "");
            console.error(`[fetch-weatherkit] Apple API error ${upstream.status}: ${errText}`);

            // If 401, invalidate cached token
            if (upstream.status === 401) {
                cachedToken = null;
            }

            return corsResponse(
                JSON.stringify({
                    error: `WeatherKit API error: ${upstream.status}`,
                    detail: errText.substring(0, 200),
                }),
                upstream.status,
                { "Content-Type": "application/json" },
            );
        }

        const weatherData = await upstream.json();

        return corsResponse(
            JSON.stringify(weatherData),
            200,
            {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=300", // 5 min cache
            },
        );
    } catch (err) {
        console.error("[fetch-weatherkit] Error:", err);
        return corsResponse(
            JSON.stringify({ error: String(err) }),
            500,
            { "Content-Type": "application/json" },
        );
    }
});
