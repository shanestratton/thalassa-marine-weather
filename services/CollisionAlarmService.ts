/**
 * CollisionAlarmService — the collision alarm's voice (build 125, 125-01).
 *
 * services/AisGuardWatch.ts grades every target with the one collision rule
 * (utils/collisionRule.ts) on each pass and hands them all here. This decides
 * what sounds and says so:
 *
 *  - ENCOUNTERS, LATCHED. A vessel that alarms opens an encounter, and it ends
 *    only on evidence: a CPA computed with known motion on both sides showing
 *    her opening, or well outside the CAUTION box, held for 30 s (and, after
 *    close quarters, with her beyond 0.1 NM). Dropping off the alarm list is
 *    not evidence. When the watch loses what it needs (no fix, our own course
 *    or speed unknown, her report too old or gone) the card stays live as
 *    CPA UNKNOWN and keeps sounding; it is never relabelled as passed. A lost
 *    contact is held until ten minutes after her CPA was due, then kept as
 *    'not shown clear' until dismissed, and its lock-screen alert stays.
 *  - SOUND through AlarmAudioService under its own 'collision-watch' lease.
 *    Leases are owner-scoped, so clearing the collision alarm can never
 *    silence an anchor alarm, and this path never force-stops: the anchor
 *    keeps priority. The anchor's alarm overlay also sits above the card.
 *  - THE LOCK SCREEN through the shared safety-notification path
 *    (AnchorSafetyNotificationService, kind 'collision'): Time Sensitive,
 *    behind iOS's verified-enabled check, with its own ids. Focus lets it
 *    through only where the skipper allows Thalassa's Time Sensitive
 *    notifications; this file never claims more than that.
 *  - ONE CARD PER VESSEL on the guard's own alert path (aisGuardAlertStore):
 *    a ring entry and a CPA alarm for the same ship never stack as two.
 *  - A per-target mute (30 min) that never silences close quarters; close
 *    quarters can only be acknowledged, for that encounter.
 *  - HONEST NOTICES: 'blind' when no AIS has been heard for 60 s while armed
 *    (a swept-out target list is not a clear sea), 'paused' when Thalassa goes
 *    to the background with nothing to keep it running (iOS suspends it then,
 *    and a suspended app watches nothing), and 'stopped' / 'no motion' /
 *    'no fix' when the rule cannot alarm. The Pi's night watch (126-04) is the
 *    real cure for suspension; until then the app says so.
 *  - AT ANCHOR (125-01b): stopped with an anchor watch on, the rule still
 *    alarms close quarters with a vessel under way, and the strip says that
 *    ('at-anchor'), not 'stays quiet'. Blind there is on a 10 min line, for
 *    the strip and the lock screen alike: at anchor transponders (our own
 *    Class B included) report every 3 min, and on the 60 s line a quiet bay
 *    flickered blind all night. A dead receiver at anchor still reaches the
 *    lock screen, once. Stopped with the watch kept elsewhere (the Pi, or
 *    another device, away from us) the strip says so ('stopped-elsewhere').
 *    The anchor watch keeps its priority: its lease and overlay are untouched
 *    by this path.
 *  - The blind lock-screen notice posts once per silence (until AIS is heard
 *    again, or the watch is re-armed) and at most every 30 min, whatever the
 *    strip said in between: blind at anchor and then under way is one post.
 *  - At anchor, an encounter also ends once she is no longer under way
 *    (collisionSettled: us stopped, her 2 kn or less) for a full anchored
 *    report cycle (3 min), wherever she lies: two boats lying still never
 *    show as opening, and the acknowledgement must not outlive her stay.
 */
import { Capacitor } from '@capacitor/core';
import { AlarmAudioService } from './AlarmAudioService';
import { AnchorSafetyNotificationService } from './AnchorSafetyNotificationService';
import {
    AisGuardAlertStore,
    COLLISION_BLIND_AT_ANCHOR_NOTICE,
    COLLISION_BLIND_NOTICE,
    COLLISION_PAUSED_NOTICE,
    collisionLines,
    type CollisionAlertCard,
    type CollisionWatchNotice,
} from './aisGuardAlertStore';
import type { CollisionLostDetail, CollisionLostReason } from './AisGuardZone';
import { COLLISION_RULE, collisionShouldSound, type CollisionAssessment } from '../utils/collisionRule';
import { createLogger } from '../utils/createLogger';

const log = createLogger('CollisionAlarm');

