/**
 * fleetFeed.ts — the punter crowd-feed endpoint.
 *
 * POST /fleet-feed: a signed-in Thalassa user's app (aboard, hearing AIS on
 * its NMEA gateway) sends a batch of raw !AIVDM/!AIVDO sentences. The worker
 * verifies the user, validates every sentence, decodes into the SAME
 * VesselDB as every other source, and forwards the raw sentences over UDP
 * to AISHub — authorized in writing (AISHub, 2026-03-18: "you may use this
 * port for all feeds. We already have some contributors who are sharing
 * aggregated data from multiple AIS stations").
 *
 * Trust posture: the URL is derivable from a public repo, so everything is
 * gated in cheap-rejection order — method, header shape, size, then the
 * (network-priced) token verification, then per-user quota, then per-
 * sentence validation. Fragments are assembled per-user (the aivdm source
 * dimension), so no two boats can cross-assemble a chimera vessel.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import dgram from 'node:dgram';
import { createClient } from '@supabase/supabase-js';
import { VesselDB } from './db.js';
import { aivdoToAivdm, decodeAisSentence, nmeaChecksumOk } from './aivdm.js';
import { MAX_AIS_MESSAGE_CHARS } from './parser.js';

/** One batch: ~20-30 s of a busy bay is 15-75 KB; 128 KB is generous. */
const MAX_BODY_BYTES = 128 * 1024;
const MAX_SENTENCES_PER_BATCH = 600;
const MAX_SENTENCE_CHARS = 120; // a real NMEA sentence tops out at 82
/** Per-user ration: one batch every ~15 s sustained. */
const QUOTA_BUCKET = 'fleet-feed';
const QUOTA_LIMIT = 300;
const QUOTA_WINDOW_S = 3600;
/** Verified tokens are cached briefly so the GoTrue round-trip is paid once
 *  per user per minute, not once per batch. Capped; never refreshed early. */
const TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_CACHE_MAX = 500;

const AUTH_HEADER = /^Bearer [^\s]+$/;

interface FleetFeedStats {
    batches: number;
    accepted: number;
    decoded: number;
    forwarded: number;
    rejectedAuth: number;
    rejectedQuota: number;
    rejectedBad: number;
}

const stats: FleetFeedStats = {
    batches: 0,
    accepted: 0,
    decoded: 0,
    forwarded: 0,
    rejectedAuth: 0,
    rejectedQuota: 0,
    rejectedBad: 0,
};

export function getFleetFeedStats(): FleetFeedStats {
    return { ...stats };
}

const tokenCache = new Map<string, { userId: string; at: number }>();

/** Test seam. */
export function __resetFleetFeedForTest(): void {
    tokenCache.clear();
    for (const key of Object.keys(stats) as (keyof FleetFeedStats)[]) stats[key] = 0;
}

export interface FleetFeedDeps {
    db: VesselDB;
    supabaseUrl: string;
    /** The PUBLISHABLE (anon) key — user tokens are verified against it. The
     *  service key must never be used here: consume_edge_quota keys on
     *  auth.uid(), which is null under the service role — every user would
     *  present as permanently rate-limited. */
    supabaseAnonKey: string;
    aishubHost?: string;
    aishubPort?: number;
    /** Injectable for tests. */
    createUserClient?: (authorization: string) => UserClientLike;
    udpSend?: (line: string) => void;
    now?: () => number;
}

export interface UserClientLike {
    auth: { getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown | null }> };
    rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown | null }>;
}

function defaultUserClient(deps: FleetFeedDeps, authorization: string): UserClientLike {
    return createClient(deps.supabaseUrl, deps.supabaseAnonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as UserClientLike;
}

let udp: dgram.Socket | null = null;
function defaultUdpSend(deps: FleetFeedDeps, line: string): void {
    if (!deps.aishubHost || !deps.aishubPort) return;
    udp ??= dgram.createSocket('udp4');
    udp.send(Buffer.from(line + '\r\n'), deps.aishubPort, deps.aishubHost, (err) => {
        if (!err) stats.forwarded++;
    });
}

function readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                resolve(null); // Content-Length can lie; count the stream
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => resolve(null));
    });
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * Handle POST /fleet-feed. Returns true when the request was handled.
 */
