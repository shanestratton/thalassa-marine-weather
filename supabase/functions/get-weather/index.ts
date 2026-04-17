// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * get-weather — Unified Weather Data Pipeline
 *
 * Single entry point for ALL weather data. Routes based on subscription tier:
 *   - Premium (owner/crew): Rainbow.ai hyper-local nowcast + Open-Meteo atmospheric
 *   - Free (deckhand):      Apple WeatherKit REST API
 *
 * Accepts: GET ?lat=X&lon=Y&user_id=UUID&minified=0|1
 *
 * Returns a standardized JSON schema regardless of upstream provider, so the
 * React frontend and the Raspberry Pi 5 cache hit the same endpoint.
 *
 * minified=1 strips response to bare essentials for Iridium GO! / low-bandwidth.
 *
 * Required Supabase Secrets:
 *   APPLE_WEATHERKIT_P8_KEY, APPLE_WEATHERKIT_KEY_ID,
 *   APPLE_WEATHERKIT_TEAM_ID, APPLE_WEATHERKIT_SERVICE_ID,
 *   RAINBOW_API_KEY, OPEN_METEO_API_KEY
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ════════════════════════════════════════════════════════════════
// CORS & HELPERS
// ════════════════════════════════════════════════════════════════

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
    });
}

function errorJson(msg: string, status: number, detail?: string): Response {
    return json({ error: msg, ...(detail ? { detail } : {}) }, status);
}

// ════════════════════════════════════════════════════════════════
// STANDARDISED RESPONSE TYPES
// ════════════════════════════════════════════════════════════════

interface StandardCurrent {
    temperature: number | null; // °C
    feelsLike: number | null; // °C
    humidity: number | null; // % 0-100
    pressure: number | null; // hPa
    windSpeed: number | null; // knots
    windDirection: number | null; // degrees
    windGust: number | null; // knots
    condition: string;
    cloudCover: number | null; // % 0-100
    visibility: number | null; // km
    uvIndex: number | null;
    precipitation: number | null; // mm/hr
    dewPoint: number | null; // °C
    isDay: boolean | null;
}

interface StandardNowcast {
    minutes: { time: string; intensity: number; precipType?: string }[]; // mm/hr per minute
    summary: string;
}

interface StandardHourly {
    time: string; // ISO
    temperature: number;
    windSpeed: number; // kts
    windDirection: number; // deg
    windGust: number | null;
    precipitation: number; // mm
    precipProbability: number; // %
    condition: string;
    pressure: number | null;
    cloudCover: number | null;
    humidity: number | null;
}

interface StandardDaily {
    date: string; // YYYY-MM-DD
    tempMax: number;
    tempMin: number;
    windSpeedMax: number; // kts
    windGustMax: number | null;
    condition: string;
    precipSum: number; // mm
    precipProbability: number | null;
    sunrise: string;
    sunset: string;
    uvIndexMax: number | null;
}

interface StandardWeatherResponse {
    provider: 'rainbow+openmeteo' | 'weatherkit';
    timestamp: string; // ISO when this response was generated
    coordinates: { lat: number; lon: number };
    timezone: string;
    isPremium: boolean;
    current: StandardCurrent;
    nowcast?: StandardNowcast; // Premium only
    hourly: StandardHourly[];
    daily: StandardDaily[];
}

/** Iridium GO! minified response — absolute bare essentials */
interface MinifiedWeatherResponse {
    p: string; // provider shorthand
    ts: number; // unix seconds
    lat: number;
    lon: number;
    c: {
        // current
        t: number | null; // temp °C
        w: number | null; // wind kts
        wd: number | null; // wind dir
        g: number | null; // gust kts
        pr: number | null; // pressure hPa
        r: number | null; // precip mm/hr
        cnd: string; // condition
    };
    n?: { m: number; i: number; pt?: string }[]; // nowcast: minutes-from-now + intensity + precipType
    h: {
        // hourly (next 24h only)
        t: number; // hours from now
        w: number; // wind kts
        wd: number; // wind dir
        r: number; // precip mm
    }[];
}

// ════════════════════════════════════════════════════════════════
// APPLE WEATHERKIT JWT AUTH (reused from fetch-weatherkit)
// ════════════════════════════════════════════════════════════════

