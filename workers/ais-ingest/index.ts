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
import { MAX_AIS_MESSAGE_CHARS, parseAisStreamMessage } from './parser.js';
import { VesselDB } from './db.js';
import { isGuardianWatchdogEnabled, startWatchdog } from './watchdog.js';

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
const GUARDIAN_WATCHDOG_ENABLED = isGuardianWatchdogEnabled(process.env.GUARDIAN_WATCHDOG_ENABLED);

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
let guardianWatchdogStarted = false;
/** Frames received but not parseable as AIS — logged, bounded, so a rejected
 *  subscription explains itself instead of vanishing. Reset on reconnect so a
 *  fresh session gets a fresh look at what the server is saying. */
let unparsedLogged = 0;
const MAX_UNPARSED_LOGS = 3;
/** Reconnects with zero frames EVER before the switch stops blaming the
 *  connection and names the account. Three is ~15 minutes — long enough to
 *  rule out a slow start, short enough to beat a human to the conclusion. */
const STALE_RECONNECTS_BEFORE_VERDICT = 3;

// Dead man's switch state
let lastMessageAt = Date.now();
let staleReconnects = 0;
const startedAt = Date.now();

// ── WebSocket lifecycle ──

function connect(): void {
    if (isShuttingDown) return;

    console.log(`[WS] Connecting to AISStream.io...`);

    console.log(`[WS] Bounding boxes: ${JSON.stringify(BOUNDING_BOXES)}`);

    ws = new WebSocket(AISSTREAM_URL, {
        // A normal decoded AIS envelope is only a few kilobytes. Bounding the
        // frame at the socket prevents an upstream/proxy fault from allocating
        // an arbitrarily large Buffer before the parser can reject it.
        maxPayload: MAX_AIS_MESSAGE_CHARS,
    });

    ws.on('open', () => {
        console.log('[WS] Connected! Sending subscription...');
        reconnectAttempts = 0;
        unparsedLogged = 0;

        // Must send subscription within 3 seconds.
        //
        // The field is APIKey — capital A, P, I, K — exactly as aisstream.io
        // documents it. This said `Apikey` until 2026-08-12. That spelling
        // may well have worked (Go's encoding/json matches struct fields
        // case-insensitively, and this worker did ingest for months), but
        // when the stream goes silent you want zero variables between you
        // and the documented contract.
        const subscription = {
            APIKey: API_KEY,
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
            return;
        }

        // SAY WHAT WE THREW AWAY. An unparseable frame used to vanish here,
        // which is how a silent stream stayed undiagnosable: aisstream.io
        // reports a rejected subscription or a bad key as an ordinary text
        // frame, so its explanation was counted by messageCount and then
        // dropped on the floor. Bounded to the first few so a genuine parser
        // gap cannot flood the log.
        if (unparsedLogged < MAX_UNPARSED_LOGS) {
            unparsedLogged++;
            // Never echo the key back into the log, whatever the server said.
            const safe = API_KEY ? raw.split(API_KEY).join('***REDACTED***') : raw;
            console.warn(`[WS] Unparsed frame ${unparsedLogged}/${MAX_UNPARSED_LOGS}: ${safe.slice(0, 400)}`);
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

        // Reconnecting cannot fix a subscription that is being accepted and
        // starved, and this switch will otherwise loop on it forever, once
        // every five minutes, saying nothing more useful each time. If we
        // have NEVER received a single frame across several reconnects, the
        // socket is not the problem — say so, once, in terms that name the
        // next place to look.
        //
        // Measured 2026-08-12, worldwide bounding box: a bogus key is
        // DISCONNECTED (ws close 1006); a key whose account is not serving
        // is kept OPEN and silent. That is the shape this detects. See
        // probe.mjs, which tests the key on its own.
        if (messageCount === 0 && staleReconnects === STALE_RECONNECTS_BEFORE_VERDICT) {
            console.error(
                `[DEADMAN] ❌ ${staleReconnects} reconnects and NOT ONE frame ever received. ` +
                    `The socket keeps opening, so this is not a network or DNS fault, and an ` +
                    `outright bad key would be disconnected rather than held open. aisstream.io ` +
                    `is accepting the subscription and sending nothing — check the ACCOUNT ` +
                    `(quota, tier, suspension), not the key string. Run probe.mjs to confirm ` +
                    `independently of this worker.`,
            );
        }

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
            guardianWatchdogEnabled: guardianWatchdogStarted,
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

console.log(`  Guardian watchdog: ${GUARDIAN_WATCHDOG_ENABLED ? 'enabled' : 'held (default off)'}`);

console.log('═══════════════════════════════════════════════');

db.start();
connect();
setInterval(logStats, STATS_INTERVAL_MS);
setInterval(checkStaleConnection, STALE_CHECK_INTERVAL_MS);

// ── Guardian Watchdog: BOLO + Geofence monitor ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!GUARDIAN_WATCHDOG_ENABLED) {
    console.warn('[GUARDIAN] Watchdog held — GUARDIAN_WATCHDOG_ENABLED must be exactly "true" to opt in');
} else if (SUPABASE_URL && SUPABASE_KEY) {
    startWatchdog(SUPABASE_URL, SUPABASE_KEY);
    guardianWatchdogStarted = true;

    console.log('[GUARDIAN] Watchdog started — monitoring armed vessels + geofences');
} else {
    console.error('[GUARDIAN] Watchdog requested but disabled — missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[HEALTH] Listening on port ${HEALTH_PORT}`);
});
