import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import type { ShoreAlarmSnapshot } from '../../services/ShoreWatchAlarmService';
import { calculateBearing } from '../../utils/navigationCalculations';

/** Who is keeping the anchor watch this row describes. */
export type AnchorWatchKeeper = 'phone' | 'pi' | 'other';

/** What the row found, for surfaces that word it differently (the Vessel tile). */
export type AnchorWatchCondition =
    | 'idle'
    | 'holding'
    | 'setting'
    | 'paused'
    | 'drifting'
    | 'alarm'
    | 'no-data'
    | 'expiring'
    | 'waiting'
    | 'no-updates';

export interface AnchorWatchRowPresentation {
    /** The anchor is down and something is (or should be) watching it. */
    active: boolean;
    keeper: AnchorWatchKeeper | null;
    condition: AnchorWatchCondition;
    tone: 'green' | 'amber' | 'red' | 'off';
    detail: string;
    /** Needs the skipper's eye: an alarm, a drift, or a watch that stopped. */
    urgent: boolean;
}

const IDLE: AnchorWatchRowPresentation = {
    active: false,
    keeper: null,
    condition: 'idle',
    tone: 'off',
    detail: 'Not deployed',
    urgent: false,
};

const span = (distance: number, radius: number) => `${Math.round(distance)}m / ${Math.round(radius)}m radius`;

/**
 * The System status box's Anchor watch row, whoever keeps the watch.
 *
 * It used to read AnchorWatchService alone, which is THIS phone's own watch.
 * When the skipper hands the watch to the Pi, handleAcceptPiWatch stops the
 * phone's watch and the phone joins as Shore Watch, so the row said "Not
 * deployed" with the anchor down and the Pi keeping the watch all night
 * (Shane 2026-09-29). The Vessel page had the same bug and was fixed the same
 * way: a watch kept elsewhere is still a deployed anchor.
 *
 * `piSessionCode` is the session this phone handed to its Pi
 * (AnchorPiWatchKeeper.keepingSessionCode()); a shore session with any other
 * code is being kept by another device aboard.
 */
