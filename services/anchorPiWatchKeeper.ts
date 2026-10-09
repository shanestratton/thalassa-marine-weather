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
import {
    authoriseRelay,
    clearWatchOnPi,
    handOffToPi,
    RENEW_INTERVAL_MS,
    sendAssignmentToPi,
    type PiWatchAssignment,
} from './anchorPiHandoff';
import {
    judgePiMove,
    piAnchorMatches,
    piMoveWords,
    type LatLonPoint,
    type PiMoveLive,
    type PiMoveResult,
    type PiMoveVerdict,
} from './anchorPiMove';
import { piCache } from './PiCacheService';
import { authScopedStorageKey, getAuthIdentityScope } from './authIdentityScope';
import { pinnedPiRequest } from './PiPairingService';
import type { SyncBroadcast } from './AnchorWatchSyncService';
import { calculateBearing, calculateDistance } from '../utils/navigationCalculations';
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
/**
 * iOS's own words for a failed connection, turned into something a skipper can
 * act on from the cockpit.
 *
 * URLSession returns NSURLErrorNotConnectedToInternet — "The Internet
 * connection appears to be offline." — when there is no route to the host,
 * which on this app's addresses almost always means the phone is off the boat
 * network with the tailnet down, NOT that the phone has no internet. Shane saw
 * exactly that on 2026-09-03: the phone on home Wi-Fi, the Pi healthy, and its
 * boat-LAN address (192.168.1.180) only reachable through the tailnet's subnet
 * route — which his iPhone was not connected to. The literal message sent him
 * looking at his internet, which was fine.
 */
function describeTransportFailure(message: string): string {
    const offline = /offline|not connected to the internet|network is unreachable|no route to host/i.test(message);
    const timedOut = /timed? ?out/i.test(message);
    if (offline) {
        // Any VPN, not one brand: most boats reach their network from ashore
        // some other way, or not at all (Thalassa is a global app).
        return 'Your phone cannot reach the boat’s network — join the boat’s Wi-Fi, or turn on the VPN you use to reach her';
    }
    if (timedOut) {
        return 'The Pi did not answer in time — it may be asleep or off the network';
    }
    return `Could not reach the Pi (${message})`;
}

/**
 * One request to one address. Says whether the TRANSPORT failed, because that
 * is the case worth retrying somewhere else.
 */
async function askPiCapability(
    baseUrl: string,
    timeoutMs: number,
): Promise<{ result: PiWatchCapability; transportFailed: boolean }> {
    try {
        const res = await pinnedPiRequest({
            url: `${baseUrl}/api/anchor/capability`,
            connectTimeout: 3_000,
            readTimeout: timeoutMs,
            responseType: 'text',
        });
        if (res.status < 200 || res.status >= 300) {
            log.warn(`Pi watch: capability probe to ${baseUrl} answered HTTP ${res.status}`);
            return {
                result: { capable: false, reason: `The Pi answered ${res.status}`, hasFix: false },
                transportFailed: false,
            };
        }
        const body = typeof res.data === 'string' ? (JSON.parse(res.data) as unknown) : null;
        if (!body || typeof body !== 'object') {
            log.warn(`Pi watch: capability probe to ${baseUrl} returned an unreadable body`);
            return {
                result: { capable: false, reason: 'The Pi sent something unreadable', hasFix: false },
                transportFailed: false,
            };
        }
        const parsed = body as { capable?: unknown; reason?: unknown; hasFix?: unknown };
        const result = {
            capable: parsed.capable === true,
            reason: typeof parsed.reason === 'string' ? parsed.reason : null,
            hasFix: parsed.hasFix === true,
        };
        if (!result.capable) {
            log.warn(`Pi watch: the Pi says it cannot keep the watch — ${result.reason ?? 'no reason given'}`);
        }
        return { result, transportFailed: false };
    } catch (err) {
        // log.warn, not log.info: createLogger silences info() in production
        // builds, and the shipped iOS bundle is one — which is how this
        // subsystem stayed silent through six attempts.
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`Pi watch: capability probe to ${baseUrl} failed — ${message}`);
        return {
            result: { capable: false, reason: describeTransportFailure(message), hasFix: false },
            transportFailed: true,
        };
    }
}

