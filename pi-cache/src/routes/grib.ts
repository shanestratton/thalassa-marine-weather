/**
 * GRIB Routes — Proxies wind/pressure/wave grid data through the Pi cache.
 *
 * Primary sources:
 *   - Open-Meteo Commercial API (GFS-based wind, pressure, precip)
 *   - NOAA GFS/HRRR via Supabase edge function (higher resolution)
 *   - Open-Meteo Marine Commercial API (swell, wave height, sea surface temp)
 *
 * The Pi pre-downloads GRIB-derived grid data on schedule so the app
 * can render wind barbs, pressure isobars, and wave overlays instantly.
 *
 * TTL: 6 hours (synced with GFS model run schedule)
 */

import { Router, Request, Response } from 'express';
import { Cache } from '../cache.js';
import { ProxyConfig, cachedJsonFetch, supabaseEdgeUrl, supabaseHeaders, openMeteoUrl } from '../proxy.js';
import { TTL } from '../scheduler.js';

export function createGribRoutes(cache: Cache, config: ProxyConfig): Router {
    const router = Router();

    /**
     * GET /api/grib/wind?lat=X&lon=Y&days=5
     * Wind field grid data — 10m wind speed, direction, gusts.
     */
    router.get('/wind', async (req: Request, res: Response) => {
        try {
            const { lat, lon, days = '5' } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `grib:wind:${lat}:${lon}:${days}d`;
            const url = openMeteoUrl(
                config,
                'forecast',
                `latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&forecast_days=${days}`,
            );

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.GRIB,
                source: 'open-meteo-wind',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Wind data failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/grib/pressure?lat=X&lon=Y&days=5
     * Pressure field — MSL pressure for isobar rendering.
     */
    router.get('/pressure', async (req: Request, res: Response) => {
        try {
            const { lat, lon, days = '5' } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `grib:pressure:${lat}:${lon}:${days}d`;
            const url = openMeteoUrl(
                config,
                'forecast',
                `latitude=${lat}&longitude=${lon}&hourly=pressure_msl,surface_pressure&forecast_days=${days}`,
            );

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.GRIB,
                source: 'open-meteo-pressure',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Pressure data failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/grib/waves?lat=X&lon=Y
     * Wave/swell grid data from Open-Meteo Marine API.
     */
    router.get('/waves', async (req: Request, res: Response) => {
        try {
            const { lat, lon } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `grib:waves:${lat}:${lon}`;
            const url = openMeteoUrl(
                config,
                'marine',
                `latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,wind_wave_height,wind_wave_direction,wind_wave_period`,
            );

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.GRIB,
                source: 'open-meteo-marine',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Wave data failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/grib/precip?lat=X&lon=Y&days=3
     * Precipitation forecast grid.
     */
    router.get('/precip', async (req: Request, res: Response) => {
        try {
            const { lat, lon, days = '3' } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `grib:precip:${lat}:${lon}:${days}d`;
            const url = openMeteoUrl(
                config,
                'forecast',
                `latitude=${lat}&longitude=${lon}&hourly=precipitation,precipitation_probability,rain,showers,snowfall&forecast_days=${days}`,
            );

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.GRIB,
                source: 'open-meteo-precip',
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'Precip data failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/grib/composite?lat=X&lon=Y&days=5
     * All-in-one: wind + pressure + precip + waves in a single request.
     * The app uses this for the combined weather overlay.
     */
    router.get('/composite', async (req: Request, res: Response) => {
        try {
            const { lat, lon, days = '5' } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `grib:composite:${lat}:${lon}:${days}d`;

            // Fetch atmosphere + marine in parallel
            const [atmoResult, marineResult] = await Promise.allSettled([
                cachedJsonFetch(cache, {
                    cacheKey: `${key}:atmo`,
                    url: openMeteoUrl(
                        config,
                        'forecast',
                        `latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,precipitation,precipitation_probability,cloud_cover,temperature_2m&wind_speed_unit=kn&forecast_days=${days}`,
                    ),
                    ttlMs: TTL.GRIB,
                    source: 'open-meteo-composite',
                }),
                cachedJsonFetch(cache, {
                    cacheKey: `${key}:marine`,
                    url: openMeteoUrl(
                        config,
                        'marine',
                        `latitude=${lat}&longitude=${lon}&hourly=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period`,
                    ),
                    ttlMs: TTL.GRIB,
                    source: 'open-meteo-marine-composite',
                }),
            ]);

            const composite: Record<string, unknown> = {};
            let anyFromCache = false;
            let anyStale = false;

            if (atmoResult.status === 'fulfilled') {
                composite.atmosphere = atmoResult.value.data;
                if (atmoResult.value.fromCache) anyFromCache = true;
                if (atmoResult.value.stale) anyStale = true;
            }
            if (marineResult.status === 'fulfilled') {
                composite.marine = marineResult.value.data;
                if (marineResult.value.fromCache) anyFromCache = true;
                if (marineResult.value.stale) anyStale = true;
            }

            res.set('X-Cache', anyFromCache ? (anyStale ? 'STALE' : 'HIT') : 'MISS');
            res.json(composite);
        } catch (err) {
            res.status(502).json({ error: 'Composite GRIB failed', message: (err as Error).message });
        }
    });

    /**
     * GET /api/grib/noaa?lat=X&lon=Y&model=gfs
     * Higher-resolution NOAA GFS/HRRR data via Supabase edge function.
     */
    router.get('/noaa', async (req: Request, res: Response) => {
        try {
            const { lat, lon, model = 'gfs' } = req.query;
            if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });

            const key = `grib:noaa:${model}:${lat}:${lon}`;
            const url = supabaseEdgeUrl(config, 'grib', {
                lat: String(lat),
                lon: String(lon),
                model: String(model),
            });

            const result = await cachedJsonFetch(cache, {
                cacheKey: key,
                url,
                ttlMs: TTL.GRIB,
                source: `noaa-${model}`,
                headers: supabaseHeaders(config),
            });

            res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
            res.json(result.data);
        } catch (err) {
            res.status(502).json({ error: 'NOAA GRIB failed', message: (err as Error).message });
        }
    });

    return router;
}
