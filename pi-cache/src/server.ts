/**
 * Thalassa Pi Cache — Express server entry point.
 *
 * Runs on the boat's Raspberry Pi. Zero config required.
 * The Thalassa app on the phone pushes any needed configuration
 * via the /api/configure endpoint.
 *
 * Default port: 3001
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { Cache } from './cache.js';
import { createWeatherRoutes } from './routes/weather.js';
import { createTileRoutes } from './routes/tiles.js';
import { createGribRoutes } from './routes/grib.js';
import { createTideRoutes } from './routes/tides.js';
import { createMiscRoutes } from './routes/misc.js';
import { cachedJsonFetch, cachedTileFetch } from './proxy.js';
import { startScheduler, stopScheduler } from './scheduler.js';

// ── Config (mutable — app can update via /api/configure) ──

const PORT = parseInt(process.env.PORT || '3001', 10);
const CACHE_DIR = process.env.CACHE_DIR || './cache';
let SUPABASE_URL = process.env.SUPABASE_URL || '';
let SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

// ── Bootstrap ──

const cache = new Cache(CACHE_DIR);
const app = express();

app.use(cors());
app.use(express.json());

// ── Health & Status ──

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'thalassa-pi-cache', uptime: process.uptime() });
});

app.get('/status', (_req, res) => {
    const stats = cache.getStats();
    res.json({
        status: 'ok',
        cache: stats,
        config: {
            port: PORT,
            cacheDir: CACHE_DIR,
            supabaseConfigured: !!SUPABASE_URL,
            prefetchConfigured: !!(process.env.PREFETCH_LAT && process.env.PREFETCH_LON),
            prefetchLat: process.env.PREFETCH_LAT || null,
            prefetchLon: process.env.PREFETCH_LON || null,
        },
    });
});

// ── Configure (called by the Thalassa app on the phone) ──
// The skipper never touches a terminal. The app pushes config here.

app.post('/api/configure', (req, res) => {
    const { supabaseUrl, supabaseAnonKey, prefetchLat, prefetchLon, prefetchRadius } = req.body || {};

    const envLines: string[] = [
        '# Thalassa Pi Cache — configured by the Thalassa app',
        `PORT=${PORT}`,
        `CACHE_DIR=${CACHE_DIR}`,
    ];

    // Update Supabase config if provided
    if (supabaseUrl) {
        SUPABASE_URL = supabaseUrl;
        envLines.push(`SUPABASE_URL=${supabaseUrl}`);
    }
    if (supabaseAnonKey) {
        SUPABASE_ANON_KEY = supabaseAnonKey;
        envLines.push(`SUPABASE_ANON_KEY=${supabaseAnonKey}`);
    }

    // Update pre-fetch location if provided
    if (prefetchLat !== undefined && prefetchLon !== undefined) {
        process.env.PREFETCH_LAT = String(prefetchLat);
        process.env.PREFETCH_LON = String(prefetchLon);
        process.env.PREFETCH_RADIUS = String(prefetchRadius || 5);
        process.env.PREFETCH_INTERVAL = process.env.PREFETCH_INTERVAL || '15';

        envLines.push(`PREFETCH_LAT=${prefetchLat}`);
        envLines.push(`PREFETCH_LON=${prefetchLon}`);
        envLines.push(`PREFETCH_RADIUS=${prefetchRadius || 5}`);
        envLines.push(`PREFETCH_INTERVAL=${process.env.PREFETCH_INTERVAL || 15}`);
    }

    // Write .env so config persists across restarts
    try {
        const envPath = path.join(process.cwd(), '.env');
        fs.writeFileSync(envPath, envLines.join('\n') + '\n');
    } catch (err) {
        console.warn('Could not write .env:', (err as Error).message);
    }

    // Restart pre-fetch scheduler with new config
    stopScheduler();
    const proxyConfig = { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY };
    startScheduler(cache, proxyConfig);

    console.log('📱 Configuration updated by Thalassa app');
    res.json({ status: 'ok', message: 'Configuration updated' });
});

// Purge expired cache entries
app.post('/cache/purge', (_req, res) => {
    const result = cache.purgeExpired();
    res.json({ purged: result });
});

// ── Generic Passthrough Proxy ──
// The app sends any URL here and the Pi caches the response.
// This is the magic one — zero config, works for every API.

app.get('/api/passthrough', async (req, res) => {
    try {
        const url = req.query.url as string;
        const ttl = parseInt((req.query.ttl as string) || '900000', 10);
        const source = (req.query.source as string) || 'passthrough';

        if (!url) return res.status(400).json({ error: 'url parameter required' });

        const key = `passthrough:${url}`;
        const result = await cachedJsonFetch(cache, { cacheKey: key, url, ttlMs: ttl, source });

        res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
        res.json(result.data);
    } catch (err) {
        res.status(502).json({ error: 'Passthrough failed', message: (err as Error).message });
    }
});

app.get('/api/passthrough-tile', async (req, res) => {
    try {
        const url = req.query.url as string;
        const ttl = parseInt((req.query.ttl as string) || '1800000', 10);
        const contentType = (req.query.ct as string) || 'image/png';

        if (!url) return res.status(400).json({ error: 'url parameter required' });

        const key = `passthrough-tile:${url}`;
        const result = await cachedTileFetch(cache, { cacheKey: key, url, contentType, ttlMs: ttl });

        res.set('Content-Type', result.contentType);
        res.set('X-Cache', result.fromCache ? (result.stale ? 'STALE' : 'HIT') : 'MISS');
        res.send(result.data);
    } catch (err) {
        res.status(502).json({ error: 'Tile passthrough failed', message: (err as Error).message });
    }
});

// ── API Routes (for direct Pi endpoints — used by pre-fetch) ──

const proxyConfig = { supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY };

app.use('/api/weather', createWeatherRoutes(cache, proxyConfig));
app.use('/api/tiles', createTileRoutes(cache, proxyConfig));
app.use('/api/grib', createGribRoutes(cache, proxyConfig));
app.use('/api/tides', createTideRoutes(cache, proxyConfig));
app.use('/api/misc', createMiscRoutes(cache, proxyConfig));

// ── Start ──

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🌊 Thalassa Pi Cache running on http://0.0.0.0:${PORT}`);
    console.log(`   Cache dir: ${CACHE_DIR}`);
    console.log(`   Supabase:  ${SUPABASE_URL ? '✅ configured' : '⏳ waiting for app to configure'}`);
    console.log(`   Open Thalassa on your phone → Settings → Pi Cache\n`);

    if (SUPABASE_URL) {
        startScheduler(cache, proxyConfig);
    }
});

// ── Graceful Shutdown ──

function shutdown() {
    console.log('\n🛑 Shutting down...');
    stopScheduler();
    server.close(() => {
        cache.close();
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
