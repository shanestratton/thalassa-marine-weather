/**
 * Guard-zone alerts outlive the screen that happened to be open.
 *
 * Detection runs app-wide (AisGuardWatch), but the alert was owned by a
 * component mounted ONLY on the chart surface, holding its list in local
 * state. Two consequences, both bad:
 *
 *   - an alert raised while the skipper was on any other page was heard by
 *     nobody, because no listener existed;
 *   - returning to the chart replayed nothing, because the state died with
 *     the component.
 *
 * And AisGuardZone is EDGE-triggered — `activeAlertMmsis` alerts once per
 * entry and not again while the vessel stays inside. So losing the alert did
 * not mean "you will be told again in a moment". It meant the warning was
 * gone for as long as that vessel remained in your guard ring.
 *
 * The store listens at module scope, so it is running before any screen is,
 * and holds every alert until it is explicitly acknowledged.
 *
 * Build 125 (125-01): the collision alarm shares this one alert path — one
 * card per vessel, so a ring entry and a CPA alarm for the same ship never
 * stack as two. The store also holds the skipper's per-target mutes and
 * acknowledgements, and the collision watch's honest notices ('blind',
 * 'paused'), so the banner and the (lazily loaded) alarm service read one
 * truth. It stays small: it ships with the app shell.
 */
import type { CollisionAlertDetail, CollisionLostDetail, CollisionLostReason, GuardAlert } from './AisGuardZone';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AisGuardAlerts');

const MAX_HELD = 5;
const MUTE_MS = 30 * 60_000;

export type CollisionAlertCard = GuardAlert & { collision: CollisionAlertDetail };

export const COLLISION_BLIND_NOTICE = 'Collision watch blind: no AIS for 60 s';
export const COLLISION_PAUSED_NOTICE =
    'Collision watch paused: Thalassa is in the background without a track or anchor watch';
export const COLLISION_NO_FIX_NOTICE = 'Collision watch: no position fix, so no CPA';
export const COLLISION_NO_MOTION_NOTICE = 'Collision watch: our own course and speed are unknown, so no CPA';
export const COLLISION_STOPPED_NOTICE = 'Collision watch: stopped, so it stays quiet until you make 0.5 kn';
export const COLLISION_UNCHECKED_NOTICE =
    'Collision alarm off until its sound check: turn the shield off and on again to run it';

/** What the armed collision watch can honestly say about itself. Null = not armed. */
export interface CollisionWatchNotice {
    state: 'watching' | 'blind' | 'paused' | 'resumed' | 'no-fix' | 'no-motion' | 'stopped' | 'unchecked';
    since: number;
    pausedFrom?: number;
    resumedAt?: number;
}

const LOST_WORDS: Record<CollisionLostReason, string> = {
    'no-fix': 'no position fix',
    'own-motion-unknown': 'our course and speed unknown',
    'target-motion-unknown': 'her course or speed unknown',
    'report-too-old': 'her last report is over 10 min old',
    gone: 'no longer reported',
};

function ago(sec: number): string {
    return sec < 60 ? `${Math.max(0, Math.round(sec))} s` : `${Math.round(sec / 60)} min`;
}

/** The words the card and the lock-screen alert share. */
export function collisionLines(
    card: CollisionAlertCard,
    nowMs = Date.now(),
): { cpa: string; where: string; age: string } {
    const c = card.collision;
    const nm = (x: number) => (x < 1 ? x.toFixed(2) : x.toFixed(1));
    const sec = c.reportAgeSec;
    const old = sec == null ? 'age unknown' : `${ago(sec)} old`;
    const when =
        c.tcpaMin < 0 ? 'passed, opening' : c.tcpaMin < 1 ? 'within a minute' : `in ${Math.round(c.tcpaMin)} min`;
    const cpa = `CPA ${nm(c.cpaNm)} NM ${when}`;
    const where = `${String(Math.round(card.bearing)).padStart(3, '0')}° · ${card.distanceNm.toFixed(1)} NM`;
    if (c.lost) {
        // Lost: the numbers are the last ones computed, said as such.
        return {
            cpa: `CPA unknown: ${LOST_WORDS[c.lost.reason]}`,
            where: `last ${where}`,
            age: `last ${cpa}, ${ago((nowMs - c.lost.lastCpaAt) / 1000)} ago`,
        };
    }
    return { cpa, where, age: c.source === 'local' ? `AIS ${old}` : `internet AIS, ${old}` };
}

let alerts: GuardAlert[] = [];
let notice: CollisionWatchNotice | null = null;
const listeners = new Set<(a: GuardAlert[]) => void>();
const noticeListeners = new Set<(n: CollisionWatchNotice | null) => void>();
/** Per-target mute expiry (ms). Never consulted for close quarters. */
const mutes = new Map<number, number>();
/** Close-quarters encounters the skipper acknowledged (never a mute: it lasts only this encounter). */
const acks = new Set<number>();
/** The alarm service hears the card's button at once, not on its next pass. */
const actionListeners = new Set<(nowMs: number) => void>();

function emit(): void {
    for (const l of listeners) l(alerts);
}

