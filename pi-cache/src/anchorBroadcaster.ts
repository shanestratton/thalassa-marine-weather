/**
 * AnchorBroadcaster — the Pi keeps the shore watch, so a skipper needs a Pi OR
 * a tablet aboard, not both.
 *
 * Shane 2026-08-29: "lets wire up the shore watch to the pi, as long as it
 * still works device to device and pi to device." A mains-powered Pi wired to
 * the bus is a better watchkeeper than a phone in a bunk: it does not sleep,
 * iOS does not background it, and it does not leave the boat in a pocket.
 *
 * WHAT THIS IS NOT
 * ────────────────
 * It is deliberately NOT a durable outbox, unlike its sibling
 * diaryRelayOutbox. A diary entry written yesterday is still true today, so
 * queueing it is right. A boat position from four minutes ago is not where the
 * boat is, and delivering it late to an anchor alarm is worse than delivering
 * nothing — it would show a shore watcher a boat sitting calmly inside its
 * swing circle that has in fact been dragging since. So: live push, no queue,
 * and a report that cannot be sent is dropped rather than stored.
 *
 * TRUST
 * ─────
 * The Pi never holds a Supabase key. It holds the same scoped per-Pi relay
 * credential the diary relay uses, and posts to the anchor-relay Edge
 * Function, which verifies the credential AND that the app authorised this
 * relay for this session code, then publishes on the Pi's behalf. The Pi never
 * joins Realtime and cannot reach any channel its owner has not granted.
 *
 * POSITION
 * ────────
 * From Signal K on this Pi (2.26.0 confirmed on Calypso 2026-08-29), which is
 * already aggregating the NMEA bus. Reading the gateway's TCP feed directly
 * would burn one of the YDWG-02's three client slots permanently, which is a
 * cost this has no business paying.
 *
 * A Signal K that is UP but has no vessel document — exactly the state ashore,
 * with nothing feeding the bus — is "no fix", not an error, and must never be
 * reported as a position.
 */

import { createHash } from 'node:crypto';

/** Signal K's own discovery document tells us the API base; do not hardcode. */
const SIGNALK_DISCOVERY_PATH = '/signalk';
const SELF_PATH = 'vessels/self';

/** How often the shore watcher hears from the boat. */
export const BROADCAST_INTERVAL_MS = 10_000;
/** A fix older than this is not worth transmitting as current. */
export const POSITION_MAX_AGE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

export interface AnchorWatchAssignment {
    /** The channel the app authorised this relay to broadcast to. */
    sessionCode: string;
    anchorLat: number;
    anchorLon: number;
    /** Alarm radius in metres, as the app computed it (rode + scope + LOA). */
    swingRadius: number;
}

export interface RelayCredential {
    /** Absolute https URL of the anchor-relay Edge Function. */
    url: string;
    relayId: string;
    token: string;
    /** Public anon JWT, presented at the gateway. Never a service-role key. */
    anonKey: string;
}

export interface VesselFix {
    latitude: number;
    longitude: number;
    /** Epoch ms the fix was taken, per Signal K's own timestamp. */
    timestamp: number;
}

type FetchLike = (
    url: string,
    init?: Record<string, unknown>,
) => Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
}>;

/**
 * Great-circle distance in metres. The anchor alarm is the one number here
 * that must not be approximated by a flat-earth shortcut: at 55°S a degree of
 * longitude is little more than half what it is at the equator, and a swing
 * circle is tens of metres wide.
 */