/**
 * The latch's numbers live in the shared rule (126-04a), so the Pi's night
 * watch (pi-cache/src/aisWatch.ts) latches encounters exactly as this does:
 * blind after 60 s (10 min at anchor), clear on evidence held 30 s over 3
 * passes (a settled vessel 3 min), a lost contact held 10 min past her CPA,
 * the blind notice at most every 30 min.
 */
const LATCH = COLLISION_RULE.latch;
const LEASE_OWNER = 'collision-watch';
/** Plain (not Time Sensitive) local notices; ids clear of the anchor's 99001/991xx. */
const PAUSED_NOTICE_ID = 97_125_01;
const BLIND_NOTICE_ID = 97_125_02;

export interface CollisionAlarmCandidate {
    mmsi: number;
    name: string;
    assessment: CollisionAssessment;
    reportAgeSec: number | null;
    source: string;
    sogKn: number | null;
    /** utils/collisionRule.ts collisionOpening for this pass: positive evidence she is clear. */
    opening?: boolean;
    /** utils/collisionRule.ts collisionSettled: us stopped, her no longer under way (125-01b). */
    settled?: boolean;
}

/** What our own position and motion let the rule do this pass. */
export type CollisionOwnState = 'moving' | 'stopped' | 'unknown' | 'no-fix';

export interface CollisionPassStatus {
    nowMs: number;
    /** When AIS was last heard by any lane (0 = never). */
    lastAisAt: number;
    own?: CollisionOwnState;
    /** An anchor watch is on (AisGuardWatch.readCollisionInputs): stopped, close quarters still sounds. */
    atAnchor?: boolean;
    /** An anchor watch is on but kept elsewhere, not for this position: stopped, it stays quiet. */
    anchorWatchElsewhere?: boolean;
}

/** How an encounter ended: shown clear, or lost and never shown clear. */
export type CollisionEnd = { how: 'passed' } | { how: 'lost'; lost: CollisionLostDetail };

interface Encounter {
    /** The last pass she alarmed: its kind (close quarters or not) is the encounter's. */
    last: CollisionAlarmCandidate;
    lastAlarmAt: number;
    /** The newest pass with a computed CPA (alarming or not): the card's numbers. */
    latest: CollisionAlarmCandidate;
    latestAt: number;
    /** She was in close quarters at some point: the encounter needs her beyond 0.1 NM to end. */
    everCloseQuarters: boolean;
    clearSince: number | null;
    clearPasses: number;
    lost: { reason: CollisionLostReason; since: number } | null;
}

let armedAt: number | null = null;
const encounters = new Map<number, Encounter>();
let sounding = new Set<number>();
let leaseToken: string | null = null;
/** What the last pass asked for, set at once; the queued side effects catch up to it. */
let soundWanted = false;
let alertLive = false;
/** A contact was lost unresolved: leave its lock-screen alert where the skipper can see it. */
let keepLockScreenAlert = false;
let backgrounded = false;
let pausedFrom: number | null = null;
let lastBlindNoticeAt = Number.NEGATIVE_INFINITY;
let lifecycleAttached = false;
/** Bumped on every return to the foreground: a late 'background' answer is dropped. */
let lifecycleEpoch = 0;
let tail: Promise<void> = Promise.resolve();

/** Side effects run one at a time, in order, so the last state always wins. */
function run(operation: () => Promise<void>): void {
    tail = tail.then(operation).catch((error) => log.warn('collision alarm side effect failed:', error));
}

function lostDetail(e: Encounter): CollisionLostDetail | undefined {
    return e.lost ? { reason: e.lost.reason, sinceMs: e.lost.since, lastCpaAt: e.latestAt } : undefined;
}

function card(e: Encounter, nowMs: number): CollisionAlertCard {
    const c = e.latest;
    const a = c.assessment;
    const lost = lostDetail(e);
    return {
        mmsi: c.mmsi,
        name: c.name,
        distanceNm: Math.round(a.rangeNm * 100) / 100,
        bearing: Math.round(a.bearingDeg),
        sog: c.sogKn,
        cog: null,
        shipType: '',
        timestamp: nowMs,
        collision: {
            cpaNm: Math.round((a.cpaNm ?? 0) * 100) / 100,
            tcpaMin: Math.round((a.tcpaMin ?? 0) * 10) / 10,
            // The encounter's kind decides the button: close quarters is acknowledged, never muted.
            closeQuarters: e.last.assessment.closeQuarters,
            reportAgeSec: c.reportAgeSec,
            source: c.source,
            ...(lost ? { lost } : {}),
        },
    };
}

