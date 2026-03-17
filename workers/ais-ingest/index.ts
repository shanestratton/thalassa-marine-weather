/**
 * AIS Ingestion Worker — AISStream.io → Supabase PostGIS
 *
 * Maintains a persistent WebSocket to AISStream.io, parses
 * PositionReport + ShipStaticData messages, and batch-upserts
 * vessel positions into the Supabase `vessels` table.
 *
 * Usage:
 *   cp .env.example .env  # fill in your keys
 *   npm install
 *   npm start
 */
import 'dotenv/config';
import WebSocket from 'ws';
import { parseAisStreamMessage } from './parser.js';
import { VesselDB } from './db.js';

// ── Config ──
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const API_KEY = process.env.AISSTREAM_KEY;
const BOUNDING_BOXES = JSON.parse(process.env.BOUNDING_BOXES || '[[[-26.5,152.5],[-27.8,153.8]]]');

// Reconnect backoff
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

// Stats logging interval
const STATS_INTERVAL_MS = 30_000;

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
            FilterMessageTypes: [
                'PositionReport',
                'ShipStaticData',
                'StandardClassBPositionReport',
            ],
        };

        ws!.send(JSON.stringify(subscription));
        console.log('[WS] Subscription sent. Listening for AIS messages...');
    });

    ws.on('message', (data: WebSocket.Data) => {
        messageCount++;
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

// ── Stats logging ──

function logStats(): void {
    const dbStats = db.getStats();
    console.log(
        `[STATS] Messages: ${messageCount} | ` +
        `Parsed: ${parsedCount} | ` +
        `Buffered: ${dbStats.buffered} | ` +
        `Upserted: ${dbStats.totalUpserts} | ` +
        `Errors: ${dbStats.totalErrors}`
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
console.log('═══════════════════════════════════════════════');

db.start();
connect();
setInterval(logStats, STATS_INTERVAL_MS);
