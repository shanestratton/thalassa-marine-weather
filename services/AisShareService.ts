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
import { authScopedStorageKey } from './authIdentityScope';

const log = createLogger('AisShare');

/**
 * AUTH-SCOPED as of 2026-08-23. It used to be a bare, unscoped boolean — the
 * only sensitive local flag in the repo that wasn't — so a mate signing into
 * their own account on the boat tablet inherited the owner's opt-in and began
 * publishing the owner's boat under an account that had never seen the
 * disclaimer. Consent stays PER-DEVICE (a cloud-synced flag would light up
 * every device aboard and double-feed the same LAN stream), but it is now
 * per-identity as well. Scoping changes the key, so existing opt-ins lapse and
 * are re-asked under the current disclaimer — which is the correct outcome,
 * not a migration to work around.
 */
const ENABLED_KEY = 'ais_share_enabled_v1';
const LOW_DATA_KEY = 'ais_share_lowdata_v1';
const CARD_KEY = 'ais_share_card_v1';

/** Bump when the disclaimer's substance changes, which re-asks for consent.
 *  Recorded server-side per check-in so we know what each punter agreed to. */
export const AIS_SHARE_CONSENT_VERSION = '2026-08-23';

/** ~20-30 s of a busy bay; older sentences roll off the front. */
const MAX_BUFFER = 2000;
/** The TICK, not the post. Every tick flush() decides for itself whether
 *  anything is due — a loud bay, or the watch clock. */
const FLUSH_INTERVAL_MS = 20_000;
/** Don't bother the network for a trickle; flush early when the bay is loud. */
const MIN_FLUSH_SENTENCES = 5;
const MAX_FLUSH_SENTENCES = 600;
const FLUSH_DEADLINE_MS = 10_000;

/**
 * THE CHECK-IN CADENCE — and the reason this service exists in its new shape.
 *
 * Until now the only path to the network was a buffer with five or more
 * sentences in it. A boat anchored off Osprey Reef with a working receiver and
 * no ships for 200 miles never crossed that floor, so it made ZERO requests,
 * forever, and was byte-for-byte indistinguishable on the wire from someone
 * who flipped the toggle on and unplugged the aerial. The single most valuable
 * contributor in the fleet looked exactly like the worst freeloader.
 *
 * So the check-in now fires on a clock rather than on yield — and it fires
 * whether or not the gateway is connected. Gating it on a live connection
 * would mean the one fault it most needs to report (a gateway that stopped
 * answering) is also the fault that silences the report. Link state travels as
 * DATA, never as a gate.
 *
 * Low-data mode earns exactly the same credit: the ledger bounds credit by the
 * connected seconds claimed and by wall clock, never by how often we knock, so
 * knocking less is strictly cheaper with no penalty. That is what makes this
 * affordable on Starlink Maritime or Iridium.
 */
const WATCH_INTERVAL_MS = 5 * 60_000;
const WATCH_INTERVAL_LOW_DATA_MS = 30 * 60_000;

function endpoint(): string {
    try {
        return (import.meta.env?.VITE_FLEET_FEED_URL as string | undefined)?.trim() || '';
    } catch {
        return '';
    }
}

export type ShareLinkState = 'connected' | 'reconnecting' | 'down';

/** What the server last told us about this boat's standing. Persisted, because
 *  every stat below dies on app launch otherwise — a skipper who has fed the
 *  fleet for months should not open the app to a card reading zero. */
export interface WatchCard {
    standing: string;
    watchMinutes: number;
    watchMinutes7d: number;
    at: number;
}

interface ShareStats {
    buffered: number;
    sharedTotal: number;
    droppedTotal: number;
    lastFlushOk: boolean | null;
    lastFlushAt: number | null;
    link: ShareLinkState;
    linkError: string | null;
    reconnects: number;
    /** Rejections the server told us apart, so the UI can name the fault
     *  instead of just reporting that something is wrong. Diagnostics only. */
    rejected: { tooLong: number; notAis: number; checksum: number } | null;
    card: WatchCard | null;
}

let buffer: string[] = [];
let enabled: boolean | null = null;
let lowData: boolean | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let sharedTotal = 0;
let droppedTotal = 0;
let lastFlushOk: boolean | null = null;
let lastFlushAt: number | null = null;

