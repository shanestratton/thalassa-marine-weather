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
import type { AnchorWatchStore } from './anchorWatchStore.js';
// trackSignalk imports fetchSelfDocument from here, so these two modules import
// each other. Safe because neither touches the other's bindings at load time:
// keep every use of these inside a function.
import { DEPTH_MAX_AGE_MS, degrees, knots, num, readDepth, timestampAt, type DepthReference } from './trackSignalk.js';

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
        // A receipt time cannot establish GPS freshness. Otherwise an old
        // untimestamped position would remain "current" indefinitely.
        if (!Number.isFinite(stamped)) return null;
        return { latitude, longitude, timestamp: stamped, source };
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
                const byFreshness = Number(fixIsCurrent(b, now)) - Number(fixIsCurrent(a, now));
                if (byFreshness !== 0) return byFreshness;
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
 * Consecutive out-of-circle fixes required before the Pi cries drag.
 *
 * The SAME rule the phone uses (services/anchorGpsWatchdog.ALARM_CONFIRM_COUNT).
 * The Pi used to fire on a bare `distance > swingRadius`: one sample, no
 * confirmation, no decay. So handing the watch to the Pi silently made the
 * alarm MORE trigger-happy than the phone it replaced — a single GPS outlier
 * a few centimetres past the circle woke the skipper, where on the phone it
 * could not have. Backwards: the Pi is on the boat's own GPS and should be the
 * steadier watcher, not the twitchier one.
 *
 * At the Pi's ten-second cadence this is ~30s genuinely outside the circle.
 */
export const ALARM_CONFIRM_COUNT = 3;

/**
 * Drag-confirmation hysteresis (pure), mirroring the app's nextDragState: the
 * counter rises on each consecutive breach and DECAYS by one on each fix back
 * inside, so jitter cannot accumulate its way to an alarm over a long night.
 */
export function nextDragState(
    outsideCount: number,
    distance: number,
    swingRadius: number,
    confirmCount: number = ALARM_CONFIRM_COUNT,
): { outsideCount: number; alarm: boolean } {
    if (distance > swingRadius) {
        const next = outsideCount + 1;
        return { outsideCount: next, alarm: next >= confirmCount };
    }
    return { outsideCount: Math.max(0, outsideCount - 1), alarm: false };
}

/**
 * The wire shape the shore device already understands. Deliberately identical
 * to what a vessel PHONE broadcasts, because the whole point is that the shore
 * side cannot tell the two apart and needs no changes.
 *
 * `alarm` is passed in rather than derived here: confirming a drag needs the
 * memory of previous fixes, and this function deliberately has none.
 *
 * `live` (126-05) is the boat's own depth and true wind, read off the same
 * Signal K document as the fix (readLiveConditions). It is a key of its own
 * and only there when something is fresh, so a shore app from before it
 * reads exactly the keys it always read.
 */
export function buildPositionPayload(
    assignment: AnchorWatchAssignment,
    fix: VesselFix,
    alarm?: boolean,
    live?: AnchorLiveConditions,
) {
    const distance = distanceMetres(assignment.anchorLat, assignment.anchorLon, fix.latitude, fix.longitude);
    return {
        vessel: { latitude: fix.latitude, longitude: fix.longitude, timestamp: fix.timestamp },
        anchor: { latitude: assignment.anchorLat, longitude: assignment.anchorLon },
        distance,
        swingRadius: assignment.swingRadius,
        isAlarm: alarm ?? distance > assignment.swingRadius,
        // The shore view reads config.rodeLength and config.waterDepth. A
        // payload without them crashed that view on the Pi's FIRST broadcast
        // (found 2026-09-03 by comparing the two payload shapes rather than
        // by waiting for it to happen at anchor).
        config:
            assignment.rodeLength !== undefined && assignment.waterDepth !== undefined
                ? { rodeLength: assignment.rodeLength, waterDepth: assignment.waterDepth }
                : undefined,
        source: 'pi',
        gpsAvailable: true,
        gpsTimestamp: fix.timestamp,
        ...(live ? { live } : {}),
    };
}

/* ── The boat's live depth and wind, for the watcher ashore (126-05) ───────── */

