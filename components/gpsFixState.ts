/**
 * gpsFixState — one fix timestamp, one answer: a live fix, a last position,
 * or no position at all.
 *
 * UX referee run 8 (gps-one-truth, the only HIGH): the System status Weather
 * position box said "This phone’s GPS unavailable — … · fix just now", then
 * "Last position 46 s ago", then "No position yet — nothing is supplying a
 * fix". Three lines, three clocks (the weather's retained fix, the phone watch
 * and the native location cache) and two age formatters. At the same moment
 * the chart drew own-ship with a live-looking "Stopped".
 *
 * Every line that says whether a receiver has a position now reads ONE
 * timestamp through this module, with one live gate per receiver and one age
 * formatter, so two lines can no longer disagree about the same fix.
 *
 * MOB, Radio and Anchor Watch keep their own, stricter gates on purpose: a
 * MOB datum needs a fresher fix than a status line does, and they say "No
 * fix" when they have none. These gates decide only whether a display may
 * call a position live; they never let a stale position read as one.
 */
import type { NmeaStoreState } from '../services/NmeaStore';
import type { WeatherFixKind, WeatherFollowTarget } from '../services/weatherPosition';
import { NMEA_USABLE_MAX_AGE_MS } from '../services/nmea/nmeaCadence';

export type GpsFixState =
    | { kind: 'live'; at: number; ageMs: number }
    | { kind: 'last'; at: number; ageMs: number }
    | { kind: 'none'; at: null; ageMs: null };

/** The fix state of each receiver the System status box shows, from its one timestamp. */
export interface GpsBoxFixes {
    phone: GpsFixState;
    /** Null when there is no boat card to agree with. */
    boat: GpsFixState | null;
}

/** How long the phone's own position counts as live (the phone card's gate since it was built). */
export const PHONE_LIVE_FIX_MAX_AGE_MS = 30_000;

/**
 * A receiver's clock may run a little fast; anything later is not a real fix
 * time. Five seconds, the same skew the own-ship arbiter
 * (services/ownshipPosition.ts) and the weather follower
 * (services/weatherPosition.ts) accept: a Pi fix stamped 3 s ahead is live to
 * the chart and to the weather, so the box must not call it 'No position yet'
 * — or let the header say 'the boat’s last fix' over it.
 */
const FUTURE_TOLERANCE_MS = 5_000;

const NO_FIX: GpsFixState = { kind: 'none', at: null, ageMs: null };

export function validFixTime(timestamp: number | null | undefined, now: number): timestamp is number {
    return (
        typeof timestamp === 'number' &&
        Number.isFinite(timestamp) &&
        timestamp > 0 &&
        timestamp <= now + FUTURE_TOLERANCE_MS
    );
}

/** How long the boat's position counts as live, by the lane it arrives on. */
export function boatLiveFixMaxAgeMs(state: Partial<Pick<NmeaStoreState, 'connectionStatus' | 'remote'>>): number {
    const remote = state.connectionStatus === 'remote' ? state.remote : null;
    return remote?.via === 'cloud' ? 60_000 : remote ? 20_000 : NMEA_USABLE_MAX_AGE_MS;
}

/**
 * The newest valid time among several readings of the SAME receiver's fix
 * (the phone watch and the weather's copy of the phone fix, say). The result
 * is the one timestamp every line about that receiver reads.
 */
export function newestFixAt(candidates: ReadonlyArray<number | null | undefined>, now: number): number | null {
    let newest: number | null = null;
    for (const candidate of candidates) {
        if (validFixTime(candidate, now) && (newest === null || candidate > newest)) newest = candidate;
    }
    return newest;
}

/** Live, last position, or none: from one timestamp and one gate. */
export function gpsFixState(fixAt: number | null | undefined, liveMaxAgeMs: number, now: number): GpsFixState {
    if (!validFixTime(fixAt, now)) return NO_FIX;
    const ageMs = Math.max(0, now - fixAt);
    return ageMs <= liveMaxAgeMs ? { kind: 'live', at: fixAt, ageMs } : { kind: 'last', at: fixAt, ageMs };
}

/** '46 s', '3 min', '2 h' — null under a second. */
function ageAmount(ageMs: number): string | null {
    if (ageMs < 1000) return null;
    if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)} s`;
    if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)} min`;
    return `${Math.floor(ageMs / 3_600_000)} h`;
}

/** 'just now', '46 s ago', '3 min ago', '2 h ago' — the one age wording for a fix. */
export function fixAgeText(ageMs: number): string {
    const amount = ageAmount(ageMs);
    return amount ? `${amount} ago` : 'just now';
}

/**
 * The card's position line. "No position yet" only when no position time
 * exists at all; a last position always says it has no live fix, so an old
 * position can never read as a current one.
 */
export function fixPositionLine(fix: GpsFixState): string {
    if (fix.kind === 'live') return `Position ${fixAgeText(fix.ageMs)}`;
    if (fix.kind === 'last') return `No live fix · last position ${fixAgeText(fix.ageMs)}`;
    return 'No position yet';
}

/** The chart's own-ship badge once the fix is not live: 'Last fix 46 s'. Null while live. */
export function ownshipFixLabel(fix: GpsFixState): string | null {
    if (fix.kind === 'live') return null;
    if (fix.kind === 'none') return 'No fix';
    return `Last fix ${ageAmount(fix.ageMs) ?? '0 s'}`;
}

/**
 * Which receiver the weather is following: its fix kind first, else the
 * skipper's pick. A boat this account crews on is 'crew' whatever answered:
 * the box's boat card is this device's own boat, not hers.
 */
export function followedReceiver(
    kind: WeatherFixKind | null | undefined,
    target?: WeatherFollowTarget,
): WeatherFollowTarget | null {
    if (target === 'crew') return 'crew';
    if (kind === 'phone') return 'phone';
    if (kind) return 'boat';
    return target ?? null;
}

/** The fix state of the receiver the weather follows, when the box has one for it. */
export function followedFix(
    fixes: GpsBoxFixes,
    kind: WeatherFixKind | null | undefined,
    target?: WeatherFollowTarget,
): GpsFixState | null {
    const receiver = followedReceiver(kind, target);
    return receiver === 'phone' ? fixes.phone : receiver === 'boat' ? fixes.boat : null;
}
