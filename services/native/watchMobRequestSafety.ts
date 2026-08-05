/**
 * Safety boundary for Watch-initiated MOB marker requests.
 *
 * A WatchConnectivity `transferUserInfo` delivery can arrive long after the
 * sailor pressed the Watch control. The Watch has no casualty position to
 * hand to the phone, so accepting an old request would mark the phone's
 * *current* position as though it were the original MOB datum. Requests are
 * therefore short-lived, structurally validated through a versioned envelope,
 * and claimed by stable ID before MobService is allowed to read GPS.
 */
import { Preferences } from '@capacitor/preferences';

export const WATCH_MOB_REQUEST_VERSION = 1;
/** Maximum Watch-to-phone delivery age. Reachable WCSession messages normally
 * arrive in well under a second; 15 seconds allows a brief radio/bridge delay
 * without turning a later own-ship position into the casualty datum. */
export const WATCH_MOB_REQUEST_TTL_MS = 15_000;
/** Apple devices normally share system time. This small allowance avoids a
 * false rejection during harmless clock rounding while still failing closed
 * on a future-dated or corrupt request. */
export const WATCH_MOB_REQUEST_FUTURE_SKEW_MS = 5_000;

const SEEN_REQUESTS_KEY = 'thalassa_watch_mob_requests_v1';
const SEEN_REQUESTS_VERSION = 1;
const SEEN_REQUEST_RETENTION_MS = 24 * 60 * 60_000;
const MAX_SEEN_REQUESTS = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WatchMobRequestRejection = 'invalid-envelope' | 'expired' | 'future-dated';

export interface AcceptedWatchMobRequest {
    accepted: true;
    requestId: string;
    requestedAtMs: number;
    expiresAtMs: number;
    deliveryChannel: 'immediate' | 'queued' | 'unknown';
}

export interface RejectedWatchMobRequest {
    accepted: false;
    reason: WatchMobRequestRejection;
    /** Present when the stable ID itself was valid, allowing malformed or
     * stale copies delivered over both WCSession channels to be deduplicated. */
    requestId?: string;
}

export type WatchMobRequestDecision = AcceptedWatchMobRequest | RejectedWatchMobRequest;

interface SeenRequest {
    id: string;
    seenAtMs: number;
}

interface SeenRequestLedger {
    version: typeof SEEN_REQUESTS_VERSION;
    requests: SeenRequest[];
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function validRequestId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const id = value.trim().toLowerCase();
    return UUID_PATTERN.test(id) ? id : null;
}

/** Pure envelope/freshness check, exported so the age boundary can be tested
 * independently from Capacitor storage and MobService. */
export function evaluateWatchMobRequest(event: unknown, nowMs = Date.now()): WatchMobRequestDecision {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return { accepted: false, reason: 'invalid-envelope' };
    }
    const payload = event as Record<string, unknown>;
    const requestId = validRequestId(payload.mobRequestId);
    const requestedAtMs = finiteNumber(payload.mobRequestedAtMs);
    const expiresAtMs = finiteNumber(payload.mobRequestExpiresAtMs);
    const declaredTtlMs = finiteNumber(payload.mobRequestTtlMs);

    if (
        payload.mobRequestVersion !== WATCH_MOB_REQUEST_VERSION ||
        !requestId ||
        requestedAtMs === null ||
        expiresAtMs === null ||
        declaredTtlMs !== WATCH_MOB_REQUEST_TTL_MS ||
        requestedAtMs <= 0 ||
        expiresAtMs <= requestedAtMs ||
        Math.abs(expiresAtMs - requestedAtMs - WATCH_MOB_REQUEST_TTL_MS) > 1
    ) {
        return { accepted: false, reason: 'invalid-envelope', ...(requestId ? { requestId } : {}) };
    }

    if (!Number.isFinite(nowMs) || requestedAtMs > nowMs + WATCH_MOB_REQUEST_FUTURE_SKEW_MS) {
        return { accepted: false, reason: 'future-dated', requestId };
    }

    // Check both the declared expiry relationship and direct age so neither
    // field can independently extend the acceptance window.
    if (nowMs > expiresAtMs || nowMs - requestedAtMs > WATCH_MOB_REQUEST_TTL_MS) {
        return { accepted: false, reason: 'expired', requestId };
    }

    const deliveryChannel =
        payload.deliveryChannel === 'immediate' || payload.deliveryChannel === 'queued'
            ? payload.deliveryChannel
            : 'unknown';
    return { accepted: true, requestId, requestedAtMs, expiresAtMs, deliveryChannel };
}