export function distanceMetres(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function isFiniteLat(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
}
function isFiniteLon(v: unknown): v is number {
    return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
}

/**
 * Pull the current fix out of a Signal K self document.
 *
 * Returns null for every shape that is not a usable position: no document, no
 * navigation branch, a null value, a non-finite number, or a timestamp we
 * cannot parse. Signal K reports position as an OBJECT with latitude and
 * longitude, and its timestamp as ISO-8601.
 */
export function readFix(selfDocument: unknown, now: number = Date.now()): VesselFix | null {
    const doc = selfDocument as Record<string, unknown> | null;
    const navigation = doc?.navigation as Record<string, unknown> | undefined;
    const position = navigation?.position as Record<string, unknown> | undefined;
    const value = position?.value as Record<string, unknown> | undefined;
    if (!value) return null;

    const { latitude, longitude } = value;
    if (!isFiniteLat(latitude) || !isFiniteLon(longitude)) return null;

    const stamped = typeof position?.timestamp === 'string' ? Date.parse(position.timestamp) : NaN;
    // No timestamp is not the same as a fresh one. Treat it as now only when
    // Signal K gave us nothing to judge by, and let the age gate below decide.
    const timestamp = Number.isFinite(stamped) ? stamped : now;
    return { latitude, longitude, timestamp };
}

/** Is this fix current enough to transmit as the boat's position? */
export function fixIsCurrent(fix: VesselFix, now: number = Date.now()): boolean {
    const age = now - fix.timestamp;
    // A fix from the future is a clock problem, not a position.
    return age >= -5_000 && age <= POSITION_MAX_AGE_MS;
}

/**
 * The wire shape the shore device already understands. Deliberately identical
 * to what a vessel PHONE broadcasts, because the whole point is that the shore
 * side cannot tell the two apart and needs no changes.
 */
export function buildPositionPayload(assignment: AnchorWatchAssignment, fix: VesselFix) {
    const distance = distanceMetres(assignment.anchorLat, assignment.anchorLon, fix.latitude, fix.longitude);
    return {
        vessel: { latitude: fix.latitude, longitude: fix.longitude, timestamp: fix.timestamp },
        anchor: { latitude: assignment.anchorLat, longitude: assignment.anchorLon },
        distance,
        swingRadius: assignment.swingRadius,
        isAlarm: distance > assignment.swingRadius,
        source: 'pi',
    };
}

export interface BroadcastDeps {
    fetchImpl: FetchLike;
    /** Base origin of Signal K on this Pi, e.g. http://127.0.0.1:3000 */
    signalkOrigin: string;
    now?: () => number;
}

export type BroadcastOutcome = 'sent' | 'no-fix' | 'stale-fix' | 'not-authorised' | 'unauthorised' | 'unreachable';

/** Ask Signal K where the boat is. Null on anything that is not a usable fix. */
export async function currentFix(deps: BroadcastDeps): Promise<VesselFix | null> {
    const now = deps.now?.() ?? Date.now();
    let base: string;
    try {
        const discovery = await deps.fetchImpl(`${deps.signalkOrigin}${SIGNALK_DISCOVERY_PATH}`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!discovery.ok) return null;
        const body = (await discovery.json()) as Record<string, unknown>;
        const endpoints = (body?.endpoints as Record<string, unknown>)?.v1 as Record<string, unknown> | undefined;
        const http = endpoints?.['signalk-http'];
        if (typeof http !== 'string') return null;
        base = http.endsWith('/') ? http : `${http}/`;
    } catch {
        return null;
    }

    try {
        const response = await deps.fetchImpl(`${base}${SELF_PATH}`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // 404 here is the ordinary ashore state: Signal K is up, but nothing
        // is feeding the bus so no vessel document exists yet.
        if (!response.ok) return null;
        return readFix(await response.json(), now);
    } catch {
        return null;
    }
}

/**
 * One report. No retry — the caller runs this on an interval, and the next
 * tick carries a fresher position than any retry of this one would.
 */
export async function broadcastOnce(
    assignment: AnchorWatchAssignment,
    credential: RelayCredential,
    deps: BroadcastDeps,
): Promise<BroadcastOutcome> {
    const now = deps.now?.() ?? Date.now();
    const fix = await currentFix(deps);
    if (!fix) return 'no-fix';
    if (!fixIsCurrent(fix, now)) return 'stale-fix';

    let response: Awaited<ReturnType<FetchLike>>;
    try {
        response = await deps.fetchImpl(credential.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // The anon key is public and is what the gateway checks; the
                // relay credential in the body is what actually identifies us.
                apikey: credential.anonKey,
                Authorization: `Bearer ${credential.anonKey}`,
            },
            body: JSON.stringify({
                relay_id: credential.relayId,
                token: credential.token,
                session_code: assignment.sessionCode,
                payload: buildPositionPayload(assignment, fix),
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        return 'unreachable';
    }

    if (response.ok) return 'sent';
    // 403 means the watch lapsed or was never authorised for this code — the
    // app must re-authorise. 401 means our credential is wrong, which no
    // amount of retrying fixes. The caller logs them differently on purpose.
    if (response.status === 403) return 'not-authorised';
    if (response.status === 401) return 'unauthorised';
    return 'unreachable';
}

/** Never log a credential. Used for correlating a Pi with its relay in logs. */
export function relayFingerprint(relayId: string): string {
    return createHash('sha256').update(relayId).digest('hex').slice(0, 8);
}
