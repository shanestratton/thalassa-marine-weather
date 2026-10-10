// deno-lint-ignore-file
import { fetchWithTimeout, readResponseTextLimited } from '../_shared/http-security.ts';

/**
 * Calypso's cloud weather tool on Open-Meteo's commercial customer endpoints
 * (127-H). The free hosts are for non-commercial use only, so they are never a
 * fallback: no key means no lookup, and the tool answers with its usual error.
 *
 * The key rides in the upstream query string, which makes every URL here a
 * secret: none is ever logged, thrown or returned, so the key cannot reach a
 * log line, an error message or the model's context. (Deno's own network
 * errors name the full URL, so they are replaced, never passed on.)
 */
export const OPEN_METEO_UPSTREAMS = {
    geocode: 'https://customer-geocoding-api.open-meteo.com/v1/search',
    forecast: 'https://customer-api.open-meteo.com/v1/forecast',
    marine: 'https://customer-marine-api.open-meteo.com/v1/marine',
} as const;

export interface GeocodeResult {
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    admin1?: string;
}

type Fetcher = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;

const FORECAST_QUERY = {
    current:
        'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,precipitation,pressure_msl',
    hourly: 'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,weather_code',
    daily:
        'temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,precipitation_sum',
    forecast_days: '2',
    timezone: 'auto',
    wind_speed_unit: 'kn',
};

const MARINE_QUERY = {
    current:
        'wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_direction,swell_wave_height,swell_wave_direction,swell_wave_period',
    daily: 'wave_height_max,wind_wave_height_max,swell_wave_height_max',
    forecast_days: '2',
    timezone: 'auto',
};

export function createOpenMeteoClient(apiKey: string | undefined, fetcher: Fetcher = fetchWithTimeout) {
    /** Fetch and parse one upstream; every failure is a fixed, URL-free message. */
    async function getJson(
        base: string,
        params: Record<string, string>,
        timeoutMs: number,
        maxBytes: number,
    ): Promise<unknown> {
        if (!apiKey) throw new Error('Open-Meteo is not configured');
        let response: Response;
        try {
            response = await fetcher(`${base}?${new URLSearchParams({ ...params, apikey: apiKey })}`, {}, timeoutMs);
        } catch {
            throw new Error('Open-Meteo request failed');
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(`Open-Meteo HTTP ${response.status}`);
        }
        const text = await readResponseTextLimited(response, maxBytes).catch(() => null);
        if (text === null) throw new Error('Open-Meteo response exceeded the safety limit');
        try {
            return JSON.parse(text);
        } catch {
            throw new Error('Open-Meteo returned an invalid response');
        }
    }

    const coordinates = (lat: number, lng: number) => ({ latitude: String(lat), longitude: String(lng) });

    return {
        async geocode(query: string): Promise<GeocodeResult | null> {
            try {
                const data = await getJson(
                    OPEN_METEO_UPSTREAMS.geocode,
                    { name: query, count: '1', language: 'en', format: 'json' },
                    10_000,
                    1_000_000,
                );
                const hit = (data as { results?: unknown[] } | null)?.results?.[0] as
                    | Record<string, unknown>
                    | undefined;
                if (
                    !hit || typeof hit.name !== 'string' || !Number.isFinite(hit.latitude) ||
                    !Number.isFinite(hit.longitude)
                ) {
                    return null;
                }
                return {
                    name: hit.name,
                    latitude: hit.latitude as number,
                    longitude: hit.longitude as number,
                    country: typeof hit.country === 'string' ? hit.country : '',
                    admin1: typeof hit.admin1 === 'string' ? hit.admin1 : undefined,
                };
            } catch {
                return null;
            }
        },

        /** Throws a URL-free message; the tool reports it as "weather fetch failed". */
        forecast(lat: number, lng: number): Promise<unknown> {
            return getJson(
                OPEN_METEO_UPSTREAMS.forecast,
                { ...coordinates(lat, lng), ...FORECAST_QUERY },
                12_000,
                2_000_000,
            );
        },

        /** Null when inland, outside coverage, or unavailable. */
        async marine(lat: number, lng: number): Promise<unknown | null> {
            try {
                return await getJson(
                    OPEN_METEO_UPSTREAMS.marine,
                    { ...coordinates(lat, lng), ...MARINE_QUERY },
                    12_000,
                    2_000_000,
                );
            } catch {
                return null;
            }
        },
    };
}
