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
import {
    ProxyConfig,
    cachedJsonFetch,
    cachedTileFetch,
    supabaseEdgeUrl,
    supabaseHeaders,
    openMeteoUrl,
} from './proxy.js';

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
    // Batch 1: Core weather (combined = what the app actually requests) + tides + rain radar
    await Promise.allSettled([
        track('weather-combined', () => prefetchWeatherCombined(cache, proxyConfig, pf)),
        track('weather-current', () => prefetchWeather(cache, proxyConfig, pf, 'current')),
        track('weather-forecast', () => prefetchWeather(cache, proxyConfig, pf, 'forecast')),
        track('tides', () => prefetchTides(cache, proxyConfig, pf)),
        track('rain-radar', () => prefetchRainRadar(cache, pf)),
    ]);

    // Batch 2: Satellite + GRIB (wind + waves + pressure) + synoptic
    await Promise.allSettled([
        track('satellite-ir', () => prefetchSatelliteTiles(cache, pf, 'ir')),
        track('satellite-vis', () => prefetchSatelliteTiles(cache, pf, 'visible')),
        track('grib-wind', () => prefetchGrib(cache, proxyConfig, pf, 'wind')),
        track('grib-waves', () => prefetchGrib(cache, proxyConfig, pf, 'waves')),
        track('grib-pressure', () => prefetchGrib(cache, proxyConfig, pf, 'pressure')),
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

/**
 * Pre-fetch the COMBINED weather response that the app's fetchOpenMeteo() expects.
 * This is the critical one — it's what makes the app open instantly without a spinner.
 * Coordinates are rounded to 2dp so GPS drift on a moored boat still gets cache HITs.
 */
async function prefetchWeatherCombined(cache: Cache, config: ProxyConfig, pf: PrefetchConfig): Promise<void> {
    // Round to 2dp — must match the Pi route's rounding logic
    const rlat = parseFloat(pf.lat.toFixed(2));
    const rlon = parseFloat(pf.lon.toFixed(2));
    const key = `weather:combined:${rlat}:${rlon}`;

    if (cache.hasFresh(key)) return;

    const url = openMeteoUrl(
        config,
        'forecast',
        `latitude=${pf.lat}&longitude=${pf.lon}` +
            `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
            `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,weather_code,pressure_msl,surface_pressure,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index,cape` +
            `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant` +
            `&timezone=auto&forecast_days=16&models=best_match`,
    );

    await cachedJsonFetch(cache, { cacheKey: key, url, ttlMs: TTL.WEATHER_CURRENT, source: 'open-meteo-combined' });
}

async function prefetchWeather(
    cache: Cache,
    config: ProxyConfig,
    pf: PrefetchConfig,
    type: 'current' | 'forecast',
): Promise<void> {
    const ttl = type === 'current' ? TTL.WEATHER_CURRENT : TTL.WEATHER_FORECAST;
    const key = `weather:${type}:${pf.lat}:${pf.lon}`;

    if (cache.hasFresh(key)) return; // Already fresh, skip

    // Open-Meteo Commercial API — key injected by openMeteoUrl helper
    const params =
        type === 'current'
            ? `latitude=${pf.lat}&longitude=${pf.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn`
            : `latitude=${pf.lat}&longitude=${pf.lon}&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&forecast_days=7`;

    const url = openMeteoUrl(config, 'forecast', params);

    await cachedJsonFetch(cache, { cacheKey: key, url, ttlMs: ttl, source: 'open-meteo' });
}

async function prefetchTides(cache: Cache, config: ProxyConfig, pf: PrefetchConfig): Promise<void> {
    const days = 7;
    // Cache key must match the route handler in routes/tides.ts
    const key = `tides:predictions:${pf.lat}:${pf.lon}:${days}d`;
    if (cache.hasFresh(key)) return;

    // Supabase edge function — proxy-tides accepts GET with query params
    const url = supabaseEdgeUrl(config, 'proxy-tides', { lat: pf.lat, lon: pf.lon, days });
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
    type: 'wind' | 'pressure' | 'waves',
): Promise<void> {
    const key = `grib:${type}:${pf.lat}:${pf.lon}`;
    if (cache.hasFresh(key)) return;

    let params: string;
    if (type === 'wind') {
        params = `latitude=${pf.lat}&longitude=${pf.lon}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kn&forecast_days=5`;
    } else if (type === 'waves') {
        params = `latitude=${pf.lat}&longitude=${pf.lon}&hourly=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period&forecast_days=5`;
        const url = openMeteoUrl(config, 'marine', params);
        await cachedJsonFetch(cache, { cacheKey: key, url, ttlMs: TTL.GRIB, source: 'open-meteo-marine' });
        return;
    } else {
        params = `latitude=${pf.lat}&longitude=${pf.lon}&hourly=pressure_msl,surface_pressure&forecast_days=5`;
    }

    const url = openMeteoUrl(config, 'forecast', params);
    await cachedJsonFetch(cache, { cacheKey: key, url, ttlMs: TTL.GRIB, source: 'open-meteo-grib' });
}

/**
 * Pre-fetch RainViewer radar tiles for the boat's area.
 *
 * 1. Fetch the RainViewer weather-maps API (frame index, ~1KB)
 * 2. For each recent radar frame, download tiles at z=5 covering the boat
 *
 * Only caches the 3 most recent past frames + nowcast (not the full history)
 * to keep storage bounded. Tiles update every 10 minutes.
 */
async function prefetchRainRadar(cache: Cache, pf: PrefetchConfig): Promise<void> {
    // 1. Cache the weather-maps API response (app fetches this to get frame paths)
    const apiKey = 'rainviewer:weather-maps';
    const apiUrl = 'https://api.rainviewer.com/public/weather-maps.json';

    const result = await cachedJsonFetch(cache, {
        cacheKey: apiKey,
        url: apiUrl,
        ttlMs: TTL.WEATHER_CURRENT, // 15 min — radar updates frequently
        source: 'rainviewer',
    });

    // 2. Download radar tiles for the boat's area (zoom 5 = synoptic overview)
    const radar = result?.data as { radar?: { past?: { path: string }[]; nowcast?: { path: string }[] } } | null;
    const past = radar?.radar?.past ?? [];
    const nowcast = radar?.radar?.nowcast ?? [];

    // Only cache recent frames (last 3 past + all nowcast) — not the full 2-hour history
    const recentPast = past.slice(-3);
    const frames = [...recentPast, ...nowcast];

    if (frames.length === 0) return;

    const z = 5;
    const { minTileX, maxTileX, minTileY, maxTileY } = latLonToTileRange(pf.lat, pf.lon, pf.radius, z);

    let tileCount = 0;
    for (const frame of frames) {
        for (let x = minTileX; x <= maxTileX; x++) {
            for (let y = minTileY; y <= maxTileY; y++) {
                const key = `tile:rainviewer:${z}/${x}/${y}:${frame.path}`;
                if (cache.hasFreshTile(key)) continue;

                const url = `https://tilecache.rainviewer.com${frame.path}/256/${z}/${y}/${x}/4/1_1.png`;
                try {
                    await cachedTileFetch(cache, {
                        cacheKey: key,
                        url,
                        contentType: 'image/png',
                        ttlMs: TTL.WEATHER_CURRENT,
                    });
                    tileCount++;
                } catch {
                    // Individual tile failures are fine — just skip
                }
            }
        }
    }
    if (tileCount > 0) console.log(`   🌧️ Cached ${tileCount} rain radar tiles`);
}

async function prefetchSynoptic(cache: Cache, _config: ProxyConfig, pf: PrefetchConfig): Promise<void> {
    const isNorthern = pf.lat > 0;

    // Synoptic charts are IMAGES — use tile cache, not JSON cache.
    // Southern Hemisphere: BOM MSLP colour analysis (IDY00030) — updates at 00/06/12/18 UTC
    // Northern Hemisphere: NOAA OPC Unified Surface Analysis
    const charts: Array<{ key: string; url: string; contentType: string; headers?: Record<string, string> }> = [];

    if (isNorthern) {
        // NOAA OPC — region based on longitude
        const isPacific = pf.lon < -30 || pf.lon > 100;
        charts.push({
            key: 'synoptic:noaa:overview',
            url: 'https://ocean.weather.gov/UA/entire_UA.gif',
            contentType: 'image/gif',
        });
        charts.push({
            key: `synoptic:noaa:${isPacific ? 'pacific' : 'atlantic'}`,
            url: isPacific ? 'https://ocean.weather.gov/UA/OPC_PAC.gif' : 'https://ocean.weather.gov/UA/OPC_ATL.gif',
            contentType: 'image/gif',
        });
    } else {
        // BOM MSLP colour chart — construct timestamped URL (nearest 6h UTC)
        const now = new Date();
        const utcH = now.getUTCHours();
        const chartHour = Math.floor(utcH / 6) * 6; // 0, 6, 12, or 18
        const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hh = String(chartHour).padStart(2, '0');
        const timestamp = `${ymd}${hh}00`;

        charts.push({
            key: `synoptic:bom:mslp:${timestamp}`,
            url: `https://www.bom.gov.au/fwo/IDY00030.${timestamp}.png`,
            contentType: 'image/png',
            headers: { 'User-Agent': 'Mozilla/5.0 ThalassaMarine/1.0' }, // BOM requires UA
        });
        // Also grab the simpler B&W chart (smaller, always available)
        charts.push({
            key: 'synoptic:bom:bw',
            url: 'https://www.bom.gov.au/difacs/IDX0894.gif',
            contentType: 'image/gif',
        });
    }

    for (const chart of charts) {
        if (cache.hasFreshTile(chart.key)) continue;
        try {
            await cachedTileFetch(cache, {
                cacheKey: chart.key,
                url: chart.url,
                contentType: chart.contentType,
                ttlMs: TTL.SYNOPTIC,
                headers: chart.headers,
            });
        } catch {
            // Individual chart failures are non-critical
        }
    }
}

async function prefetchBuoys(cache: Cache, _config: ProxyConfig, pf: PrefetchConfig): Promise<void> {
    const key = `buoys:${pf.lat}:${pf.lon}:${pf.radius}`;
    if (cache.hasFresh(key)) return;

    // NOAA NDBC Active Stations — free JSON API (no key needed)
    // Returns stations within a bounding box around the boat's location
    const degRadius = pf.radius || 5;
    const url = `https://www.ndbc.noaa.gov/data/stations/station_table.txt`;

    // Fallback: use the NDBC RSS observation search which returns nearby buoy data
    const rssUrl = `https://www.ndbc.noaa.gov/rss/ndbc_obs_search.php?lat=${pf.lat}N&lon=${Math.abs(pf.lon)}${pf.lon >= 0 ? 'E' : 'W'}&radius=${Math.round(degRadius * 60)}`;

    try {
        await cachedJsonFetch(cache, {
            cacheKey: key,
            url: rssUrl,
            ttlMs: TTL.BUOY,
            source: 'ndbc-rss',
        });
    } catch {
        // RSS might fail to parse as JSON — that's OK, client fetches buoys on-demand
        console.warn('   ⚠️ Buoy pre-fetch skipped (RSS not JSON-parseable)');
    }
}

async function prefetchCyclones(cache: Cache, _config: ProxyConfig): Promise<void> {
    const key = 'cyclones:active';
    if (cache.hasFresh(key)) return;

    // KnackWx ATCF API — free, CORS-enabled, no API key needed
    const url = 'https://api.knackwx.com/atcf/v2';
    await cachedJsonFetch(cache, {
        cacheKey: key,
        url,
        ttlMs: TTL.CYCLONE,
        source: 'knackwx-atcf',
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
