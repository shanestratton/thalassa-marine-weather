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
import { getAishubStats, startAishubPoller } from './aishub.js';
import { fleetFeedCorsHeaders, getFleetFeedStats, handleFleetFeed, setFleetFeedCors } from './fleetFeed.js';

// ── Config ──
const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const API_KEY = process.env.AISSTREAM_KEY;
/**
 * WHERE TO LISTEN.
 *
 * The default used to be the whole planet — [[-90,-180],[90,180]] — which is
 * every AIS-equipped vessel on Earth, tens of thousands of ships, each
 * rewritten to a Micro's disk on every flush. That is where 34,661,184 rows
 * and ~1.8 TB of writes came from (measured 2026-08-18). The app never asks
 * for vessels more than 100 NM from the boat (vessels-nearby caps radius at
 * 100), so ingesting the Pacific is pure cost.
 *
 * Default is now the Australian east coast and Coral Sea — Torres Strait to
 * Bass Strait, out past the reef and Lord Howe. Wide enough for any passage
 * Thalassa's users are on, and a tiny fraction of the globe. Override with
 * BOUNDING_BOXES for a different cruising ground; a deliberately global
 * subscription still works, it is just no longer what you get by accident.
 * Format is [[[latMin,lonMin],[latMax,lonMax]], ...] as aisstream expects.
 */
