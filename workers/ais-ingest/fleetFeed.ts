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

/** Re-emit an !AIVDM sentence from its pre-star body with a fresh checksum —
 *  drops anything after the original checksum by construction. */
function rebuildAivdm(sentence: string): string | null {
    const star = sentence.lastIndexOf('*');
    if (star < 1) return null;
    const body = sentence.slice(1, star);
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
    return `!${body}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
}

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
    /** Per-sentence rejection reasons. Every one of these used to be a bare
     *  `continue`, so a gateway emitting nothing but garbage produced exactly
     *  the same 200 and the same green "sharing live" card as a perfect one.
     *  A skipper cannot fix a fault nobody reports; these are what turn
     *  "sharing isn't working" into "your multiplexer is mangling fragments"
     *  or "that looks like a baud-rate fault". Diagnostics only — nothing here
     *  may ever feed a credit, standing or access decision. */
    rejectedTooLong: number;
    rejectedNotAis: number;
    rejectedChecksum: number;
    /** Watch check-ins seen, credited, and failed. A check-in with an EMPTY
     *  body is the empty-bay punter and is the entire point of the mechanism —
     *  `watchCheckins` climbing while `accepted` stays flat is a healthy
     *  ocean, not a broken feed. */
    watchCheckins: number;
    watchCredited: number;
    watchErrors: number;
}

const stats: FleetFeedStats = {
    batches: 0,
    accepted: 0,
    decoded: 0,
    forwarded: 0,
    rejectedAuth: 0,
    rejectedQuota: 0,
    rejectedBad: 0,
    rejectedTooLong: 0,
    rejectedNotAis: 0,
    rejectedChecksum: 0,
    watchCheckins: 0,
    watchCredited: 0,
    watchErrors: 0,
};

export function getFleetFeedStats(): FleetFeedStats {
    return { ...stats };
}

const tokenCache = new Map<string, { userId: string; at: number }>();
/** Invalid tokens are remembered briefly too, so spraying random bearers
 *  can't force one GoTrue round-trip per request (auth-backend amplification,
 *  review 2026-08-21). Short TTL: a token that becomes valid later re-checks. */
const badTokenCache = new Map<string, number>();
const BAD_TOKEN_TTL_MS = 30_000;

/** Test seam. */
export function __resetFleetFeedForTest(): void {
    tokenCache.clear();
    badTokenCache.clear();
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

/**
 * CORS for the web build, which posts here cross-origin from a different
 * host to the Railway worker.
 *
 * A preflight is unavoidable: `text/plain` is CORS-safelisted, but the
 * `Authorization` bearer and the `X-Thalassa-*` watch envelope are not, so
 * the browser always OPTIONS first — and an OPTIONS carries no credentials,
 * which is why it must be answered before any auth or config check.
 *
 * Wide-open by default is the right call HERE, and only because the security
 * boundary is the Supabase user JWT rather than the origin: there is no
 * cookie, so a third-party page cannot obtain a token to spend, and every
 * accepted request is quota'd per user. Set FLEET_FEED_ORIGINS (comma
 * separated) to narrow it anyway if a domain is ever worth pinning.
 */
export function fleetFeedCorsHeaders(origin: string | undefined, allowList: string | undefined): Record<string, string> {
    const allowed = (allowList ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    let allowOrigin = '*';
    if (allowed.length > 0) {
        // Reflect only a known origin; otherwise name the first as the answer
        // so the browser blocks it explicitly rather than ambiguously.
        allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
    }
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers':
            'authorization, content-type, x-thalassa-watch, x-thalassa-connected, x-thalassa-link, ' +
            'x-thalassa-link-err, x-thalassa-reconnects, x-thalassa-heard, x-thalassa-rig, ' +
            'x-thalassa-consent, x-thalassa-revoke, x-thalassa-client',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };
}

let corsHeadersForResponses: Record<string, string> = fleetFeedCorsHeaders(undefined, undefined);

/** Called per request so responses carry the same CORS answer the preflight
 *  gave — a mismatch is a silent browser-side failure with a healthy server. */
export function setFleetFeedCors(headers: Record<string, string>): void {
    corsHeadersForResponses = headers;
}

/** One check-in's self-report. Every field is a CLAIM: record_ais_watch
 *  bounds connected seconds against wall clock, so an inflated claim buys
 *  nothing. Nothing here is trusted enough to need proving. */
export interface WatchEnvelope {
    connectedS: number;
    sentences: number;
    link: string | null;
    linkError: string | null;
    reconnects: number;
    rig: string | null;
    offlineMin: number;
    consentVersion: string | null;
    revoke: boolean;
}

function headerInt(req: IncomingMessage, name: string, max: number): number {
    const raw = req.headers[name];
    const n = Number(Array.isArray(raw) ? raw[0] : (raw ?? 0));
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), max);
}

function headerText(req: IncomingMessage, name: string, max = 200): string | null {
    const raw = req.headers[name];
    const v = Array.isArray(raw) ? raw[0] : raw;
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/**
 * Read the watch envelope. It rides in HEADERS rather than the request body
 * for a specific reason: the sentence loop drops any line not starting
 * `!AIVDM`/`!AIVDO`, so a JSON body would be silently binned by this very
 * server — and headers leave the text/plain payload byte-identical, which
 * keeps the strict checksum gate in aivdm.ts untouched. That gate is the only
 * thing standing between a smuggled second NMEA line and AISHub under our
 * station key, so nothing gets to reshape the payload for convenience.
 */
export function readWatchEnvelope(req: IncomingMessage): WatchEnvelope | null {
    if (headerText(req, 'x-thalassa-watch') === null) return null;
    const link = headerText(req, 'x-thalassa-link', 20);
    return {
        // One hour, matching the RPC's own hard cap.
        connectedS: headerInt(req, 'x-thalassa-connected', 3600),
        sentences: headerInt(req, 'x-thalassa-heard', 1_000_000),
        link: link && ['connected', 'reconnecting', 'down'].includes(link) ? link : null,
        linkError: headerText(req, 'x-thalassa-link-err', 200),
        reconnects: headerInt(req, 'x-thalassa-reconnects', 10_000_000),
        rig: headerText(req, 'x-thalassa-rig', 20),
        offlineMin: headerInt(req, 'x-thalassa-offline-min', 1_000_000),
        consentVersion: headerText(req, 'x-thalassa-consent', 40),
        revoke: headerText(req, 'x-thalassa-revoke') !== null,
    };
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeadersForResponses });
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

    // ── Verify the user (cached briefly per token, good AND bad) ──
    const bad = badTokenCache.get(authorization);
    if (bad !== undefined && now() - bad < BAD_TOKEN_TTL_MS) {
        stats.rejectedAuth++;
        json(res, 401, { error: 'invalid token' });
        return;
    }
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
                if (badTokenCache.size >= TOKEN_CACHE_MAX) {
                    const oldest = badTokenCache.keys().next().value;
                    if (oldest !== undefined) badTokenCache.delete(oldest);
                }
                badTokenCache.set(authorization, now());
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
    let tooLong = 0;
    let notAis = 0;
    let badChecksum = 0;
    for (const rawLine of lines) {
        if (acceptedCount >= MAX_SENTENCES_PER_BATCH) break;
        const line = rawLine.trim();
        if (!line) continue;
        if (line.length > MAX_SENTENCE_CHARS || line.length > MAX_AIS_MESSAGE_CHARS) {
            tooLong++;
            continue;
        }
        if (!line.startsWith('!AIVDM') && !line.startsWith('!AIVDO')) {
            notAis++;
            continue;
        }
        if (!nmeaChecksumOk(line)) {
            badChecksum++;
            continue;
        }
        acceptedCount++;
        // Fragments assemble per-user — no cross-boat chimeras.
        const record = decodeAisSentence(line, now(), userId);
        if (record) {
            decodedCount++;
            deps.db.enqueue(record);
        }
        // Forward to AISHub. Own-ship AIVDO becomes a receipt; AIVDM is
        // REBUILT from the pre-star body with a fresh checksum rather than
        // forwarded verbatim — belt and braces against any trailing-byte
        // smuggling even past the strict checksum gate.
        const send = deps.udpSend ?? ((l: string) => defaultUdpSend(deps, l));
        const out = line.startsWith('!AIVDO') ? aivdoToAivdm(line) : rebuildAivdm(line);
        if (out) send(out);
    }
    stats.accepted += acceptedCount;
    stats.decoded += decodedCount;
    stats.rejectedTooLong += tooLong;
    stats.rejectedNotAis += notAis;
    stats.rejectedChecksum += badChecksum;

    // ── Credit the watch (INVARIANT 4: this must never break the feed) ──
    // The sentences are already banked above; crediting is bookkeeping that
    // happens afterwards on the SAME authenticated user client, because
    // record_ais_watch keys on auth.uid() and would see null under the
    // service role. Any failure is logged and swallowed: a ledger outage must
    // not cost a skipper their contribution.
    let standing: unknown = null;
    const watch = readWatchEnvelope(req);
    if (watch) {
        stats.watchCheckins++;
        try {
            const { data, error } = await client.rpc('record_ais_watch', {
                p_connected_s: watch.connectedS,
                p_sentences: watch.sentences,
                p_link: watch.link,
                p_link_error: watch.linkError,
                p_reconnects: watch.reconnects,
                p_rig: watch.rig,
                p_health: null,
                p_heard: decodedCount > 0,
                p_offline_min: watch.offlineMin,
                p_consent_version: watch.consentVersion,
                p_revoke: watch.revoke,
            });
            if (error) {
                stats.watchErrors++;
                console.error('[FLEET] watch credit failed:', error);
            } else {
                stats.watchCredited++;
                standing = data;
            }
        } catch (e) {
            stats.watchErrors++;
            console.error('[FLEET] watch credit threw:', e);
        }
    }
    // Echoed per-batch so the app can say WHICH fault it is. The client reads
    // this; today it discards the body and shows five stats that die on every
    // app launch.
    json(res, 200, {
        accepted: acceptedCount,
        decoded: decodedCount,
        rejected: { tooLong, notAis, checksum: badChecksum },
        // Echoed so the card can survive an app relaunch — today the client
        // discards this body and every stat it shows dies on launch.
        ...(standing !== null ? { watch: standing } : {}),
    });
}
