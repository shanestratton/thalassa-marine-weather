// deno-lint-ignore-file
/* eslint-disable @typescript-eslint/no-namespace */
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';
import {
    fetchWithTimeout,
    parseCoordinate,
    readJsonObject,
    readResponseTextLimited,
} from '../_shared/http-security.ts';

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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

// ── Base64url encoding ────────────────────────────────────────

function base64url(data: Uint8Array): string {
    let binary = '';
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncode(str: string): string {
    return base64url(new TextEncoder().encode(str));
}

// ── PEM → CryptoKey ───────────────────────────────────────────

async function importP8Key(pem: string): Promise<CryptoKey> {
    // Strip PEM headers/footers and whitespace
    const pemBody = pem
        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
        .replace(/-----END PRIVATE KEY-----/g, '')
        .replace(/\s/g, '');

    // Decode base64 to binary
    const binaryStr = atob(pemBody);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }

    // Import as ECDSA P-256 private key
    return await crypto.subtle.importKey('pkcs8', bytes.buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign',
    ]);
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
        alg: 'ES256',
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
        { name: 'ECDSA', hash: 'SHA-256' },
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
let cachedPrivateKey: CryptoKey | null = null;

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
    language?: string; // e.g. "en-AU", defaults to "en"
    dataSets?: string[]; // defaults to currentWeather + forecastHourly + forecastDaily + forecastNextHour
}

