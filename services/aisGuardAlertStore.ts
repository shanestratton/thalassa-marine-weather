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
 *
 * Build 125 (125-02): distress beacons ride the same stack, above every other
 * card. The watch (services/DistressAlarmService.ts, lazy) hands over every
 * beacon it classified; the store keeps the skipper's Silence and Dismiss per
 * activation (a new beacon, or one switched from test to active, starts
 * afresh) and which beacon Go to it is steering to.
 *
 * Build 126 (126-04a): the Pi keeps the night watch too, and one alarm per
 * vessel per encounter holds across every watcher aboard. An acknowledgement
 * made here is announced (subscribeAcks) so the Pi hears it
 * (services/piNightWatch.ts); one made on the Pi or another phone arrives
 * through services/piNightWatchStatus.ts: a DANGER is muted here until 30
 * minutes after it was muted aboard, close quarters is acknowledged for as
 * long as the Pi's encounter is open, and a distress is silenced with its
 * card kept. Those last two are
 * held apart from this phone's own (setPeerAcks), so they end with the Pi's
 * encounter or activation and never outlive it.
 */
import type { CollisionAlertDetail, CollisionLostDetail, CollisionLostReason, GuardAlert } from './AisGuardZone';
import type { DistressKind, DistressState } from '../utils/collisionRule';
import { createLogger } from '../utils/createLogger';

const log = createLogger('AisGuardAlerts');

const MAX_HELD = 5;
const MUTE_MS = 30 * 60_000;

export type CollisionAlertCard = GuardAlert & { collision: CollisionAlertDetail };

export const COLLISION_BLIND_NOTICE = 'Collision watch blind: no AIS for 60 s';
/** At anchor transponders report every 3 min: blind on a longer line there (125-01b review). */
export const COLLISION_BLIND_AT_ANCHOR_NOTICE = 'Collision watch blind: no AIS for 10 min';
export const COLLISION_PAUSED_NOTICE =
    'Collision watch paused: Thalassa is in the background without a track or anchor watch';
export const COLLISION_NO_FIX_NOTICE = 'Collision watch: no position fix, so no CPA';
export const COLLISION_NO_MOTION_NOTICE = 'Collision watch: our own course and speed are unknown, so no CPA';
/** Stopped at a berth (no anchor watch): nothing sounds (125-01b says which kind of stopped). */
export const COLLISION_STOPPED_NOTICE =
    'Collision watch: stopped with no anchor watch, so it stays quiet until you make 0.5 kn';
/** Stopped, an anchor watch on but kept elsewhere (the Pi, or another device, away from us): quiet. */
export const COLLISION_STOPPED_ELSEWHERE_NOTICE =
    'Collision watch: stopped, and the anchor watch is kept elsewhere, so it stays quiet until you make 0.5 kn';
/** Stopped with an anchor watch on: close quarters with a vessel under way still sounds (125-01b). */
export const COLLISION_AT_ANCHOR_NOTICE =
    'Collision watch at anchor: it still sounds for a vessel under way coming within 0.1 NM';
export const COLLISION_UNCHECKED_NOTICE =
    'Collision alarm off until its sound check: turn the shield off and on again to run it';