/**
 * Can the Pi keep this watch?
 *
 * ASK THE PI, NOT THE CACHED MIRROR. This used to start with
 * resolvePiWatchTarget(), which returns null unless piCache's cached status
 * already says `reachable` — a mirror refreshed by a health poll that backs
 * off to five-minute intervals and that nothing on the anchor page can force.
 * So it answered "no Pi" without sending a packet.
 *
 * AND ASK AT THE RIGHT ADDRESS. getBaseUrl() returns the BOAT-LAN host until
 * checkHealth's ladder has flipped _useRemote to the tailnet address, and that
 * ladder runs only on the same backed-off poll. Measured 2026-09-03 with Shane
 * ashore at Newport: the probe reached the Pi's LAN IP and iOS answered
 * NSURLErrorNotConnectedToInternet — "Could not reach the Pi (The Internet
 * connection appears to be offline.)" — while the Pi was healthy on its 100.x
 * address the whole time. A phone off the boat could therefore never be
 * offered the handoff, which is precisely the phone that needs it.
 *
 * So a transport failure runs the ladder once and asks again. Only a transport
 * failure: a Pi that answers "no, I cannot" is a real answer, not a wrong
 * address, and re-pinging on it would poll the boat's LAN for nothing.
 */
export async function probePiWatchCapability(timeoutMs = 4_000): Promise<PiWatchCapability> {
    const baseUrl = piCache.getBaseUrl();
    if (!baseUrl) {
        log.warn('Pi watch: no Pi host is configured on this phone — not offering the watch');
        return { capable: false, reason: 'No Pi is set up on this phone yet', hasFix: false };
    }

    const first = await askPiCapability(baseUrl, timeoutMs);
    if (!first.transportFailed) return first.result;

    log.warn('Pi watch: transport failed — running the health ladder in case the phone has left the boat LAN');
    try {
        await piCache.ping();
    } catch (err) {
        log.warn(`Pi watch: health check itself failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    // Try, in order, whatever the ladder now says, then the tailnet address
    // outright. The second matters on its own: _useRemote only flips when
    // checkHealth's own remote probe succeeded, so a phone whose health tick
    // failed at BOTH addresses is left pointing at the boat LAN — and never
    // asks the off-boat address at all, which is the one that would work.
    const candidates: string[] = [];
    const laddered = piCache.getBaseUrl();
    if (laddered && laddered !== baseUrl) candidates.push(laddered);
    const remote = piCache.getRemoteBaseUrl();
    if (remote && remote !== baseUrl && !candidates.includes(remote)) candidates.push(remote);
    if (candidates.length === 0) return first.result;

    for (const url of candidates) {
        log.warn(`Pi watch: retrying the capability probe at ${url}`);
        const next = await askPiCapability(url, timeoutMs);
        if (!next.transportFailed) return next.result;
    }
    return first.result;
}

/**
 * Auth-scoped so account B can never inherit account A's Pi assignment.
 *
 * THE DURABLE HOLE this closes: `current` was memory only. After iOS killed
 * the app — which it will, overnight, on a phone in a pocket — it came back
 * null, so renew() returned at `if (!held) return` and the six-hour lease
 * simply lapsed. And nothing re-offered: the offer loop is gated on
 * viewMode === 'watching', which a shore-mode phone never is. So the Pi went
 * quiet a few hours in, permanently, while the phone showed a session it
 * believed was healthy.
 */
const KEEPER_STATE_KEY = 'thalassa_pi_watch_assignment';

/**
 * A move sent to the Pi gets this long to answer at each address. iOS's
 * PiTlsPlugin reads only readTimeout (its URLRequest timeoutInterval, which
 * covers the connect too); connectTimeout is for the transports that use it.
 */
const MOVE_TIMEOUTS = { connectTimeout: 3_000, readTimeout: 8_000 };
/**
 * After a move nobody answered, a report of the OLD anchor counts only once it
 * was heard this long after giving up: one sent before the Pi took the move
 * may still have been on its way (the Pi reports every 10 s).
 */
const PI_MOVE_SETTLE_MS = 15_000;
/**
 * How long a move nobody answered waits for the Pi's own report before the
 * renewal re-sends the move's point (in step with the shore link's silence
 * ladder, which asks for a renewal after two minutes of hearing nothing). A
 * Pi that reports settles it within half a minute; one that has no watch to
 * report on never will.
 */
const PI_MOVE_UNKNOWN_LIMIT_MS = 120_000;
/**
 * The boat's LAN counts as answering "now" for this long after piCache's
 * health tick last reached it (every 30 s while it does).
 */
const LAN_ANSWER_FRESH_MS = 75_000;
const NOT_KEEPING: PiMoveResult = {
    ok: false,
    outcome: 'invalid',
    error: 'This phone is not keeping a Pi watch to move.',
};
/**
 * A second move while the first is unknown would leave three points the Pi
 * might be watching. Shore Watch only offers Move on fresh reports, and the
 * next one settles the first within half a minute, so it waits for that.
 */
const STILL_UNKNOWN: PiMoveResult = {
    ok: false,
    outcome: 'invalid',
    error: 'The Pi has not shown which point it is watching yet. Wait for its next report, then try again.',
};
const ENDED_MEANWHILE: PiMoveResult = {
    ok: false,
    outcome: 'invalid',
    error: 'The watch ended while the move was on its way.',
};

/** A watch handed to the Pi, as this phone holds it. */
interface HeldWatch {
    assignment: PiWatchAssignment;
    target: PiWatchTarget;
    /**
     * Where the Pi's watch was first set (126-07a). A move must stay within
     * the rode's reach of it, so the mark cannot be walked across the bay one
     * move at a time. A record saved before 126 has none: its anchor stands in.
     */
    centreAtSet: LatLonPoint;
}

/**
 * A move of the Pi's mark, until the Pi's own report settles it. 'sent': the
 * Pi said yes (2xx); 'confirmed': its report shows the new anchor; 'unknown':
 * no address answered, so it may or may not have taken it.
 */
export type PiMoveStatus = 'sent' | 'confirmed' | 'unknown';

export interface PiMovePending {
    target: LatLonPoint;
    previous: LatLonPoint;
    status: PiMoveStatus;
    /** When it was answered, or given up on. */
    at: number;
}

interface HeldMove extends PiMovePending {
    /** The assignment with the new mark: adopted if the Pi's report shows it. */
    assignment: PiWatchAssignment;
    /** The account it belongs to; another account never sees it. */
    scopeKey: string;
}

const isPoint = (value: unknown): value is LatLonPoint => {
    const p = value as LatLonPoint | null;
    return !!p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
};

const anchorOf = (assignment: PiWatchAssignment): LatLonPoint => ({
    latitude: assignment.anchorLat,
    longitude: assignment.anchorLon,
});

class AnchorPiWatchKeeperClass {
    private renewTimer: ReturnType<typeof setInterval> | null = null;
    private current: HeldWatch | null = null;
    private pending: HeldMove | null = null;
    /** begin, renew and a move, one at a time: a renewal must never land between a move and its answer. */
    private queue: Promise<unknown> = Promise.resolve();
    private moveWatchOff: (() => void) | null = null;
    private moveWatchArming = false;

    /** Write-through, so a kill between renewals cannot lose the watch. */
    private persist(): void {
        try {
            const key = authScopedStorageKey(KEEPER_STATE_KEY);
            const move = this.pending && this.pending.scopeKey === getAuthIdentityScope().key ? this.pending : null;
            if (this.current)
                localStorage.setItem(key, JSON.stringify({ ...this.current, pending: move ?? undefined }));
            else localStorage.removeItem(key);
        } catch {
            /* private mode / quota — the in-memory watch still runs */
        }
    }

    private serial<T>(work: () => Promise<T>): Promise<T> {
        const run = this.queue.then(work);
        this.queue = run.catch(() => undefined);
        return run;
    }

    /**
     * Bring a watch back after the app was killed, and resume renewing it.
     *
     * Called once at launch. Safe to call when there is nothing to restore,
     * and refuses to clobber a live in-memory watch.
     */
    restore(): boolean {
        if (this.current) return true;
        try {
            const raw = localStorage.getItem(authScopedStorageKey(KEEPER_STATE_KEY));
            if (!raw) return false;
            const saved = JSON.parse(raw) as {
                assignment?: PiWatchAssignment;
                target?: PiWatchTarget;
                centreAtSet?: unknown;
                pending?: Partial<HeldMove>;
            };
            if (!saved?.assignment?.sessionCode || !saved.target?.baseUrl || !saved.target.relayId) {
                localStorage.removeItem(authScopedStorageKey(KEEPER_STATE_KEY));
                return false;
            }
            this.current = {
                assignment: saved.assignment,
                target: saved.target,
                centreAtSet: isPoint(saved.centreAtSet) ? saved.centreAtSet : anchorOf(saved.assignment),
            };
            const move = saved.pending;
            this.pending =
                move &&
                (move.status === 'sent' || move.status === 'confirmed' || move.status === 'unknown') &&
                isPoint(move.target) &&
                isPoint(move.previous) &&
                move.assignment?.sessionCode === saved.assignment.sessionCode
                    ? {
                          target: move.target,
                          previous: move.previous,
                          status: move.status,
                          at: Number(move.at) || Date.now(),
                          assignment: move.assignment,
                          scopeKey: getAuthIdentityScope().key,
                      }
                    : null;
            log.warn(
                `Pi watch restored after relaunch (session ${saved.assignment.sessionCode})${this.pending ? ` with a move ${this.pending.status}` : ''} — renewing`,
            );
            if (this.pending && this.pending.status !== 'confirmed') this.armMoveWatch();
            this.startRenewing();
            void this.renew();
            return true;
        } catch {
            return false;
        }
    }

    /** True once the PI is keeping the watch. False means the phone carries on
     *  alone, which is the behaviour that existed before this module. */
    isKeeping(): boolean {
        return this.current !== null;
    }

    /** The session the Pi is currently broadcasting, for the UI to show. */
    keepingSessionCode(): string | null {
        return this.current?.assignment.sessionCode ?? null;
    }

    /** Where the Pi's watch was first set, for the Move anchor sheet's reach check. */
    centreAtSet(): LatLonPoint | null {
        return this.current ? { ...this.current.centreAtSet } : null;
    }

    /**
     * Whether this phone is off the boat, for the Move anchor sheet's caution.
     *
     * Aboard only while the boat's LAN answers NOW. The address that last took
     * the watch is not enough on its own: a watch handed over aboard keeps its
     * LAN address until a renewal answers at the tailnet, which may be an hour
     * after the skipper stepped ashore. So piCache's own health tick (every
     * 30 s while the LAN answers) is asked too, and anything short of a recent
     * LAN answer counts as ashore: the caution said aboard costs one line, and
     * missing it ashore costs more.
     */
    answersFromAshore(): boolean {
        const held = this.current;
        if (!held) return false;
        const remote = piCache.getRemoteBaseUrl();
        if (remote && held.target.baseUrl === remote) return true;
        const base = piCache.getBaseUrl();
        const status = piCache.getStatus();
        const lanAnswersNow =
            status.reachable && !!base && base !== remote && Date.now() - status.lastCheck <= LAN_ANSWER_FRESH_MS;
        return !lanAnswersNow;
    }

    /** The latest move of the Pi's mark, for this account, until the next watch. */
    getPending(): PiMovePending | null {
        const move = this.pending;
        if (!move || !this.current || move.scopeKey !== getAuthIdentityScope().key) return null;
        return { target: { ...move.target }, previous: { ...move.previous }, status: move.status, at: move.at };
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
        return this.serial(() => this.beginLocked(assignment));
    }

    private async beginLocked(assignment: PiWatchAssignment): Promise<boolean> {
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

        // The SAME address ladder the capability probe uses. Without this the
        // probe could reach the Pi on the tailnet, raise the offer, and then
        // the handoff would post to the boat-LAN address and fail — asking a
        // question at one address and acting on the answer at another.
        const addresses = [target.baseUrl];
        const remote = piCache.getRemoteBaseUrl();
        if (remote && remote !== target.baseUrl) addresses.push(remote);

        let took = false;
        for (const baseUrl of addresses) {
            took = await handOffToPi(assignment, target.relayId, baseUrl);
            if (took) {
                target = { ...target, baseUrl };
                break;
            }
            log.warn(`Pi watch: the Pi at ${baseUrl} did not take the watch`);
        }
        if (!took) {
            log.warn('Pi did not take the watch at any known address; the phone keeps it');
            return false;
        }
        // A new watch: its own first centre, and no move yet.
        this.current = { assignment, target, centreAtSet: anchorOf(assignment) };
        this.pending = null;
        this.disarmMoveWatch();
        this.persist();
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
        this.persist();
        if (!held) return;
        await clearWatchOnPi(held.target.baseUrl);
        log.info('Shore watch handed back from the Pi');
    }

    /**
     * Move the mark of the watch the Pi keeps (126-07a): Shore Watch's Move
     * anchor on the phone that handed the watch over.
     *
     * A re-POST of the assignment with the new anchor, and nothing else. The
     * Pi's /api/anchor/watch replaces a watch in place (its drag count starts
     * again), so no Pi change is needed. No re-authorise: the hourly renewal
     * already holds the relay binding, and authorising again mid-watch would
     * only reset it. Never end(), never begin().
     *
     * The guards are judged again here (judgePiMove), whatever the sheet said:
     * this is the authority. The live parts (the Pi's latest fix, an alarm,
     * lost GPS) come from Shore Watch's latest report; the circle, the rode and
     * where the watch was first set are this keeper's own.
     *
     * Judged twice. At the tap, so a stale one is refused at once. And when
     * its turn comes, with the newest report Shore Watch has heard by then: a
     * renewal ahead of it in the queue can spend half a minute on a boat-LAN
     * address that no longer answers, and the fix from the tap may have aged
     * past 30 s while fresh reports kept coming.
     */
    async relocate(lat: number, lon: number, live: PiMoveLive): Promise<PiMoveResult> {
        const held = this.current;
        if (!held) return NOT_KEEPING;
        const atTap = judgeMoveOf(held, lat, lon, live, Date.now());
        if (!atTap.ok) return notSent(atTap);
        return this.serial(() => this.relocateLocked(lat, lon, live));
    }

    private async relocateLocked(lat: number, lon: number, tapped: PiMoveLive): Promise<PiMoveResult> {
        if (!this.current) return NOT_KEEPING;
        const live = await latestPiLive(tapped, this.current.assignment.sessionCode);
        const held = this.current;
        if (!held) return NOT_KEEPING;
        if (this.getPending()?.status === 'unknown') return STILL_UNKNOWN;
        const target = { latitude: lat, longitude: lon };
        const verdict = judgeMoveOf(held, lat, lon, live, Date.now());
        if (!verdict.ok) return notSent(verdict);
        const next: PiWatchAssignment = { ...held.assignment, anchorLat: lat, anchorLon: lon };
        const previous = anchorOf(held.assignment);
        // The SAME ladder begin() and renew() use: the boat's LAN, then the tailnet.
        const via = resolvePiWatchTarget() ?? held.target;
        const addresses = [via.baseUrl];
        const remote = piCache.getRemoteBaseUrl();
        if (remote && remote !== via.baseUrl) addresses.push(remote);

        for (const baseUrl of addresses) {
            const answer = await sendAssignmentToPi(next, baseUrl, MOVE_TIMEOUTS);
            if (answer.taken) {
                const still = this.current;
                if (!still) {
                    // Weighed while the move was on its way: that DELETE may
                    // have landed first. The anchor coming up wins.
                    log.warn(`Pi anchor move landed after the watch was ended; telling the Pi at ${baseUrl} to stop`);
                    await clearWatchOnPi(baseUrl);
                    return ENDED_MEANWHILE;
                }
                const ashore = !!remote && baseUrl === remote;
                this.current = { ...still, assignment: next, target: { ...via, baseUrl } };
                this.setPending({ assignment: next, target, previous, status: 'sent', at: Date.now() });
                const m = Math.round(calculateDistance(previous.latitude, previous.longitude, lat, lon) * 1852);
                const bearing = Math.round(calculateBearing(previous.latitude, previous.longitude, lat, lon)) % 360;
                log.warn(
                    `Pi anchor moved ${m} m at ${String(bearing).padStart(3, '0')}°T (${ashore ? 'from ashore' : 'aboard'}, ${baseUrl})`,
                );
                return { ok: true, ashore };
            }
            if (answer.status !== null) {
                // A real answer, not a wrong address: nothing changed, and
                // asking the same Pi elsewhere would only ask it again.
                log.warn(
                    `Pi anchor move refused (HTTP ${answer.status})${answer.error ? ` — ${answer.error}` : ''}; the Pi keeps the old point`,
                );
                return { ok: false, outcome: 'refused', error: piMoveWords('refused') };
            }
        }

        if (!this.current) {
            for (const baseUrl of addresses) await clearWatchOnPi(baseUrl);
            return ENDED_MEANWHILE;
        }
        // Nobody answered, so the Pi may have taken it. Until its own report
        // says which point it is watching, renew() re-sends neither; if none
        // has come within PI_MOVE_UNKNOWN_LIMIT_MS, it re-sends the new point.
        this.setPending({ assignment: next, target, previous, status: 'unknown', at: Date.now() });
        log.warn(
            `Pi anchor move unknown: no answer at ${addresses.join(', ')}; neither point re-sent until the Pi reports (the new one after ${PI_MOVE_UNKNOWN_LIMIT_MS / 60_000} min)`,
        );
        return { ok: false, outcome: 'unknown', error: piMoveWords('unknown') };
    }

    private setPending(move: Omit<HeldMove, 'scopeKey'>): void {
        this.pending = { ...move, scopeKey: getAuthIdentityScope().key };
        this.persist();
        if (move.status !== 'confirmed') this.armMoveWatch();
    }

    /**
     * The Pi took a move re-sent after no report settled it: the new point is
     * the watch now, and the Pi's next report confirms it. A report that
     * already confirmed it while the re-send was on its way stands.
     */
    private adoptResentMove(move: HeldMove, target: PiWatchTarget): void {
        const held = this.current;
        if (!held) return;
        this.current = { ...held, assignment: move.assignment, target };
        const latest = this.pending;
        if (latest?.status === 'confirmed' && piAnchorMatches(latest.target, move.target)) this.persist();
        else
            this.setPending({
                assignment: move.assignment,
                target: move.target,
                previous: move.previous,
                status: 'sent',
                at: Date.now(),
            });
        log.warn(`Pi anchor move re-sent: the Pi at ${target.baseUrl} took the new point`);
    }

    /**
     * Listen for the Pi's own report while a move is unsettled, even with the
     * Anchor Watch page closed. Imported when needed: the sync service already
     * imports this keeper on demand, so a static import here would be a cycle.
     */
    private armMoveWatch(): void {
        if (this.moveWatchOff || this.moveWatchArming) return;
        this.moveWatchArming = true;
        void import('./AnchorWatchSyncService')
            .then(({ AnchorWatchSyncService }) => {
                this.moveWatchArming = false;
                if (this.moveWatchOff || !this.pending || this.pending.status === 'confirmed') return;
                this.moveWatchOff = AnchorWatchSyncService.onBroadcast((data) =>
                    this.hearReport(data, AnchorWatchSyncService.getState().sessionCode),
                );
            })
            .catch((err) => {
                this.moveWatchArming = false;
                log.warn(`Pi anchor move: could not listen for the Pi's report — ${String(err)}`);
            });
    }

    private disarmMoveWatch(): void {
        const off = this.moveWatchOff;
        this.moveWatchOff = null;
        off?.();
    }

    /** The Pi's report of the anchor it is watching settles a move. */
    private hearReport(data: SyncBroadcast, sessionCode: string | null): void {
        const held = this.current;
        const move = this.pending;
        if (!held || !move || move.status === 'confirmed') {
            this.disarmMoveWatch();
            return;
        }
        if (data.type !== 'position' || sessionCode !== held.assignment.sessionCode) return;
        if (piAnchorMatches(data.anchor, move.target)) {
            if (move.status === 'unknown') {
                // It did take it: the new mark is the watch now.
                this.current = { ...held, assignment: move.assignment };
                log.warn(
                    "Pi anchor move confirmed by the Pi's own report after no answer: it is watching the new point",
                );
            }
            this.pending = { ...move, status: 'confirmed' };
            this.persist();
            this.disarmMoveWatch();
            return;
        }
        if (
            move.status === 'unknown' &&
            Date.now() - move.at >= PI_MOVE_SETTLE_MS &&
            piAnchorMatches(data.anchor, anchorOf(held.assignment))
        ) {
            log.warn("Pi anchor move unknown: the Pi's report shows it kept the old point");
            this.pending = null;
            this.persist();
            this.disarmMoveWatch();
        }
    }

    private startRenewing(): void {
        this.stopRenewing();
        // Renewal is the whole reason this timer exists: the relay grants six
        // hours and the app refreshes inside that, so a watch that runs
        // overnight does not quietly lapse at 3 a.m.
        this.renewTimer = setInterval(() => void this.renew(), RENEW_INTERVAL_MS);
        // A timer in a backgrounded WKWebView is not a promise. Renew the
        // moment the app is alive again too — handOffToPi is idempotent, so an
        // extra renew costs one request and buys back a lease that may have
        // been minutes from lapsing while the phone slept.
        void (async () => {
            try {
                const { App } = await import('@capacitor/app');
                const handle = await App.addListener('appStateChange', ({ isActive }) => {
                    if (isActive && this.current) void this.renew();
                });
                this.foregroundHandle = handle;
            } catch {
                /* web build — the interval alone */
            }
        })();
    }

    private foregroundHandle: { remove: () => void } | null = null;

    private stopRenewing(): void {
        if (this.foregroundHandle) {
            try {
                this.foregroundHandle.remove();
            } catch {
                /* already gone */
            }
            this.foregroundHandle = null;
        }
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
    /**
     * Re-authorise and re-assign, on demand.
     *
     * Public because the shore link's silence ladder calls it: a channel
     * rejoin cannot repair a lapsed lease or a Pi that rebooted, and after two
     * minutes of hearing nothing that is the likelier fault.
     */
    async renewNow(): Promise<PiRenewal> {
        if (!this.current) return false;
        const renewed = await this.renew();
        return this.current ? renewed : false;
    }

    /**
     * 'assigned': the Pi took the watch again. 'authorised': the cloud renewed
     * the Pi's week (the renewal Shore Watch's "ends soon" asks for) but no
     * address could re-send the Pi the watch, as for a skipper ashore with no
     * route to the boat. False: neither (126-03b).
     */
    private async renew(): Promise<PiRenewal> {
        return this.serial(() => this.renewLocked());
    }

    private async renewLocked(): Promise<PiRenewal> {
        const held = this.current;
        if (!held) return false;
        let authorised = false;
        // The Pi may have moved (remote access) or dropped off the tailnet.
        const target = resolvePiWatchTarget() ?? held.target;
        // A move nobody answered (126-07a): the Pi is watching the old point or
        // the new one, and re-sending the old could silently undo a move it
        // took. So while its own report may yet say which, only the
        // authorisation is renewed and neither point is re-sent.
        const unsettled = this.pending?.status === 'unknown' ? this.pending : null;
        const waitedMs = unsettled ? Date.now() - unsettled.at : 0;
        if (unsettled && waitedMs < PI_MOVE_UNKNOWN_LIMIT_MS) {
            authorised = await authoriseRelay(target.relayId, held.assignment.sessionCode);
            log.warn(
                `Pi watch renewal: a move is unconfirmed, so only the authorisation was renewed (${authorised ? 'ok' : 'failed'})`,
            );
            return authorised ? 'authorised' : false;
        }
        // …but not for ever. A Pi that rebooted, or whose lease lapsed, holds
        // no watch and so sends no report: waiting for one would leave the boat
        // unwatched until someone is aboard, with every renewal (the silence
        // ladder's repair among them) re-sending nothing. So past the limit the
        // MOVE's point is re-sent: the skipper's own choice, which passed every
        // guard. A Pi already watching it just starts that watch again.
        const assignment = unsettled ? unsettled.assignment : held.assignment;
        if (unsettled) {
            log.warn(
                `Pi anchor move unknown for ${Math.round(waitedMs / 1000)} s with no report from the Pi to settle it: re-sending the new point`,
            );
        }
        // The SAME ladder begin() and the capability probe use. Without it a
        // renewal from ashore posted only to the boat-LAN address and failed,
        // so the lease lapsed for exactly the phone that had left the boat.
        const addresses = [target.baseUrl];
        const remote = piCache.getRemoteBaseUrl();
        if (remote && remote !== target.baseUrl) addresses.push(remote);
        for (const baseUrl of addresses) {
            if (await handOffToPi(assignment, target.relayId, baseUrl, () => (authorised = true))) {
                if (!this.current) {
                    // Weighed while this was on its way: its DELETE may have
                    // landed first. The anchor coming up wins.
                    log.warn(`Pi watch renewal landed after the watch was ended; telling the Pi at ${baseUrl} to stop`);
                    await clearWatchOnPi(baseUrl);
                    return false;
                }
                if (unsettled) {
                    this.adoptResentMove(unsettled, { ...target, baseUrl });
                    return 'assigned';
                }
                // Remember which address answered so teardown uses it too.
                if (this.current === held) {
                    this.current = { ...held, target: { ...target, baseUrl } };
                    this.persist();
                }
                return 'assigned';
            }
        }
        // Do NOT tear down: the phone is still broadcasting, and the next
        // renew may well succeed once the Pi is reachable again. Forgetting
        // the watch here would mean never trying it again this session.
        log.warn(
            `Pi watch renewal failed at every known address (${addresses.join(', ')}); will try again at the next interval`,
        );
        return authorised ? 'authorised' : false;
    }
}