function setNotice(state: CollisionWatchNotice['state'], nowMs: number): void {
    const current = AisGuardAlertStore.getWatchNotice();
    // 'Was paused' stays until the skipper dismisses it, unless something worse replaces it.
    if ((state === 'watching' || state === 'at-anchor') && current?.state === 'resumed') return;
    if (current?.state === state) return;
    AisGuardAlertStore.setWatchNotice({ state, since: nowMs });
}

/** The plugin, imported once and shared: notices can fire back to back. */
let localNotificationsPlugin: Promise<typeof import('@capacitor/local-notifications')> | null = null;

async function localNotice(id: number, text: string): Promise<void> {
    const split = text.indexOf(': ');
    try {
        localNotificationsPlugin ??= import('@capacitor/local-notifications');
        const { LocalNotifications } = await localNotificationsPlugin.catch((error) => {
            localNotificationsPlugin = null;
            throw error;
        });
        await LocalNotifications.schedule({
            notifications: [{ id, title: text.slice(0, split), body: text.slice(split + 2) }],
        });
    } catch (error) {
        log.warn('collision watch notice could not be posted:', error);
    }
}

/** Why the watch cannot see her this pass, or null when it can. */
function blindReason(t: CollisionAlarmCandidate | undefined, own: CollisionOwnState): CollisionLostReason | null {
    if (own === 'no-fix') return 'no-fix';
    if (own === 'unknown') return 'own-motion-unknown';
    if (!t) return 'gone';
    if (t.assessment.rangeOnly) return t.assessment.reason ?? 'target-motion-unknown';
    return null;
}

/** Track every encounter against this pass's grades. Returns the ones that ended, and how. */
function track(targets: CollisionAlarmCandidate[], own: CollisionOwnState, nowMs: number): Map<number, CollisionEnd> {
    const byMmsi = new Map(targets.map((t) => [t.mmsi, t]));
    for (const t of targets) {
        if (!t.assessment.alarm) continue;
        const e = encounters.get(t.mmsi);
        encounters.set(t.mmsi, {
            last: t,
            lastAlarmAt: nowMs,
            latest: t,
            latestAt: nowMs,
            everCloseQuarters: (e?.everCloseQuarters ?? false) || t.assessment.closeQuarters,
            clearSince: null,
            clearPasses: 0,
            lost: null,
        });
    }

    const ended = new Map<number, CollisionEnd>();
    for (const [mmsi, e] of encounters) {
        const t = byMmsi.get(mmsi);
        if (t?.assessment.alarm) continue;
        const blind = blindReason(t, own);
        if (blind) {
            e.clearSince = null;
            e.clearPasses = 0;
            e.lost = e.lost?.reason === blind ? e.lost : { reason: blind, since: e.lost?.since ?? nowMs };
            const cpaDueAt = e.latestAt + Math.max(0, e.latest.assessment.tcpaMin ?? 0) * 60_000;
            if (nowMs > cpaDueAt + LATCH.lostHoldAfterCpaMs) ended.set(mmsi, { how: 'lost', lost: lostDetail(e)! });
            continue;
        }
        e.lost = null;
        e.latest = t!;
        e.latestAt = nowMs;
        // She is no longer under way and we are stopped: over, however close
        // she lies, once that holds a full anchored report cycle.
        const settled = t!.settled === true;
        const opening =
            settled ||
            (t!.opening === true &&
                (!e.everCloseQuarters || t!.assessment.rangeNm >= COLLISION_RULE.closeQuarters.cpaNm));
        if (!opening) {
            e.clearSince = null;
            e.clearPasses = 0;
            continue;
        }
        e.clearSince ??= nowMs;
        e.clearPasses += 1;
        const holdMs = settled ? LATCH.settledAfterMs : LATCH.clearAfterMs;
        if (nowMs - e.clearSince >= holdMs && e.clearPasses >= LATCH.clearMinPasses) {
            ended.set(mmsi, { how: 'passed' });
        }
    }
    for (const [mmsi, end] of ended) {
        encounters.delete(mmsi);
        AisGuardAlertStore.endEncounter(mmsi);
        // Never shown clear: whatever reached the lock screen stays there.
        if (end.how === 'lost') keepLockScreenAlert = true;
    }
    return ended;
}