/** What the armed collision watch can honestly say about itself. Null = not armed. */
export interface CollisionWatchNotice {
    state:
        | 'watching'
        | 'blind'
        | 'paused'
        | 'resumed'
        | 'no-fix'
        | 'no-motion'
        | 'stopped'
        | 'stopped-elsewhere'
        | 'at-anchor'
        | 'blind-at-anchor'
        | 'unchecked';
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

// ── Distress beacons (125-02) ───────────────────────────────────────────────

/** One beacon as the distress watch last classified it. */
export interface DistressBeacon {
    mmsi: number;
    /** Its AIS name, if it sent one ('' otherwise). */
    name: string;
    kind: DistressKind;
    state: DistressState;
    /** 'local': heard by her own radio. 'cloud': relayed over the internet. */
    source: 'local' | 'cloud';
    /** Active and heard by her own radio: it sounds until silenced. */
    sounds: boolean;
    /** Null until a position report is heard. */
    lat: number | null;
    lon: number | null;
    /** Epoch ms of its newest report, position or text. */
    heardAt: number;
    /** From her own position at the watch's last pass; null without a fix or a beacon position. */
    rangeNm: number | null;
    bearingDeg: number | null;
}

export const DISTRESS_RELAYED_WORDS = 'Relayed via internet, not heard by your radio';

const DISTRESS_WORDS: Record<DistressKind, { card: string; name: string }> = {
    sart: { card: 'AIS-SART', name: 'AIS-SART' },
    mob: { card: 'MAN OVERBOARD BEACON', name: 'man overboard beacon' },
    epirb: { card: 'EPIRB-AIS', name: 'EPIRB-AIS' },
};

function agoWords(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `${s} s`;
    const min = Math.round(s / 60);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** The words a distress card, its buttons and the lock-screen alert share. */
export function distressLines(
    b: DistressBeacon,
    nowMs = Date.now(),
): { title: string; who: string; where: string; heard: string; label: string; alert: string; canGoTo: boolean } {
    const words = DISTRESS_WORDS[b.kind];
    const who = b.name || `MMSI ${b.mmsi}`;
    const canGoTo = b.lat !== null && b.lon !== null;
    const nm = (x: number) => (x < 1 ? x.toFixed(2) : x.toFixed(1));
    const where = !canGoTo
        ? 'Position not yet received'
        : b.rangeNm === null || b.bearingDeg === null
          ? 'Range unknown: no position fix'
          : `${String(Math.round(b.bearingDeg) % 360).padStart(3, '0')}° · ${nm(b.rangeNm)} NM`;
    const age = agoWords((nowMs - b.heardAt) / 1000);
    return {
        title:
            b.state === 'caution'
                ? `${words.card} HEARD: NOT ACTIVE OR TEST`
                : b.state === 'test'
                  ? `${words.card} TEST`
                  : `DISTRESS: ${words.card} ACTIVE`,
        who,
        where,
        heard: b.source === 'local' ? `Heard by your radio, ${age} ago` : `${DISTRESS_RELAYED_WORDS}, ${age} old`,
        label: `${words.name} ${who}`,
        alert: `Distress: ${b.kind === 'epirb' ? 'EPIRB-AIS beacon' : words.name} active`,
        canGoTo,
    };
}

let distress: DistressBeacon[] = [];
let distressSignature = '';
/** Per activation: cleared when a beacon goes active again, or is first heard by her own radio. */
const distressSilenced = new Set<number>();
const distressDismissed = new Set<number>();
let distressGoTo: number | null = null;
/** When Go to it was chosen (epoch ms): her own MOB marked later outranks it. */
let distressGoToAt: number | null = null;
/** Man Overboard pages open now: Go to it lasts while one is (one visit). */
let distressGoToHolders = 0;
const distressListeners = new Set<(d: DistressBeacon[]) => void>();

function emitDistress(): void {
    for (const l of distressListeners) l(distress);
}

function signatureOf(list: DistressBeacon[]): string {
    return list
        .map(
            (b) =>
                `${b.mmsi}|${b.name}|${b.kind}|${b.state}|${b.source}|${b.sounds}|${b.lat}|${b.lon}|${b.heardAt}|` +
                `${b.rangeNm === null ? '' : b.rangeNm.toFixed(2)}|${b.bearingDeg === null ? '' : Math.round(b.bearingDeg)}`,
        )
        .join(';');
}

/** Sounding now: active, heard by her own radio, not silenced in this activation (here or aboard). */
function distressSounding(b: DistressBeacon): boolean {
    return b.sounds && !distressSilenced.has(b.mmsi) && !peerDistress.has(b.mmsi);
}

function distressRank(b: DistressBeacon): number {
    if (distressSounding(b)) return 0;
    if (b.state === 'active') return b.source === 'local' ? 1 : 2;
    return 3;
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

/** What an acknowledgement settles, aboard (126-04a): the key is (kind, MMSI) for the open encounter. */
export type AlarmAckKind = 'collision' | 'close-quarters' | 'distress';
export interface AlarmAck {
    kind: AlarmAckKind;
    mmsi: number;
    nowMs: number;
}
/** Acknowledgements made on THIS phone, for the Pi (services/piNightWatch.ts). */
const ackListeners = new Set<(ack: AlarmAck) => void>();
/** Acknowledgements made on the Pi or another phone, while the Pi's alarm is open (piNightWatchStatus). */
let peerCloseQuarters = new Set<number>();
let peerDistress = new Set<number>();

function emitAck(kind: AlarmAckKind, mmsi: number, nowMs: number): void {
    for (const l of ackListeners) {
        try {
            l({ kind, mmsi, nowMs });
        } catch {
            /* One listener must not keep the acknowledgement from the others. */
        }
    }
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
    return a.size === b.size && [...a].every((x) => b.has(x));
}

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
        distress = [];
        distressSignature = '';
        distressSilenced.clear();
        distressDismissed.clear();
        distressGoTo = null;
        distressGoToAt = null;
        peerCloseQuarters = new Set();
        peerDistress = new Set();
        emit();
        for (const l of noticeListeners) l(notice);
        emitDistress();
    },

    // ── Distress beacons (125-02) ──

    /**
     * Every beacon the watch classified this pass. A beacon that goes active
     * (new, or switched from test) or is first heard by her own radio starts
     * a new activation: Silence and Dismiss start afresh, so it sounds again.
     */
    setDistress(next: DistressBeacon[], _nowMs = Date.now()): void {
        const previous = new Map(distress.map((b) => [b.mmsi, b]));
        for (const b of next) {
            const before = previous.get(b.mmsi);
            const activated = b.state === 'active' && before?.state !== 'active';
            const nowHeard = b.source === 'local' && before?.source === 'cloud';
            if (activated || nowHeard) {
                distressSilenced.delete(b.mmsi);
                distressDismissed.delete(b.mmsi);
            }
        }
        const signature = signatureOf(next);
        if (signature === distressSignature) return;
        distressSignature = signature;
        distress = next;
        emitDistress();
    },

    getDistress(): DistressBeacon[] {
        return distress;
    },

    subscribeDistress(listener: (d: DistressBeacon[]) => void): () => void {
        distressListeners.add(listener);
        listener(distress);
        return () => distressListeners.delete(listener);
    },

    /**
     * The cards to show, most urgent first: sounding, then heard and silenced,
     * then relayed, then cautions. A test beacon is drawn on the chart, not
     * carded; a relayed caution neither. A sounding card is never hidden.
     */
    distressCards(): DistressBeacon[] {
        return distress
            .filter((b) => b.state !== 'test' && !(b.state === 'caution' && b.source === 'cloud'))
            .filter((b) => distressSounding(b) || !distressDismissed.has(b.mmsi))
            .sort((a, b) => distressRank(a) - distressRank(b) || a.mmsi - b.mmsi);
    },

    /** Whether this beacon sounds now (active, heard by her radio, not silenced in this activation). */
    distressSounding(b: DistressBeacon): boolean {
        return distressSounding(b);
    },

    /** Silence: the sound and the lock-screen reminders stop; the card and the chart symbol stay. */
    silenceDistress(mmsi: number, nowMs = Date.now()): void {
        const fresh = !distressSilenced.has(mmsi);
        distressSilenced.add(mmsi);
        emitDistress();
        for (const l of actionListeners) l(nowMs);
        // Silenced here: silenced on the Pi and every phone aboard (126-04a).
        if (fresh) emitAck('distress', mmsi, nowMs);
    },

    /** Dismiss a silent card for this activation; the chart symbol stays. */
    dismissDistress(mmsi: number, nowMs = Date.now()): void {
        const fresh = !distressSilenced.has(mmsi);
        distressSilenced.add(mmsi);
        distressDismissed.add(mmsi);
        emitDistress();
        for (const l of actionListeners) l(nowMs);
        if (fresh) emitAck('distress', mmsi, nowMs);
    },

    distressSilenced(mmsi: number): boolean {
        return distressSilenced.has(mmsi);
    },

    distressDismissed(mmsi: number): boolean {
        return distressDismissed.has(mmsi);
    },

    /** Go to it: the Man Overboard page steers to this beacon and follows it. */
    goToDistress(mmsi: number, nowMs = Date.now()): void {
        distressGoTo = mmsi;
        distressGoToAt = nowMs;
        emitDistress();
    },

    stopDistressGoTo(): void {
        if (distressGoTo === null) return;
        distressGoTo = null;
        distressGoToAt = null;
        emitDistress();
    },

    getDistressGoTo(): number | null {
        return distressGoTo;
    },

    /** When Go to it was chosen, or null. */
    getDistressGoToAt(): number | null {
        return distressGoToAt;
    },

    /**
     * The Man Overboard page holds Go to it while it is open; the returned
     * release ends it once no page holds it. Go to it lasts one visit, so the
     * page never reopens hours later on an old beacon in place of the MOB
     * button (125-02 review). The release waits a tick: React's development
     * StrictMode unmounts and remounts at once, and that must not end it.
     */
    holdDistressGoTo(): () => void {
        distressGoToHolders += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            distressGoToHolders -= 1;
            setTimeout(() => {
                if (distressGoToHolders === 0) AisGuardAlertStore.stopDistressGoTo();
            }, 0);
        };
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
        const live = !!card?.collision && !card.collision.cleared;
        if (live) {
            if (card!.collision!.closeQuarters) acks.add(mmsi);
            else mutes.set(mmsi, nowMs + MUTE_MS);
        }
        alerts = alerts.filter((a) => a.mmsi !== mmsi);
        emit();
        for (const l of actionListeners) l(nowMs);
        // The same acknowledgement on the Pi and every phone aboard (126-04a).
        if (live) emitAck(card!.collision!.closeQuarters ? 'close-quarters' : 'collision', mmsi, nowMs);
    },