export function presentAnchorWatchRow(
    local: Pick<
        AnchorWatchSnapshot,
        'state' | 'distanceFromAnchor' | 'swingRadius' | 'alarmTriggeredAt' | 'alarmCause'
    > | null,
    shore: Pick<ShoreAlarmSnapshot, 'sessionCode' | 'position' | 'stale' | 'cause' | 'lastContactAt'>,
    piSessionCode: string | null,
): AnchorWatchRowPresentation {
    // This phone's own watch comes first: it is the one that sounds here.
    if (local && local.state !== 'idle') {
        const distance = local.distanceFromAnchor ?? 0;
        const radius = local.swingRadius ?? 0;
        if (local.state === 'alarm' || local.alarmTriggeredAt) {
            return {
                active: true,
                keeper: 'phone',
                condition: 'alarm',
                tone: 'red',
                detail: local.alarmCause === 'gps-lost' ? 'ALARM · GPS lost' : `ALARM · ${span(distance, radius)}`,
                urgent: true,
            };
        }
        if (local.state === 'paused') {
            // A retained recovery state: the anchor is down but nothing on this
            // phone is watching it. It used to read "Holding".
            return {
                active: true,
                keeper: 'phone',
                condition: 'paused',
                tone: 'amber',
                detail: 'Paused · not watching. Open Anchor watch to resume.',
                urgent: true,
            };
        }
        if (local.state === 'setting') {
            return {
                active: true,
                keeper: 'phone',
                condition: 'setting',
                tone: 'amber',
                detail: 'Setting the watch…',
                urgent: false,
            };
        }
        if (distance > (local.swingRadius ?? 50)) {
            return {
                active: true,
                keeper: 'phone',
                condition: 'drifting',
                tone: 'red',
                detail: `Drifting · ${span(distance, radius)}`,
                urgent: true,
            };
        }
        return {
            active: true,
            keeper: 'phone',
            condition: 'holding',
            tone: 'green',
            detail: `Holding · ${span(distance, radius)}`,
            urgent: false,
        };
    }

    const shoreCode = shore.sessionCode;
    if (!shoreCode) {
        // The Pi took the watch but this phone never joined as Shore Watch
        // ("The Pi has the watch, but this phone could not switch to shore
        // view"). The anchor is still down; this phone just has no news of it.
        if (piSessionCode) {
            return {
                active: true,
                keeper: 'pi',
                condition: 'no-updates',
                tone: 'amber',
                detail: 'Down · watched by the Pi · no updates on this phone',
                urgent: false,
            };
        }
        return IDLE;
    }

    const keeper: AnchorWatchKeeper = piSessionCode === shoreCode ? 'pi' : 'other';
    const by = keeper === 'pi' ? 'watched by the Pi' : 'watched from another device';
    const remote = shore.position;
    if (shore.cause === 'drag' || remote?.isAlarm) {
        return {
            active: true,
            keeper,
            condition: 'alarm',
            tone: 'red',
            detail: remote ? `ALARM · ${span(remote.distance, remote.swingRadius)} · ${by}` : `ALARM · ${by}`,
            urgent: true,
        };
    }
    if (shore.cause === 'contact-lost' || shore.cause === 'gps-lost') {
        return {
            active: true,
            keeper,
            condition: 'no-data',
            tone: 'red',
            detail: `Down · ${by} · no current data`,
            urgent: true,
        };
    }
    const fresh = !shore.stale && remote !== null && shore.lastContactAt !== null;
    if (fresh && remote && remote.distance > remote.swingRadius) {
        return {
            active: true,
            keeper,
            condition: 'drifting',
            tone: 'red',
            detail: `Drifting · ${span(remote.distance, remote.swingRadius)} · ${by}`,
            urgent: true,
        };
    }
    if (shore.cause === 'session-expiring') {
        // A session_expiring push sounds this phone and raises the expiring
        // dialog; with fresh data the row used to read green "Holding".
        return {
            active: true,
            keeper,
            condition: 'expiring',
            tone: 'amber',
            detail:
                fresh && remote
                    ? `Down · ${span(remote.distance, remote.swingRadius)} · ${by} · watch authorisation expiring`
                    : `Down · ${by} · watch authorisation expiring`,
            urgent: true,
        };
    }
    if (fresh && remote) {
        return {
            active: true,
            keeper,
            condition: 'holding',
            tone: 'green',
            detail: `Holding · ${span(remote.distance, remote.swingRadius)} · ${by}`,
            urgent: false,
        };
    }
    return {
        active: true,
        keeper,
        condition: 'waiting',
        tone: 'amber',
        detail: `Down · ${by} · waiting for data`,
        urgent: false,
    };
}

/**
 * A string that changes only when the Vessel tile could: who keeps a shore
 * watch and what state it is in, never its distances. The Vessel page is a
 * large component; re-rendering it on every position the Pi sends would be
 * waste, so it subscribes to this instead of the whole shore snapshot.
 */
export function shoreWatchTileKey(
    shore: Pick<ShoreAlarmSnapshot, 'sessionCode' | 'position' | 'stale' | 'cause' | 'lastContactAt'>,
    piSessionCode: string | null,
): string {
    const row = presentAnchorWatchRow(null, shore, piSessionCode);
    return `${row.condition}|${row.keeper ?? ''}`;
}

/** The Vessel hero's swing arc: the circle, and where the boat sits in it. */
export interface AnchorSwingGeometry {
    radiusM: number;
    offsetM: number;
    /** From the boat to the anchor, as AnchorWatchService.bearingToAnchor. */
    bearingDeg: number;
}

const NO_SWING: AnchorSwingGeometry = { radiusM: 0, offsetM: 0, bearingDeg: 0 };

/**
 * What the Vessel hero's swing arc draws: the watch the row describes, from
 * the device keeping it. A radius of 0 hides the arc, and the hero shows its
 * status pill instead.
 *
 * The hero used to take the arc from this phone's own watch alone. After a
 * hand-off, stopWatch() zeroes the phone's distance but keeps its swing
 * radius, so once the Pi reported a drag the Drag Alarm card drew the boat
 * sitting on its anchor and VoiceOver read "0m of 45m swing" (review
 * 2026-09-29). A remote watch is drawn from the Pi's (or the other device's)
 * own report, and only while that report is fresh.
 */