// ── Link state, reported TO us by the NMEA listener rather than polled ──
// The listener already calls offer() on the hot path; having it also report
// connection changes keeps the dependency pointing one way and avoids a
// circular import.
let linkState: ShareLinkState = 'down';
let linkError: string | null = null;
let reconnects = 0;
/** When the link last became connected — the running half of the credit. */
let connectedSince: number | null = null;
/** Connected milliseconds banked since the last successful check-in. */
let connectedPendingMs = 0;
let heardSinceCheckin = 0;
let lastCheckinAt = 0;
let lastRejected: { tooLong: number; notAis: number; checksum: number } | null = null;
let card: WatchCard | null = null;
let cardLoaded = false;

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
            enabled = localStorage.getItem(authScopedStorageKey(ENABLED_KEY)) === 'true';
        } catch {
            enabled = false;
        }
    }
    return enabled;
}

export function setShareEnabled(value: boolean): void {
    const wasEnabled = enabled === true;
    enabled = value;
    try {
        localStorage.setItem(authScopedStorageKey(ENABLED_KEY), value ? 'true' : 'false');
    } catch {
        /* consent still applies for this session */
    }
    if (value) {
        startTimer();
    } else {
        // Opt-out is an EVENT, and worth one best-effort post before the timer
        // dies — otherwise the ledger cannot tell "withdrew consent" from
        // "went to sea". Best-effort is fine: failing means we assume the
        // latter, which is the safe direction to be wrong in.
        if (wasEnabled) void postRevoke();
        stopTimer();
        buffer = [];
        connectedPendingMs = 0;
        connectedSince = null;
    }
    notify();
}

/** Fewer check-ins on a satellite link. Credit is IDENTICAL either way — the
 *  ledger bounds it by connected seconds and wall clock, not by how often we
 *  knock — so this costs the skipper nothing but data. */
export function isLowDataLink(): boolean {
    if (lowData === null) {
        try {
            lowData = localStorage.getItem(authScopedStorageKey(LOW_DATA_KEY)) === 'true';
        } catch {
            lowData = false;
        }
    }
    return lowData;
}

export function setLowDataLink(value: boolean): void {
    lowData = value;
    try {
        localStorage.setItem(authScopedStorageKey(LOW_DATA_KEY), value ? 'true' : 'false');
    } catch {
        /* applies for this session regardless */
    }
    notify();
}

function watchIntervalMs(): number {
    return isLowDataLink() ? WATCH_INTERVAL_LOW_DATA_MS : WATCH_INTERVAL_MS;
}

/**
 * The NMEA listener tells us what the gateway is doing. Called on connect,
 * on disconnect and on each reconnect attempt.
 *
 * Connected time is banked here rather than measured at check-in, so a link
 * that flaps between check-ins is credited for the time it was actually up
 * instead of all-or-nothing on whatever state happened to be current when the
 * timer fired.
 */
export function reportLink(state: ShareLinkState, error?: string): void {
    const now = Date.now();
    if (linkState === 'connected' && connectedSince !== null) {
        connectedPendingMs += Math.max(0, now - connectedSince);
    }
    if (state === 'connected') {
        if (linkState !== 'connected') reconnects++;
        connectedSince = now;
        linkError = null;
    } else {
        connectedSince = null;
        if (error) linkError = error.slice(0, 200);
    }
    linkState = state;
    notify();
}

/** Connected seconds to claim now, including time still running. */
function pendingConnectedSeconds(): number {
    let ms = connectedPendingMs;
    if (linkState === 'connected' && connectedSince !== null) {
        ms += Math.max(0, Date.now() - connectedSince);
    }
    return Math.min(3600, Math.floor(ms / 1000));
}

function loadCard(): WatchCard | null {
    if (cardLoaded) return card;
    cardLoaded = true;
    try {
        const raw = localStorage.getItem(authScopedStorageKey(CARD_KEY));
        card = raw ? (JSON.parse(raw) as WatchCard) : null;
    } catch {
        card = null;
    }
    return card;
}