/** Decide what sounds now, from the open encounters and the skipper's mutes. */
function reconcile(nowMs: number, ended: ReadonlyMap<number, CollisionEnd> = new Map()): void {
    const cards: CollisionAlertCard[] = [];
    for (const e of encounters.values()) {
        const closeQuarters = e.last.assessment.closeQuarters;
        if (!collisionShouldSound({ alarm: true, closeQuarters }, AisGuardAlertStore.mutedUntil(e.last.mmsi), nowMs)) {
            continue;
        }
        if (AisGuardAlertStore.acknowledged(e.last.mmsi)) continue;
        cards.push(card(e, nowMs));
    }
    // Close quarters first, then the soonest.
    cards.sort(
        (x, y) =>
            Number(y.collision.closeQuarters) - Number(x.collision.closeQuarters) ||
            x.collision.tcpaMin - y.collision.tcpaMin,
    );
    AisGuardAlertStore.setCollision(cards, nowMs, ended);

    const next = new Set(cards.map((c) => c.mmsi));
    const fresh = cards.find((c) => !sounding.has(c.mmsi));
    sounding = next;
    // This runs on every AIS update: queue work only when the sound must
    // start or stop, a new vessel must be announced, or a failed start retried.
    const wantSound = sounding.size > 0;
    if (!fresh && wantSound === soundWanted && !(wantSound && leaseToken === null)) return;
    soundWanted = wantSound;

    run(async () => {
        // Act on the LATEST intent, not on what was true when this was queued.
        if (soundWanted && !leaseToken) {
            leaseToken = await AlarmAudioService.acquire(LEASE_OWNER).catch((error) => {
                log.warn('collision alarm audio could not start:', error);
                return null;
            });
        } else if (!soundWanted && leaseToken) {
            const token = leaseToken;
            leaseToken = null;
            await AlarmAudioService.release(token).catch(() => AlarmAudioService.releaseEventually(token));
        }

        if (fresh && sounding.has(fresh.mmsi)) {
            const lines = collisionLines(fresh);
            const title = `${fresh.collision.closeQuarters ? 'Close quarters' : 'Collision risk'}: ${fresh.name}`;
            const body = `${lines.cpa}, ${lines.where} away. ${lines.age}.`;
            alertLive = true;
            // A new alert replaces whatever a lost contact left on the lock screen.
            keepLockScreenAlert = false;
            await AnchorSafetyNotificationService.scheduleSafetyAlert('collision', title, body).catch((error) =>
                log.warn('collision lock-screen alert could not be scheduled:', error),
            );
        } else if (!soundWanted && alertLive) {
            alertLive = false;
            // A contact lost unresolved keeps its alert on the lock screen: the
            // danger was never shown to pass.
            if (keepLockScreenAlert) return;
            await AnchorSafetyNotificationService.cancelSafetyAlert('collision').catch((error) =>
                log.warn('collision lock-screen alert could not be withdrawn:', error),
            );
        }
    });
}

async function keepAliveActive(): Promise<boolean> {
    // A browser tab has nothing that keeps it running once hidden.
    if (!Capacitor.isNativePlatform()) return false;
    try {
        // A voyage track, an anchor watch or MOB holds the background GPS
        // engine, which is what keeps iOS from suspending the app.
        const { BgGeoManager } = await import('./BgGeoManager');
        return (await BgGeoManager.getLeaseState()).active;
    } catch {
        return false;
    }
}

/** Gone to the background: decide 'paused' once the keep-alive answer is in, unless we came back first. */
async function wentToBackground(): Promise<void> {
    const epoch = lifecycleEpoch;
    const keepAlive = await keepAliveActive();
    if (epoch !== lifecycleEpoch) return;
    await CollisionAlarmService.onBackground(keepAlive);
}

function attachLifecycle(): void {
    if (lifecycleAttached) return;
    lifecycleAttached = true;
    if (Capacitor.isNativePlatform()) {
        // 'pause' / 'resume' are iOS's didEnterBackground / willEnterForeground.
        // Not appStateChange: that fires on willResignActive, so Control
        // Centre, a call or Siri would read as a pause the watch never had.
        void import('@capacitor/app')
            .then(({ App }) => {
                void App.addListener('pause', () => void wentToBackground());
                void App.addListener('resume', () => CollisionAlarmService.onForeground());
            })
            .catch(() => undefined);
        return;
    }
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void wentToBackground();
        else CollisionAlarmService.onForeground();
    });
}

function arm(nowMs: number): void {
    if (armedAt !== null) return;
    armedAt = nowMs;
    attachLifecycle();
}

AisGuardAlertStore.subscribeActions((nowMs) => {
    if (armedAt !== null) reconcile(nowMs);
});