export type PiRenewal = 'assigned' | 'authorised' | false;

/** The guards for moving this watch's mark to (lat, lon), with the live parts given. */
function judgeMoveOf(held: HeldWatch, lat: number, lon: number, live: PiMoveLive, now: number): PiMoveVerdict {
    return judgePiMove({
        ...live,
        now,
        target: { latitude: lat, longitude: lon },
        swingRadiusM: held.assignment.swingRadius,
        centreAtSet: held.centreAtSet,
        rodeLength: held.assignment.rodeLength,
        waterDepth: held.assignment.waterDepth,
    });
}

function notSent(verdict: Extract<PiMoveVerdict, { ok: false }>): PiMoveResult {
    log.warn(`Pi anchor move not sent: ${verdict.lead}`);
    return { ok: false, outcome: 'invalid', error: verdict.error };
}

/**
 * The live parts of a move as Shore Watch has heard them by now: the fix the
 * page passed at the tap, or a newer one from the Pi's latest report for this
 * watch, with its alarm if it reports one. Imported when needed, as for the
 * move listener (the sync service imports this keeper on demand).
 */
async function latestPiLive(live: PiMoveLive, sessionCode: string): Promise<PiMoveLive> {
    try {
        const { AnchorWatchSyncService } = await import('./AnchorWatchSyncService');
        if (AnchorWatchSyncService.getState().sessionCode !== sessionCode) return live;
        const report = AnchorWatchSyncService.getLatestPosition();
        const fix = report?.vessel;
        if (!report || !fix || !(fix.timestamp > (live.boatFix?.timestamp ?? Number.NEGATIVE_INFINITY))) return live;
        return { boatFix: fix, alarm: live.alarm || report.isAlarm === true, gpsLost: live.gpsLost };
    } catch {
        return live;
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
