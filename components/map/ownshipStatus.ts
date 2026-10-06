import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import type { ShoreAlarmSnapshot } from '../../services/ShoreWatchAlarmService';
import { calculateDistance } from '../../utils/navigationCalculations';
import { presentAnchorWatchRow, type AnchorWatchRowPresentation } from '../anchor-watch/anchorWatchStatusRow';
import { ownshipFixLabel, type GpsFixState } from '../gpsFixState';

type MarkerPosition = { latitude: number; longitude: number; speed: number | null };

/**
 * Whose position the marker shows, and down which lane it came. 'own' is the
 * account's boat, 'crew' the boat it crews on, 'phone' a punter whose phone is
 * all the boat has (the phone IS her own ship).
 */
export interface OwnshipMarkerIdentity {
    owner: 'own' | 'crew' | 'phone';
    lane: 'bus' | 'pi' | 'cloud' | 'held' | 'phone';
}

/** The anchor watch's three sources, as presentAnchorWatchRow reads them. */
export interface OwnshipAnchorSources {
    local: Pick<
        AnchorWatchSnapshot,
        'state' | 'gpsSource' | 'distanceFromAnchor' | 'swingRadius' | 'alarmTriggeredAt' | 'alarmCause'
    > & { vesselPosition?: { latitude: number; longitude: number } | null };
    shore: Pick<ShoreAlarmSnapshot, 'sessionCode' | 'position' | 'stale' | 'cause'> & {
        lastContactAt?: number | null;
    };
    /** AnchorPiWatchKeeper.keepingSessionCode(): the session this phone handed to its Pi. */
    piSessionCode: string | null;
}

/** Below this the boat is 'Stopped'. A berthed receiver's speed noise sits under it; the Pi's at-rest fix uses it too. */
export const OWNSHIP_STOPPED_BELOW_KTS = 0.5;
/** Another device's watch is this boat's only when its position is this close to her fix. */
const SHORE_MATCH_M = 50;
/** A Shore Watch report counts for that match only while it is this fresh (its 5 s cadence, with slack). */
const SHORE_MATCH_MAX_AGE_MS = 35_000;
/** This phone's own watch is this boat's when the watch's position is this close to her fix. */
const PHONE_WATCH_MATCH_M = 200;
/**
 * The watch this phone handed to its own Pi is the own boat's unless the Pi's
 * last report puts it somewhere else entirely (a Pi this phone paired as crew).
 * Generous: a dragging boat's report and her cloud fix can be half a minute
 * apart, and an alarm must never be hidden by a strict match.
 */
const PI_WATCH_MATCH_M = 500;

const metresBetween = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
    calculateDistance(a.latitude, a.longitude, b.latitude, b.longitude) * 1852;

function shoreReportNear(position: MarkerPosition, shore: OwnshipAnchorSources['shore'], now: number): boolean {
    const remote = shore.position;
    if (!remote || shore.stale) return false;
    const age = now - Math.min(remote.timestamp, remote.vessel.timestamp);
    if (!(age >= -5_000 && age < SHORE_MATCH_MAX_AGE_MS)) return false;
    return metresBetween(position, remote.vessel) <= SHORE_MATCH_M;
}

/**
 * Whether the watch the row describes is THIS marker's boat's.
 *
 *  · This phone's own watch: the own boat's (or the phone-only punter's) when
 *    it watches the same receiver the marker draws (the boat's bus), or when
 *    the watch's own position is beside her fix. A watch this phone runs on
 *    its own GPS at home is not the boat's in a marina far away.
 *  · The watch this phone handed to its Pi: the own boat's, unless the Pi's
 *    report is somewhere else entirely.
 *  · Another device's: only by its report lying within 50 m of her fix.
 *  · A phone-only punter's marker takes only the phone's own watch.
 */
function watchIsThisBoats(
    row: AnchorWatchRowPresentation,
    position: MarkerPosition,
    identity: OwnshipMarkerIdentity,
    anchor: OwnshipAnchorSources,
    now: number,
): boolean {
    if (!row.active || !row.keeper) return false;
    if (row.keeper === 'phone') {
        const { gpsSource, vesselPosition } = anchor.local;
        if (identity.owner === 'phone') return gpsSource !== 'nmea';
        if (gpsSource === 'nmea' && identity.lane === 'bus') return true;
        if (vesselPosition) return metresBetween(position, vesselPosition) <= PHONE_WATCH_MATCH_M;
        // A watch with no position of its own yet cannot be told apart, so
        // the own boat keeps it: an alarm on her must never read 'Stopped'.
        return identity.owner === 'own';
    }
    if (identity.owner === 'phone') return false;
    if (row.keeper === 'pi' && identity.owner === 'own') {
        const report = anchor.shore.sessionCode === anchor.piSessionCode ? anchor.shore.position : null;
        return !report || metresBetween(position, report.vessel) <= PI_WATCH_MATCH_M;
    }
    return shoreReportNear(position, anchor.shore, now);
}

/** The anchor watch's own colour for the badge: the row's tone (presentAnchorWatchRow). */
export type OwnshipAnchorTone = 'green' | 'amber' | 'red';

export interface OwnshipAnchorStatus {
    label: 'Anchor alarm' | 'Drifting' | 'Anchored';
    /** The row's own tone: only a watch that is holding is green. */
    tone: OwnshipAnchorTone;
    /** What the row says beyond the word, for the marker's spoken name; null when the word says it all. */
    note: string | null;
}

