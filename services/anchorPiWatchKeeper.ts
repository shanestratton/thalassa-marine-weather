/**
 * anchorPiWatchKeeper — the missing middle of the Pi shore watch.
 *
 * anchorPiHandoff knew HOW to hand the watch over and pi-cache's
 * AnchorWatchRunner knew how to keep it, but nothing ever called either: the
 * handoff module had no caller in the app and the Pi had no /api/anchor/watch
 * route to receive an assignment (found 2026-09-03, when Shane asked how the
 * phone connects to a Pi that is keeping the watch — the answer was that it
 * could not).
 *
 * This module owns the part that was missing: WHEN. It resolves the paired Pi,
 * hands the assignment over, keeps the six-hour authorisation renewed while
 * the watch runs, and gives it back when the watch stops.
 *
 * ── The phone keeps broadcasting too, on purpose ──────────────────────────
 * This does not switch the phone off. The Pi exists because a phone in a bunk
 * gets backgrounded by iOS and leaves the boat in a pocket; while the app IS
 * awake and aboard, two reports of the same boat ten seconds apart are
 * agreement, not conflict — both read the same vessel, and the shore device
 * simply sees the more recent one. What the Pi adds is that the reports do not
 * stop when the phone sleeps, which is the entire point of the feature.
 *
 * ── Nothing here throws ───────────────────────────────────────────────────
 * A Pi that is asleep, unpaired, or on the far side of a dead tailnet must
 * never break the anchor watch the phone is already keeping. Every failure
 * path returns false and leaves the phone doing exactly what it does today.
 */
import { clearWatchOnPi, handOffToPi, RENEW_INTERVAL_MS, type PiWatchAssignment } from './anchorPiHandoff';
import { piCache } from './PiCacheService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AnchorPiWatchKeeper');

/** Where to send the assignment, and which relay to authorise for it. */
export interface PiWatchTarget {
    baseUrl: string;
    relayId: string;
}

/**
 * The paired, reachable Pi — or null, which is the ordinary case ashore.
 *
 * relayId is the Pi's PUBLIC identity, reported by its own /status; it is not
 * the bearer token, which never leaves the Pi.
 */
export function resolvePiWatchTarget(): PiWatchTarget | null {
    const status = piCache.getStatus();
    if (!status.reachable) return null;
    const relayId = status.diaryRelayId;
    if (!relayId) return null;
    const baseUrl = piCache.getBaseUrl();
    if (!baseUrl) return null;
    return { baseUrl, relayId };
}

class AnchorPiWatchKeeperClass {
    private renewTimer: ReturnType<typeof setInterval> | null = null;
    private current: { assignment: PiWatchAssignment; target: PiWatchTarget } | null = null;

    /** True once the PI is keeping the watch. False means the phone carries on
     *  alone, which is the behaviour that existed before this module. */
    isKeeping(): boolean {
        return this.current !== null;
    }

    /** The session the Pi is currently broadcasting, for the UI to show. */
    keepingSessionCode(): string | null {
        return this.current?.assignment.sessionCode ?? null;
    }

    /**
     * Hand this watch to the boat's Pi, and keep it handed over.
     *
     * Idempotent for the same assignment: re-calling with an unchanged session
     * code, anchor and radius does nothing, so an effect that re-runs on every
     * snapshot cannot restart the Pi's loop ten times a minute.
     */
    async begin(assignment: PiWatchAssignment): Promise<boolean> {
        if (this.current && sameAssignment(this.current.assignment, assignment)) return true;
        const target = resolvePiWatchTarget();
        if (!target) return false;

        const took = await handOffToPi(assignment, target.relayId, target.baseUrl);
        if (!took) {
            log.info('Pi did not take the watch; the phone keeps it');
            return false;
        }
        this.current = { assignment, target };
        this.startRenewing();
        log.info(`Pi is keeping the shore watch for session ${assignment.sessionCode}`);
        return true;
    }

    /**
     * Give the watch back.
     *
     * Best effort by design: the six-hour authorisation lapsing is what
     * actually guarantees a Pi stops broadcasting, so a Pi that never hears
     * this cannot keep publishing a position for long.
     */
    async end(): Promise<void> {
        this.stopRenewing();
        const held = this.current;
        this.current = null;
        if (!held) return;
        await clearWatchOnPi(held.target.baseUrl);
        log.info('Shore watch handed back from the Pi');
    }

    private startRenewing(): void {
        this.stopRenewing();
        // Renewal is the whole reason this timer exists: the relay grants six
        // hours and the app refreshes inside that, so a watch that runs
        // overnight does not quietly lapse at 3 a.m.
        this.renewTimer = setInterval(() => void this.renew(), RENEW_INTERVAL_MS);
    }

    private stopRenewing(): void {
        if (this.renewTimer) {
            clearInterval(this.renewTimer);
            this.renewTimer = null;
        }
    }

    /**
     * Re-authorise and re-assign.
     *
     * Re-ASSIGNING matters as much as re-authorising: the Pi deliberately does
     * not persist its assignment, so one that rebooted since the last renew
     * comes back knowing nothing, and this is what puts it back to work.
     */
    private async renew(): Promise<void> {
        const held = this.current;
        if (!held) return;
        // The Pi may have moved (remote access) or dropped off the tailnet.
        const target = resolvePiWatchTarget() ?? held.target;
        const ok = await handOffToPi(held.assignment, target.relayId, target.baseUrl);
        if (ok) {
            this.current = { assignment: held.assignment, target };
            return;
        }
        // Do NOT tear down: the phone is still broadcasting, and the next
        // renew may well succeed once the Pi is reachable again. Forgetting
        // the watch here would mean never trying it again this session.
        log.warn('Pi watch renewal failed; will try again at the next interval');
    }
}

function sameAssignment(a: PiWatchAssignment, b: PiWatchAssignment): boolean {
    return (
        a.sessionCode === b.sessionCode &&
        a.anchorLat === b.anchorLat &&
        a.anchorLon === b.anchorLon &&
        a.swingRadius === b.swingRadius
    );
}

export const AnchorPiWatchKeeper = new AnchorPiWatchKeeperClass();
