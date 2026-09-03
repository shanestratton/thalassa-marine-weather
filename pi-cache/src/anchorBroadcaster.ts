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
    /**
     * The skipper's own setup numbers, carried so the shore device can show
     * them. The Pi cannot know how much rode went out or how deep it is; only
     * the phone that set the anchor does. Optional because a Pi that was
     * assigned by an older app build must still broadcast a position — the
     * shore view treats them as unknown rather than crashing.
     */
    rodeLength?: number;
    waterDepth?: number;
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
    /** Signal K's own source id, e.g. 'ydwg-tcp.YD'. Null when it named none. */
    source?: string | null;
}

/**
 * WHICH GPS WINS, in order.
 *
 * Calypso carries two receivers and Signal K picks per PATH by whoever wrote
 * last — measured 2026-09-03, with navigation.position won by the bus while
 * navigation.gnss.methodQuality was simultaneously won by the USB stick. So
 * the boat's position was correct by luck, not by rule, and on the day the
 * USB stick happened to write last it would have become the vessel's position
 * with a third of the satellites (25 on the bus, 11 on the stick).
 *
 * Shane 2026-09-03: "a: garmin gps b: usb gps c: phone gps."
 *
 * a — the instrument bus. The Garmin's fix arrives through the YDWG gateway,
 *     which is also what every other instrument on the boat is steering by, so
 *     agreeing with it matters as much as its accuracy.
 * b — a USB receiver plugged into the Pi. A real fix and a fine backup, but it
 *     sits under the deck with a fraction of the sky.
 *
 * Overridable with GPS_SOURCE_PRIORITY (comma-separated prefixes) for a boat
 * wired differently, because these names are Calypso's, not a standard.
 */
const DEFAULT_SOURCE_PRIORITY = ['ydwg', 'n2k', 'nmea', 'ublox', 'usb', 'gps'];

export function sourcePriority(): string[] {
    const raw = typeof process !== 'undefined' ? process.env?.GPS_SOURCE_PRIORITY : undefined;
    const parsed = (raw ?? '')
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_SOURCE_PRIORITY;
}

/** Lower is better. Anything unrecognised ranks last but is still usable. */
export function rankSource(source: string | null | undefined): number {
    if (!source) return Number.MAX_SAFE_INTEGER;
    const id = source.toLowerCase();
    const order = sourcePriority();
    for (let i = 0; i < order.length; i++) if (id.startsWith(order[i]) || id.includes(order[i])) return i;
    return Number.MAX_SAFE_INTEGER;
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
    if (!position) return null;

    const readOne = (node: Record<string, unknown> | undefined, source: string | null): VesselFix | null => {
        const value = node?.value as Record<string, unknown> | undefined;
        if (!value) return null;
        const { latitude, longitude } = value;
        if (!isFiniteLat(latitude) || !isFiniteLon(longitude)) return null;
        const stamped = typeof node?.timestamp === 'string' ? Date.parse(node.timestamp) : NaN;
        // No timestamp is not the same as a fresh one. Treat it as now only
        // when Signal K gave us nothing to judge by, and let the age gate
        // below decide.
        return { latitude, longitude, timestamp: Number.isFinite(stamped) ? stamped : now, source };
    };

    // When Signal K retains a value per source, CHOOSE — do not accept its
    // last-writer-wins answer. Ties break on the fresher fix.
    const values = position.values as Record<string, Record<string, unknown>> | undefined;
    if (values && typeof values === 'object') {
        const candidates = Object.entries(values)
            .map(([src, node]) => readOne(node, src))
            .filter((f): f is VesselFix => f !== null);
        if (candidates.length > 0) {
            candidates.sort((a, b) => {
                const byRank = rankSource(a.source) - rankSource(b.source);
                return byRank !== 0 ? byRank : b.timestamp - a.timestamp;
            });
            return candidates[0];
        }
    }

    // One writer only: take it, and record WHICH it was so the app can say so.
    const single = typeof position.$source === 'string' ? position.$source : null;
    return readOne(position, single);
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
        // The shore view reads config.rodeLength and config.waterDepth. A
        // payload without them crashed that view on the Pi's FIRST broadcast
        // (found 2026-09-03 by comparing the two payload shapes rather than
        // by waiting for it to happen at anchor).
        config:
            assignment.rodeLength !== undefined && assignment.waterDepth !== undefined
                ? { rodeLength: assignment.rodeLength, waterDepth: assignment.waterDepth }
                : undefined,
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

/**
 * Fetch Signal K's self document, following its own discovery endpoint.
 *
 * Exported so the always-on track recorder reads the bus through exactly this
 * path rather than growing a second copy of the discovery dance — two
 * implementations would eventually disagree about which Signal K they are
 * talking to.
 *
 * Null covers every not-usable shape, including the ordinary ashore state: a
 * 404 here means Signal K is up but nothing is feeding the bus, so there is no
 * vessel document yet.
 */
export async function fetchSelfDocument(deps: BroadcastDeps): Promise<unknown | null> {
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
        if (!response.ok) return null;
        return (await response.json()) as unknown;
    } catch {
        return null;
    }
}

