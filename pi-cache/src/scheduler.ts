/**
 * Scheduler — Cron-based pre-fetching of weather, tide, and satellite data.
 *
 * When the boat has internet, the Pi proactively downloads fresh data
 * on a schedule so it's ready before the punter even opens the app.
 *
 * Pre-fetch targets are based on PREFETCH_LAT/LON/RADIUS from .env.
 * Default interval: every 15 minutes.
 */

import cron from 'node-cron';
import { Cache } from './cache.js';
import { ProxyConfig, cachedJsonFetch, cachedTileFetch, supabaseEdgeUrl, supabaseHeaders } from './proxy.js';

// ── TTL Constants (milliseconds) ──

export const TTL = {
    WEATHER_CURRENT: 15 * 60 * 1000, // 15 min — conditions change fast
    WEATHER_FORECAST: 60 * 60 * 1000, // 1 hour — forecasts update hourly
    WEATHER_EXTENDED: 6 * 60 * 60 * 1000, // 6 hours — 7-day outlook
    TIDES: 12 * 60 * 60 * 1000, // 12 hours — tide tables are predictable
    SATELLITE: 30 * 60 * 1000, // 30 min — satellite passes update frequently
    SYNOPTIC: 6 * 60 * 60 * 1000, // 6 hours — synoptic charts update 4x/day
    GRIB: 6 * 60 * 60 * 1000, // 6 hours — GFS model runs
    CYCLONE: 60 * 60 * 1000, // 1 hour — active storm tracking
    BUOY: 30 * 60 * 1000, // 30 min — observation frequency
    SEALEVEL: 60 * 60 * 1000, // 1 hour
    SEAMARK: 24 * 60 * 60 * 1000, // 24 hours — rarely change
};

let scheduledTask: cron.ScheduledTask | null = null;

interface PrefetchConfig {
    lat: number;
    lon: number;
    radius: number;
    interval: number;
}

function getPrefetchConfig(): PrefetchConfig | null {
    const lat = parseFloat(process.env.PREFETCH_LAT || '');
    const lon = parseFloat(process.env.PREFETCH_LON || '');
    if (isNaN(lat) || isNaN(lon)) return null;

    return {
        lat,
        lon,
        radius: parseFloat(process.env.PREFETCH_RADIUS || '5'),
        interval: parseInt(process.env.PREFETCH_INTERVAL || '15', 10),
    };
}

/**
 * Run all pre-fetch jobs. Called on startup and then by the cron scheduler.
 */
async function runPrefetch(cache: Cache, proxyConfig: ProxyConfig, pf: PrefetchConfig): Promise<void> {
    const start = Date.now();
    const results: Array<{ name: string; ok: boolean; ms: number }> = [];

    async function track(name: string, fn: () => Promise<void>) {
        const t0 = Date.now();
        try {
            await fn();
            results.push({ name, ok: true, ms: Date.now() - t0 });
        } catch (err) {
            results.push({ name, ok: false, ms: Date.now() - t0 });
            console.error(`   ❌ ${name}: ${(err as Error).message}`);
        }
    }

    console.log(`\n🔄 Pre-fetch starting for ${pf.lat}, ${pf.lon} (r=${pf.radius}°)...`);

    // Run fetches in parallel batches to avoid hammering the network
    // Batch 1: Core weather + tides
    await Promise.allSettled([
        track('weather-current', () => prefetchWeather(cache, proxyConfig, pf, 'current')),
        track('weather-forecast', () => prefetchWeather(cache, proxyConfig, pf, 'forecast')),
        track('tides', () => prefetchTides(cache, proxyConfig, pf)),
    ]);

    // Batch 2: Satellite + GRIB + synoptic
    await Promise.allSettled([
        track('satellite-ir', () => prefetchSatelliteTiles(cache, pf, 'ir')),
        track('satellite-vis', () => prefetchSatelliteTiles(cache, pf, 'visible')),
        track('grib-wind', () => prefetchGrib(cache, proxyConfig, pf, 'wind')),
        track('synoptic', () => prefetchSynoptic(cache, proxyConfig, pf)),
    ]);

    // Batch 3: Buoys + cyclones + misc
    await Promise.allSettled([
        track('buoys', () => prefetchBuoys(cache, proxyConfig, pf)),
        track('cyclones', () => prefetchCyclones(cache, proxyConfig)),
    ]);

    const elapsed = Date.now() - start;
    const ok = results.filter((r) => r.ok).length;
    const fail = results.filter((r) => !r.ok).length;
    console.log(`✅ Pre-fetch complete: ${ok} succeeded, ${fail} failed (${elapsed}ms total)\n`);
}

