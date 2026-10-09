/**
 * piNightWatchStatus — what the Pi's night watch says, as this phone hears it
 * (build 126, package 126-04a).
 *
 * The Pi grades every AIS target all night with the phone's own collision
 * rule (pi-cache/src/aisWatch.ts). Its word reaches the phone two ways:
 *
 *   - over the boat LAN, on every /api/telemetry read (PiTelemetryService,
 *     every 2 s): its state and its open alarms, each with the key and the
 *     acknowledgement any phone aboard made;
 *   - ashore, in the cloud row the Pi publishes (CloudTelemetryService): three
 *     keys, its state, its last pass and how many alarms are sounding.
 *
 * From that this store gives the AIS key its 'who is watching' row
 * (utils/collisionWatchRow.ts), the alarm stack its cards 'from the Pi' (an
 * alarm the Pi raised that this phone has not carded itself, never our own
 * boat), and the alert store the acknowledgements made elsewhere aboard: a
 * DANGER is muted here until 30 minutes after it was muted aboard (the Pi's
 * time, put on this phone's clock, so hearing it late, or again after a LAN
 * gap, never makes it longer), close quarters and a silenced beacon are held
 * only while the Pi's alarm is open, and those two lapse when the Pi goes
 * quiet.
 *
 * Small and static on purpose: it ships with the app shell (the LAN lane
 * feeds it). Sending to the Pi is services/piNightWatch.ts, loaded only on a
 * phone with a Pi paired.
 */
import { AisGuardAlertStore, type AlarmAckKind } from './aisGuardAlertStore';
import type { CollisionLostReason } from './AisGuardZone';
import { AisStore } from './AisStore';
import { useSettingsStore } from '../stores/settingsStore';
import { PI_WATCH_STALE_MS, type PiWatchState, type PiWatchView } from '../utils/collisionWatchRow';

/** The LAN counts as reaching the Pi while its last answer is this recent (PiTelemetryService's window). */
export const PI_WATCH_PRESENT_MS = 10_000;
/** A card 'from the Pi' acknowledged here hides this long while the Pi confirms it. */
const ACK_PENDING_MS = 30_000;
const MAX_ALARMS = 20;
/** A DANGER acknowledgement mutes for this long from when it was made (COLLISION_RULE.muteMinutes). */
const PEER_MUTE_MS = 30 * 60_000;

/** One open alarm on the Pi (pi-cache/src/aisWatch.ts AisWatchAlarm). */
export interface PiWatchAlarm {
    key: string;
    kind: AlarmAckKind;
    mmsi: number;
    name: string;
    cpaNm: number | null;
    tcpaMin: number | null;
    rangeNm: number | null;
    bearingDeg: number | null;
    lat: number | null;
    lon: number | null;
    raisedAt: number;
    /** When a phone aboard acknowledged it, on the Pi's clock (the acknowledgement's identity). */
    ackedAt: number | null;
    /** The same moment on this phone's clock (aged by the Pi's own servedAt), or null. */
    ackedLocalAt: number | null;
    /** A collision the Pi lost before she was shown clear: why. */
    lost: CollisionLostReason | null;
    distressKind: 'sart' | 'mob' | 'epirb' | null;
    positionKnown: boolean | null;
}

/** The cloud row's three keys, as the phone reads them. */
export interface PiWatchCloudReport {
    state: PiWatchState;
    /** The Pi's last pass (or, standing down, when it said so). */
    atMs: number;
    /** Alarms open and not acknowledged. */
    alarms: number;
}

interface LanReport {
    state: PiWatchState;
    /** The Pi's last pass, on this phone's clock. */
    lastPassAt: number | null;
    /** The Pi keeps an anchor watch of its own (only that counts as at anchor there). */
    atAnchor: boolean | null;
    alarms: PiWatchAlarm[];
    receivedAt: number;
}

export type PhoneAnchorWatch = 'at-anchor' | 'elsewhere' | 'none';

const STATES: ReadonlySet<string> = new Set<PiWatchState>(['off', 'armed', 'blind', 'no-fix']);
const KINDS: ReadonlySet<string> = new Set<AlarmAckKind>(['collision', 'close-quarters', 'distress']);
const DISTRESS_KINDS: ReadonlySet<string> = new Set(['sart', 'mob', 'epirb']);
const LOST: ReadonlySet<string> = new Set<CollisionLostReason>([
    'no-fix',
    'own-motion-unknown',
    'target-motion-unknown',
    'report-too-old',
    'gone',
]);

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isMmsi = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1_000_000 && v <= 999_999_999;