/**
 * The live block of a position report: the boat's own depth and true wind,
 * each value with the time of the reading it came from (epoch ms), and each
 * only while it is fresh. Every key is optional; the block is left out of the
 * report altogether when none is fresh. The shore phone ages and bounds it
 * again (services/anchorLiveConditions.ts), because its own copy of a report
 * can grow old while the boat's link is down.
 *
 * The skipper's typed `config` (rode out, depth when anchoring) is a separate
 * thing and stays as it is: this is what the boat measures now.
 */
export interface AnchorLiveConditions {
    /** Metres, measured from depthReference. Below the keel may dip under zero (the keel on the mud). */
    depthM?: number;
    depthReference?: DepthReference;
    depthAt?: number;
    /** True wind speed, knots. */
    twsKn?: number;
    twsAt?: number;
    /** True wind direction, degrees true, 0 to under 360. */
    twdDeg?: number;
    twdAt?: number;
}

/** The true wind speed's freshness limit: the cloud snapshot's (wind_tws_at_ms). */
export const LIVE_TWS_MAX_AGE_MS = 20_000;
/**
 * The true wind direction's, by its own leaf time. Wider than the speed's: on
 * Serene Summer it comes off a different, slower sentence (the gateway's MDA,
 * which needs a heading), and a minute-old direction is still the wind's.
 */
export const LIVE_TWD_MAX_AGE_MS = 60_000;
/** A reading stamped this far ahead of the Pi's clock still counts (as readDepth's). */
const LIVE_FUTURE_SKEW_MS = 5_000;
/** Above this a true wind speed is a fault, not a wind (the snapshot's bound). */
const LIVE_TWS_MAX_KN = 150;

function freshWithin(at: number | null, nowMs: number, maxAgeMs: number): at is number {
    return at !== null && at > 0 && at <= nowMs + LIVE_FUTURE_SKEW_MS && nowMs - at <= maxAgeMs;
}

const round = (value: number, places: number): number => {
    const scale = 10 ** places;
    // `+ 0` turns a rounded -0 (a keel figure a hair under zero) into 0.
    return Math.round(value * scale) / scale + 0;
};

/**
 * The time of the reading readDepth's figure came from: the leaf it read, or
 * for a keel figure it worked out from the raw reading, the raw reading's.
 * Null when that reading carries no time of its own; it cannot be aged.
 */
function depthReadingAt(
    selfDocument: unknown,
    depthM: number,
    reference: DepthReference,
    nowMs: number,
): number | null {
    const at = (leaf: string) => timestampAt(selfDocument, `environment.depth.${leaf}`, false);
    if (reference === 'below-transducer') return at('belowTransducer');
    if (reference === 'below-waterline') return at('belowSurface');
    // Below the keel: Signal K's own keel figure first, as readDepth takes it…
    const keelAt = at('belowKeel');
    if (num(selfDocument, 'environment.depth.belowKeel') === depthM && freshWithin(keelAt, nowMs, DEPTH_MAX_AGE_MS)) {
        return keelAt;
    }
    // …else the raw reading less the sounder's keel offset.
    const raw = num(selfDocument, 'environment.depth.belowTransducer');
    const toKeel = num(selfDocument, 'environment.depth.transducerToKeel');
    if (raw !== null && toKeel !== null && Math.abs(raw - toKeel - depthM) < 0.0005) return at('belowTransducer');
    return null;
}

/**
 * Read the live block off a Signal K self document (SI units: metres, m/s,
 * radians). Undefined when nothing is fresh.
 *
 *   depth  readDepth's figure and reference (below the keel first, the
 *          boat's own display), dated by the reading it came from, within
 *          DEPTH_MAX_AGE_MS (20 s).
 *   TWS    within LIVE_TWS_MAX_AGE_MS (20 s), 0 to 150 kn.
 *   TWD    by its own leaf time, within LIVE_TWD_MAX_AGE_MS (60 s).
 *
 * A reading with no time of its own is left out: ashore it could never be
 * told from a stale one. A real zero (a flat calm, the keel on the mud) is a
 * reading and goes.
 */