// ── Individual Pre-fetch Functions ──

async function prefetchWeather(
    cache: Cache,
    config: ProxyConfig,
    pf: PrefetchConfig,
    type: 'current' | 'forecast',
): Promise<void> {
    const ttl = type === 'current' ? TTL.WEATHER_CURRENT : TTL.WEATHER_FORECAST;
    const key = `weather:${type}:${pf.lat}:${pf.lon}`;

    if (cache.hasFresh(key)) return; // Already fresh, skip

    // Try Open-Meteo directly (no API key needed)
    const params =
        type === 'current'
            ? `latitude=${pf.lat}&longitude=${pf.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn`
            : `latitude=${pf.lat}&longitude=${pf.lon}&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&forecast_days=7`;

    const url = `https://api.open-meteo.com/v1/forecast?${params}`;

    await cachedJsonFetch(cache, { cacheKey: key, url, ttlMs: ttl, source: 'open-meteo' });
}

async function prefetchTides(cache: Cache, config: ProxyConfig, pf: PrefetchConfig): Promise<void> {
    const key = `tides:${pf.lat}:${pf.lon}`;
    if (cache.hasFresh(key)) return;

    // Try via Supabase edge function (handles WorldTides API key)
    const url = supabaseEdgeUrl(config, 'tides', { lat: pf.lat, lon: pf.lon });
    await cachedJsonFetch(cache, {
        cacheKey: key,
        url,
        ttlMs: TTL.TIDES,
        source: 'worldtides',
        headers: supabaseHeaders(config),
    });
}