export function anchorSwingGeometry(
    row: Pick<AnchorWatchRowPresentation, 'keeper'>,
    local: AnchorSwingGeometry,
    shore: Pick<ShoreAlarmSnapshot, 'position' | 'stale' | 'lastContactAt'>,
): AnchorSwingGeometry {
    if (row.keeper === 'phone') return local;
    const remote = shore.position;
    if (!row.keeper || !remote || shore.stale || shore.lastContactAt === null) return NO_SWING;
    return {
        radiusM: remote.swingRadius,
        offsetM: remote.distance,
        bearingDeg: calculateBearing(
            remote.vessel.latitude,
            remote.vessel.longitude,
            remote.anchor.latitude,
            remote.anchor.longitude,
        ),
    };
}

/**
 * Changes when the hero's remote swing arc would visibly move: whole metres
 * and 5° steps. The Vessel page subscribes to this beside the tile key so the
 * arc follows the Pi without re-rendering on every identical report.
 */
export function shoreSwingKey(
    shore: Pick<ShoreAlarmSnapshot, 'sessionCode' | 'position' | 'stale' | 'cause' | 'lastContactAt'>,
    piSessionCode: string | null,
): string {
    const geometry = anchorSwingGeometry(presentAnchorWatchRow(null, shore, piSessionCode), NO_SWING, shore);
    return `${Math.round(geometry.radiusM)}|${Math.round(geometry.offsetM)}|${Math.round(geometry.bearingDeg / 5)}`;
}

export interface AnchorTilePresentation {
    /** For the Vessel hero card: at anchor, dragging, or not at anchor. */
    status: 'armed' | 'disarmed' | 'alarm';
    /** The quarter-width tile's one status line. */
    label: string;
    /** What VoiceOver hears after "Anchor watch, ". */
    spoken: string;
    tone: 'cyan' | 'amber' | 'red' | 'off';
}

/**
 * The Vessel page's Anchor tile, worded from the same row as the System
 * status box so the two can never disagree.
 *
 * The tile used to read this phone's own watch plus "a shore session exists".
 * So a watch only the Pi kept read "Up", a paused watch read "Up", a drag
 * alarm reported by the Pi stayed a calm cyan "Down · Pi", and a session
 * joined from another phone was credited to the Pi (review 2026-09-29).
 */
export function presentAnchorTile(row: AnchorWatchRowPresentation): AnchorTilePresentation {
    if (!row.active) return { status: 'disarmed', label: 'Up', spoken: 'up', tone: 'off' };
    const who = row.keeper === 'pi' ? 'Pi' : row.keeper === 'other' ? 'Remote' : null;
    const by =
        row.keeper === 'pi' ? ', watched by the Pi' : row.keeper === 'other' ? ', watched from another device' : '';
    const down = who ? `Down · ${who}` : 'Down';
    switch (row.condition) {
        case 'alarm':
            return { status: 'alarm', label: 'DRAGGING', spoken: `dragging${by}`, tone: 'red' };
        case 'drifting':
            return {
                status: 'armed',
                label: 'Drifting',
                spoken: `drifting outside the swing circle${by}`,
                tone: 'red',
            };
        case 'no-data':
            return { status: 'armed', label: 'No data', spoken: `down${by}, no current data`, tone: 'red' };
        case 'paused':
            return { status: 'armed', label: 'Paused', spoken: 'down, watch paused', tone: 'amber' };
        case 'setting':
            return { status: 'armed', label: 'Setting', spoken: 'setting the watch', tone: 'amber' };
        case 'expiring':
            return { status: 'armed', label: down, spoken: `down${by}, watch authorisation expiring`, tone: 'amber' };
        case 'waiting':
            return { status: 'armed', label: down, spoken: `down${by}, waiting for data`, tone: 'amber' };
        case 'no-updates':
            return { status: 'armed', label: down, spoken: `down${by}, no updates on this phone`, tone: 'amber' };
        default:
            return { status: 'armed', label: down, spoken: `down${by}`, tone: 'cyan' };
    }
}
