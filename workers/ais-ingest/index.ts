/**
 * AIS Ingestion Worker — AISStream.io → Supabase PostGIS
 *
 * Maintains a persistent WebSocket to AISStream.io, parses
 * PositionReport + ShipStaticData messages, and batch-upserts
 * vessel positions into the Supabase `vessels` table.
 *
 * Dead man's switch:
 *   - HTTP health endpoint on PORT (default 3001)
 *   - Returns 503 if no messages received in STALE_THRESHOLD_MS
 *   - Auto-reconnects WebSocket if data stream goes stale
 *   - Railway health check hits /health → restarts container on failure
 *
 * Usage:
 *   cp .env.example .env  # fill in your keys
 *   npm install
 *   npm start
 */
import 'dotenv/config';
import http from 'node:http';
import WebSocket from 'ws';
import { parseAisStreamMessage } from './parser.js';
import { VesselDB } from './db.js';
import { startWatchdog } from './watchdog.js';

// ── Config ──
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const API_KEY = process.env.AISSTREAM_KEY;
const BOUNDING_BOXES = JSON.parse(process.env.BOUNDING_BOXES || '[[[-90,-180],[90,180]]]');

// Reconnect backoff
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

// Stats logging interval
const STATS_INTERVAL_MS = 30_000;

// Dead man's switch — stale threshold
const STALE_THRESHOLD_MS = parseInt(process.env.STALE_THRESHOLD_MS || '300000', 10); // 5 min
const STALE_CHECK_INTERVAL_MS = 60_000; // Check every 60s
const HEALTH_PORT = parseInt(process.env.PORT || '3001', 10);

if (!API_KEY) {
    console.error('[FATAL] AISSTREAM_KEY not set. Copy .env.example to .env and fill in your key.');
    process.exit(1);
}

// ── State ──
const db = new VesselDB();
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let messageCount = 0;
let parsedCount = 0;
let isShuttingDown = false;

// Dead man's switch state
let lastMessageAt = Date.now();
let staleReconnects = 0;
const startedAt = Date.now();

// ── WebSocket lifecycle ──

function connect(): void {
    if (isShuttingDown) return;

    console.log(`[WS] Connecting to AISStream.io...`);

    console.log(`[WS] Bounding boxes: ${JSON.stringify(BOUNDING_BOXES)}`);

    ws = new WebSocket(AISSTREAM_URL);

    ws.on('open', () => {
        console.log('[WS] Connected! Sending subscription...');
        reconnectAttempts = 0;

        // Must send subscription within 3 seconds
        const subscription = {
            Apikey: API_KEY,
            BoundingBoxes: BOUNDING_BOXES,
            FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'],
        };

        ws!.send(JSON.stringify(subscription));

        console.log('[WS] Subscription sent. Listening for AIS messages...');
    });

    ws.on('message', (data: WebSocket.Data) => {
        messageCount++;
        lastMessageAt = Date.now(); // ← Dead man's switch heartbeat
        const raw = data.toString();

        const record = parseAisStreamMessage(raw);
        if (record) {
            parsedCount++;
            db.enqueue(record);
        }
    });

    ws.on('error', (err: Error) => {
        console.error('[WS] Error:', err.message);
    });

    ws.on('close', (code: number, reason: Buffer) => {
        console.warn(`[WS] Disconnected (code=${code}, reason=${reason.toString()})`);
        ws = null;
        scheduleReconnect();
    });
}

function scheduleReconnect(): void {
    if (isShuttingDown || reconnectTimer) return;

    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, reconnectAttempts), BACKOFF_MAX_MS);
    reconnectAttempts++;

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

// ── Dead Man's Switch — stale connection detector ──

