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
import { pinnedPiRequest } from './PiPairingService';
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

/** What the Pi says about its own fitness to keep a watch. */
export interface PiWatchCapability {
    capable: boolean;
    /** Plain words for the skipper when it cannot — never an error code. */
    reason: string | null;
    /** Whether the Pi can currently see the vessel, for the offer to say so. */
    hasFix: boolean;
}

/**
 * Ask the Pi whether it can actually keep the watch, before offering.
 *
 * A Pi that takes the watch and then reports "no-fix" forever is worse than
 * one that never offered: the skipper goes ashore believing the boat is being
 * watched. So the offer is only made when the Pi is paired, configured, and
 * can see the vessel on the bus right now.
 */
export async function probePiWatchCapability(timeoutMs = 4_000): Promise<PiWatchCapability> {
    // ── ASK THE PI, DO NOT ASK THE MIRROR ────────────────────────────────
    //
    // This used to start with `resolvePiWatchTarget()`, which returns null
    // unless piCache's CACHED status already says `reachable` and already
    // carries a diaryRelayId. That mirror is refreshed by a health poll that
    // backs off to five-minute intervals, and nothing on the anchor page can
    // make it refresh — so a phone whose last health tick failed answered
    // "there is no Pi" for the whole night, without ever sending a packet,
    // while `curl` to the same Pi from a laptop returned capable:true.
    //
    // Measured on Shane's own iPhone 2026-09-03: every app launch from
    // 06:26 to 13:04 reached the Pi within 1-2 s; every launch from 14:10
    // onward — including 15:40 and 15:44, the launches of the build that
    // carried the fixed offer — reached it not once. Six fixes to WHERE and
    // WHEN the offer was raised could not matter, because the probe was
    // returning false before any I/O.
    //
    // The Pi's /api/anchor/capability is always-200 and self-describing, and
    // asking it costs one small request on the boat's own LAN. relayId is
    // needed to HAND OVER, not to ASK — begin() still requires it.
    const baseUrl = piCache.getBaseUrl();
    if (!baseUrl) {
        log.warn('Pi watch: no Pi host is configured on this phone — not offering the watch');
        return { capable: false, reason: 'No Pi is set up on this phone yet', hasFix: false };
    }
    try {
        const res = await pinnedPiRequest({
            url: `${baseUrl}/api/anchor/capability`,
            connectTimeout: 3_000,
            readTimeout: timeoutMs,
            responseType: 'text',
        });
        if (res.status < 200 || res.status >= 300) {
            log.warn(`Pi watch: capability probe to ${baseUrl} answered HTTP ${res.status}`);
            return { capable: false, reason: `The Pi answered ${res.status}`, hasFix: false };
        }
        const body = typeof res.data === 'string' ? (JSON.parse(res.data) as unknown) : null;
        if (!body || typeof body !== 'object') {
            log.warn(`Pi watch: capability probe to ${baseUrl} returned an unreadable body`);
            return { capable: false, reason: 'The Pi sent something unreadable', hasFix: false };
        }
        const parsed = body as { capable?: unknown; reason?: unknown; hasFix?: unknown };
        const out = {
            capable: parsed.capable === true,
            reason: typeof parsed.reason === 'string' ? parsed.reason : null,
            hasFix: parsed.hasFix === true,
        };
        if (!out.capable) {
            log.warn(`Pi watch: the Pi says it cannot keep the watch — ${out.reason ?? 'no reason given'}`);
        }
        return out;
    } catch (err) {
        // An older Pi has no such route, a sleeping one answers nothing, and
        // an unpaired phone is refused natively with PIN_REQUIRED. They are
        // NOT the same thing to whoever reads this next, so say which.
        //
        // log.warn, not log.info: createLogger silences info() in production
        // builds (utils/createLogger.ts), and the shipped iOS bundle is a
        // production build — an info() here would be invisible on the device,
        // which is how this failure stayed silent through six attempts.
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Pi watch: capability probe to ${baseUrl} failed — ${message}`);
        return { capable: false, reason: `Could not reach the Pi (${message})`, hasFix: false };
    }
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
        // The probe above no longer consults piCache's cached mirror, so by
        // the time the skipper says yes that mirror may still be stale — and
        // this is the one place that genuinely needs `diaryRelayId`, which
        // only a successful /api/admin/status ever fills in. Force one health
        // check rather than failing with "the Pi would not take the watch"
        // over a boolean that was simply out of date.
        let target = resolvePiWatchTarget();
        if (!target) {
            log.warn('Pi watch: no target from the cached Pi status — forcing a health check before giving up');
            await piCache.ping();
            target = resolvePiWatchTarget();
        }
        if (!target) {
            log.warn('Pi watch: still no reachable, paired Pi with a relay id — the phone keeps the watch');
            return false;
        }

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