function parseLedger(raw: string | null): SeenRequest[] {
    if (!raw) return [];
    try {
        const value = JSON.parse(raw) as Partial<SeenRequestLedger>;
        if (value.version !== SEEN_REQUESTS_VERSION || !Array.isArray(value.requests)) return [];
        return value.requests.filter(
            (entry): entry is SeenRequest =>
                !!entry &&
                typeof entry.id === 'string' &&
                UUID_PATTERN.test(entry.id) &&
                typeof entry.seenAtMs === 'number' &&
                Number.isFinite(entry.seenAtMs) &&
                entry.seenAtMs > 0,
        );
    } catch {
        return [];
    }
}

/** Value records whether the in-memory claim is also present in Preferences. */
const volatileSeen = new Map<string, boolean>();
let claimChain: Promise<void> = Promise.resolve();

export interface WatchMobRequestClaim {
    duplicate: boolean;
    /** False only when native Preferences could not persist the reservation.
     * The in-process reservation still prevents a second delivery, and the
     * 15-second TTL fails closed after a restart. */
    durable: boolean;
}

async function claimOne(requestId: string, nowMs: number): Promise<WatchMobRequestClaim> {
    const existingVolatileClaim = volatileSeen.get(requestId);
    if (existingVolatileClaim !== undefined) return { duplicate: true, durable: existingVolatileClaim };

    let retained: SeenRequest[] = [];
    try {
        const { value } = await Preferences.get({ key: SEEN_REQUESTS_KEY });
        retained = parseLedger(value).filter(
            (entry) => nowMs - entry.seenAtMs >= 0 && nowMs - entry.seenAtMs <= SEEN_REQUEST_RETENTION_MS,
        );
    } catch {
        // A native-storage outage must not suppress a fresh physical emergency.
        // The volatile reservation + short expiry still prevent normal repeats.
        volatileSeen.set(requestId, false);
        return { duplicate: false, durable: false };
    }

    if (retained.some((entry) => entry.id === requestId)) {
        volatileSeen.set(requestId, true);
        return { duplicate: true, durable: true };
    }

    volatileSeen.set(requestId, false);
    const requests = [...retained, { id: requestId, seenAtMs: nowMs }].slice(-MAX_SEEN_REQUESTS);
    try {
        await Preferences.set({
            key: SEEN_REQUESTS_KEY,
            value: JSON.stringify({ version: SEEN_REQUESTS_VERSION, requests } satisfies SeenRequestLedger),
        });
        volatileSeen.set(requestId, true);
        return { duplicate: false, durable: true };
    } catch {
        return { duplicate: false, durable: false };
    }
}

/** Atomically reserves an ID across immediate and queued deliveries. Calls are
 * serialized because Capacitor Preferences has no compare-and-swap primitive. */
export function claimWatchMobRequest(requestId: string, nowMs = Date.now()): Promise<WatchMobRequestClaim> {
    const result = claimChain.then(() => claimOne(requestId, nowMs));
    claimChain = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

/** Test-only reset. Production listener resets deliberately do not clear the
 * ledger or volatile claims, because HMR/bridge recreation is another delivery
 * boundary the dedupe contract must survive. */
export async function _resetWatchMobRequestSafetyForTests(): Promise<void> {
    await claimChain.catch(() => undefined);
    volatileSeen.clear();
    claimChain = Promise.resolve();
}