    // ── Acknowledgements aboard (126-04a) ──

    /** Acknowledgements made on this phone, for the Pi. */
    subscribeAcks(listener: (ack: AlarmAck) => void): () => void {
        ackListeners.add(listener);
        return () => ackListeners.delete(listener);
    },

    /**
     * The button on a card the Pi raised and this phone did not ('from the
     * Pi'): sent to the Pi, which settles it for every phone aboard. A DANGER
     * is muted here at once for its 30 minutes (time-bounded, so safe without
     * an encounter of this phone's own); close quarters and a distress wait
     * for the Pi's word, which arrives through setPeerAcks.
     */
    acknowledgePiAlarm(kind: AlarmAckKind, mmsi: number, nowMs = Date.now()): void {
        if (kind === 'collision') mutes.set(mmsi, Math.max(mutes.get(mmsi) ?? 0, nowMs + MUTE_MS));
        for (const l of actionListeners) l(nowMs);
        emitAck(kind, mmsi, nowMs);
    },

    /**
     * A DANGER acknowledged on the Pi or another phone: muted here until
     * `untilMs` (30 minutes from when it was muted aboard, on this phone's
     * clock), its card put away. Never shortens a longer mute made here.
     */
    applyPeerMute(mmsi: number, untilMs: number, nowMs = Date.now()): void {
        if (untilMs <= nowMs) return;
        mutes.set(mmsi, Math.max(mutes.get(mmsi) ?? 0, untilMs));
        // A mute never covers close quarters: that card stays.
        const before = alerts.length;
        alerts = alerts.filter(
            (a) => !(a.mmsi === mmsi && a.collision && !a.collision.cleared && !a.collision.closeQuarters),
        );
        if (alerts.length !== before) emit();
        for (const l of actionListeners) l(nowMs);
    },

