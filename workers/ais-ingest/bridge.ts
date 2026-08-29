/**
 * bridge.ts — the yacht's own AIS receiver as a data source.
 *
 * Second entrypoint of this package (Railway runs dist/index.js; the pi5
 * runs dist/bridge.js — see workers/ais-bridge-README.md). Connects over
 * the tailnet to the boat's YDWG-02 NMEA gateway, decodes the `!AIVDM`
 * stream the transponder is already producing, and upserts through the SAME
 * VesselDB as the aisstream worker — identical change detection, batching
 * and merge semantics. Own-ship `!AIVDO` decodes too: that is precisely how
 * the owner's yacht lands in the shared table, heard by its own radio.
 *
 * Optional second lane: forward the raw sentences to AISHub (UDP NMEA,
 * AIVDO rewritten as AIVDM receipts) — feeding the aggregate that the
 * Railway worker will one day drink back.
 *
 * Design constraints learned elsewhere in this repo:
 *  - The boat being asleep is NORMAL, not an error: capped backoff forever,
 *    reconnect the moment the network returns, health stays HTTP 200
 *    'degraded-upstream' (the Railway lesson: a restart cannot conjure an
 *    upstream, so never invite the supervisor to shoot the process).
 *  - One socket at a time, ownership-checked handlers (the 01:15:34Z race).
 *  - A silent-but-open socket is detected by a dead-man timer, same as the
 *    app's NMEA listener had to learn for this exact gateway.
 */
import 'dotenv/config';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import { VesselDB } from './db.js';
import { aivdoToAivdm, decodeAisSentence } from './aivdm.js';

// ── Config ──
// Default to the Pi's own Signal K rebroadcast, NOT the gateway.
//
// The YDWG-02 has exactly THREE usable client slots: it accepts a fourth
// connection and then resets it on first read. On 2026-08-29 all three were
// held — Signal K, this bridge, and wind.py — so no phone aboard could get a
// fix at all, and a backbone power-cycle left Signal K on a half-open socket
// that reported ESTAB while delivering nothing for eight hours.
//
// Signal K holds the single gateway slot and rebroadcasts raw passthrough on
// 10110, which serves unlimited clients (8 concurrent verified, byte-identical).
// Defaulting here to the gateway meant a lost or unreadable .env would silently
// re-take a scarce slot; defaulting to the rebroadcast makes that failure show
// up as no data instead of as someone else's dropouts.
const YDWG_HOST = process.env.YDWG_HOST || '127.0.0.1';
const YDWG_PORT = parseInt(process.env.YDWG_PORT || '10110', 10);
const AISHUB_HOST = process.env.AISHUB_HOST;
const AISHUB_PORT = parseInt(process.env.AISHUB_PORT || '0', 10);
const HEALTH_PORT = parseInt(process.env.PORT || '3002', 10);
const STATS_INTERVAL_MS = 30_000;
/** No sentences for this long on an OPEN socket → assume half-dead, redial. */
const STALE_THRESHOLD_MS = parseInt(process.env.STALE_THRESHOLD_MS || '300000', 10);
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/** A single NMEA sentence tops out well under this; a longer "line" means a
 *  framing fault and must not grow the buffer unboundedly. */
const MAX_LINE_CHARS = 1024;

// ── State ──
const db = new VesselDB();
let socket: net.Socket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let isShuttingDown = false;
let sentenceCount = 0;
let decodedCount = 0;
let forwardedCount = 0;
let lastSentenceAt = 0;
let connectedSince = 0;
const startedAt = Date.now();

const aishubEnabled = Boolean(AISHUB_HOST && AISHUB_PORT > 0);
const udp = aishubEnabled ? dgram.createSocket('udp4') : null;

function forwardToAishub(sentence: string): void {
    if (!udp || !AISHUB_HOST) return;
    // AISHub expects station receipts: AIVDM as-is, own-ship AIVDO rewritten.
    const out = sentence.startsWith('!AIVDO') ? aivdoToAivdm(sentence) : sentence;
    if (!out) return;
    udp.send(Buffer.from(out + '\r\n'), AISHUB_PORT, AISHUB_HOST, (err) => {
        if (err) console.warn('[AISHUB] send failed:', err.message);
        else forwardedCount++;
    });
}

// ── YDWG connection ──

