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
        return 'Your phone cannot reach the boat network — check Tailscale is on, or join the boat’s Wi-Fi';
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
    /**
     * Re-authorise and re-assign, on demand.
     *
     * Public because the shore link's silence ladder calls it: a channel
     * rejoin cannot repair a lapsed lease or a Pi that rebooted, and after two
     * minutes of hearing nothing that is the likelier fault.
     */
    async renewNow(): Promise<boolean> {
        if (!this.current) return false;
        await this.renew();
        return this.current !== null;
    }

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
