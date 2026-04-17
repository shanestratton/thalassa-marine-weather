/**
 * Weather Routes — Proxies weather API calls through the Pi cache.
 *
 * Supports:
 *   - Open-Meteo Commercial API (customer-api.open-meteo.com)
 *   - StormGlass (via Supabase edge function — key stays server-side)
 *   - Marine-specific: wind, swell, sea state, pressure
 *
 * All responses are cached with appropriate TTLs:
 *   - Current conditions: 15 min
 *   - Hourly forecast: 1 hour
 *   - Extended forecast: 6 hours
 */

import { Router, Request, Response } from 'express';
import { Cache } from '../cache.js';
import { ProxyConfig, cachedJsonFetch, supabaseEdgeUrl, supabaseHeaders, openMeteoUrl } from '../proxy.js';
import { TTL } from '../scheduler.js';

export function createWeatherRoutes(cache: Cache, config: ProxyConfig): Router {
    const router = Router();

    /**
     * GET /api/weather/current?lat=X&lon=Y
     * Current conditions from Open-Meteo.
     */
    router.get('/current', async (req: Request, res: Response) => {
        try {
            const { lat, lon } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `weather:current:${lat}:${lon}`;
            const url = openMeteoUrl(
                config,
                'forecast',
                `latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn`,
            );

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.WEATHER_CURRENT,
                source: 'open-meteo',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Weather fetch failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/weather/forecast?lat=X&lon=Y&days=7
     * Hourly forecast from Open-Meteo.
     */
    router.get('/forecast', async (req: Request, res: Response) => {
        try {
            const { lat, lon, days = '7' } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `weather:forecast:${lat}:${lon}:${days}d`;
            const url = openMeteoUrl(
                config,
                'forecast',
                `latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl&wind_speed_unit=kn&forecast_days=${days}`,
            );

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.WEATHER_FORECAST,
                source: 'open-meteo',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Forecast fetch failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/weather/marine?lat=X&lon=Y
     * Marine-specific: swell, wave height, wave period, sea surface temp.
     */
    router.get('/marine', async (req: Request, res: Response) => {
        try {
            const { lat, lon } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `weather:marine:${lat}:${lon}`;
            const url = openMeteoUrl(
                config,
                'marine',
                `latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_direction,wind_wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,ocean_current_velocity,ocean_current_direction&current=wave_height,wave_direction,wave_period,wind_wave_height,swell_wave_height`,
            );

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.WEATHER_CURRENT,
                source: 'open-meteo-marine',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Marine weather failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/weather/combined?lat=X&lon=Y
     * Full atmospheric dataset: current + hourly (16d) + daily — matches what the app's
     * fetchOpenMeteo() needs in one shot. Coordinates are rounded to 2dp for cache key
     * so GPS drift on a moored boat still gets cache HITs.
     */
    router.get('/combined', async (req: Request, res: Response) => {
        try {
            const { lat, lon } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            // Round to 2dp for cache key (~1km grid) — GPS drift won't break cache hits
            const rlat = parseFloat(parseFloat(lat as string).toFixed(2));
            const rlon = parseFloat(parseFloat(lon as string).toFixed(2));
            const key = `weather:combined:${rlat}:${rlon}`;

            const url = openMeteoUrl(
                config,
                'forecast',
                `latitude=${lat}&longitude=${lon}` +
                    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
                    `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,weather_code,pressure_msl,surface_pressure,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,cape` +
                    `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant` +
                    `&timezone=auto&forecast_days=16&models=best_match`,
            );

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.WEATHER_CURRENT,
                source: 'open-meteo-combined',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Combined weather failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/weather/unified?lat=X&lon=Y&user_id=UUID&minified=0|1
     * Unified weather pipeline via get-weather Supabase edge function.
     *
     * Routes to Rainbow.ai+OpenMeteo (premium) or Apple WeatherKit (free)
     * based on the user's subscription tier. Subscription check happens
     * server-side in the edge function.
     *
     * This is the PRIMARY endpoint the Pi should pre-fetch — it gives the
     * frontend everything it needs in a single request.
     */
    router.get('/unified', async (req: Request, res: Response) => {
        try {
            const { lat, lon, user_id, minified } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const mini = minified === '1' ? '1' : '0';
            const uid = (user_id as string) || '';
            const key = `weather:unified:${lat}:${lon}:${uid}:${mini}`;

            const params: Record<string, string> = {
                lat: String(lat),
                lon: String(lon),
                minified: mini,
            };
            if (uid) params.user_id = uid;

            const url = supabaseEdgeUrl(config, 'get-weather', params);

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.WEATHER_CURRENT,
                source: 'get-weather',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Unified weather fetch failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/weather/stormglass?lat=X&lon=Y
     * StormGlass premium data via Supabase edge function (API key stays on server).
     */
    router.get('/stormglass', async (req: Request, res: Response) => {
        try {
            const { lat, lon } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `weather:stormglass:${lat}:${lon}`;
            const url = supabaseEdgeUrl(config, 'proxy-stormglass', {
                lat: String(lat),
                lon: String(lon),
            });

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.WEATHER_FORECAST,
                source: 'stormglass',
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'StormGlass fetch failed', message: (err as Error).message });
        }
    });

    return router;
}