const DEFAULT_BOUNDING_BOXES = '[[[-44,140],[-9,162]]]';
const BOUNDING_BOXES = JSON.parse(process.env.BOUNDING_BOXES || DEFAULT_BOUNDING_BOXES);

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

    // Every handler closes over ITS socket and checks it is still the
    // current one. Without this, the dead-man's terminate raced the dying
    // socket's close event: both paths dialled, two sockets ran at once, and
    // a superseded socket's open-handler read `ws` as null (the exact
    // "Cannot read properties of null (reading 'send')" caught in the
    // 2026-08-21 01:15:34Z Railway log — an outright crash on builds before
    // the send guard). A superseded socket now stands down silently.
    const socket = new WebSocket(AISSTREAM_URL, {
        // A normal decoded AIS envelope is only a few kilobytes. Bounding the
        // frame at the socket prevents an upstream/proxy fault from allocating
        // an arbitrarily large Buffer before the parser can reject it.
        maxPayload: MAX_AIS_MESSAGE_CHARS,
    });
    ws = socket;

    socket.on('open', () => {
        if (ws !== socket) {
            // Superseded while the dial was in flight — close quietly; the
            // current socket owns the stream now.
            try {
                socket.terminate();
            } catch {
                /* ignore */
            }
            return;
        }
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
            // StaticDataReport (msg 24) is where Class B vessels — yachts —
            // send their names; without it the table fills with nameless
            // positions no name-search can find.
            FilterMessageTypes: [
                'PositionReport',
                'ShipStaticData',
                'StandardClassBPositionReport',
                'StaticDataReport',
            ],
        };

        try {
            socket.send(JSON.stringify(subscription));
        } catch (e) {
            console.error('[WS] Subscription send failed:', e);
            return; // close handler will schedule the reconnect
        }

        console.log('[WS] Subscription sent. Listening for AIS messages...');
    });

    socket.on('message', (data: WebSocket.Data) => {
        if (ws !== socket) return; // superseded — not this stream's frames
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

    socket.on('error', (err: Error) => {
        console.error('[WS] Error:', err.message);
    });

    socket.on('close', (code: number, reason: Buffer) => {
        if (ws !== socket) return; // a superseded socket's death is not news
        console.warn(`[WS] Disconnected (code=${code}, reason=${reason.toString()})`);
        ws = null;
        scheduleReconnect();
    });
}

function scheduleReconnect(): void {
    if (isShuttingDown || reconnectTimer) return;

    const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, reconnectAttempts), BACKOFF_MAX_MS);
    // ±25% jitter: identical containers restarting together must not hammer
    // the upstream in lockstep.
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
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

        // Kill the current connection and force reconnect. Ownership is
        // released FIRST so the dying socket's close event sees itself
        // superseded and stands down instead of scheduling a second dial.
        const old = ws;
        ws = null;
        if (old) {
            try {
                old.terminate();
            } catch {
                /* ignore */
            }
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

const FLEET_FEED_ANON_KEY = process.env.SUPABASE_ANON_KEY;

/** The roaming-station leg. Punters are mobile by definition, so the crowd
 *  feed goes to the ROAMING port — the fixed shore station keeps its own ID,
 *  and mixing the two would blend a moving feed and a fixed one into one
 *  station's position and uptime stats (Shane, 2026-08-23). */
const AISHUB_FORWARD_HOST = process.env.AISHUB_HOST;
const AISHUB_FORWARD_PORT = parseInt(process.env.AISHUB_PORT || '0', 10) || undefined;

const healthServer = http.createServer((req, res) => {
    // ── Punter crowd-feed (authorized: AISHub 2026-03-18, port for all
    // feeds). Requires SUPABASE_ANON_KEY for user-token verification —
    // absent, the endpoint answers 503 and the rest of the worker is
    // unaffected. AISHub forward reuses the same env pair as the bridge.
    if (req.url === '/fleet-feed') {
        // The preflight carries no Authorization and no config expectations,
        // so it is answered before every other check.
        const cors = fleetFeedCorsHeaders(req.headers.origin, process.env.FLEET_FEED_ORIGINS);
        setFleetFeedCors(cors);
        if (req.method === 'OPTIONS') {
            res.writeHead(204, cors);
            res.end();
            return;
        }
        if (!SUPABASE_URL || !FLEET_FEED_ANON_KEY) {
            res.writeHead(503, { 'Content-Type': 'application/json', ...cors });
            res.end(JSON.stringify({ error: 'fleet feed not configured' }));
            return;
        }
        // ASSERT THE AISHUB LEG RATHER THAN DROP IT SILENTLY.
        // defaultUdpSend returns early when host/port are unset, so an
        // unconfigured forward previously produced an identical 200, identical
        // credit, and an identical "sharing live" card — while we told the
        // skipper their own boat's position had gone to a public network and
        // the socket was never created. Misrepresenting where someone's
        // position went is a worse class of wrong than a broken feature, so
        // the endpoint refuses work it cannot honour.
        if (!AISHUB_FORWARD_HOST || !AISHUB_FORWARD_PORT) {
            res.writeHead(503, { 'Content-Type': 'application/json', ...cors });
            res.end(JSON.stringify({ error: 'ais forward not configured' }));
            return;
        }
        void handleFleetFeed(req, res, {
            db,
            supabaseUrl: SUPABASE_URL,
            supabaseAnonKey: FLEET_FEED_ANON_KEY,
            aishubHost: AISHUB_FORWARD_HOST,
            aishubPort: AISHUB_FORWARD_PORT,
        }).catch((e) => {
            console.error('[FLEET] handler error:', e);
            try {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'internal' }));
            } catch {
                /* headers already sent */
            }
        });
        return;
    }
    if (req.url === '/health' || req.url === '/') {
        const staleDuration = Date.now() - lastMessageAt;
        const isStale = staleDuration > STALE_THRESHOLD_MS;
        const uptimeS = Math.round((Date.now() - startedAt) / 1000);
        const dbStats = db.getStats();

        const dbWedged = dbStats.consecutiveErrorFlushes >= 5;

        const body = JSON.stringify({
            // 'degraded-upstream' is a 200: the process is fine, aisstream is
            // quiet, and the internal dead-man switch is already reconnecting.
            // The old behaviour returned 503 here — and Railway's healthcheck
            // read that as a dead container and RESTARTED it, so every
            // upstream data drought turned into a visible crash loop (Shane,
            // 2026-08-21: "the railway worker crashes quite a bit"). A
            // restart cannot conjure frames aisstream is not sending; it only
            // discards the change-detection memory and re-learns it as a
            // burst of redundant writes. 503 is reserved for the one thing a
            // restart CAN fix: a wedged process (five consecutive DB flush
            // failures — auth rotated or client wedged — with recovery on
            // any success).
            status: dbWedged ? 'db-wedged' : isStale ? 'degraded-upstream' : 'healthy',
            uptimeSeconds: uptimeS,
            lastMessageAgoMs: staleDuration,
            lastMessageAgoSeconds: Math.round(staleDuration / 1000),
            wsConnected: ws !== null && ws.readyState === WebSocket.OPEN,
            messageCount,
            parsedCount,
            upserted: dbStats.totalUpserts,
            errors: dbStats.totalErrors,
            consecutiveErrorFlushes: dbStats.consecutiveErrorFlushes,
            staleReconnects,
            staleThresholdMs: STALE_THRESHOLD_MS,
            guardianWatchdogEnabled: guardianWatchdogStarted,
            aishub: getAishubStats(),
            fleetFeed: getFleetFeedStats(),
            // Ops alarm, not a user metric: if this reads false the crowd feed
            // is refusing every batch, and the cause is env rather than code.
            fleetFeedForwardConfigured: Boolean(AISHUB_FORWARD_HOST && AISHUB_FORWARD_PORT),
            fleetFeedAuthConfigured: Boolean(SUPABASE_URL && FLEET_FEED_ANON_KEY),
        });

        res.writeHead(dbWedged ? 503 : 200, {
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
            `Upserted: ${dbStats.totalUpserts} | Skipped-unchanged: ${dbStats.totalSkipped} | ` +
            `Errors: ${dbStats.totalErrors} | ` +
            `Last msg: ${staleSec}s ago | ` +
            `Stale reconnects: ${staleReconnects}` +
            (getAishubStats().enabled
                ? ` | AISHub: ${getAishubStats().lastAccepted}/${getAishubStats().lastRecords} rows, ${getAishubStats().pollErrors} errs`
                : ''),
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

// A worker that dies silently teaches nothing. An uncaught synchronous throw
// is unrecoverable — log it and exit non-zero so Railway's ON_FAILURE policy
// restarts a clean process. A rejected promise nobody awaited is logged and
// survived: the flush loop and socket lifecycle are all try/caught, so these
// are stragglers, not the main line — but a STORM of them means something is
// structurally wrong, and restarting is honest.
let recentRejections = 0;
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    recentRejections++;
    console.error(`[WARN] Unhandled rejection (${recentRejections} in the last minute):`, reason);
    if (recentRejections >= 10) {
        console.error('[FATAL] Rejection storm — restarting clean.');
        process.exit(1);
    }
});
setInterval(() => {
    recentRejections = 0;
}, 60_000).unref();

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

// ── AISHub aggregate feed (earned by feeding a station) ──
// Gated on the API key: absent, the worker behaves exactly as before. With
// it, the aggregate — every contributing station's coverage — fills the same
// VesselDB at AISHub's rationed one-poll-per-minute cadence. Bounds reuse
// the first configured bounding box so the two sources watch the same water.
const AISHUB_API_KEY = process.env.AISHUB_API_KEY;
if (AISHUB_API_KEY) {
    const box = (BOUNDING_BOXES as number[][][])[0];
    if (Array.isArray(box) && box.length === 2) {
        startAishubPoller(db, {
            apiKey: AISHUB_API_KEY,
            bounds: { latMin: box[0][0], lonMin: box[0][1], latMax: box[1][0], lonMax: box[1][1] },
        });
    } else {
        console.error('[AISHUB] Cannot derive bounds from BOUNDING_BOXES — poller not started');
    }
} else {
    console.log('[AISHUB] Aggregate feed off — set AISHUB_API_KEY when the station earns its key');
}
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