export function readLiveConditions(selfDocument: unknown, nowMs: number): AnchorLiveConditions | undefined {
    const live: AnchorLiveConditions = {};

    const depth = readDepth(selfDocument, nowMs);
    if (depth.depthM !== null && depth.reference !== null) {
        const depthAt = depthReadingAt(selfDocument, depth.depthM, depth.reference, nowMs);
        if (freshWithin(depthAt, nowMs, DEPTH_MAX_AGE_MS)) {
            live.depthM = round(depth.depthM, 2);
            live.depthReference = depth.reference;
            live.depthAt = depthAt;
        }
    }

    const twsAt = timestampAt(selfDocument, 'environment.wind.speedTrue', false);
    const twsKn = knots(num(selfDocument, 'environment.wind.speedTrue'));
    if (twsKn !== null && twsKn >= 0 && twsKn <= LIVE_TWS_MAX_KN && freshWithin(twsAt, nowMs, LIVE_TWS_MAX_AGE_MS)) {
        live.twsKn = round(twsKn, 1);
        live.twsAt = twsAt;
    }

    const twdAt = timestampAt(selfDocument, 'environment.wind.directionTrue', false);
    const twdDeg = degrees(num(selfDocument, 'environment.wind.directionTrue'));
    if (twdDeg !== null && freshWithin(twdAt, nowMs, LIVE_TWD_MAX_AGE_MS)) {
        live.twdDeg = round(twdDeg, 1) % 360;
        live.twdAt = twdAt;
    }

    return Object.keys(live).length > 0 ? live : undefined;
}

export interface BroadcastDeps {
    fetchImpl: FetchLike;
    /** Base origin of Signal K on this Pi, e.g. http://127.0.0.1:3000 */
    signalkOrigin: string;
    now?: () => number;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    onLease?: (lease: { expiresAt: number; sessionExpiresAt: number }) => void;
}

function requestSignal(deps: BroadcastDeps): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
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
    return fetchSignalkDocument(deps, SELF_PATH);
}

/**
 * Any document under Signal K's REST root, e.g. `vessels` (every AIS target the
 * server has decoded) or `self` (the boat's own URN). Same discovery, same
 * timeouts, same null-for-anything-unusable contract as the self document.
 */
export async function fetchSignalkDocument(deps: BroadcastDeps, path: string): Promise<unknown | null> {
    let base: string;
    try {
        const discovery = await deps.fetchImpl(`${deps.signalkOrigin}${SIGNALK_DISCOVERY_PATH}`, {
            signal: requestSignal(deps),
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
        const response = await deps.fetchImpl(`${base}${path}`, {
            signal: requestSignal(deps),
        });
        if (!response.ok) return null;
        return (await response.json()) as unknown;
    } catch {
        return null;
    }
}

/**
 * Ask Signal K where the boat is, and keep the document the answer came from:
 * the position report reads her live depth and wind off that same document
 * (126-05), so they are never from a different moment than the fix.
 */
export async function currentReading(deps: BroadcastDeps): Promise<{ fix: VesselFix | null; document: unknown }> {
    const document = await fetchSelfDocument(deps);
    const now = deps.now?.() ?? Date.now();
    return { fix: document === null ? null : readFix(document, now), document };
}

/** Ask Signal K where the boat is. Null on anything that is not a usable fix. */
export async function currentFix(deps: BroadcastDeps): Promise<VesselFix | null> {
    return (await currentReading(deps)).fix;
}

/**
 * One report. No retry — the caller runs this on an interval, and the next
 * tick carries a fresher position than any retry of this one would.
 */
/** Carried across ticks so a drag can be CONFIRMED rather than guessed from one fix. */
export interface DragConfirmState {
    outsideCount: number;
    lastTimestamp?: number;
}

export async function broadcastOnce(
    assignment: AnchorWatchAssignment,
    credential: RelayCredential,
    deps: BroadcastDeps,
    drag?: DragConfirmState,
): Promise<BroadcastOutcome> {
    const { fix, document } = await currentReading(deps);
    const now = deps.now?.() ?? Date.now();
    if (deps.signal?.aborted || deps.isCurrent?.() === false) return 'unreachable';
    const unavailable = !fix ? 'no-fix' : !fixIsCurrent(fix, now) ? 'stale-fix' : null;

    // Confirmation needs the memory of previous fixes, which only a caller
    // holding DragConfirmState has. The running watch always passes one.
    let alarm: boolean | undefined;
    if (drag && fix && !unavailable) {
        const distance = distanceMetres(assignment.anchorLat, assignment.anchorLon, fix.latitude, fix.longitude);
        // Re-reading one frozen outlier is not three distinct GPS fixes.
        const next =
            fix.timestamp > (drag.lastTimestamp ?? -Infinity)
                ? nextDragState(drag.outsideCount, distance, assignment.swingRadius)
                : { outsideCount: drag.outsideCount, alarm: drag.outsideCount >= ALARM_CONFIRM_COUNT };
        drag.outsideCount = next.outsideCount;
        drag.lastTimestamp = Math.max(drag.lastTimestamp ?? -Infinity, fix.timestamp);
        alarm = next.alarm;
    }
    if (drag && unavailable) drag.outsideCount = 0;
    // The status report stays as it was: no live block without a position.
    const payload = unavailable
        ? {
              type: 'status',
              gpsAvailable: false,
              gpsTimestamp: fix?.timestamp ?? null,
              reason: unavailable,
              source: 'pi',
              timestamp: now,
              anchor: { latitude: assignment.anchorLat, longitude: assignment.anchorLon },
              swingRadius: assignment.swingRadius,
          }
        : buildPositionPayload(assignment, fix!, alarm, readLiveConditions(document, now));

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
                action: 'broadcast',
                relay_id: credential.relayId,
                token: credential.token,
                session_code: assignment.sessionCode,
                payload,
            }),
            signal: requestSignal(deps),
        });
    } catch {
        return 'unreachable';
    }

    if (response.ok) {
        try {
            const body = (await response.json()) as Record<string, unknown>;
            const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : NaN;
            const sessionExpiresAt =
                typeof body.session_expires_at === 'string' ? Date.parse(body.session_expires_at) : NaN;
            if (expiresAt > now && sessionExpiresAt >= expiresAt && sessionExpiresAt <= now + 24 * 60 * 60_000) {
                deps.onLease?.({ expiresAt, sessionExpiresAt });
            }
        } catch {
            /* Older relays do not return lease metadata; no durable recovery in that case. */
        }
        return unavailable ?? 'sent';
    }
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
    store?: AnchorWatchStore;
}