/** Collision cards first (close quarters, then danger, then passed), then ring entries. */
function rank(a: GuardAlert): number {
    if (!a.collision) return 3;
    if (a.collision.cleared) return 2;
    return a.collision.closeQuarters ? 0 : 1;
}

function settle(next: GuardAlert[]): void {
    alerts = next.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_HELD);
    emit();
}

function ingest(incoming: GuardAlert[]): void {
    if (!incoming?.length) return;
    // Newest first, one entry per vessel: a second alert for a vessel already
    // being warned about should refresh it, not stack up beside it. A
    // collision card is the stronger warning and is never replaced by a ring one.
    const byMmsi = new Map<number, GuardAlert>();
    for (const a of alerts) if (a.collision) byMmsi.set(a.mmsi, a);
    for (const a of [...incoming, ...alerts]) if (!byMmsi.has(a.mmsi)) byMmsi.set(a.mmsi, a);
    settle([...byMmsi.values()]);
    log.warn(`AIS guard: ${incoming.length} vessel(s) in the ring — ${alerts.length} awaiting acknowledgement`);
}

if (typeof window !== 'undefined') {
    window.addEventListener('ais-guard-alert', (e: Event) => {
        ingest((e as CustomEvent<GuardAlert[]>).detail);
    });
}

export const AisGuardAlertStore = {
    get(): GuardAlert[] {
        return alerts;
    },

    subscribe(listener: (a: GuardAlert[]) => void): () => void {
        listeners.add(listener);
        listener(alerts);
        return () => listeners.delete(listener);
    },

    /** Explicit acknowledgement — the only thing that removes an alert. */
    dismiss(mmsi: number): void {
        alerts = alerts.filter((a) => a.mmsi !== mmsi);
        emit();
    },

    /** Identity change / sign-out: this account's warnings are not the next one's. */
    clear(): void {
        alerts = [];
        mutes.clear();
        acks.clear();
        notice = null;
        emit();
        for (const l of noticeListeners) l(notice);
    },

    /**
     * The collision alarm's cards for the vessels sounding now, and the
     * encounters that ended this pass. Only an ended encounter's card is
     * marked cleared: shown clear ('passed'), or lost and never shown clear
     * ('lost'). A card is never relabelled because its vessel merely dropped
     * off the list, and it stays until the skipper dismisses it: a warning
     * never vanishes on its own.
     */
    setCollision(
        cards: CollisionAlertCard[],
        _nowMs = Date.now(),
        ended: ReadonlyMap<number, { how: 'passed' } | { how: 'lost'; lost: CollisionLostDetail }> = new Map(),
    ): void {
        // Called on every AIS update: a quiet sea must not re-render the banner each time.
        if (cards.length === 0 && ended.size === 0) return;
        const live = new Map(cards.map((c) => [c.mmsi, c]));
        const kept = alerts
            .filter((a) => !live.has(a.mmsi))
            .map((a) => {
                const end = ended.get(a.mmsi);
                if (!a.collision || a.collision.cleared || !end) return a;
                const lost = end.how === 'lost' ? { lost: end.lost } : {};
                return { ...a, collision: { ...a.collision, ...lost, cleared: true } };
            });
        settle([...live.values(), ...kept]);
    },

    /** The skipper switched the collision watch off: its cards go, never relabelled as passed. */
    dropCollision(): void {
        if (!alerts.some((a) => a.collision)) return;
        alerts = alerts.filter((a) => !a.collision);
        emit();
    },

    /**
     * The card's one button. Danger: silence it and mute that vessel for 30
     * minutes. Close quarters: acknowledge this encounter only, never a mute.
     * A card whose danger has passed is simply dismissed.
     */
    muteCollision(mmsi: number, nowMs = Date.now()): void {
        const card = alerts.find((a) => a.mmsi === mmsi && a.collision);
        if (card?.collision && !card.collision.cleared) {
            if (card.collision.closeQuarters) acks.add(mmsi);
            else mutes.set(mmsi, nowMs + MUTE_MS);
        }
        alerts = alerts.filter((a) => a.mmsi !== mmsi);
        emit();
        for (const l of actionListeners) l(nowMs);
    },

    subscribeActions(listener: (nowMs: number) => void): () => void {
        actionListeners.add(listener);
        return () => actionListeners.delete(listener);
    },

    mutedUntil(mmsi: number): number | null {
        return mutes.get(mmsi) ?? null;
    },

    /** Whether the skipper acknowledged close quarters in this encounter (it covers the lesser danger too). */
    acknowledged(mmsi: number): boolean {
        return acks.has(mmsi);
    },

    /** She is no longer alarming: the next approach is a new encounter. */
    endEncounter(mmsi: number): void {
        acks.delete(mmsi);
    },

    getWatchNotice(): CollisionWatchNotice | null {
        return notice;
    },

    setWatchNotice(next: CollisionWatchNotice | null): void {
        if (next?.state === notice?.state && next?.pausedFrom === notice?.pausedFrom) return;
        notice = next;
        for (const l of noticeListeners) l(notice);
    },

    subscribeNotice(listener: (n: CollisionWatchNotice | null) => void): () => void {
        noticeListeners.add(listener);
        listener(notice);
        return () => noticeListeners.delete(listener);
    },
};