/** Ask Signal K where the boat is. Null on anything that is not a usable fix. */
export async function currentFix(deps: BroadcastDeps): Promise<VesselFix | null> {
    const now = deps.now?.() ?? Date.now();
    const doc = await fetchSelfDocument(deps);
    return doc === null ? null : readFix(doc, now);
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

/* ── The running watch ──────────────────────────────────────────────────── */

export interface RunnerDeps extends BroadcastDeps {
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
    onOutcome?: (outcome: BroadcastOutcome) => void;
}

/**
 * Holds at most ONE watch. A boat has one anchor down; accepting a second
 * assignment replaces the first rather than running two loops that would
 * report contradictory positions to the same shore device.
 *
 * The assignment is deliberately NOT persisted. If the Pi reboots mid-watch it
 * comes back knowing nothing, and the app re-assigns on its next authorise
 * sweep — which is the honest outcome, because a Pi that has just rebooted
 * cannot vouch for what happened while it was down.
 */
export class AnchorWatchRunner {
    private assignment: AnchorWatchAssignment | null = null;
    private credential: RelayCredential | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastOutcome: BroadcastOutcome | null = null;

    constructor(private readonly deps: RunnerDeps) {}

    /** Replace whatever is running. Returns immediately; the first report is
     *  sent on the next tick so a caller is never blocked on the network. */
    start(assignment: AnchorWatchAssignment, credential: RelayCredential): void {
        this.stop();
        this.assignment = assignment;
        this.credential = credential;
        const setIntervalFn = this.deps.setIntervalImpl ?? setInterval;
        this.timer = setIntervalFn(() => void this.tick(), BROADCAST_INTERVAL_MS);
        void this.tick();
    }

    stop(): void {
        if (this.timer) {
            (this.deps.clearIntervalImpl ?? clearInterval)(this.timer);
            this.timer = null;
        }
        this.assignment = null;
        this.credential = null;
    }

    isRunning(): boolean {
        return this.timer !== null;
    }

    /** Never includes the credential — this is safe to put in /status. */
    describe(): { running: boolean; sessionCode: string | null; lastOutcome: BroadcastOutcome | null } {
        return {
            running: this.isRunning(),
            sessionCode: this.assignment?.sessionCode ?? null,
            lastOutcome: this.lastOutcome,
        };
    }

    private async tick(): Promise<void> {
        const assignment = this.assignment;
        const credential = this.credential;
        if (!assignment || !credential) return;
        const outcome = await broadcastOnce(assignment, credential, this.deps);
        this.lastOutcome = outcome;
        this.deps.onOutcome?.(outcome);
        // A credential the relay rejects outright will never start working, and
        // retrying it every ten seconds is a stream of failed auth attempts
        // against the skipper's own account. A LAPSED authorisation is
        // different — the app renews it, so keep going.
        if (outcome === 'unauthorised') this.stop();
    }
}