function alarmFromWire(raw: unknown, skewMs: number, receivedAt: number): PiWatchAlarm | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const raisedAt = finite(r.raisedAt);
    if (
        typeof r.key !== 'string' ||
        r.key.length > 80 ||
        typeof r.kind !== 'string' ||
        !KINDS.has(r.kind) ||
        !isMmsi(r.mmsi) ||
        raisedAt === null
    ) {
        return null;
    }
    return {
        key: r.key,
        kind: r.kind as AlarmAckKind,
        mmsi: r.mmsi,
        name: typeof r.name === 'string' ? r.name.trim().slice(0, 60) : '',
        cpaNm: finite(r.cpaNm),
        tcpaMin: finite(r.tcpaMin),
        rangeNm: finite(r.rangeNm),
        bearingDeg: finite(r.bearingDeg),
        lat: finite(r.lat),
        lon: finite(r.lon),
        raisedAt,
        ackedAt: finite(r.ackedAt),
        ackedLocalAt: finite(r.ackedAt) === null ? null : Math.min(receivedAt, (r.ackedAt as number) + skewMs),
        lost: typeof r.lost === 'string' && LOST.has(r.lost) ? (r.lost as CollisionLostReason) : null,
        distressKind:
            typeof r.distressKind === 'string' && DISTRESS_KINDS.has(r.distressKind)
                ? (r.distressKind as PiWatchAlarm['distressKind'])
                : null,
        positionKnown: typeof r.positionKnown === 'boolean' ? r.positionKnown : null,
    };
}

/** The Pi's `ais_watch` off /api/telemetry, or null from an older Pi or anything odd. */
function lanFromWire(raw: unknown, receivedAt: number): LanReport | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (r.v !== 1 || typeof r.state !== 'string' || !STATES.has(r.state) || !Array.isArray(r.alarms)) return null;
    const lastPass = finite(r.lastPassAt);
    const servedAt = finite(r.servedAt);
    // Aged on the Pi's own clock, so a Pi whose clock is off still reads right.
    const lastPassAt =
        lastPass === null ? null : servedAt === null ? lastPass : receivedAt - Math.max(0, servedAt - lastPass);
    const skewMs = servedAt === null ? 0 : receivedAt - servedAt;
    const alarms = r.alarms
        .slice(0, MAX_ALARMS)
        .map((a) => alarmFromWire(a, skewMs, receivedAt))
        .filter((a): a is PiWatchAlarm => a !== null);
    const atAnchor = typeof r.atAnchor === 'boolean' ? r.atAnchor : null;
    return { state: r.state as PiWatchState, lastPassAt, atAnchor, alarms, receivedAt };
}

/** The Pi watch keys off a cloud row's `extra`, or null (a Pi before Pi update 2, or anything odd). */
export function aisWatchFromCloudExtra(extra: unknown): PiWatchCloudReport | null {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
    const e = extra as Record<string, unknown>;
    const atMs = finite(e.ais_watch_at_ms);
    if (typeof e.ais_watch !== 'string' || !STATES.has(e.ais_watch) || atMs === null) return null;
    const alarms = finite(e.ais_watch_alarms);
    return {
        state: e.ais_watch as PiWatchState,
        atMs,
        alarms: alarms !== null && alarms >= 0 ? Math.round(alarms) : 0,
    };
}

let paired = false;
/** When the LAN lane last heard the Pi at all (null: not now). */
let lanSeenAt: number | null = null;
let lanVia: 'lan-host' | 'tailnet-host' = 'lan-host';
let lan: LanReport | null = null;
let cloud: (PiWatchCloudReport & { receivedAt: number }) | null = null;
let pending: 'arm' | 'disarm' | null = null;
/**
 * DANGER acknowledgements already applied here, by `${key}@${ackedAt}` (a
 * second mute in one encounter is a new one) → muted until. Kept through a
 * LAN gap, dropped once the mute is over.
 */
const mutesApplied = new Map<string, number>();
/** The deliberate stand-down from aboard (services/piNightWatch.ts, while it runs). */
let standDownHandler: (() => void) | null = null;
/**
 * Where this phone's anchor watch puts the boat (services/collisionAnchorWatch.ts),
 * read by services/piNightWatch.ts while the Pi says it keeps none itself.
 */
