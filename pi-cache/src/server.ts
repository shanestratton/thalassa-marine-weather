/**
 * Thalassa Pi Cache — Express server entry point.
 *
 * Runs on the boat's Raspberry Pi alongside Signal K (3000) and AvNav (8080).
 * Proxies all external API calls through a local SQLite cache so phones/tablets
 * on the boat WiFi get instant responses — even when the sat-phone is off.
 *
 * Default port: 3001
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Cache } from './cache.js';
import { createWeatherRoutes } from './routes/weather.js';
import { createTileRoutes } from './routes/tiles.js';
import { createGribRoutes } from './routes/grib.js';
import { createTideRoutes } from './routes/tides.js';
import { createMiscRoutes } from './routes/misc.js';
import { startScheduler, stopScheduler } from './scheduler.js';

// ── Config ──

const PORT = parseInt(process.env.PORT || '3001', 10);
const CACHE_DIR = process.env.CACHE_DIR || './cache';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.warn('⚠️  SUPABASE_URL or SUPABASE_ANON_KEY not set — proxied requests will fail.');
    console.warn('   Copy .env.example to .env and fill in your Supabase project details.');
}

// ── Bootstrap ──

const cache = new Cache(CACHE_DIR);
const app = express();

// Allow all origins — this runs on a private boat network
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
            prefetchLat: process.env.PREFETCH_LAT || null,
            prefetchLon: process.env.PREFETCH_LON || null,
        },
    });
});

// Purge expired cache entries on demand
app.post('/cache/purge', (_req, res) => {
    const result = cache.purgeExpired();
    res.json({ purged: result });
});

// ── API Routes ──

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
    console.log(`   Supabase:  ${SUPABASE_URL ? '✅ configured' : '❌ not configured'}`);
    console.log('');

    // Start scheduled pre-fetch jobs
    startScheduler(cache, proxyConfig);
});

// ── Graceful Shutdown ──

function shutdown() {
    console.log('\n🛑 Shutting down Pi Cache...');
    stopScheduler();
    server.close(() => {
        cache.close();
        console.log('   Cache closed. Goodbye! 🚢');
        process.exit(0);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
