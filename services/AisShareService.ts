/**
 * AisShareService — the punter crowd-feed's app half.
 *
 * When the skipper opts in, every valid-checksum AIS sentence the NMEA
 * gateway delivers (received `!AIVDM` broadcasts AND the boat's own `!AIVDO`
 * transponder reports) is batched and posted to the fleet-feed relay, which
 * decodes it into the shared vessels pond and forwards the raw sentences to
 * AISHub — authorized in writing (AISHub, 2026-03-18: "you may use this port
 * for all feeds"). One punter sailing anywhere = live AIS coverage there for
 * every user, plus contribution credit toward the AISHub aggregate key.
 *
 * Design constraints, each learned elsewhere in this repo:
 *  - offer() is O(1) into an in-memory ring: it sits on the NMEA hot path
 *    (10-30 sentences/s in a busy bay) and must never touch the Capacitor
 *    bridge, storage, or JSON. The buffer survives socket churn because it
 *    lives here, not in the connection.
 *  - LOSSY by design. This is telemetry, not safety data: a failed flush is
 *    dropped, never queued — the next 20 s brings fresher truth anyway.
 *    (anchorPiPush argues the opposite for anchor state; both are right.)
 *  - Consent is PER-DEVICE (localStorage), never cloud-synced: a synced flag
 *    would light up every signed-in device on the boat LAN and double-feed
 *    the same stream — the dual-source failure skipperDevice was built to
 *    kill. Default off, fresh key, no migration from the retired
 *    AisHubService opt-in ("it must never spring back to life without a
 *    fresh choice").
 *  - The endpoint comes from VITE_FLEET_FEED_URL at build time (this repo is
 *    public — no baked endpoints). Absent, the whole service is inert.
 *  - CapacitorHttp ignores AbortSignal on device (600 s native default), so
 *    the flush is bounded by withTimeout, the same fix anchorPiPush carries.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { createLogger } from '../utils/createLogger';
import { withTimeout } from '../utils/deadline';
import { getAuthenticatedFunctionHeaders } from './supabaseAuth';

const log = createLogger('AisShare');

const ENABLED_KEY = 'ais_share_enabled_v1';
/** ~20-30 s of a busy bay; older sentences roll off the front. */
const MAX_BUFFER = 2000;
const FLUSH_INTERVAL_MS = 20_000;
/** Don't bother the network for a trickle; flush early when the bay is loud. */
const MIN_FLUSH_SENTENCES = 5;
const MAX_FLUSH_SENTENCES = 600;
const FLUSH_DEADLINE_MS = 10_000;

function endpoint(): string {
    try {
        return (import.meta.env?.VITE_FLEET_FEED_URL as string | undefined)?.trim() || '';
    } catch {
        return '';
    }
}

interface ShareStats {
    buffered: number;
    sharedTotal: number;
    droppedTotal: number;
    lastFlushOk: boolean | null;
    lastFlushAt: number | null;
}

let buffer: string[] = [];
let enabled: boolean | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let sharedTotal = 0;
let droppedTotal = 0;
let lastFlushOk: boolean | null = null;
let lastFlushAt: number | null = null;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch {
            /* one bad listener must not silence the rest */
        }
    }
}

export function isShareConfigured(): boolean {
    return endpoint() !== '';
}

export function isShareEnabled(): boolean {
    if (enabled === null) {
        try {
            enabled = localStorage.getItem(ENABLED_KEY) === 'true';
        } catch {
            enabled = false;
        }
    }
    return enabled;
}

export function setShareEnabled(value: boolean): void {
    enabled = value;
    try {
        localStorage.setItem(ENABLED_KEY, value ? 'true' : 'false');
    } catch {
        /* consent still applies for this session */
    }
    if (value) {
        startTimer();
    } else {
        stopTimer();
        buffer = [];
    }
    notify();
}

export function getShareStats(): ShareStats {
    return { buffered: buffer.length, sharedTotal, droppedTotal, lastFlushOk, lastFlushAt };
}

export function subscribeShareStats(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Offer one raw AIS sentence to the share buffer. O(1), hot-path safe —
 * called for every gateway AIS sentence; a disabled or unconfigured share
 * costs one boolean check.
 */
export function offer(sentence: string): void {
    if (!isShareEnabled() || !isShareConfigured()) return;
    if (buffer.length >= MAX_BUFFER) {
        buffer.shift();
        droppedTotal++;
    }
    buffer.push(sentence);
    startTimer();
}

function startTimer(): void {
    if (flushTimer !== null) return;
    flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    // Drain before the webview is suspended — same trigger anchorPiPush uses.
    if (typeof document !== 'undefined' && !visibilityHooked) {
        visibilityHooked = true;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) void flush();
        });
    }
}

let visibilityHooked = false;

function stopTimer(): void {
    if (flushTimer !== null) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
}

async function flush(): Promise<void> {
    if (inFlight || !isShareEnabled()) return;
    if (buffer.length < MIN_FLUSH_SENTENCES) return;
    const url = endpoint();
    if (!url) return;

    const batch = buffer.slice(0, MAX_FLUSH_SENTENCES);
    buffer = buffer.slice(batch.length);
    inFlight = true;
    try {
        const headers = await getAuthenticatedFunctionHeaders();
        const body = batch.join('\n');
        const ok = await withTimeout(
            (async () => {
                if (Capacitor.isNativePlatform()) {
                    const res = await CapacitorHttp.post({
                        url,
                        headers: { ...headers, 'Content-Type': 'text/plain' },
                        data: body,
                        readTimeout: FLUSH_DEADLINE_MS,
                        connectTimeout: FLUSH_DEADLINE_MS,
                    });
                    return res.status >= 200 && res.status < 300;
                }
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'text/plain' },
                    body,
                    signal: AbortSignal.timeout(FLUSH_DEADLINE_MS),
                });
                return res.ok;
            })(),
            false,
            FLUSH_DEADLINE_MS + 2_000,
        );
        if (ok) {
            sharedTotal += batch.length;
            lastFlushOk = true;
        } else {
            // LOSSY: the batch is gone. Fresher sentences are already
            // accumulating; re-queueing stale telemetry helps nobody.
            droppedTotal += batch.length;
            lastFlushOk = false;
        }
    } catch (e) {
        droppedTotal += batch.length;
        lastFlushOk = false;
        // Signed out is the common, boring cause — one debug line, not a warn.
        log.debug('flush skipped:', e instanceof Error ? e.message : e);
    } finally {
        lastFlushAt = Date.now();
        inFlight = false;
        notify();
    }
}

/** Test seam. */
export function __resetAisShareForTest(): void {
    buffer = [];
    enabled = null;
    stopTimer();
    inFlight = false;
    sharedTotal = 0;
    droppedTotal = 0;
    lastFlushOk = null;
    lastFlushAt = null;
    listeners.clear();
}

/** Test seam — force a flush cycle. */
export function __flushForTest(): Promise<void> {
    return flush();
}