let phoneAnchor: PhoneAnchorWatch = 'none';
/** Cards 'from the Pi' acknowledged here, while the Pi confirms: key → when. */
const acksSent = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const l of listeners) {
        try {
            l();
        } catch {
            /* One display must not keep the word from the others. */
        }
    }
}

function lanFresh(nowMs: number): boolean {
    return lan !== null && lanSeenAt !== null && nowMs - lan.receivedAt <= PI_WATCH_STALE_MS;
}

/** Acknowledgements made elsewhere aboard, onto this phone's alarms. */
function applyPeerAcks(nowMs: number): void {
    const open = lanFresh(nowMs) ? lan!.alarms : [];
    for (const [id, until] of mutesApplied) if (until <= nowMs) mutesApplied.delete(id);
    for (const a of open) {
        if (a.kind !== 'collision' || a.ackedAt === null || a.ackedLocalAt === null) continue;
        const id = `${a.key}@${a.ackedAt}`;
        const until = a.ackedLocalAt + PEER_MUTE_MS;
        // Muted until 30 min after it was muted aboard: never longer for being heard late.
        if (mutesApplied.has(id) || until <= nowMs) continue;
        mutesApplied.set(id, until);
        AisGuardAlertStore.applyPeerMute(a.mmsi, until, nowMs);
    }
    for (const [key, at] of acksSent) {
        const alarm = open.find((a) => a.key === key);
        if (!alarm || alarm.ackedAt !== null || nowMs - at > ACK_PENDING_MS) acksSent.delete(key);
    }
    AisGuardAlertStore.setPeerAcks(
        {
            closeQuarters: open.filter((a) => a.kind === 'close-quarters' && a.ackedAt !== null).map((a) => a.mmsi),
            distress: open.filter((a) => a.kind === 'distress' && a.ackedAt !== null).map((a) => a.mmsi),
        },
        nowMs,
    );
}