function base64url(data: Uint8Array): string {
    let binary = '';
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncode(str: string): string {
    return base64url(new TextEncoder().encode(str));
}

async function importP8Key(pem: string): Promise<CryptoKey> {
    const pemBody = pem
        .replace(/-----BEGIN PRIVATE KEY-----/g, '')
        .replace(/-----END PRIVATE KEY-----/g, '')
        .replace(/\s/g, '');
    const binaryStr = atob(pemBody);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    return crypto.subtle.importKey('pkcs8', bytes.buffer, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

let cachedAppleToken: { jwt: string; expiresAt: number } | null = null;

async function getAppleJWT(key: CryptoKey, keyId: string, teamId: string, serviceId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (cachedAppleToken && cachedAppleToken.expiresAt > now + 300) return cachedAppleToken.jwt;

    const header = { alg: 'ES256', kid: keyId, id: `${teamId}.${serviceId}` };
    const payload = { iss: teamId, iat: now, exp: now + 3600, sub: serviceId };
    const headerB64 = base64urlEncode(JSON.stringify(header));
    const payloadB64 = base64urlEncode(JSON.stringify(payload));
    const sigInput = `${headerB64}.${payloadB64}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(sigInput));
    const jwt = `${sigInput}.${base64url(new Uint8Array(sig))}`;
    cachedAppleToken = { jwt, expiresAt: now + 3600 };
    return jwt;
}

// ════════════════════════════════════════════════════════════════
// APPLE WEATHERKIT CONDITION CODES
// ════════════════════════════════════════════════════════════════

const APPLE_CONDITIONS: Record<string, string> = {
    Clear: 'Clear',
    MostlyClear: 'Mostly Clear',
    PartlyCloudy: 'Partly Cloudy',
    MostlyCloudy: 'Mostly Cloudy',
    Cloudy: 'Cloudy',
    Foggy: 'Fog',
    Haze: 'Haze',
    Windy: 'Windy',
    Drizzle: 'Drizzle',
    Rain: 'Rain',
    HeavyRain: 'Heavy Rain',
    Showers: 'Showers',
    Thunderstorms: 'Thunderstorm',
    Snow: 'Snow',
    HeavySnow: 'Heavy Snow',
    Sleet: 'Sleet',
    FreezingRain: 'Freezing Rain',
    Blizzard: 'Blizzard',
    TropicalStorm: 'Tropical Storm',
    Hurricane: 'Hurricane',
};

/** Apple km/h → knots */
const kmhToKts = (v: number | null | undefined): number | null => (v != null ? Math.round(v * 0.539957) : null);

/** Apple 0-1 fraction → 0-100% */
const frac = (v: number | null | undefined): number | null => (v != null ? Math.round(v * 100) : null);

// ════════════════════════════════════════════════════════════════
// RAINBOW.AI NOWCAST API (v1 — direct JSON, no tile decoding!)
// ════════════════════════════════════════════════════════════════

const RAINBOW_NOWCAST = 'https://api.rainbow.ai/nowcast/v1';

// ════════════════════════════════════════════════════════════════
// DATA FETCHERS
// ════════════════════════════════════════════════════════════════

/**
 * PREMIUM PATH: Rainbow.ai nowcast + Open-Meteo commercial atmospheric data.
 * Rainbow gives us 1km precipitation at 10-min resolution out to 4 hours.
 * Open-Meteo commercial gives us wind, temp, pressure, clouds, etc.
 */
async function fetchPremium(lat: number, lon: number): Promise<StandardWeatherResponse> {
    const rainbowKey = Deno.env.get('RAINBOW_API_KEY') || '';
    const omKey = Deno.env.get('OPEN_METEO_API_KEY') || '';

    // ── Parallel: Open-Meteo atmosphere + Rainbow.ai nowcast ──
    const omUrl =
        `https://customer-api.open-meteo.com/v1/forecast` +
        `?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,dew_point_2m` +
        `&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,pressure_msl,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max` +
        `&wind_speed_unit=kn&timezone=auto&forecast_days=7` +
        (omKey ? `&apikey=${omKey}` : '');

    const [omRes, nowcast] = await Promise.all([
        fetch(omUrl).then(async (r) => {
            if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
            return r.json();
        }),
        fetchRainbowNowcast(lat, lon, rainbowKey),
    ]);

    // ── Map Open-Meteo to standard schema ──
    const om = omRes;
    const cur = om.current;
    const wmoCode = cur?.weather_code ?? 0;

    const current: StandardCurrent = {
        temperature: cur?.temperature_2m ?? null,
        feelsLike: cur?.apparent_temperature ?? null,
        humidity: cur?.relative_humidity_2m ?? null,
        pressure: cur?.pressure_msl ?? null,
        windSpeed: cur?.wind_speed_10m ?? null, // Already in kts
        windDirection: cur?.wind_direction_10m ?? null,
        windGust: cur?.wind_gusts_10m ?? null,
        condition: wmoToCondition(wmoCode),
        cloudCover: cur?.cloud_cover ?? null,
        visibility: null, // Not in this OM request
        uvIndex: null,
        precipitation: cur?.precipitation ?? null,
        dewPoint: cur?.dew_point_2m ?? null,
        isDay: cur?.is_day === 1,
    };

    // Hourly (up to 168h = 7 days)
    const hourly: StandardHourly[] = (om.hourly?.time ?? []).map((t: string, i: number) => ({
        time: t,
        temperature: om.hourly.temperature_2m?.[i] ?? 0,
        windSpeed: om.hourly.wind_speed_10m?.[i] ?? 0,
        windDirection: om.hourly.wind_direction_10m?.[i] ?? 0,
        windGust: om.hourly.wind_gusts_10m?.[i] ?? null,
        precipitation: om.hourly.precipitation?.[i] ?? 0,
        precipProbability: om.hourly.precipitation_probability?.[i] ?? 0,
        condition: wmoToCondition(om.hourly.weather_code?.[i] ?? 0),
        pressure: om.hourly.pressure_msl?.[i] ?? null,
        cloudCover: om.hourly.cloud_cover?.[i] ?? null,
        humidity: om.hourly.relative_humidity_2m?.[i] ?? null,
    }));

    // Daily
    const daily: StandardDaily[] = (om.daily?.time ?? []).map((t: string, i: number) => ({
        date: t,
        tempMax: om.daily.temperature_2m_max?.[i] ?? 0,
        tempMin: om.daily.temperature_2m_min?.[i] ?? 0,
        windSpeedMax: om.daily.wind_speed_10m_max?.[i] ?? 0,
        windGustMax: om.daily.wind_gusts_10m_max?.[i] ?? null,
        condition: wmoToCondition(om.daily.weather_code?.[i] ?? 0),
        precipSum: om.daily.precipitation_sum?.[i] ?? 0,
        precipProbability: om.daily.precipitation_probability_max?.[i] ?? null,
        sunrise: om.daily.sunrise?.[i] ?? '',
        sunset: om.daily.sunset?.[i] ?? '',
        uvIndexMax: om.daily.uv_index_max?.[i] ?? null,
    }));

    return {
        provider: 'rainbow+openmeteo',
        timestamp: new Date().toISOString(),
        coordinates: { lat, lon },
        timezone: om.timezone || 'UTC',
        isPremium: true,
        current,
        nowcast: nowcast ?? undefined,
        hourly,
        daily,
    };
}

/**
 * Rainbow.ai Nowcast API — direct JSON point forecast.
 *
 * Uses the new /nowcast/v1/precip-global/{lon}/{lat} endpoint which returns
 * minute-by-minute precipitation with precipType (rain/snow/mixed) directly
 * as JSON. No tile fetching, no PNG decoding. Global coverage via satellite
 * + radar fusion at 1km² resolution.
 *
 * Response: { forecast: [{precipRate, precipType, timestampBegin, timestampEnd}...],
 *             summary: {intensity} }
 */
async function fetchRainbowNowcast(lat: number, lon: number, apiKey: string): Promise<StandardNowcast | null> {
    if (!apiKey) return null;

    try {
        // Nowcast API: /nowcast/v1/precip-global/{longitude}/{latitude}
        // NOTE: longitude comes FIRST in the path!
        const url = `${RAINBOW_NOWCAST}/precip-global/${lon.toFixed(4)}/${lat.toFixed(4)}?token=${apiKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

        if (!res.ok) {
            console.warn(`[get-weather] Rainbow Nowcast API ${res.status}`);
            return null;
        }

        const data = await res.json();
        const forecast: { precipRate: number; precipType?: string; timestampBegin: number; timestampEnd: number }[] =
            data.forecast || [];

        if (forecast.length === 0) {
            return { minutes: [], summary: data.summary?.intensity || 'No precipitation expected' };
        }

        // Map Rainbow's native minute-by-minute format to our standard
        const minutes: { time: string; intensity: number; precipType?: string }[] = forecast.map((f) => ({
            time: new Date(f.timestampBegin * 1000).toISOString(),
            intensity: Math.round((f.precipRate ?? 0) * 100) / 100,
            precipType: f.precipType || undefined,
        }));

        // Build human-readable summary
        const THRESH = 0.1;
        const now = Date.now();
        const firstPrecip = minutes.find((m) => m.intensity >= THRESH);
        const isCurrentlyRaining = (minutes[0]?.intensity ?? 0) >= THRESH;
        let summary = 'No precipitation expected';

        if (firstPrecip) {
            const precipLabel = firstPrecip.precipType === 'snow' ? 'Snow' : 'Rain';
            const minsUntil = Math.max(1, Math.round((new Date(firstPrecip.time).getTime() - now) / 60000));

            if (isCurrentlyRaining) {
                const dryAt = minutes.find((m, i) => i > 0 && m.intensity < THRESH);
                if (dryAt) {
                    const minsUntilDry = Math.max(1, Math.round((new Date(dryAt.time).getTime() - now) / 60000));
                    summary = `${precipLabel} stopping in ~${minsUntilDry} min`;
                } else {
                    summary = `${precipLabel} continuing`;
                }
            } else {
                summary =
                    minsUntil <= 60
                        ? `${precipLabel} in ${minsUntil} min`
                        : `${precipLabel} in ~${Math.round(minsUntil / 60)}h`;
            }
        }

        // Use Rainbow's own intensity summary if available
        if (data.summary?.intensity && data.summary.intensity !== 'none') {
            const rainbowIntensity = data.summary.intensity;
            // Augment our summary with Rainbow's intensity classification
            if (isCurrentlyRaining && !summary.includes('stopping')) {
                const precipLabel = minutes[0]?.precipType === 'snow' ? 'Snow' : 'Rain';
                summary = `${rainbowIntensity.charAt(0).toUpperCase() + rainbowIntensity.slice(1)} ${precipLabel.toLowerCase()} continuing`;
            }
        }

        return { minutes, summary };
    } catch (err) {
        console.error('[get-weather] Rainbow Nowcast API error:', err);
        return null;
    }
}

/**
 * FREE PATH: Apple WeatherKit REST API.
 * JWT generated using the .p8 private key stored in Supabase Secrets.
 */
async function fetchFree(lat: number, lon: number): Promise<StandardWeatherResponse> {
    const p8Key = Deno.env.get('APPLE_WEATHERKIT_P8_KEY') || Deno.env.get('WEATHERKIT_PRIVATE_KEY') || '';
    const keyId = Deno.env.get('APPLE_WEATHERKIT_KEY_ID') || Deno.env.get('WEATHERKIT_KEY_ID') || '';
    const teamId = Deno.env.get('APPLE_WEATHERKIT_TEAM_ID') || Deno.env.get('WEATHERKIT_TEAM_ID') || '';
    const serviceId =
        Deno.env.get('APPLE_WEATHERKIT_SERVICE_ID') ||
        Deno.env.get('WEATHERKIT_SERVICE_ID') ||
        'com.thalassa.weatherkit';

    if (!p8Key || !keyId || !teamId) {
        throw new Error('Apple WeatherKit credentials not configured');
    }

    const privateKey = await importP8Key(p8Key);
    const jwt = await getAppleJWT(privateKey, keyId, teamId, serviceId);

    const url =
        `https://weatherkit.apple.com/api/v1/weather/en/${lat}/${lon}` +
        `?dataSets=currentWeather,forecastHourly,forecastDaily,forecastNextHour`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });

    if (!res.ok) {
        if (res.status === 401) cachedAppleToken = null;
        const detail = await res.text().catch(() => '');
        throw new Error(`WeatherKit ${res.status}: ${detail.substring(0, 200)}`);
    }

    const wk = await res.json();

    // ── Map Apple WeatherKit → Standard Schema ──
    const cw = wk.currentWeather || {};
    const current: StandardCurrent = {
        temperature: cw.temperature ?? null,
        feelsLike: cw.temperatureApparent ?? null,
        humidity: frac(cw.humidity),
        pressure: cw.pressure ?? null,
        windSpeed: kmhToKts(cw.windSpeed),
        windDirection: cw.windDirection ?? null,
        windGust: kmhToKts(cw.windGust),
        condition: APPLE_CONDITIONS[cw.conditionCode] || cw.conditionCode || 'Unknown',
        cloudCover: frac(cw.cloudCover),
        visibility: cw.visibility != null ? cw.visibility / 1000 : null, // m → km
        uvIndex: cw.uvIndex ?? null,
        precipitation: cw.precipitationIntensity ?? null,
        dewPoint: cw.temperatureDewPoint ?? null,
        isDay: cw.daylight ?? null,
    };

    // Next-hour precipitation → nowcast
    let nowcast: StandardNowcast | undefined;
    const nextHour = wk.forecastNextHour;
    if (nextHour?.minutes?.length > 0) {
        const mins = nextHour.minutes.slice(0, 60);
        nowcast = {
            minutes: mins.map((m: { startTime: string; precipitationIntensity: number }) => ({
                time: m.startTime,
                intensity: m.precipitationIntensity ?? 0,
            })),
            summary: buildAppleSummary(nextHour),
        };
    }

    // Hourly forecast
    const hourly: StandardHourly[] = (wk.forecastHourly?.hours ?? []).map((h: Record<string, unknown>) => ({
        time: h.forecastStart || '',
        temperature: (h.temperature as number) ?? 0,
        windSpeed: kmhToKts(h.windSpeed as number) ?? 0,
        windDirection: (h.windDirection as number) ?? 0,
        windGust: kmhToKts(h.windGust as number),
        precipitation: (h.precipitationAmount as number) ?? 0,
        precipProbability: h.precipitationChance != null ? Math.round((h.precipitationChance as number) * 100) : 0,
        condition: APPLE_CONDITIONS[h.conditionCode as string] || (h.conditionCode as string) || 'Unknown',
        pressure: (h.pressure as number) ?? null,
        cloudCover: frac(h.cloudCover as number),
        humidity: frac(h.humidity as number),
    }));

    // Daily forecast
    const daily: StandardDaily[] = (wk.forecastDaily?.days ?? []).map((d: Record<string, unknown>) => ({
        date: ((d.forecastStart as string) || '').slice(0, 10),
        tempMax: (d.temperatureMax as number) ?? 0,
        tempMin: (d.temperatureMin as number) ?? 0,
        windSpeedMax: kmhToKts(d.windSpeedMax as number) ?? 0,
        windGustMax: kmhToKts(d.windGustSpeedMax as number),
        condition: APPLE_CONDITIONS[d.conditionCode as string] || (d.conditionCode as string) || 'Unknown',
        precipSum: (d.precipitationAmount as number) ?? 0,
        precipProbability: d.precipitationChance != null ? Math.round((d.precipitationChance as number) * 100) : null,
        sunrise: (d.sunrise as string) || '',
        sunset: (d.sunset as string) || '',
        uvIndexMax: (d.maxUvIndex as number) ?? null,
    }));

    return {
        provider: 'weatherkit',
        timestamp: new Date().toISOString(),
        coordinates: { lat, lon },
        timezone: 'UTC', // WeatherKit doesn't return timezone — client resolves
        isPremium: false,
        current,
        nowcast,
        hourly,
        daily,
    };
}

function buildAppleSummary(nextHour: Record<string, unknown>): string {
    const summary = nextHour.summary as { condition: string; startTime: string }[] | undefined;
    if (!summary || !Array.isArray(summary) || summary.length === 0) return '';
    const firstPrecip = summary.find(
        (p) => p.condition === 'rain' || p.condition === 'drizzle' || p.condition === 'snow',
    );
    if (!firstPrecip) return 'No precipitation expected';
    const minsUntil = Math.round((new Date(firstPrecip.startTime).getTime() - Date.now()) / 60000);
    const label = firstPrecip.condition.charAt(0).toUpperCase() + firstPrecip.condition.slice(1);
    return minsUntil <= 0 ? `${label} continuing` : `${label} in ${minsUntil} min`;
}

// ════════════════════════════════════════════════════════════════
// WMO WEATHER CODE → HUMAN CONDITION
// ════════════════════════════════════════════════════════════════

function wmoToCondition(code: number): string {
    if (code === 0) return 'Clear';
    if (code <= 3) return ['Clear', 'Mostly Clear', 'Partly Cloudy', 'Overcast'][code];
    if (code <= 49) return 'Fog';
    if (code <= 59) return 'Drizzle';
    if (code <= 69) return 'Rain';
    if (code <= 79) return 'Snow';
    if (code <= 84) return 'Rain Showers';
    if (code <= 86) return 'Snow Showers';
    if (code === 95) return 'Thunderstorm';
    if (code <= 99) return 'Thunderstorm with Hail';
    return 'Unknown';
}

// ════════════════════════════════════════════════════════════════
// MINIFICATION (Iridium GO! mode)
// ════════════════════════════════════════════════════════════════

function minify(full: StandardWeatherResponse): MinifiedWeatherResponse {
    const c = full.current;
    const result: MinifiedWeatherResponse = {
        p: full.provider === 'weatherkit' ? 'wk' : 'rb',
        ts: Math.floor(Date.now() / 1000),
        lat: full.coordinates.lat,
        lon: full.coordinates.lon,
        c: {
            t: c.temperature != null ? Math.round(c.temperature) : null,
            w: c.windSpeed != null ? Math.round(c.windSpeed) : null,
            wd: c.windDirection != null ? Math.round(c.windDirection) : null,
            g: c.windGust != null ? Math.round(c.windGust) : null,
            pr: c.pressure != null ? Math.round(c.pressure) : null,
            r: c.precipitation != null ? Math.round(c.precipitation * 10) / 10 : null,
            cnd: c.condition.substring(0, 12), // Truncate condition
        },
        h: full.hourly.slice(0, 24).map((h, i) => ({
            t: i,
            w: Math.round(h.windSpeed),
            wd: Math.round(h.windDirection),
            r: Math.round(h.precipitation * 10) / 10,
        })),
    };

    // Include nowcast in minified form (only non-zero entries, every 10 min)
    if (full.nowcast?.minutes?.length) {
        result.n = full.nowcast.minutes
            .filter((_, i) => i % 10 === 0) // Every 10 minutes
            .filter((m) => m.intensity > 0.05) // Only actual precip
            .map((m) => ({
                m: Math.round((new Date(m.time).getTime() - Date.now()) / 60000),
                i: Math.round(m.intensity * 10) / 10,
                ...(m.precipType && m.precipType !== 'rain' ? { pt: m.precipType } : {}),
            }));
        if (result.n.length === 0) delete result.n;
    }

    return result;
}

// ════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    try {
        // ── Parse request (supports both GET query params and POST body) ──
        let lat: number, lon: number, userId: string | null, minified: boolean;

        if (req.method === 'GET') {
            const url = new URL(req.url);
            lat = parseFloat(url.searchParams.get('lat') || '');
            lon = parseFloat(url.searchParams.get('lon') || '');
            userId = url.searchParams.get('user_id');
            minified = url.searchParams.get('minified') === '1';
        } else {
            const body = await req.json();
            lat = body.lat;
            lon = body.lon;
            userId = body.user_id || null;
            minified = !!body.minified;
        }

        if (isNaN(lat) || isNaN(lon)) {
            return errorJson('lat and lon are required', 400);
        }

        // ── Check subscription tier ──
        let isPremium = false;

        if (userId) {
            try {
                const supabase = createClient(
                    Deno.env.get('SUPABASE_URL')!,
                    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
                );

                const { data: profile } = await supabase
                    .from('profiles')
                    .select('subscription_status, subscription_expiry')
                    .eq('id', userId)
                    .single();

                if (profile) {
                    const status = profile.subscription_status;
                    const expiry = profile.subscription_expiry;
                    const notExpired = !expiry || new Date(expiry) > new Date();
                    isPremium = (status === 'active' || status === 'trial') && notExpired;
                }
            } catch (err) {
                console.warn('[get-weather] Profile lookup failed, defaulting to free:', err);
            }
        }

        console.info(`[get-weather] lat=${lat} lon=${lon} premium=${isPremium} minified=${minified}`);

        // ── Route to provider ──
        const weather = isPremium ? await fetchPremium(lat, lon) : await fetchFree(lat, lon);

        // ── Return response ──
        if (minified) {
            return json(minify(weather), 200, { 'Cache-Control': 'public, max-age=300' });
        }

        return json(weather, 200, { 'Cache-Control': 'public, max-age=300' });
    } catch (err) {
        console.error('[get-weather] Fatal:', err);
        return errorJson('Weather fetch failed', 502, String(err));
    }
});