    /**
     * The Pi's open alarms that a phone aboard acknowledged, replaced whole on
     * every word from the Pi: close quarters (which covers the lesser danger
     * too) and silenced beacons. They last only while the Pi's encounter or
     * activation is open, and go when the Pi goes quiet.
     */
    setPeerAcks(next: { closeQuarters: Iterable<number>; distress: Iterable<number> }, nowMs = Date.now()): void {
        const closeQuarters = new Set(next.closeQuarters);
        const distressNext = new Set(next.distress);
        const cqChanged = !sameSet(closeQuarters, peerCloseQuarters);
        const distressChanged = !sameSet(distressNext, peerDistress);
        if (!cqChanged && !distressChanged) return;
        peerCloseQuarters = closeQuarters;
        peerDistress = distressNext;
        if (cqChanged) {
            const before = alerts.length;
            alerts = alerts.filter((a) => !(a.collision && !a.collision.cleared && closeQuarters.has(a.mmsi)));
            if (alerts.length !== before) emit();
        }
        if (distressChanged) emitDistress();
        for (const l of actionListeners) l(nowMs);
    },

    subscribeActions(listener: (nowMs: number) => void): () => void {
        actionListeners.add(listener);
        return () => actionListeners.delete(listener);
    },

    mutedUntil(mmsi: number): number | null {
        return mutes.get(mmsi) ?? null;
    },

    /**
     * Whether the skipper acknowledged close quarters in this encounter (it
     * covers the lesser danger too), here or on the Pi or another phone while
     * the Pi's encounter is open (126-04a).
     */
    acknowledged(mmsi: number): boolean {
        return acks.has(mmsi) || peerCloseQuarters.has(mmsi);
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