function saveCard(next: WatchCard): void {
    card = next;
    cardLoaded = true;
    try {
        localStorage.setItem(authScopedStorageKey(CARD_KEY), JSON.stringify(next));
    } catch {
        /* the card is a convenience; the server remains the authority */
    }
}

export function getShareStats(): ShareStats {
    return {
        buffered: buffer.length,
        sharedTotal,
        droppedTotal,
        lastFlushOk,
        lastFlushAt,
        link: linkState,
        linkError,
        reconnects,
        rejected: lastRejected,
        card: loadCard(),
    };
}

/**
 * Start checking in at boot, if consent is already stored.
 *
 * Without this the timer was reachable only from offer() or a fresh toggle —
 * so a boat that relaunched the app in an empty anchorage scheduled nothing at
 * all, and the very case the check-in exists to serve stayed silent.
 */
export function startWatch(): void {
    if (!isShareEnabled() || !isShareConfigured()) return;
    startTimer();
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
    heardSinceCheckin++;
    startTimer();
}

function startTimer(): void {
    if (flushTimer !== null) return;
    flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    // Drain before the webview is suspended — same trigger anchorPiPush uses.
    if (typeof document !== 'undefined' && !visibilityHooked) {
        visibilityHooked = true;
        document.addEventListener('visibilitychange', () => {
            // Drain buffered sentences before suspend, but don't turn every
            // app-switch into a check-in.
            if (document.hidden) void flush(buffer.length > 0);
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

/** The watch envelope. Headers, not a JSON body: the worker's line loop drops
 *  anything not starting `!AIVDM`/`!AIVDO`, so a JSON body would be silently
 *  binned — and headers leave the text/plain payload byte-identical, which
 *  keeps the server's strict checksum gate untouched. */
function watchHeaders(): Record<string, string> {
    return {
        'X-Thalassa-Watch': '1',
        'X-Thalassa-Connected': String(pendingConnectedSeconds()),
        'X-Thalassa-Link': linkState,
        'X-Thalassa-Reconnects': String(reconnects),
        'X-Thalassa-Heard': String(heardSinceCheckin),
        'X-Thalassa-Consent': AIS_SHARE_CONSENT_VERSION,
        ...(linkError ? { 'X-Thalassa-Link-Err': linkError } : {}),
    };
}

/** A response body is a bonus, never a requirement. */
async function readJsonSafely(res: { json?: () => Promise<unknown> }): Promise<unknown> {
    try {
        return typeof res.json === 'function' ? await res.json() : null;
    } catch {
        return null;
    }
}

/** Take what the server told us: the standing card, and which rejections it
 *  saw. Today this body is discarded entirely and every stat shown in the UI
 *  dies on app launch. */
function absorbReply(payload: unknown): void {
    // Tolerant on purpose. CapacitorHttp may hand back a parsed object or a
    // raw string, and a proxy or an old worker may answer with neither — none
    // of which is a reason to lose a batch of sentences. An earlier draft did
    // `await res.json()` directly and threw on any response without a json
    // method, which the outer catch then counted as a failed flush.
    let value: unknown = payload;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return;
        }
    }
    if (!value || typeof value !== 'object') return;
    const p = value as Record<string, unknown>;
    const rej = p.rejected as Record<string, number> | undefined;
    if (rej && typeof rej === 'object') {
        lastRejected = {
            tooLong: Number(rej.tooLong) || 0,
            notAis: Number(rej.notAis) || 0,
            checksum: Number(rej.checksum) || 0,
        };
    }
    const w = p.watch as Record<string, unknown> | undefined;
    if (w && typeof w === 'object' && w.ok === true) {
        saveCard({
            standing: typeof w.standing === 'string' ? w.standing : 'on_watch',
            watchMinutes: Number(w.watchMinutes) || 0,
            watchMinutes7d: Number(w.watchMinutes7d) || 0,
            at: Date.now(),
        });
    }
}

/** One best-effort post so the ledger can tell withdrawal from going to sea. */
async function postRevoke(): Promise<void> {
    const url = endpoint();
    if (!url) return;
    try {
        const headers = await getAuthenticatedFunctionHeaders();
        await withTimeout(
            (async () => {
                const h = {
                    ...headers,
                    'Content-Type': 'text/plain',
                    'X-Thalassa-Watch': '1',
                    'X-Thalassa-Revoke': '1',
                };
                if (Capacitor.isNativePlatform()) {
                    await CapacitorHttp.post({
                        url,
                        headers: h,
                        data: '',
                        readTimeout: FLUSH_DEADLINE_MS,
                        connectTimeout: FLUSH_DEADLINE_MS,
                    });
                    return true;
                }
                await fetch(url, {
                    method: 'POST',
                    headers: h,
                    body: '',
                    signal: AbortSignal.timeout(FLUSH_DEADLINE_MS),
                });
                return true;
            })(),
            false,
            FLUSH_DEADLINE_MS + 2_000,
        );
    } catch {
        /* silent: assuming "gone to sea" is the safe way to be wrong */
    }
}

/**
 * Post sentences, a check-in, or both.
 *
 * The critical change from the original: an EMPTY buffer is no longer a reason
 * to stay silent. When the watch is due we post regardless — no sentences, no
 * connection, nothing to say but "I am still here and this is what my gateway
 * is doing". That post is the empty-bay punter's entire contribution record.
 */
async function flush(force = false): Promise<void> {
    if (inFlight || !isShareEnabled()) return;
    const url = endpoint();
    if (!url) return;

    const now = Date.now();
    const watchDue = now - lastCheckinAt >= watchIntervalMs();
    // On a satellite link even a loud bay waits for the watch tick; the credit
    // is identical, and the skipper asked us to spend less data.
    const loud = !isLowDataLink() && buffer.length >= MIN_FLUSH_SENTENCES;
    if (!force && !watchDue && !loud) return;

    const batch = buffer.slice(0, MAX_FLUSH_SENTENCES);
    buffer = buffer.slice(batch.length);
    const claimedHeard = heardSinceCheckin;
    inFlight = true;
    try {
        const headers = { ...(await getAuthenticatedFunctionHeaders()), ...watchHeaders() };
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
                    if (res.status < 200 || res.status >= 300) return false;
                    absorbReply(res.data);
                    return true;
                }
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'text/plain' },
                    body,
                    signal: AbortSignal.timeout(FLUSH_DEADLINE_MS),
                });
                if (!res.ok) return false;
                absorbReply(await readJsonSafely(res));
                return true;
            })(),
            false,
            FLUSH_DEADLINE_MS + 2_000,
        );
        if (ok) {
            sharedTotal += batch.length;
            lastFlushOk = true;
            // Rebase the credit clock ONLY on success. A failed post must not
            // silently consume connected time the ledger never heard about —
            // the sentences are lossy by design, the watch is not.
            lastCheckinAt = Date.now();
            connectedPendingMs = 0;
            connectedSince = linkState === 'connected' ? Date.now() : null;
            heardSinceCheckin = Math.max(0, heardSinceCheckin - claimedHeard);
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

/** Test seam. lastCheckinAt returns to 0 — a cold app start, where the watch
 *  is immediately due, which is the real behaviour at boot. */
export function __resetAisShareForTest(): void {
    buffer = [];
    enabled = null;
    lowData = null;
    stopTimer();
    inFlight = false;
    sharedTotal = 0;
    droppedTotal = 0;
    lastFlushOk = null;
    lastFlushAt = null;
    linkState = 'down';
    linkError = null;
    reconnects = 0;
    connectedSince = null;
    connectedPendingMs = 0;
    heardSinceCheckin = 0;
    lastCheckinAt = 0;
    lastRejected = null;
    card = null;
    cardLoaded = false;
    listeners.clear();
}

/** Test seam — pretend a check-in just succeeded, so the watch is NOT due.
 *  This is the steady state between ticks, where most of a day is spent. */
export function __markCheckedInForTest(): void {
    lastCheckinAt = Date.now();
}

/** Test seam — make the watch due now, without waiting five real minutes. */
export function __resetWatchClockForTest(): void {
    lastCheckinAt = 0;
}

/** Test seam — bank connected time without waiting for a real clock. */
export function __bankConnectedForTest(ms: number): void {
    connectedPendingMs += ms;
}

/** Test seam — force a flush cycle. */
export function __flushForTest(force = false): Promise<void> {
    return flush(force);
}