export const CollisionAlarmService = {
    /**
     * One pass of the armed watch: every target the rule graded (alarming or
     * not), what our own motion allowed, and when AIS was last heard.
     */
    update(targets: CollisionAlarmCandidate[], status: CollisionPassStatus): void {
        const { nowMs, lastAisAt } = status;
        const own = status.own ?? 'moving';
        arm(nowMs);
        reconcile(nowMs, track(targets, own, nowMs));

        if (pausedFrom !== null) return;
        if (own === 'no-fix') return setNotice('no-fix', nowMs);
        if (own === 'unknown') return setNotice('no-motion', nowMs);
        const atAnchor = own === 'stopped' && status.atAnchor === true;
        // Stopped at a berth, nothing can sound, so a quiet receiver is not news.
        if (own === 'stopped' && !atAnchor) {
            return setNotice(status.anchorWatchElsewhere === true ? 'stopped-elsewhere' : 'stopped', nowMs);
        }
        const silentSince = Math.max(lastAisAt, armedAt!);
        const blind = nowMs - silentSince >= (atAnchor ? LATCH.atAnchorBlindAfterMs : LATCH.blindAfterMs);
        if (
            blind &&
            backgrounded &&
            // Once per silence: nothing heard since the last post, it already went.
            silentSince > lastBlindNoticeAt &&
            nowMs - lastBlindNoticeAt >= LATCH.blindNoticeEveryMs
        ) {
            lastBlindNoticeAt = nowMs;
            void localNotice(BLIND_NOTICE_ID, atAnchor ? COLLISION_BLIND_AT_ANCHOR_NOTICE : COLLISION_BLIND_NOTICE);
        }
        setNotice(blind ? (atAnchor ? 'blind-at-anchor' : 'blind') : atAnchor ? 'at-anchor' : 'watching', nowMs);
    },

    /** Armed, but no position: no ring and no CPA. Said, not hidden; live encounters stay live. */
    noFix(nowMs: number): void {
        CollisionAlarmService.update([], { nowMs, lastAisAt: 0, own: 'no-fix' });
    },

    /** The shield is armed from before build 125: the collision part waits for its sound check. */
    unchecked(nowMs: number): void {
        // Every pass: settle once, then stay quiet (no notice churn).
        if (armedAt === null && encounters.size === 0 && AisGuardAlertStore.getWatchNotice()?.state === 'unchecked') {
            return;
        }
        CollisionAlarmService.disarm();
        AisGuardAlertStore.setWatchNotice({ state: 'unchecked', since: nowMs });
    },

    /** The skipper switched the watch off: stand down quietly. */
    disarm(): void {
        if (armedAt === null && !soundWanted && !leaseToken && !alertLive && encounters.size === 0) {
            AisGuardAlertStore.setWatchNotice(null);
            return;
        }
        armedAt = null;
        pausedFrom = null;
        for (const mmsi of encounters.keys()) AisGuardAlertStore.endEncounter(mmsi);
        encounters.clear();
        keepLockScreenAlert = false;
        // Switched off on purpose: its cards go with it, never relabelled as passed.
        AisGuardAlertStore.dropCollision();
        reconcile(Date.now());
        AisGuardAlertStore.setWatchNotice(null);
    },

    async onBackground(keepAlive: boolean, nowMs = Date.now()): Promise<void> {
        if (backgrounded) return;
        backgrounded = true;
        if (armedAt === null || keepAlive) return;
        pausedFrom = nowMs;
        AisGuardAlertStore.setWatchNotice({ state: 'paused', since: nowMs });
        await localNotice(PAUSED_NOTICE_ID, COLLISION_PAUSED_NOTICE);
    },

    onForeground(nowMs = Date.now()): void {
        lifecycleEpoch += 1;
        backgrounded = false;
        if (armedAt === null || pausedFrom === null) return;
        AisGuardAlertStore.setWatchNotice({ state: 'resumed', since: nowMs, pausedFrom, resumedAt: nowMs });
        pausedFrom = null;
    },

    /** Test seam: resolves once every queued side effect has run. */
    whenIdle(): Promise<void> {
        return tail;
    },

    /** Test seam. */
    __resetForTests(): void {
        armedAt = null;
        encounters.clear();
        sounding = new Set();
        leaseToken = null;
        soundWanted = false;
        alertLive = false;
        keepLockScreenAlert = false;
        backgrounded = false;
        pausedFrom = null;
        lastBlindNoticeAt = Number.NEGATIVE_INFINITY;
        lifecycleAttached = false;
        lifecycleEpoch = 0;
        tail = Promise.resolve();
    },
};