/**
 * The anchor's word and colour for the badge, from the one anchor-watch truth
 * (presentAnchorWatchRow, the System status box and the Vessel tile read the
 * same row): 'Anchor alarm' while it sounds, 'Drifting' outside the swing
 * circle, 'Anchored' while the watch is on, for this boat. Null when no watch
 * on this boat is on: being set or idle reads as the boat's speed. A paused
 * watch (anchor down, nothing watching) reads an amber 'Anchored'.
 *
 * The colour is the row's: green only while the watch is holding. A watch
 * that has lost its data is red and one that is expiring, waiting or not
 * updating this phone is amber, exactly as the row shows them; a calm green
 * 'Anchored' beside a red row is the reassuring-direction disagreement the one
 * truth exists to stop.
 */
export function ownshipAnchorStatus(
    position: MarkerPosition,
    identity: OwnshipMarkerIdentity,
    anchor: OwnshipAnchorSources,
    now = Date.now(),
): OwnshipAnchorStatus | null {
    const row = presentAnchorWatchRow(
        anchor.local,
        { ...anchor.shore, lastContactAt: anchor.shore.lastContactAt ?? null },
        anchor.piSessionCode,
    );
    if (!watchIsThisBoats(row, position, identity, anchor, now)) return null;
    // An active row is never 'off'; if one ever were, it is not a calm green.
    const tone: OwnshipAnchorTone = row.tone === 'off' ? 'amber' : row.tone;
    switch (row.condition) {
        case 'alarm':
            return { label: 'Anchor alarm', tone: 'red', note: null };
        case 'drifting':
            return { label: 'Drifting', tone: 'red', note: null };
        // Paused: the anchor is down but nothing is watching it, so the badge
        // says so in amber, as the row does (Shane 2026-10-07: "Yes to amber").
        case 'paused':
            return { label: 'Anchored', tone: 'amber', note: 'anchor watch paused, not watching' };
        case 'setting':
        case 'idle':
            return null;
        case 'holding':
            return { label: 'Anchored', tone, note: null };
        case 'no-data':
            return { label: 'Anchored', tone, note: 'anchor watch has no current data' };
        case 'expiring':
            return { label: 'Anchored', tone, note: 'anchor watch authorisation expiring' };
        case 'waiting':
            return { label: 'Anchored', tone, note: 'anchor watch waiting for data' };
        case 'no-updates':
            return { label: 'Anchored', tone, note: 'no anchor watch updates on this phone' };
        default:
            return { label: 'Anchored', tone, note: null };
    }
}

/** The anchor's word alone (ownshipAnchorStatus). */
export function ownshipAnchorLabel(
    position: MarkerPosition,
    identity: OwnshipMarkerIdentity,
    anchor: OwnshipAnchorSources,
    now = Date.now(),
): OwnshipAnchorStatus['label'] | null {
    return ownshipAnchorStatus(position, identity, anchor, now)?.label ?? null;
}

/** What the badge shows: its words, and the anchor watch's colour and note when an anchor word holds it. */
export interface OwnshipStatusPresentation {
    label: string;
    anchorTone: OwnshipAnchorTone | null;
    anchorNote: string | null;
}

/** Speed cannot tell us whether an anchor is down. Only a watch that is on,
 * for the boat this marker shows, may supply that label (ownshipAnchorLabel).
 *
 * Nor can a fix that is no longer live say 'Stopped' or a speed: the chart
 * drew a live-looking 'Stopped' off a 46 s old phone fix while MOB, Radio and
 * Anchor Watch said NO FIX (UX referee run 8, gps-one-truth). `fix` is the
 * marker's one fix state (gpsFixState, the same gates the System status box
 * uses); once it is not live the badge says 'Last fix 46 s'. Anchor labels
 * still come first: they are the watch's own state, gated by its own GPS
 * watchdog, and an alarm must never be hidden behind a fix age. */
export function ownshipStatus(
    position: MarkerPosition,
    identity: OwnshipMarkerIdentity,
    anchor: OwnshipAnchorSources,
    now = Date.now(),
    fix: GpsFixState | null = null,
): OwnshipStatusPresentation {
    const anchored = ownshipAnchorStatus(position, identity, anchor, now);
    if (anchored) return { label: anchored.label, anchorTone: anchored.tone, anchorNote: anchored.note };
    const plain = (label: string): OwnshipStatusPresentation => ({ label, anchorTone: null, anchorNote: null });

    const lastFix = fix ? ownshipFixLabel(fix) : null;
    if (lastFix) return plain(lastFix);
    if (position.speed === null || !Number.isFinite(position.speed) || position.speed < 0) return plain('SOG —');
    const knots = position.speed * 1.94384;
    return plain(knots < OWNSHIP_STOPPED_BELOW_KTS ? 'Stopped' : `${knots.toFixed(1)} kts`);
}

/** The badge's words alone (ownshipStatus). */
export function ownshipStatusLabel(
    position: MarkerPosition,
    identity: OwnshipMarkerIdentity,
    anchor: OwnshipAnchorSources,
    now = Date.now(),
    fix: GpsFixState | null = null,
): string {
    return ownshipStatus(position, identity, anchor, now, fix).label;
}