async function prefetchSatelliteTiles(cache: Cache, pf: PrefetchConfig, band: 'ir' | 'visible'): Promise<void> {
    // NASA GIBS tiles for the area around the boat
    // Calculate tile coordinates for zoom level 5 (good overview)
    const z = 5;
    const { minTileX, maxTileX, minTileY, maxTileY } = latLonToTileRange(pf.lat, pf.lon, pf.radius, z);

    const today = new Date().toISOString().split('T')[0];
    const layer =
        band === 'ir' ? 'MODIS_Terra_CorrectedReflectance_TrueColor' : 'VIIRS_SNPP_CorrectedReflectance_TrueColor';

    for (let x = minTileX; x <= maxTileX; x++) {
        for (let y = minTileY; y <= maxTileY; y++) {
            const key = `tile:gibs:${band}:${z}/${x}/${y}`;
            if (cache.hasFreshTile(key)) continue;

            const url = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${today}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`;
            try {
                await cachedTileFetch(cache, {
                    cacheKey: key,
                    url,
                    contentType: 'image/jpeg',
                    ttlMs: TTL.SATELLITE,
                });
            } catch {
                // Individual tile failures are fine — just skip
            }
        }
    }
}

async function prefetchGrib(
    cache: Cache,
    config: ProxyConfig,
    pf: PrefetchConfig,
    type: 'wind' | 'pressure',
): Promise<void> {
    const key = `grib:${type}:${pf.lat}:${pf.lon}`;
    if (cache.hasFresh(key)) return;

    // Open-Meteo has a free GRIB-like endpoint
    const params = `latitude=${pf.lat}&longitude=${pf.lon}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl&wind_speed_unit=kn&forecast_days=5`;
    const url = `https://api.open-meteo.com/v1/forecast?${params}`;

    await cachedJsonFetch(cache, { cacheKey: key, url, ttlMs: TTL.GRIB, source: 'open-meteo-grib' });
}

async function prefetchSynoptic(cache: Cache, config: ProxyConfig, pf: PrefetchConfig): Promise<void> {
    const key = `synoptic:${pf.lat}:${pf.lon}`;
    if (cache.hasFresh(key)) return;

    // BOM synoptic charts (Southern Hemisphere) or NOAA OPC (Northern)
    const isNorthern = pf.lat > 0;
    const url = isNorthern
        ? 'https://ocean.weather.gov/A_brief/shtml/atlsfc_brief.gif'
        : 'https://www.bom.gov.au/charts/synoptic_col.shtml'; // Parsed downstream

    // Store via Supabase edge function if available
    const edgeUrl = supabaseEdgeUrl(config, 'synoptic', { lat: pf.lat, lon: pf.lon });
    await cachedJsonFetch(cache, {
        cacheKey: key,
        url: edgeUrl,
        ttlMs: TTL.SYNOPTIC,
        source: 'synoptic',
        headers: supabaseHeaders(config),
    });
}

async function prefetchBuoys(cache: Cache, config: ProxyConfig, pf: PrefetchConfig): Promise<void> {
    const key = `buoys:${pf.lat}:${pf.lon}:${pf.radius}`;
    if (cache.hasFresh(key)) return;

    // NOAA NDBC buoys — fetch active stations near the boat
    const url = `https://www.ndbc.noaa.gov/rss/ndbc_obs_search.php?lat=${pf.lat}N&lon=${Math.abs(pf.lon)}${pf.lon >= 0 ? 'E' : 'W'}&radius=250`;

    await cachedJsonFetch(cache, {
        cacheKey: key,
        url: supabaseEdgeUrl(config, 'buoys', { lat: pf.lat, lon: pf.lon, radius: pf.radius }),
        ttlMs: TTL.BUOY,
        source: 'ndbc',
        headers: supabaseHeaders(config),
    });
}

async function prefetchCyclones(cache: Cache, config: ProxyConfig): Promise<void> {
    const key = 'cyclones:active';
    if (cache.hasFresh(key)) return;

    const url = supabaseEdgeUrl(config, 'cyclones');
    await cachedJsonFetch(cache, {
        cacheKey: key,
        url,
        ttlMs: TTL.CYCLONE,
        source: 'nhc-atcf',
        headers: supabaseHeaders(config),
    });
}

// ── Tile Math Helpers ──

function latLonToTileRange(lat: number, lon: number, radiusDeg: number, z: number) {
    const n = 1 << z;
    const lonToX = (lng: number) => Math.floor(((lng + 180) / 360) * n);
    const latToY = (lt: number) =>
        Math.floor(
            ((1 - Math.log(Math.tan((lt * Math.PI) / 180) + 1 / Math.cos((lt * Math.PI) / 180)) / Math.PI) / 2) * n,
        );

    return {
        minTileX: Math.max(0, lonToX(lon - radiusDeg)),
        maxTileX: Math.min(n - 1, lonToX(lon + radiusDeg)),
        minTileY: Math.max(0, latToY(lat + radiusDeg)),
        maxTileY: Math.min(n - 1, latToY(lat - radiusDeg)),
    };
}

// ── Public API ──

export function startScheduler(cache: Cache, proxyConfig: ProxyConfig): void {
    const pf = getPrefetchConfig();
    if (!pf) {
        console.log('📡 Pre-fetch disabled (no PREFETCH_LAT/LON configured)');
        return;
    }

    console.log(`📡 Pre-fetch enabled: ${pf.lat}, ${pf.lon} every ${pf.interval}min`);

    // Run immediately on startup
    runPrefetch(cache, proxyConfig, pf).catch((err) => console.error('Pre-fetch startup error:', err));

    // Then on schedule
    scheduledTask = cron.schedule(`*/${pf.interval} * * * *`, () => {
        runPrefetch(cache, proxyConfig, pf).catch((err) => console.error('Pre-fetch cron error:', err));
    });
}

export function stopScheduler(): void {
    if (scheduledTask) {
        scheduledTask.stop();
        scheduledTask = null;
        console.log('📡 Pre-fetch scheduler stopped');
    }
}