/**
 * Holds at most ONE watch. A boat has one anchor down; accepting a second
 * assignment replaces the first rather than running two loops that would
 * report contradictory positions to the same shore device.
 *
 * Recovery retains only a cloud-confirmed assignment until its finite lease
 * expires. A reboot always reads a NEW GPS fix and revalidates with the relay;
 * it never replays a position or claims to know what happened while offline.
 */
export class AnchorWatchRunner {
    private assignment: AnchorWatchAssignment | null = null;
    private credential: RelayCredential | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    /** Reset whenever a watch starts, so a new anchor never inherits old breaches. */
    private drag: DragConfirmState = { outsideCount: 0 };
    private lastOutcome: BroadcastOutcome | null = null;
    private generation = 0;
    private controller: AbortController | null = null;
    private pendingGeneration: number | null = null;
    private lease: { expiresAt: number; sessionExpiresAt: number } | null = null;
    private lastPersistedAt = 0;

    constructor(private readonly deps: RunnerDeps) {}

    /** Replace whatever is running. Returns immediately; the first report is
     *  sent on the next tick so a caller is never blocked on the network. */
    start(assignment: AnchorWatchAssignment, credential: RelayCredential): void {
        this.cancel();
        this.clearSaved();
        this.lease = null;
        this.lastPersistedAt = 0;
        this.lastOutcome = null;
        this.run(assignment, credential);
    }

    private run(assignment: AnchorWatchAssignment, credential: RelayCredential): void {
        this.assignment = assignment;
        this.credential = credential;
        this.controller = new AbortController();
        // A fresh anchor must never inherit breaches counted against the last one.
        this.drag = { outsideCount: 0 };
        const setIntervalFn = this.deps.setIntervalImpl ?? setInterval;
        this.timer = setIntervalFn(() => void this.tick(), BROADCAST_INTERVAL_MS);
        void this.tick();
    }

    stop(): void {
        const assignment = this.assignment;
        const credential = this.credential;
        this.cancel();
        this.clearSaved();
        this.lease = null;
        if (assignment && credential) void this.revoke(assignment, credential);
    }

    /** Process shutdown preserves a confirmed lease; it does NOT end the watch. */
    close(): void {
        this.cancel();
    }