function connect(): void {
    if (isShuttingDown) return;
    console.log(`[YDWG] Connecting to ${YDWG_HOST}:${YDWG_PORT}...`);

    const sock = net.createConnection({ host: YDWG_HOST, port: YDWG_PORT, timeout: 15_000 });
    socket = sock;
    let lineBuffer = '';

    sock.on('connect', () => {
        if (socket !== sock) {
            sock.destroy();
            return;
        }
        console.log('[YDWG] Connected — listening for AIS sentences');
        reconnectAttempts = 0;
        connectedSince = Date.now();
        lastSentenceAt = Date.now();
        sock.setTimeout(0);
    });

    sock.on('timeout', () => {
        if (socket !== sock) return;
        console.warn('[YDWG] Connect timeout');
        sock.destroy(); // 'close' schedules the redial
    });

    sock.on('data', (chunk) => {
        if (socket !== sock) return;
        lineBuffer += chunk.toString('ascii');
        if (lineBuffer.length > MAX_LINE_CHARS * 8) {
            // Framing fault — resynchronise rather than grow forever.
            console.warn('[YDWG] Line buffer overflow — resynchronising');
            lineBuffer = '';
            return;
        }
        let idx: number;
        while ((idx = lineBuffer.indexOf('\n')) >= 0) {
            const line = lineBuffer.slice(0, idx).trim();
            lineBuffer = lineBuffer.slice(idx + 1);
            if (!line || line.length > MAX_LINE_CHARS) continue;
            if (!line.startsWith('!AIVDM') && !line.startsWith('!AIVDO')) continue;
            sentenceCount++;
            lastSentenceAt = Date.now();
            const record = decodeAisSentence(line);
            if (record) {
                decodedCount++;
                db.enqueue(record);
            }
            if (aishubEnabled) forwardToAishub(line);
        }
    });

    sock.on('error', (err) => {
        if (socket !== sock) return;
        // ECONNREFUSED/EHOSTUNREACH while the boat sleeps is routine — one
        // line, not a stack trace.
        console.warn('[YDWG] Socket error:', err.message);
    });

    sock.on('close', () => {
        if (socket !== sock) return; // superseded socket's death is not news
        socket = null;
        connectedSince = 0;
        scheduleReconnect();
    });
}

function scheduleReconnect(): void {
    if (isShuttingDown || reconnectTimer) return;
    const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, reconnectAttempts), BACKOFF_MAX_MS);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    reconnectAttempts++;
    if (reconnectAttempts <= 3 || reconnectAttempts % 30 === 0) {
        // The boat asleep for a weekend is ~2900 attempts; log the first few
        // and then one line every half hour, not a scroll of failure.
        console.log(`[YDWG] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})...`);
    }
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

/** Open-but-silent detection: the YDWG can hold a socket while the bus side
 *  is quiet or the slot is contended. No sentences for the threshold → redial. */
function checkStale(): void {
    if (isShuttingDown || !socket || connectedSince === 0) return;
    const silentMs = Date.now() - lastSentenceAt;
    if (silentMs > STALE_THRESHOLD_MS) {
        console.warn(`[DEADMAN] No sentences for ${Math.round(silentMs / 1000)}s — redialling`);
        const old = socket;
        socket = null; // release ownership BEFORE destroy: no double dial
        connectedSince = 0;
        try {
            old.destroy();
        } catch {
            /* ignore */
        }
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        reconnectAttempts = 0;
        connect();
    }
}

// ── Health ──

const healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        const dbStats = db.getStats();
        const dbWedged = dbStats.consecutiveErrorFlushes >= 5;
        const connected = socket !== null && connectedSince > 0;
        const silentMs = connected ? Date.now() - lastSentenceAt : null;
        res.writeHead(dbWedged ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(
            JSON.stringify({
                status: dbWedged ? 'db-wedged' : connected ? 'healthy' : 'degraded-upstream',
                uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
                connected,
                silentMs,
                sentenceCount,
                decodedCount,
                forwardedCount,
                aishubEnabled,
                upserted: dbStats.totalUpserts,
                skipped: dbStats.totalSkipped,
                errors: dbStats.totalErrors,
                consecutiveErrorFlushes: dbStats.consecutiveErrorFlushes,
            }),
        );
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// ── Stats ──

function logStats(): void {
    const dbStats = db.getStats();
    const state = socket && connectedSince > 0 ? 'connected' : 'waiting-for-boat';
    console.log(
        `[STATS] ${state} | Sentences: ${sentenceCount} | Decoded: ${decodedCount} | ` +
            `Upserted: ${dbStats.totalUpserts} | Skipped-unchanged: ${dbStats.totalSkipped} | ` +
            `Errors: ${dbStats.totalErrors} | AISHub fwd: ${aishubEnabled ? forwardedCount : 'off'}`,
    );
}

// ── Lifecycle ──

async function shutdown(signal: string): Promise<void> {
    console.log(`\n[SHUTDOWN] ${signal} — flushing...`);
    isShuttingDown = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const old = socket;
    socket = null;
    old?.destroy();
    udp?.close();
    healthServer.close();
    await db.stop();
    console.log('[SHUTDOWN] Done.');
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[WARN] Unhandled rejection:', reason);
});

console.log('═══════════════════════════════════════════════');
console.log('  Thalassa AIS Boat Bridge');
console.log('  YDWG-02 → Supabase PostGIS' + (aishubEnabled ? ' + AISHub' : ''));
console.log('═══════════════════════════════════════════════');
console.log(`  Gateway: ${YDWG_HOST}:${YDWG_PORT}`);
console.log(`  AISHub forward: ${aishubEnabled ? `${AISHUB_HOST}:${AISHUB_PORT}` : 'off (set AISHUB_HOST/PORT)'}`);
console.log(`  Health: http://0.0.0.0:${HEALTH_PORT}/health`);
console.log('═══════════════════════════════════════════════');

db.start();
connect();
setInterval(logStats, STATS_INTERVAL_MS);
setInterval(checkStale, 60_000);
healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[HEALTH] Listening on port ${HEALTH_PORT}`);
});