export async function handleFleetFeed(req: IncomingMessage, res: ServerResponse, deps: FleetFeedDeps): Promise<void> {
    const now = deps.now ?? Date.now;
    if (req.method !== 'POST') {
        json(res, 405, { error: 'POST only' });
        return;
    }
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !AUTH_HEADER.test(authorization)) {
        stats.rejectedAuth++;
        res.setHeader('WWW-Authenticate', 'Bearer');
        json(res, 401, { error: 'signed-in users only' });
        return;
    }
    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (declaredLength > MAX_BODY_BYTES) {
        stats.rejectedBad++;
        json(res, 413, { error: 'batch too large' });
        return;
    }

    // ── Verify the user (cached briefly per token) ──
    let userId: string | null = null;
    const cached = tokenCache.get(authorization);
    if (cached && now() - cached.at < TOKEN_CACHE_TTL_MS) {
        userId = cached.userId;
    }
    const makeClient = deps.createUserClient ?? ((a: string) => defaultUserClient(deps, a));
    const client = makeClient(authorization);
    if (!userId) {
        try {
            const { data, error } = await client.auth.getUser();
            if (error || !data.user) {
                stats.rejectedAuth++;
                json(res, 401, { error: 'invalid token' });
                return;
            }
            userId = data.user.id;
            if (tokenCache.size >= TOKEN_CACHE_MAX) {
                const oldest = tokenCache.keys().next().value;
                if (oldest !== undefined) tokenCache.delete(oldest);
            }
            tokenCache.set(authorization, { userId, at: now() });
        } catch {
            stats.rejectedAuth++;
            json(res, 401, { error: 'could not verify token' });
            return;
        }
    }

    // ── Per-user ration (on the USER client — auth.uid() must resolve) ──
    try {
        const { data: allowed, error } = await client.rpc('consume_edge_quota', {
            p_bucket: QUOTA_BUCKET,
            p_limit: QUOTA_LIMIT,
            p_window_seconds: QUOTA_WINDOW_S,
        });
        if (error || allowed !== true) {
            stats.rejectedQuota++;
            json(res, 429, { error: 'rationed — slow down' });
            return;
        }
    } catch {
        stats.rejectedQuota++;
        json(res, 429, { error: 'rationed — slow down' });
        return;
    }

    // ── Body: newline-separated raw sentences ──
    const body = await readBody(req);
    if (body === null) {
        stats.rejectedBad++;
        json(res, 413, { error: 'batch too large' });
        return;
    }
    stats.batches++;
    const lines = body.split('\n');
    let acceptedCount = 0;
    let decodedCount = 0;
    for (const rawLine of lines) {
        if (acceptedCount >= MAX_SENTENCES_PER_BATCH) break;
        const line = rawLine.trim();
        if (!line || line.length > MAX_SENTENCE_CHARS || line.length > MAX_AIS_MESSAGE_CHARS) continue;
        if (!line.startsWith('!AIVDM') && !line.startsWith('!AIVDO')) continue;
        if (!nmeaChecksumOk(line)) continue;
        acceptedCount++;
        // Fragments assemble per-user — no cross-boat chimeras.
        const record = decodeAisSentence(line, now(), userId);
        if (record) {
            decodedCount++;
            deps.db.enqueue(record);
        }
        // Forward raw to AISHub: received broadcasts as-is, own-ship AIVDO
        // rewritten as a receipt (fresh checksum).
        const send = deps.udpSend ?? ((l: string) => defaultUdpSend(deps, l));
        const out = line.startsWith('!AIVDO') ? aivdoToAivdm(line) : line;
        if (out) send(out);
    }
    stats.accepted += acceptedCount;
    stats.decoded += decodedCount;
    json(res, 200, { accepted: acceptedCount, decoded: decodedCount });
}
