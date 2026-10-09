/**
 * Who is watching (build 126, package 126-04a): the line under the AIS key's
 * shield. Pure, so every case is a table row in tests/CollisionWatchRow.test.ts.
 *
 * Two watchers can keep the collision watch aboard: this phone (its shield,
 * armed through the sound check) and the boat's Pi (pi-cache/src/aisWatch.ts),
 * which the shield arms and stands down too. The Pi's word comes over the boat
 * LAN, or ashore from the cloud row the Pi publishes; a word whose last pass is
 * over 30 s old is a Pi that is not answering, never one that is watching.
 * With no Pi paired there is no row: the key reads as it always did.
 *
 * The Pi counts as at anchor only while it keeps an anchor watch itself (its
 * own anchor runner): it cannot see one kept on a phone. When this phone puts
 * the boat at anchor and the Pi does not, the row says so in amber and asks
 * for the anchor watch to be handed to the Pi; otherwise the Pi grades her as
 * at a berth (or under way, as she swings) and its alarms are not the ones an
 * anchorage needs.
 *
 * Every device that armed the Pi keeps it armed (the Pi stands down when the
 * last of them disarms), so a phone whose own shield is off can see the Pi
 * still watching. From aboard it may stand the Pi down for everyone, with a
 * deliberate second tap (`action: 'stand-down-all'`).
 *
 * Until 126-04b the Pi cannot wake a locked phone, and the row says so
 * whenever the Pi is watching.
 */

export type PiWatchState = 'off' | 'armed' | 'blind' | 'no-fix';

/** The Pi's last pass older than this: not answering. */
export const PI_WATCH_STALE_MS = 30_000;

export const PI_WATCH_LOCKED_PHONE_NOTE = "The Pi can't wake a locked phone yet.";
export const PI_WATCH_HAND_ANCHOR_NOTE = 'Hand the anchor watch to the Pi so it grades her at anchor.';

export interface PhoneWatch {
    /** This phone's collision watch is armed (the shield, through its sound check). */
    armed: boolean;
    /**
     * Where this phone's anchor watch puts the boat, for the position it grades
     * (services/collisionAnchorWatch.ts): 'at-anchor' when a watch kept on this
     * phone or another device holds her here. Omitted: none.
     */
    anchorWatch?: 'at-anchor' | 'elsewhere' | 'none';
}

export interface PiWatchView {
    /** A Pi is paired with this phone. */
    paired: boolean;
    /** The Pi's latest word on its watch (LAN preferred), or null when none has arrived. */
    report: {
        state: PiWatchState;
        lastPassAt: number | null;
        via: 'lan' | 'cloud';
        /** The Pi keeps an anchor watch itself (LAN only; null when unknown). */
        atAnchor?: boolean | null;
    } | null;
    /** This phone reaches the Pi right now (the boat LAN, or her tailnet). */
    reachable: boolean;
    /** A change made on this phone that the Pi has not confirmed yet. */
    pending: 'arm' | 'disarm' | null;
    /** The Pi answers the LAN with no night watch at all (a Pi before Pi update 2). */
    noWatch?: boolean;
    /** This phone can send 'stand the Pi down for everyone' (its link to the Pi is running). */
    canStandDown?: boolean;
}

export interface CollisionWatchRow {
    text: string;
    tone: 'ok' | 'warn' | 'quiet';
    note: string | null;
    /** A control the row offers: stand the Pi down for every device (a confirmed, second tap). */
    action?: 'stand-down-all' | null;
}

const PI_SAYS: Record<'blind' | 'no-fix', string> = {
    blind: 'the Pi hears no AIS',
    'no-fix': 'the Pi has no position',
};

export function presentCollisionWatchRow(phone: PhoneWatch, pi: PiWatchView, nowMs: number): CollisionWatchRow | null {
    if (!pi.paired) return null;
    const report = pi.report;
    const piOn = report !== null && report.state !== 'off';
    const piFresh = piOn && report.lastPassAt !== null && nowMs - report.lastPassAt <= PI_WATCH_STALE_MS;

    // A Pi before Pi update 2: nothing there to arm or stand down, whatever this phone asked.
    if (pi.reachable && pi.noWatch) {
        return phone.armed
            ? { text: 'Watching: this phone only (this Pi has no night watch yet)', tone: 'quiet', note: null }
            : null;
    }

    // Stood down here, not yet on the Pi.
    if (pi.pending === 'disarm' && !phone.armed && !(report?.state === 'off')) {
        return pi.reachable
            ? { text: 'Standing the Pi down', tone: 'quiet', note: null }
            : { text: 'The Pi is still watching. Stand it down from aboard.', tone: 'warn', note: null };
    }

    if (piFresh) {
        const trouble = report.state === 'blind' || report.state === 'no-fix' ? PI_SAYS[report.state] : null;
        // At anchor here, not on the Pi: it cannot see a watch kept on a phone.
        const anchorUnseen = report.via === 'lan' && report.atAnchor === false && phone.anchorWatch === 'at-anchor';
        const aside =
            trouble ??
            (anchorUnseen ? "it can't see the anchor watch" : null) ??
            (report.via === 'cloud' ? "this phone can't reach it" : null);
        const who = phone.armed ? 'this phone and the Pi' : 'the Pi';
        const standDown =
            !phone.armed && report.via === 'lan' && pi.reachable && pi.pending === null && pi.canStandDown === true;
        return {
            text: `Watching: ${who}${aside ? ` (${aside})` : ''}`,
            tone: trouble || anchorUnseen ? 'warn' : 'ok',
            note: anchorUnseen ? PI_WATCH_HAND_ANCHOR_NOTE : PI_WATCH_LOCKED_PHONE_NOTE,
            ...(standDown ? { action: 'stand-down-all' as const } : {}),
        };
    }

    if (!phone.armed) {
        return piOn ? { text: "Not watching here (the Pi isn't answering)", tone: 'warn', note: null } : null;
    }

    if (piOn) return { text: "Watching: this phone only (the Pi isn't answering)", tone: 'warn', note: null };
    if (pi.pending === 'arm') {
        return pi.reachable
            ? { text: 'Watching: this phone (arming the Pi)', tone: 'quiet', note: null }
            : { text: "Watching: this phone only (the Pi isn't reachable)", tone: 'quiet', note: null };
    }
    if (report?.state === 'off') {
        return { text: "Watching: this phone only (the Pi's watch is off)", tone: 'quiet', note: null };
    }
    return pi.reachable
        ? { text: 'Watching: this phone only (this Pi has no night watch yet)', tone: 'quiet', note: null }
        : { text: "Watching: this phone only (the Pi isn't reachable)", tone: 'quiet', note: null };
}
