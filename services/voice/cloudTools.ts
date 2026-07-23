/**
 * cloudTools — Haiku tool implementations that don't need the Pi.
 *
 * Currently houses just `thalassa_weather`, ported from the legacy
 * edge function (proxy-bosun-fallback) so the client-side orchestrator
 * (services/voice/orchestrator.ts) can dispatch it without a server
 * round-trip. Forecast data uses Thalassa's commercial Open-Meteo boundary;
 * only the keyless geocoder remains a fixed direct public lookup.
 *
 * web_search isn't here because Anthropic's `web_search_20250305` runs
 * server-side at Anthropic — we just register it in the tool list and
 * Haiku does the rest. No client-side dispatch needed.
 */
import { fetchOpenMeteoProxy } from '../weather/openMeteoProxy';

interface GeocodeResult {
    name: string;
    latitude: number;
    longitude: number;
    country: string;
    admin1?: string;
}

async function geocode(query: string): Promise<GeocodeResult | null> {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        query,
    )}&count=1&language=en&format=json`;
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const data = await r.json();
        const hit = data.results?.[0];
        if (!hit) return null;
        return {
            name: hit.name,
            latitude: hit.latitude,
            longitude: hit.longitude,
            country: hit.country,
            admin1: hit.admin1,
        };
    } catch {
        return null;
    }
}

async function fetchOpenMeteo(lat: number, lng: number): Promise<unknown> {
    return fetchOpenMeteoProxy('forecast', {
        latitude: lat.toFixed(4),
        longitude: lng.toFixed(4),
        current:
            'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,precipitation,pressure_msl',
        hourly: 'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,weather_code',
        daily: 'temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,precipitation_sum',
        forecast_days: 2,
        timezone: 'auto',
        wind_speed_unit: 'kn',
    });
}

async function fetchOpenMeteoMarine(lat: number, lng: number): Promise<unknown | null> {
    try {
        return await fetchOpenMeteoProxy('marine', {
            latitude: lat.toFixed(4),
            longitude: lng.toFixed(4),
            current:
                'wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_direction,swell_wave_height,swell_wave_direction,swell_wave_period',
            daily: 'wave_height_max,wind_wave_height_max,swell_wave_height_max',
            forecast_days: 2,
            timezone: 'auto',
        });
    } catch {
        return null;
    }
}

/**
 * Execute Haiku's thalassa_weather tool. Returns a JSON string suitable
 * for handing back as a tool_result block; tone matches what the legacy
 * edge function returned so any prompt-engineering Haiku has learned
 * about this tool's shape still applies.
 */
export async function runThalassaWeather(
    input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
    let lat = typeof input.lat === 'number' ? input.lat : NaN;
    let lng = typeof input.lng === 'number' ? input.lng : NaN;
    let displayName = '';

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const location = typeof input.location === 'string' ? input.location.trim() : '';
        if (!location) {
            return { content: 'ERROR: must provide either lat/lng or location', isError: true };
        }
        const geo = await geocode(location);
        if (!geo) {
            return { content: `ERROR: could not geocode "${location}"`, isError: true };
        }
        lat = geo.latitude;
        lng = geo.longitude;
        displayName = `${geo.name}${geo.admin1 ? ', ' + geo.admin1 : ''}, ${geo.country}`;
    } else {
        displayName = typeof input.location === 'string' ? input.location : `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
    }

    try {
        const [weather, marine] = await Promise.all([fetchOpenMeteo(lat, lng), fetchOpenMeteoMarine(lat, lng)]);
        return {
            content: JSON.stringify({
                location: { name: displayName, lat, lng },
                atmospheric: weather,
                marine: marine ?? null,
                note:
                    'Wind speeds are in knots. Times are local to the location. ' +
                    'Marine fields may be null if the location is inland or outside coverage.',
            }),
            isError: false,
        };
    } catch (err) {
        return {
            content: `ERROR: weather fetch failed - ${(err as Error).message}`,
            isError: true,
        };
    }
}