function checkStaleConnection(): void {
    if (isShuttingDown) return;

    const staleDuration = Date.now() - lastMessageAt;

    if (staleDuration > STALE_THRESHOLD_MS) {
        staleReconnects++;
        console.warn(
            `[DEADMAN] ⚠️ No AIS messages for ${Math.round(staleDuration / 1000)}s ` +
                `(threshold: ${STALE_THRESHOLD_MS / 1000}s). Forcing reconnect #${staleReconnects}...`,
        );

        // Kill the current connection and force reconnect
        if (ws) {
            try {
                ws.terminate();
            } catch {
                /* ignore */
            }
            ws = null;
        }

        // Clear any pending reconnect timer
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        reconnectAttempts = 0; // Reset backoff — this is a fresh attempt
        connect();
    }
}

// ── Health Check HTTP Server ──

const healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        const staleDuration = Date.now() - lastMessageAt;
        const isStale = staleDuration > STALE_THRESHOLD_MS;
        const uptimeS = Math.round((Date.now() - startedAt) / 1000);
        const dbStats = db.getStats();

        const body = JSON.stringify({
            status: isStale ? 'stale' : 'healthy',
            uptimeSeconds: uptimeS,
            lastMessageAgoMs: staleDuration,
            lastMessageAgoSeconds: Math.round(staleDuration / 1000),
            wsConnected: ws !== null && ws.readyState === WebSocket.OPEN,
            messageCount,
            parsedCount,
            upserted: dbStats.totalUpserts,
            errors: dbStats.totalErrors,
            staleReconnects,
            staleThresholdMs: STALE_THRESHOLD_MS,
        });

        res.writeHead(isStale ? 503 : 200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
        });
        res.end(body);
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// ── Stats logging ──

function logStats(): void {
    const dbStats = db.getStats();
    const staleSec = Math.round((Date.now() - lastMessageAt) / 1000);

    console.log(
        `[STATS] Messages: ${messageCount} | ` +
            `Parsed: ${parsedCount} | ` +
            `Buffered: ${dbStats.buffered} | ` +
            `Upserted: ${dbStats.totalUpserts} | ` +
            `Errors: ${dbStats.totalErrors} | ` +
            `Last msg: ${staleSec}s ago | ` +
            `Stale reconnects: ${staleReconnects}`,
    );
}

// ── Graceful shutdown ──

async function shutdown(signal: string): Promise<void> {
    console.log(`\n[SHUTDOWN] Received ${signal}. Cleaning up...`);
    isShuttingDown = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (ws) {
        ws.close();
        ws = null;
    }

    healthServer.close();
    await db.stop(); // Final flush

    console.log('[SHUTDOWN] Final DB flush complete. Goodbye!');
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ── Main ──

console.log('═══════════════════════════════════════════════');

console.log('  Thalassa AIS Ingestion Worker');

console.log('  AISStream.io → Supabase PostGIS');

console.log('═══════════════════════════════════════════════');

console.log(`  Bounding boxes: ${JSON.stringify(BOUNDING_BOXES)}`);

console.log(`  Flush interval: ${process.env.BATCH_FLUSH_MS || 2000}ms`);

console.log(`  Batch size: ${process.env.BATCH_MAX_SIZE || 50}`);

console.log(`  Health check: http://0.0.0.0:${HEALTH_PORT}/health`);

console.log(`  Stale threshold: ${STALE_THRESHOLD_MS / 1000}s`);

console.log('═══════════════════════════════════════════════');

db.start();
connect();
setInterval(logStats, STATS_INTERVAL_MS);
setInterval(checkStaleConnection, STALE_CHECK_INTERVAL_MS);

// ── Guardian Watchdog: BOLO + Geofence monitor ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (SUPABASE_URL && SUPABASE_KEY) {
    startWatchdog(SUPABASE_URL, SUPABASE_KEY);

    console.log('[GUARDIAN] Watchdog started — monitoring armed vessels + geofences');
} else {
    console.warn('[GUARDIAN] Watchdog disabled — missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[HEALTH] Listening on port ${HEALTH_PORT}`);
});