// ── Main handler ──────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return corsResponse(null, 204);
    }

    if (req.method !== 'POST') {
        return corsResponse(JSON.stringify({ error: 'POST required' }), 405, { 'Content-Type': 'application/json' });
    }

    // route-weather fans out bounded corridor samples through this proxy. Its
    // service-role call is already protected by route-weather's own quota and
    // must not consume (or be rejected by) the public 30-call WeatherKit lane.
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const isTrustedInternalCall =
        Boolean(serviceRoleKey) && req.headers.get('authorization') === `Bearer ${serviceRoleKey}`;
    if (!isTrustedInternalCall) {
        const caller = await requireAuthenticatedOrPublicQuota(req, 'weatherkit', 240, 30, 3600);
        if (caller instanceof Response) return withCors(caller, CORS);
    }

    try {
        // ── Read secrets (try both naming conventions) ──
        const p8Key = Deno.env.get('APPLE_WEATHERKIT_P8_KEY') || Deno.env.get('WEATHERKIT_PRIVATE_KEY');
        const keyId = Deno.env.get('APPLE_WEATHERKIT_KEY_ID') || Deno.env.get('WEATHERKIT_KEY_ID');
        const teamId = Deno.env.get('APPLE_WEATHERKIT_TEAM_ID') || Deno.env.get('WEATHERKIT_TEAM_ID');
        const serviceId =
            Deno.env.get('APPLE_WEATHERKIT_SERVICE_ID') ||
            Deno.env.get('WEATHERKIT_SERVICE_ID') ||
            (teamId ? `com.thalassa.weatherkit` : undefined);

        if (!p8Key || !keyId || !teamId || !serviceId) {
            console.error('[fetch-weatherkit] Missing required secrets');
            return corsResponse(JSON.stringify({ error: 'WeatherKit not configured' }), 503, {
                'Content-Type': 'application/json',
            });
        }

        // ── Parse request ──
        const rawBody = await readJsonObject(req, 8192);
        if (!rawBody) {
            return corsResponse(JSON.stringify({ error: 'Invalid JSON request body' }), 400, {
                'Content-Type': 'application/json',
            });
        }
        const lat = parseCoordinate(rawBody.lat, 'lat');
        const lon = parseCoordinate(rawBody.lon, 'lon');
        if (lat === null || lon === null) {
            return corsResponse(JSON.stringify({ error: 'lat/lon must be valid coordinates' }), 400, {
                'Content-Type': 'application/json',
            });
        }

        const language = typeof rawBody.language === 'string' ? rawBody.language : 'en';
        if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) {
            return corsResponse(JSON.stringify({ error: 'Invalid language' }), 400, {
                'Content-Type': 'application/json',
            });
        }
        const allowedDataSets = new Set(['currentWeather', 'forecastHourly', 'forecastDaily', 'forecastNextHour']);
        const requestedDataSets = rawBody.dataSets;
        const dataSets =
            requestedDataSets === undefined
                ? [...allowedDataSets]
                : Array.isArray(requestedDataSets) &&
                    requestedDataSets.length >= 1 &&
                    requestedDataSets.length <= allowedDataSets.size &&
                    requestedDataSets.every((value) => typeof value === 'string' && allowedDataSets.has(value))
                  ? [...new Set(requestedDataSets as string[])]
                  : null;
        if (!dataSets) {
            return corsResponse(JSON.stringify({ error: 'Invalid dataSets' }), 400, {
                'Content-Type': 'application/json',
            });
        }

        // ── Generate JWT ──
        const privateKey = cachedPrivateKey ?? (cachedPrivateKey = await importP8Key(p8Key));
        const jwt = await getOrCreateJWT(privateKey, keyId, teamId, serviceId);

        // ── Fetch from Apple WeatherKit ──
        const dataSetsParam = dataSets.join(',');
        let url = `https://weatherkit.apple.com/api/v1/weather/${language}/${lat}/${lon}?dataSets=${dataSetsParam}`;
        // Optional time-window params, forwarded to Apple when provided.
        // hourlyStart/hourlyEnd (ISO8601) let callers request HISTORICAL hourly
        // (e.g. yesterday) for the metric deep-dive. Backward-compatible: when
        // absent, the URL is identical to before.
        const b = rawBody;
        const extra: string[] = [];
        const parsedTimes: Record<string, number> = {};
        for (const k of ['hourlyStart', 'hourlyEnd', 'dailyStart', 'dailyEnd', 'currentAsOf']) {
            const v = b[k];
            if (v === undefined) continue;
            const parsed = typeof v === 'string' ? Date.parse(v) : NaN;
            if (typeof v !== 'string' || v.length > 40 || !Number.isFinite(parsed)) {
                return corsResponse(JSON.stringify({ error: `Invalid ${k}` }), 400, {
                    'Content-Type': 'application/json',
                });
            }
            parsedTimes[k] = parsed;
            extra.push(`${k}=${encodeURIComponent(v)}`);
        }
        const now = Date.now();
        const hourlyStart = parsedTimes.hourlyStart;
        const hourlyEnd = parsedTimes.hourlyEnd;
        if ((hourlyStart === undefined) !== (hourlyEnd === undefined)) {
            return corsResponse(JSON.stringify({ error: 'Invalid hourly forecast window' }), 400, {
                'Content-Type': 'application/json',
            });
        }
        if (
            hourlyStart !== undefined &&
            hourlyEnd !== undefined &&
            (hourlyStart > hourlyEnd ||
                hourlyEnd - hourlyStart > 7 * 86_400_000 ||
                hourlyStart < now - 48 * 3_600_000 ||
                hourlyEnd > now + 12 * 86_400_000)
        ) {
            return corsResponse(JSON.stringify({ error: 'Invalid hourly forecast window' }), 400, {
                'Content-Type': 'application/json',
            });
        }
        const dailyStart = parsedTimes.dailyStart;
        const dailyEnd = parsedTimes.dailyEnd;
        if ((dailyStart === undefined) !== (dailyEnd === undefined)) {
            return corsResponse(JSON.stringify({ error: 'Invalid daily forecast window' }), 400, {
                'Content-Type': 'application/json',
            });
        }
        if (
            dailyStart !== undefined &&
            dailyEnd !== undefined &&
            (dailyStart > dailyEnd ||
                dailyEnd - dailyStart > 15 * 86_400_000 ||
                dailyStart < now - 7 * 86_400_000 ||
                dailyEnd > now + 30 * 86_400_000)
        ) {
            return corsResponse(JSON.stringify({ error: 'Invalid daily forecast window' }), 400, {
                'Content-Type': 'application/json',
            });
        }
        const currentAsOf = parsedTimes.currentAsOf;
        if (currentAsOf !== undefined && (currentAsOf < now - 7 * 86_400_000 || currentAsOf > now + 12 * 86_400_000)) {
            return corsResponse(JSON.stringify({ error: 'Invalid currentAsOf' }), 400, {
                'Content-Type': 'application/json',
            });
        }
        if (b.timezone !== undefined) {
            if (typeof b.timezone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(b.timezone)) {
                return corsResponse(JSON.stringify({ error: 'Invalid timezone' }), 400, {
                    'Content-Type': 'application/json',
                });
            }
            extra.push(`timezone=${encodeURIComponent(b.timezone)}`);
        }
        if (b.countryCode !== undefined) {
            if (typeof b.countryCode !== 'string' || !/^[A-Z]{2}$/.test(b.countryCode)) {
                return corsResponse(JSON.stringify({ error: 'Invalid countryCode' }), 400, {
                    'Content-Type': 'application/json',
                });
            }
            extra.push(`countryCode=${encodeURIComponent(b.countryCode)}`);
        }
        if (extra.length) url += '&' + extra.join('&');

        console.info(`[fetch-weatherkit] Fetching ${dataSets.length} dataset(s)`);

        const upstream = await fetchWithTimeout(
            url,
            {
                headers: {
                    Authorization: `Bearer ${jwt}`,
                },
            },
            12_000,
        );

        if (!upstream.ok) {
            console.error(`[fetch-weatherkit] Apple API error ${upstream.status}`);

            // If 401, invalidate cached token
            if (upstream.status === 401) {
                cachedToken = null;
                cachedPrivateKey = null;
            }

            return corsResponse(
                JSON.stringify({
                    error: `WeatherKit API error: ${upstream.status}`,
                }),
                502,
                { 'Content-Type': 'application/json' },
            );
        }

        const responseText = await readResponseTextLimited(upstream, 5_000_000);
        if (responseText === null) {
            console.error('[fetch-weatherkit] Apple response exceeded the byte limit');
            return corsResponse(JSON.stringify({ error: 'WeatherKit response exceeded the safety limit' }), 502, {
                'Content-Type': 'application/json',
            });
        }
        const weatherData: unknown = JSON.parse(responseText);
        if (!weatherData || typeof weatherData !== 'object' || Array.isArray(weatherData)) {
            throw new Error('WeatherKit returned an invalid payload');
        }

        return corsResponse(JSON.stringify(weatherData), 200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300', // 5 min cache
            'X-Content-Type-Options': 'nosniff',
        });
    } catch (err) {
        console.error('[fetch-weatherkit] Error:', err);
        return corsResponse(JSON.stringify({ error: 'WeatherKit fetch failed' }), 502, {
            'Content-Type': 'application/json',
        });
    }
});