    restore(credential: RelayCredential): boolean {
        const saved = this.deps.store?.read();
        const now = this.deps.now?.() ?? Date.now();
        if (
            !saved ||
            saved.relayId !== credential.relayId ||
            saved.expiresAt <= now ||
            saved.sessionExpiresAt <= now ||
            saved.sessionExpiresAt > now + 24 * 60 * 60_000
        ) {
            this.clearSaved();
            return false;
        }
        this.cancel();
        this.lease = { expiresAt: saved.expiresAt, sessionExpiresAt: saved.sessionExpiresAt };
        this.lastPersistedAt = 0;
        this.lastOutcome = null;
        this.run(saved.assignment, credential);
        return true;
    }

    private cancel(): void {
        this.generation++;
        this.controller?.abort();
        this.controller = null;
        if (this.timer) {
            (this.deps.clearIntervalImpl ?? clearInterval)(this.timer);
            this.timer = null;
        }
        this.assignment = null;
        this.credential = null;
    }

    private clearSaved(): void {
        try {
            this.deps.store?.clear();
        } catch {
            /* Cloud stop/expiry still enforce the authorisation. */
        }
    }

    private async revoke(assignment: AnchorWatchAssignment, credential: RelayCredential): Promise<void> {
        try {
            await this.deps.fetchImpl(credential.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: credential.anonKey,
                    Authorization: `Bearer ${credential.anonKey}`,
                },
                body: JSON.stringify({
                    action: 'stop',
                    relay_id: credential.relayId,
                    token: credential.token,
                    session_code: assignment.sessionCode,
                }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch {
            /* Phone revoke and finite cloud expiry remain independent backstops. */
        }
    }

    isRunning(): boolean {
        return this.timer !== null;
    }

    /** Never includes the credential — this is safe to put in /status. */
    describe(): {
        running: boolean;
        sessionCode: string | null;
        lastOutcome: BroadcastOutcome | null;
        sessionExpiresAt: number | null;
    } {
        return {
            running: this.isRunning(),
            sessionCode: this.assignment?.sessionCode ?? null,
            lastOutcome: this.lastOutcome,
            sessionExpiresAt: this.lease?.sessionExpiresAt ?? null,
        };
    }

    private async tick(): Promise<void> {
        const assignment = this.assignment;
        const credential = this.credential;
        if (!assignment || !credential) return;
        const generation = this.generation;
        if (this.pendingGeneration === generation) return;
        const now = this.deps.now?.() ?? Date.now();
        if (this.lease && this.lease.sessionExpiresAt <= now) {
            this.lastOutcome = 'not-authorised';
            this.stop();
            return;
        }
        this.pendingGeneration = generation;
        const isCurrent = () => this.generation === generation;
        let outcome: BroadcastOutcome;
        try {
            outcome = await broadcastOnce(
                assignment,
                credential,
                {
                    ...this.deps,
                    signal: this.controller?.signal,
                    isCurrent,
                    onLease: (lease) => {
                        if (!isCurrent()) return;
                        this.lease = lease;
                        // The six-hour lease has ample recovery slack. Avoid an
                        // SD-card write for every ten-second position heartbeat.
                        const persistedAt = this.deps.now?.() ?? Date.now();
                        if (this.lastPersistedAt && persistedAt - this.lastPersistedAt < 5 * 60_000) return;
                        try {
                            this.deps.store?.save({ assignment, relayId: credential.relayId, ...lease });
                            this.lastPersistedAt = persistedAt;
                        } catch {
                            /* Live monitoring continues, but reboot recovery is unavailable. */
                        }
                    },
                },
                this.drag,
            );
        } finally {
            if (this.pendingGeneration === generation) this.pendingGeneration = null;
        }
        if (!isCurrent()) return;
        this.lastOutcome = outcome;
        this.deps.onOutcome?.(outcome);
        // A credential the relay rejects outright will never start working, and
        // retrying it every ten seconds is a stream of failed auth attempts
        // against the skipper's own account. Expired/revoked assignments need
        // explicit app reauthorisation; they must never resume by themselves.
        if (outcome === 'unauthorised' || outcome === 'not-authorised') {
            this.cancel();
            this.clearSaved();
            this.lease = null;
        }
    }
}