export const PiNightWatchStatus = {
    /** A Pi is paired with this phone (services/piNightWatch.ts, at its start and stop). */
    setPaired(next: boolean): void {
        if (paired === next) return;
        paired = next;
        emit();
    },

    /**
     * One answer off the LAN lane (PiTelemetryService): the Pi is reachable,
     * and here is its watch (or none, from a Pi before Pi update 2).
     */
    ingestLan(raw: unknown, ctx: { nowMs?: number; answeredVia?: 'lan-host' | 'tailnet-host' | null } = {}): void {
        const nowMs = ctx.nowMs ?? Date.now();
        lanSeenAt = nowMs;
        if (ctx.answeredVia) lanVia = ctx.answeredVia;
        lan = lanFromWire(raw, nowMs);
        applyPeerAcks(nowMs);
        emit();
    },

    /** The LAN lane has been gone past its live budget: what the Pi said there no longer holds here. */
    lanLost(nowMs = Date.now()): void {
        if (lanSeenAt === null) return;
        lanSeenAt = null;
        applyPeerAcks(nowMs);
        emit();
    },

    /** The cloud row's keys (CloudTelemetryService), or null when there is no row from a Pi. */
    ingestCloud(report: PiWatchCloudReport | null, nowMs = Date.now()): void {
        cloud = report ? { ...report, receivedAt: nowMs } : null;
        emit();
    },

    /** A change made on this phone that the Pi has not confirmed (services/piNightWatch.ts). */
    setPending(next: 'arm' | 'disarm' | null): void {
        if (pending === next) return;
        pending = next;
        emit();
    },

    /** This phone reaches the Pi now (an answer on the LAN lane within its window). */
    reachable(nowMs = Date.now()): boolean {
        return lanSeenAt !== null && nowMs - lanSeenAt <= PI_WATCH_PRESENT_MS;
    },

    /**
     * False when the Pi answers the LAN with no night watch (a Pi before Pi
     * update 2): nothing to arm there. True when it has one; null when this
     * phone cannot tell (the Pi not reachable now).
     */
    hasNightWatch(nowMs = Date.now()): boolean | null {
        if (!PiNightWatchStatus.reachable(nowMs)) return null;
        // Each LAN answer replaces the report: none in the latest is no night watch there.
        return lan !== null;
    },

    /** services/piNightWatch.ts, while it runs: how 'stand the Pi down for everyone' is sent. */
    setStandDownHandler(handler: (() => void) | null): void {
        if (standDownHandler === handler) return;
        standDownHandler = handler;
        emit();
    },

    /** The deliberate stand-down from aboard (the second tap on the row): the Pi's watch ends for every device. */
    standDownForEveryone(): void {
        standDownHandler?.();
    },

    /**
     * Whether the Pi keeps an anchor watch itself, from a LAN answer under
     * 30 s old (null: not known). Only its own counts there: it cannot see one
     * kept on a phone.
     */
    piAtAnchor(nowMs = Date.now()): boolean | null {
        return lanFresh(nowMs) ? lan!.atAnchor : null;
    },

    /** Where this phone's anchor watch puts the boat (services/piNightWatch.ts reads it). */
    setPhoneAnchorWatch(next: PhoneAnchorWatch): void {
        if (phoneAnchor === next) return;
        phoneAnchor = next;
        emit();
    },

    phoneAnchorWatch(): PhoneAnchorWatch {
        return phoneAnchor;
    },

    /** Which of the Pi's saved addresses answered last. */
    answeredVia(): 'lan-host' | 'tailnet-host' {
        return lanVia;
    },

    /** The row's input (utils/collisionWatchRow.ts): the LAN while it answers, else the newer word. */
    view(nowMs = Date.now()): PiWatchView {
        const reachable = PiNightWatchStatus.reachable(nowMs);
        const lanReport = lan
            ? { state: lan.state, lastPassAt: lan.lastPassAt, via: 'lan' as const, atAnchor: lan.atAnchor }
            : null;
        const cloudReport = cloud
            ? {
                  state: cloud.state,
                  lastPassAt: cloud.state === 'off' ? null : cloud.atMs,
                  via: 'cloud' as const,
                  atAnchor: null,
              }
            : null;
        const report =
            reachable && lanReport
                ? lanReport
                : cloudReport && (!lan || cloud!.receivedAt >= lan.receivedAt)
                  ? cloudReport
                  : (lanReport ?? cloudReport);
        return {
            paired: paired || lanSeenAt !== null,
            report,
            reachable,
            pending,
            noWatch: PiNightWatchStatus.hasNightWatch(nowMs) === false,
            canStandDown: standDownHandler !== null,
        };
    },

    /**
     * The Pi's open alarms this phone has not carded itself and nobody aboard
     * has acknowledged: shown as cards 'from the Pi'. Only from a LAN answer
     * under 30 s old.
     */
    piCards(nowMs = Date.now()): PiWatchAlarm[] {
        if (!lanFresh(nowMs)) return [];
        const cards = AisGuardAlertStore.get();
        const beacons = AisGuardAlertStore.getDistress();
        // Our own boat is never a card, whatever the Pi could not tell (its Signal K `self` unread).
        const own = new Set<number>();
        const typed = Number(useSettingsStore.getState().settings?.vessel?.mmsi);
        if (Number.isInteger(typed) && typed > 0) own.add(typed);
        const heard = AisStore.getOwnMmsi();
        if (typeof heard === 'number' && heard > 0) own.add(heard);
        return lan!.alarms.filter((a) => {
            if (a.ackedAt !== null || own.has(a.mmsi)) return false;
            const sent = acksSent.get(a.key);
            if (sent !== undefined && nowMs - sent <= ACK_PENDING_MS) return false;
            if (a.kind === 'distress') return !beacons.some((b) => b.mmsi === a.mmsi);
            if (cards.some((c) => c.mmsi === a.mmsi && c.collision && !c.collision.cleared)) return false;
            if (AisGuardAlertStore.acknowledged(a.mmsi)) return false;
            return !(a.kind === 'collision' && (AisGuardAlertStore.mutedUntil(a.mmsi) ?? 0) > nowMs);
        });
    },

    /** The button on a card 'from the Pi': to the Pi, and the card stands aside while it confirms. */
    acknowledge(alarm: PiWatchAlarm, nowMs = Date.now()): void {
        acksSent.set(alarm.key, nowMs);
        AisGuardAlertStore.acknowledgePiAlarm(alarm.kind, alarm.mmsi, nowMs);
        emit();
    },

    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    /** Test seam. */
    __resetForTests(): void {
        paired = false;
        lanSeenAt = null;
        lanVia = 'lan-host';
        lan = null;
        cloud = null;
        pending = null;
        standDownHandler = null;
        phoneAnchor = 'none';
        mutesApplied.clear();
        acksSent.clear();
        listeners.clear();
        AisGuardAlertStore.setPeerAcks({ closeQuarters: [], distress: [] });
    },
};
