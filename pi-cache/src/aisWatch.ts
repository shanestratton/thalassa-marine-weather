/**
 * AisNightWatch — the Pi keeps the night watch (build 126, package 126-04a).
 *
 * WHY. iOS suspends Thalassa in the background, and a suspended app watches
 * nothing: the phone's collision watch says 'paused' rather than pretend
 * (build 125, 125-01). A mains-powered Pi on the boat's own AIS receiver does
 * not sleep. So arming the collision shield aboard arms this watch too, and
 * it grades every AIS target all night, at anchor included, and listens for
 * distress beacons its own radio hears.
 *
 * THE SAME RULE. Every target is graded by ./collisionRule/collisionRule.ts,
 * the app's utils/collisionRule.ts copied VERBATIM (scripts/
 * sync-collision-rule.mjs; tests/CollisionRulePiMirror.test.ts fails on any
 * drift). Encounters latch exactly as the phone's alarm latches them
 * (services/CollisionAlarmService.ts), with the same numbers
 * (COLLISION_RULE.latch): an encounter ends only on evidence held 30 s over
 * three passes (a vessel that settled near us at anchor, 3 min), and a contact
 * lost before she was shown clear stays open as lost until 10 min after her
 * CPA was due. A lost contact is never a passed one.
 *
 * WHAT IT READS. Signal K on this Pi, never the gateway: the boat's own fix
 * (readFix: source priority, timestamped, no older than 15 s), her own speed
 * and course from their own timestamped leaves (no older than 15 s), and the
 * targets as the phones get them (readAisTargets: unknown stays null, beacons
 * with no fix kept). One shared read serves /api/telemetry and this watch
 * (lanTelemetry.ts SharedSignalkReader), so the watch adds no Signal K load
 * while a phone polls. 'At anchor' is this Pi's own anchor runner: a watch a
 * phone keeps for itself is invisible here.
 *
 * WHAT IT SAYS. A state, never silence: 'armed', 'blind' (Signal K down, or
 * armed with no AIS heard for 60 s, 10 min at anchor), 'no-fix' (no fresh own
 * fix, or our own course and speed unknown), 'off'. And a bounded list of open
 * alarms, most urgent first, each with the key (kind:mmsi:raisedAt) that an
 * acknowledgement from any phone aboard settles: close quarters is
 * acknowledged for its encounter; a DANGER acknowledgement lasts the 30 min a
 * phone's mute does and never covers close quarters; a distress is silenced
 * and stays shown while the beacon is active. A phone often sees her first
 * (it grades every 2 s LAN read; internet AIS can be minutes ahead), so an
 * acknowledgement that names no alarm here yet is kept: a DANGER for its
 * 30 min, close quarters and a distress for 5 min or until her encounter or
 * activation here ends, and an alarm raised inside that is raised settled.
 *
 * WHO ARMED IT. Every paired phone or tablet aboard can arm it. Each one that
 * did is kept (by its install id), the watch grades with the strictest of
 * their thresholds, and it stands down only when the last of them disarms,
 * or when someone aboard stands it down for everyone (a deliberate second
 * tap on the phone's watch row). One device's disarm never ends a watch
 * another device set.
 *
 * WAKING A LOCKED PHONE (126-04b). Each alarm raised (onAlarm) and each pass
 * (onPass) goes to the cloud relay (piAlarmRelay.ts), which pushes it to the
 * skipper's phones; an acknowledgement made ashore comes back through ack().
 * Whether the Pi can wake a phone at all is the relay's word (pushStatus), in
 * describe() and the cloud row, so the phone never claims it before the Pi
 * has proved it.
 *
 * WHAT IT DOES NOT DO (yet): sound aboard on its own (126-04c, a Signal K
 * notification and DSC).
 */
import { readFix } from './anchorBroadcaster.js';
import { readAisTargets, readSelfUrn, type AisTargetWire, type SignalkDocuments } from './lanTelemetry.js';
import { degrees, knots, num, timestampAt } from './trackSignalk.js';
import {
    AIS_WATCH_MAX_DEVICES,
    AIS_WATCH_UNNAMED_DEVICE,
    isDeviceId,
    isMmsi,
    type AisWatchArmer,
    type AisWatchStore,
} from './aisWatchStore.js';
import {
    COLLISION_RULE,
    aisCogDeg,
    aisSogKn,
    aisTargetIsDistressBeacon,
    assessCollision,
    classifyDistress,
    collisionOpening,
    collisionPairFor,
    collisionSettled,
    distressKindOfMmsi,
    ownMotionState,
    rangeBearing,
    sanitiseCollisionPrefs,
    type CollisionAssessment,
    type CollisionPairName,
    type CollisionPrefs,
    type DistressKind,
} from './collisionRule/collisionRule.js';

/** One pass every five seconds, as the phone's watch ticks (services/AisGuardWatch.ts). */
export const AIS_WATCH_TICK_MS = 5_000;
/** Our own fix, speed and course older than this are not where she is now. */
export const OWN_FIX_MAX_AGE_MS = 15_000;
/** The open alarms the watch reports, most urgent first. */
export const AIS_WATCH_MAX_ALARMS = 20;
/**
 * A close-quarters or distress acknowledgement that named no alarm here yet
 * (a phone saw her first) settles one raised within this long. A DANGER one
 * lasts the 30 min a phone's mute does (COLLISION_RULE.muteMinutes).
 */
export const AIS_WATCH_EARLY_ACK_MS = 5 * 60_000;

export type AisWatchState = 'off' | 'armed' | 'blind' | 'no-fix';
/** Whether the Pi can wake the skipper's phone (piAlarmRelay.ts): 'ready' only after the relay answered within the hour. */
export type AisWatchPushState = 'ready' | 'unavailable' | 'internet-off' | 'not-paired';
export interface AisWatchPushStatus {
    state: AisWatchPushState;
    /** When the relay last answered (the Pi's clock), or null. */
    checkedAt: number | null;
    /** The account the Pi wakes (its pairing's owner), so a crew phone never claims it. */
    ownerId: string | null;
}
export type AisWatchKind = 'collision' | 'close-quarters' | 'distress';
/** What our own fix and motion let the rule do this pass. */
export type AisWatchOwn = 'moving' | 'stopped' | 'unknown' | 'no-fix';
/** Why the watch can no longer compute her CPA (the phone's CollisionLostReason). */
export type AisWatchLostReason = 'no-fix' | 'own-motion-unknown' | 'target-motion-unknown' | 'report-too-old' | 'gone';

export interface AisWatchAlarm {
    /** `${kind}:${mmsi}:${raisedAt}`: one alarm per vessel per encounter (per activation, for a beacon). */
    key: string;
    kind: AisWatchKind;
    mmsi: number;
    /** Her AIS name, or '' when she sent none. */
    name: string;
    /** The last computed CPA and TCPA (null for a beacon, or before one could be computed). */
    cpaNm: number | null;
    tcpaMin: number | null;
    /** From our own fix; null without one, or without her position. */
    rangeNm: number | null;
    bearingDeg: number | null;
    lat: number | null;
    lon: number | null;
    raisedAt: number;
    /** When a phone aboard acknowledged it (or silenced it, for a beacon); null while it sounds. */
    ackedAt: number | null;
    /** A collision the watch lost before she was shown clear: why. Null while it can see her. */
    lost: AisWatchLostReason | null;
    /** A beacon's kind (distress only). */
    distressKind?: DistressKind;
    /** False: a beacon alarming as 'position not yet received' (distress only). */
    positionKnown?: boolean;
}

/** The watch's word on itself: /api/telemetry `ais_watch`, GET /api/ais-watch and /api/admin/status. */
export interface AisWatchDescription {
    v: 1;
    state: AisWatchState;
    armed: boolean;
    armedAt: number | null;
    /** When the last pass ran (the Pi's clock). */
    lastPassAt: number | null;
    /** When this description was given (the Pi's clock), so a phone can age lastPassAt on its own. */
    servedAt: number;
    atAnchor: boolean;
    own: AisWatchOwn | null;
    /** When AIS was last heard from any target (0 / null = never). */
    lastAisAt: number | null;
    /** Targets read at the last pass. */
    targets: number;
    prefs: CollisionPrefs | null;
    ownMmsi: number | null;
    /** How many devices armed it (it stands down when the last of them disarms). */
    devices: number;
    alarms: AisWatchAlarm[];
    /** Whether the Pi can wake the skipper's phone (126-04b); null with no relay wired. */
    push: AisWatchPushStatus | null;
}

/** The keys the cloud row carries, first in `extra` (telemetryPublisher.ts). */
export interface AisWatchCloudExtra {
    [key: string]: string | number;
    ais_watch: AisWatchState;
    ais_watch_at_ms: number;
    /** Open alarms not yet acknowledged. */
    ais_watch_alarms: number;
}

export interface AisWatchDeps {
    /** Signal K's answer: the shared read in production (lanTelemetry.ts SharedSignalkReader). */
    documents: () => Promise<SignalkDocuments>;
    /** This Pi keeps an anchor watch now (its own AnchorWatchRunner). */
    atAnchor: () => boolean;
    now?: () => number;
    store?: AisWatchStore;
    /** A new alarm, or one sounding again: the hook 126-04b (push) and 126-04c (Signal K, DSC) use. */
    onAlarm?: (alarm: AisWatchAlarm) => void;
    /**
     * After every pass, what the watch says now (126-04b: the relay's sync,
     * probe and notices); and once more when it stands down, so the relay
     * closes what is open and the next arm starts afresh.
     */
    onPass?: (description: AisWatchDescription) => void;
    /** Whether the Pi can wake the skipper's phone (126-04b, piAlarmRelay.ts status()). */
    pushStatus?: () => AisWatchPushStatus;
    setIntervalImpl?: typeof setInterval;
    clearIntervalImpl?: typeof clearInterval;
}

interface Encounter {
    alarm: AisWatchAlarm;
    /** She was in close quarters at some point: the encounter needs her beyond 0.1 NM to end. */
    everCloseQuarters: boolean;
    /** The newest pass with a computed CPA, and that CPA's TCPA: when the CPA was due. */
    latestAt: number;
    latestTcpaMin: number | null;
    clearSince: number | null;
    clearPasses: number;
}

interface Graded {
    target: AisTargetWire;
    assessment: CollisionAssessment;
    opening: boolean;
    settled: boolean;
}

const LATCH = COLLISION_RULE.latch;
const MUTE_MS = COLLISION_RULE.muteMinutes * 60_000;
const round = (value: number | null, places: number): number | null =>
    value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** places) / 10 ** places;

function samePrefs(a: CollisionPrefs | null, b: CollisionPrefs): boolean {
    return (
        a !== null &&
        a.offshore.cpaNm === b.offshore.cpaNm &&
        a.offshore.tcpaMin === b.offshore.tcpaMin &&
        a.inshore.cpaNm === b.inshore.cpaNm &&
        a.inshore.tcpaMin === b.inshore.tcpaMin
    );
}

function clonePrefs(p: CollisionPrefs): CollisionPrefs {
    return { offshore: { ...p.offshore }, inshore: { ...p.inshore } };
}

/** The strictest of every armer's thresholds: the watch sounds whenever any of them would. */
function strictest(all: Iterable<CollisionPrefs>): CollisionPrefs {
    let out: CollisionPrefs | null = null;
    for (const p of all) {
        out =
            out === null
                ? clonePrefs(p)
                : {
                      offshore: {
                          cpaNm: Math.max(out.offshore.cpaNm, p.offshore.cpaNm),
                          tcpaMin: Math.max(out.offshore.tcpaMin, p.offshore.tcpaMin),
                      },
                      inshore: {
                          cpaNm: Math.max(out.inshore.cpaNm, p.inshore.cpaNm),
                          tcpaMin: Math.max(out.inshore.tcpaMin, p.inshore.tcpaMin),
                      },
                  };
    }
    return out ?? sanitiseCollisionPrefs(null);
}

/** The MMSI Signal K files our own boat under (vessels/self `mmsi`), or null. */
function selfMmsiOf(selfDoc: unknown): number | null {
    const raw = selfDoc && typeof selfDoc === 'object' ? (selfDoc as Record<string, unknown>).mmsi : null;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    return isMmsi(n) ? n : null;
}

/** A leaf of our own document, only when its own time is recent (no parent's, no GPS clock's). */
function freshLeaf(doc: unknown, path: string, now: number): number | null {
    const at = timestampAt(doc, path, false);
    if (at === null || now - at > OWN_FIX_MAX_AGE_MS || at - now > 5_000) return null;
    return num(doc, path);
}

const URGENCY: Record<AisWatchKind, number> = { distress: 0, 'close-quarters': 1, collision: 2 };

export class AisNightWatch {
    private armed = false;
    private armedAt: number | null = null;
    private prefs: CollisionPrefs | null = null;
    private ownMmsi: number | null = null;
    /** Who armed it, first armed first, with the thresholds each sent. */
    private readonly armers = new Map<string, CollisionPrefs>();
    /**
     * Acknowledgements by `${kind}:${mmsi}`, kept to settle an alarm raised
     * after them. `bound`: it settled an alarm open here, so a close-quarters
     * or distress one lasts until that encounter or activation ends.
     */
    private readonly recentAcks = new Map<string, { at: number; bound: boolean }>();
    /** Our own boat, as Signal K last said: kept across a read whose `self` or `vessels/self` failed. */
    private selfUrn: string | null = null;
    private selfMmsi: number | null = null;
    private state: AisWatchState = 'off';
    private own: AisWatchOwn | null = null;
    private atAnchor = false;
    private pair: CollisionPairName | null = null;
    private lastPassAt: number | null = null;
    private lastAisAt: number | null = null;
    private targets = 0;
    private readonly encounters = new Map<number, Encounter>();
    private readonly distress = new Map<number, AisWatchAlarm>();
    private published: AisWatchAlarm[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private inFlight: Promise<void> | null = null;
    private failing = false;

    constructor(private readonly deps: AisWatchDeps) {}

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    /**
     * Arm (or re-arm with new thresholds) for one device. The first pass runs
     * on the next tick. The watch grades with the strictest thresholds of
     * every device that armed it; an arm that names no MMSI keeps the one
     * already known. Kept on disk only when something actually changed.
     */
    arm(rawPrefs: unknown, opts: { ownMmsi?: number | null; device?: string | null } = {}): void {
        const prefs = sanitiseCollisionPrefs(rawPrefs);
        const device = isDeviceId(opts.device) ? opts.device : AIS_WATCH_UNNAMED_DEVICE;
        const ownMmsi = isMmsi(opts.ownMmsi) ? opts.ownMmsi : this.ownMmsi;
        const before = this.armers.get(device);
        const changed = !this.armed || !before || !samePrefs(before, prefs) || ownMmsi !== this.ownMmsi;
        this.armers.set(device, prefs);
        // The first armed goes first when the list is full: the newest arm always counts.
        for (const id of this.armers.keys()) {
            if (this.armers.size <= AIS_WATCH_MAX_DEVICES) break;
            this.armers.delete(id);
        }
        this.prefs = strictest(this.armers.values());
        this.ownMmsi = ownMmsi;
        if (!this.armed) {
            this.begin();
            console.log(
                `[ais-watch] ARMED: CPA ${prefs.offshore.cpaNm} NM / ${prefs.offshore.tcpaMin} min offshore, ` +
                    `${prefs.inshore.cpaNm} NM / ${prefs.inshore.tcpaMin} min inshore`,
            );
        } else if (!before) {
            console.log(`[ais-watch] armed by another device too (${this.armers.size})`);
        }
        if (changed) this.keep();
    }

    /**
     * One device stands down. The watch ends only when no device that armed
     * it is left, or with `everyone` (a deliberate stand-down from aboard). A
     * device that never armed it changes nothing.
     */
    disarm(opts: { device?: string | null; everyone?: boolean } = {}): void {
        if (!this.armed) return;
        if (!opts.everyone) {
            const device = isDeviceId(opts.device) ? opts.device : AIS_WATCH_UNNAMED_DEVICE;
            if (!this.armers.delete(device)) return;
            if (this.armers.size > 0) {
                this.prefs = strictest(this.armers.values());
                this.keep();
                console.log(`[ais-watch] one device stood down; still armed by ${this.armers.size}`);
                return;
            }
        }
        this.stopTimer();
        this.armed = false;
        this.armedAt = null;
        this.state = 'off';
        this.own = null;
        this.pair = null;
        this.lastPassAt = null;
        this.armers.clear();
        this.recentAcks.clear();
        this.encounters.clear();
        this.distress.clear();
        this.published = [];
        try {
            this.deps.store?.clear();
        } catch {
            /* A stale file would re-arm on restart: the next disarm clears it. */
        }
        console.log(`[ais-watch] STOOD DOWN${opts.everyone ? ' for everyone' : ''}`);
        // No pass runs while disarmed: the stand-down is handed on itself.
        this.handOn();
    }

    /** At boot: a watch that was armed when the Pi stopped is armed again (who armed it, thresholds and all). */
    restore(): boolean {
        let saved;
        try {
            saved = this.deps.store?.read() ?? null;
        } catch {
            saved = null;
        }
        if (!saved) return false;
        this.armers.clear();
        for (const d of saved.devices) this.armers.set(d.id, sanitiseCollisionPrefs(d.prefs));
        this.prefs = strictest(this.armers.values());
        this.ownMmsi = saved.ownMmsi;
        this.begin();
        console.log('[ais-watch] ARMED again after a restart');
        return true;
    }

    private keep(): void {
        if (!this.prefs) return;
        const devices: AisWatchArmer[] = [...this.armers].map(([id, prefs]) => ({ id, prefs }));
        try {
            this.deps.store?.save({ armed: true, prefs: this.prefs, ownMmsi: this.ownMmsi, devices });
        } catch (error) {
            // The watch runs on; only a restart would forget it.
            console.warn(
                `[ais-watch] could not keep the armed state: ${error instanceof Error ? error.message : error}`,
            );
        }
    }

    /** Process shutdown: the armed state stays on disk, the loop stops. */
    close(): void {
        this.stopTimer();
    }

    /**
     * An acknowledgement from a phone aboard, by (kind, mmsi). Close quarters
     * covers the lesser danger; a DANGER acknowledgement never covers close
     * quarters. Returns the alarm it settled, or null when none is open here
     * yet (it is kept, and settles one raised soon after: priorAck).
     */
    ack(kind: AisWatchKind, mmsi: number): AisWatchAlarm | null {
        if (!this.armed) return null;
        let alarm: AisWatchAlarm | undefined;
        if (kind === 'distress') alarm = this.distress.get(mmsi);
        else {
            const e = this.encounters.get(mmsi);
            if (e && (kind === 'close-quarters' || e.alarm.kind === 'collision')) alarm = e.alarm;
        }
        // Kept either way: it settles her alarm if this watch raises it after
        // the phone did, or raises close quarters later in the same encounter.
        const key = `${kind}:${mmsi}`;
        this.recentAcks.delete(key);
        this.recentAcks.set(key, { at: this.now(), bound: alarm !== undefined });
        for (const k of this.recentAcks.keys()) {
            if (this.recentAcks.size <= 64) break;
            this.recentAcks.delete(k);
        }
        if (!alarm) return null;
        // A DANGER muted again runs its 30 min from the newest mute, as on the
        // phone that made it; the others aboard follow the new time.
        if (alarm.ackedAt === null || alarm.kind === 'collision') {
            alarm.ackedAt = this.now();
            console.log(`[ais-watch] acknowledged ${alarm.key}`);
        }
        return { ...alarm };
    }

    describe(): AisWatchDescription {
        return {
            v: 1,
            state: this.armed ? this.state : 'off',
            armed: this.armed,
            armedAt: this.armedAt,
            lastPassAt: this.armed ? this.lastPassAt : null,
            servedAt: this.now(),
            atAnchor: this.atAnchor,
            own: this.armed ? this.own : null,
            lastAisAt: this.lastAisAt,
            targets: this.targets,
            prefs: this.armed && this.prefs ? clonePrefs(this.prefs) : null,
            ownMmsi: this.ownMmsi,
            devices: this.armed ? this.armers.size : 0,
            alarms: this.armed ? this.published.map((a) => ({ ...a })) : [],
            push: this.pushStatus(),
        };
    }

    private pushStatus(): AisWatchPushStatus | null {
        try {
            const status = this.deps.pushStatus?.();
            return status ? { ...status } : null;
        } catch {
            return null;
        }
    }

    /** The cloud row's three keys (telemetryPublisher.ts puts them first). */
    cloudExtra(): AisWatchCloudExtra {
        const now = this.now();
        if (!this.armed) return { ais_watch: 'off', ais_watch_at_ms: now, ais_watch_alarms: 0 };
        return {
            ais_watch: this.state,
            ais_watch_at_ms: this.lastPassAt ?? this.armedAt ?? now,
            ais_watch_alarms: this.published.filter((a) => a.ackedAt === null).length,
        };
    }

    /**
     * The cloud row's fourth key (126-04b): whether the Pi can wake the
     * skipper's phone, so ashore the AIS key can say so. Written LAST in
     * `extra` (telemetryPublisher.ts trailingExtra): the relay keeps 40 keys,
     * and the Pi's worst case already sends 40, so when one must go it is
     * this word (the phone then claims nothing), never an instrument's.
     */
    cloudPushExtra(): Record<string, string> {
        const push = this.pushStatus();
        return push ? { ais_watch_push: push.state } : {};
    }

    /** One pass, now: the tick's step, and a test seam. Concurrent callers share the pass in flight. */
    passOnce(): Promise<void> {
        if (!this.armed) return Promise.resolve();
        if (this.inFlight) return this.inFlight;
        const pass = (async () => {
            try {
                const documents = await this.deps.documents();
                if (!this.armed) return;
                this.pass(documents, this.now());
                if (this.failing) console.log('[ais-watch] passes running again');
                this.failing = false;
            } catch (error) {
                // One line per failure run, never per tick.
                if (!this.failing)
                    console.warn(`[ais-watch] pass failed: ${error instanceof Error ? error.message : String(error)}`);
                this.failing = true;
            }
        })().finally(() => {
            if (this.inFlight === pass) this.inFlight = null;
        });
        this.inFlight = pass;
        return pass;
    }

    private begin(): void {
        this.armed = true;
        this.armedAt = this.now();
        this.state = 'armed';
        this.lastPassAt = null;
        this.startTimer();
    }

    private startTimer(): void {
        if (this.timer !== null) return;
        const timer = (this.deps.setIntervalImpl ?? setInterval)(() => void this.passOnce(), AIS_WATCH_TICK_MS);
        (timer as { unref?: () => void } | null)?.unref?.();
        this.timer = timer;
    }

    private stopTimer(): void {
        if (this.timer === null) return;
        (this.deps.clearIntervalImpl ?? clearInterval)(this.timer);
        this.timer = null;
    }

    private pass(documents: SignalkDocuments, now: number): void {
        const prefs = this.prefs ?? sanitiseCollisionPrefs(null);
        const signalkDown = documents.selfDoc === null && documents.vesselsDoc === null;
        const atAnchor = this.deps.atAnchor();
        this.atAnchor = atAnchor;

        // ── Us ──
        const self = documents.selfDoc;
        const fix = self === null ? null : readFix(self, now);
        const fixFresh = fix !== null && now - fix.timestamp <= OWN_FIX_MAX_AGE_MS && fix.timestamp - now <= 5_000;
        const sogKn = self === null ? null : knots(freshLeaf(self, 'navigation.speedOverGround', now));
        const cogDeg = self === null ? null : degrees(freshLeaf(self, 'navigation.courseOverGroundTrue', now));
        const own: AisWatchOwn = fixFresh ? ownMotionState(sogKn, cogDeg, atAnchor) : 'no-fix';
        this.own = own;
        this.pair = collisionPairFor(aisSogKn(sogKn), this.pair);

        // ── Them ──
        // Us, by every name we know: the MMSI a phone sent, the MMSI Signal K
        // files us under, and the URN `self` names. Each is kept from the last
        // read that had it: one of the three documents can fail on its own,
        // and our own boat graded at range 0 is a false close quarters.
        this.selfUrn = readSelfUrn(documents.selfAnswer) ?? this.selfUrn;
        this.selfMmsi = selfMmsiOf(documents.selfDoc) ?? this.selfMmsi;
        const isOwn = (mmsi: number) => mmsi === this.ownMmsi || mmsi === this.selfMmsi;
        const targets =
            documents.vesselsDoc === null
                ? []
                : readAisTargets(documents.vesselsDoc, this.selfUrn, () => now).filter((t) => !isOwn(t.mmsi));
        this.targets = targets.length;
        for (const t of targets) {
            const heard = Math.min(t.lastUpdated, now);
            if (heard > (this.lastAisAt ?? 0)) this.lastAisAt = heard;
        }

        // ── Collision: grade, then latch (CollisionAlarmService.track, on the Pi) ──
        const graded = new Map<number, Graded>();
        if (fixFresh) {
            const ownShip = {
                lat: fix.latitude,
                lon: fix.longitude,
                sogKn,
                cogDeg,
                pair: this.pair,
                atAnchor,
            };
            for (const target of targets) {
                // A beacon's MMSI is the distress alarm's, never a collision target.
                if (target.lat === null || target.lon === null || distressKindOfMmsi(target.mmsi) !== null) continue;
                const herSog = aisSogKn(target.sog);
                const assessment = assessCollision(
                    ownShip,
                    {
                        lat: target.lat,
                        lon: target.lon,
                        sogKn: herSog,
                        cogDeg: aisCogDeg(target.cog),
                        navStatus: target.navStatus,
                        reportAgeSec: Math.max(0, Math.round((now - target.lastUpdated) / 1000)),
                        // Signal K on this Pi decodes the boat's own receiver: the 'local' lane.
                        source: 'local',
                    },
                    prefs,
                );
                if (!assessment) continue;
                graded.set(target.mmsi, {
                    target,
                    assessment,
                    opening: collisionOpening(assessment, prefs),
                    settled: collisionSettled(assessment, { sogKn, atAnchor }, herSog),
                });
            }
        }
        const raised: AisWatchAlarm[] = [];
        this.latchCollisions(graded, own, now, raised);

        // ── Distress: what her own radio hears (125-02's classifier) ──
        // With no answer from Signal K at all, nothing is known: keep what is open.
        if (documents.vesselsDoc !== null) this.watchBeacons(targets, fixFresh ? fix : null, now, raised);

        // ── A DANGER acknowledgement lasts as long as a phone's mute ──
        for (const [key, held] of this.recentAcks) {
            if (!this.ackHolds(key, held, now)) this.recentAcks.delete(key);
        }
        for (const e of this.encounters.values()) {
            const a = e.alarm;
            if (a.kind === 'collision' && a.ackedAt !== null && now - a.ackedAt >= MUTE_MS) {
                a.ackedAt = null;
                raised.push(a);
            }
        }

        this.lastPassAt = now;
        this.state = this.stateFor(signalkDown, own, atAnchor, now);
        this.publish();
        for (const alarm of raised) {
            console.log(`[ais-watch] ALARM ${alarm.key}${alarm.name ? ` (${alarm.name})` : ''}`);
            try {
                this.deps.onAlarm?.({ ...alarm });
            } catch {
                /* A hook that fails must not stop the watch. */
            }
        }
        this.handOn();
    }

    /** What the watch says now, to onPass; a hook that fails must not stop the watch. */
    private handOn(): void {
        if (!this.deps.onPass) return;
        try {
            this.deps.onPass(this.describe());
        } catch {
            /* The watch runs on. */
        }
    }

    private latchCollisions(graded: Map<number, Graded>, own: AisWatchOwn, now: number, raised: AisWatchAlarm[]): void {
        for (const [mmsi, g] of graded) {
            const a = g.assessment;
            if (!a.alarm) continue;
            const e = this.encounters.get(mmsi);
            if (!e) {
                const alarm = this.newAlarm(a.closeQuarters ? 'close-quarters' : 'collision', mmsi, g.target, now);
                this.encounters.set(mmsi, {
                    alarm,
                    everCloseQuarters: a.closeQuarters,
                    latestAt: now,
                    latestTcpaMin: a.tcpaMin,
                    clearSince: null,
                    clearPasses: 0,
                });
                this.fill(alarm, g);
                alarm.ackedAt = this.priorAck(alarm.kind, mmsi, now);
                if (alarm.ackedAt === null) raised.push(alarm);
                continue;
            }
            e.everCloseQuarters ||= a.closeQuarters;
            // Close quarters is a new alarm, whatever a DANGER acknowledgement
            // said; only a close-quarters acknowledgement settles it.
            if (a.closeQuarters && e.alarm.kind === 'collision') {
                e.alarm.kind = 'close-quarters';
                e.alarm.key = `close-quarters:${mmsi}:${now}`;
                e.alarm.raisedAt = now;
                e.alarm.ackedAt = this.priorAck('close-quarters', mmsi, now);
                if (e.alarm.ackedAt === null) raised.push(e.alarm);
            }
            e.latestAt = now;
            e.latestTcpaMin = a.tcpaMin;
            e.clearSince = null;
            e.clearPasses = 0;
            this.fill(e.alarm, g);
        }

        for (const [mmsi, e] of this.encounters) {
            const g = graded.get(mmsi);
            if (g?.assessment.alarm) continue;
            const blind: AisWatchLostReason | null =
                own === 'no-fix'
                    ? 'no-fix'
                    : own === 'unknown'
                      ? 'own-motion-unknown'
                      : !g
                        ? 'gone'
                        : g.assessment.rangeOnly
                          ? (g.assessment.reason ?? 'target-motion-unknown')
                          : null;
            if (blind) {
                e.clearSince = null;
                e.clearPasses = 0;
                e.alarm.lost = blind;
                const cpaDueAt = e.latestAt + Math.max(0, e.latestTcpaMin ?? 0) * 60_000;
                if (now > cpaDueAt + LATCH.lostHoldAfterCpaMs) this.endEncounter(mmsi);
                continue;
            }
            const seen = g!;
            e.latestAt = now;
            e.latestTcpaMin = seen.assessment.tcpaMin;
            this.fill(e.alarm, seen);
            // She is no longer under way and we are stopped: over, however close
            // she lies, once that holds a full anchored report cycle.
            const opening =
                seen.settled ||
                (seen.opening &&
                    (!e.everCloseQuarters || seen.assessment.rangeNm >= COLLISION_RULE.closeQuarters.cpaNm));
            if (!opening) {
                e.clearSince = null;
                e.clearPasses = 0;
                continue;
            }
            e.clearSince ??= now;
            e.clearPasses += 1;
            const holdMs = seen.settled ? LATCH.settledAfterMs : LATCH.clearAfterMs;
            if (now - e.clearSince >= holdMs && e.clearPasses >= LATCH.clearMinPasses) this.endEncounter(mmsi);
        }
    }

    /**
     * Her encounter is over: her next approach is a new one, and a
     * close-quarters acknowledgement ends with it, as on the phone
     * (AisGuardAlertStore.endEncounter). A DANGER one keeps its 30 min.
     */
    private endEncounter(mmsi: number): void {
        this.encounters.delete(mmsi);
        this.recentAcks.delete(`close-quarters:${mmsi}`);
    }

    /**
     * An acknowledgement made before this alarm was raised here that settles
     * it (a phone saw her first), or null. Close quarters covers the lesser
     * danger; a DANGER acknowledgement never covers close quarters.
     */
    private priorAck(kind: AisWatchKind, mmsi: number, now: number): number | null {
        const covering: AisWatchKind[] = kind === 'collision' ? ['collision', 'close-quarters'] : [kind];
        let at: number | null = null;
        for (const k of covering) {
            const key = `${k}:${mmsi}`;
            const held = this.recentAcks.get(key);
            if (!held || !this.ackHolds(key, held, now)) continue;
            // Now it settles an alarm open here: it lasts as long as that does.
            held.bound = true;
            at = Math.max(at ?? held.at, held.at);
        }
        if (at !== null) console.log(`[ais-watch] ${kind}:${mmsi} raised already acknowledged aboard`);
        return at;
    }

    /**
     * Whether a kept acknowledgement still settles anything: a DANGER one for
     * the 30 min a phone's mute lasts; close quarters and a distress while the
     * encounter or activation it settled is open, or 5 min while none is.
     */
    private ackHolds(key: string, held: { at: number; bound: boolean }, now: number): boolean {
        if (held.at - now > 5_000) return false; // from a clock since stepped back
        if (key.startsWith('collision:')) return now - held.at < MUTE_MS;
        return held.bound || now - held.at < AIS_WATCH_EARLY_ACK_MS;
    }

    private watchBeacons(
        targets: AisTargetWire[],
        fix: { latitude: number; longitude: number } | null,
        now: number,
        raised: AisWatchAlarm[],
    ): void {
        const active = new Set<number>();
        for (const t of targets) {
            if (!aisTargetIsDistressBeacon(t.mmsi, t.navStatus) && !t.safetyText) continue;
            const positioned = t.lat !== null && t.lon !== null;
            // As the phone reads it (DistressAlarmService): with no position, 15 is not a test.
            const status = positioned || t.navStatus !== 15 ? t.navStatus : null;
            const c = classifyDistress({
                mmsi: t.mmsi,
                navStatus: status,
                navStatusAt: status === null ? null : t.lastUpdated,
                safetyText: t.safetyText ?? null,
                safetyTextAt: t.safetyTextAt ?? null,
                // The Pi's radio is the boat's own radio.
                source: 'local',
                hasPosition: positioned,
            });
            if (!c?.sounds) continue;
            active.add(t.mmsi);
            let alarm = this.distress.get(t.mmsi);
            if (!alarm) {
                alarm = this.newAlarm('distress', t.mmsi, t, now);
                alarm.ackedAt = this.priorAck('distress', t.mmsi, now);
                this.distress.set(t.mmsi, alarm);
                if (alarm.ackedAt === null) raised.push(alarm);
            }
            const where =
                fix && positioned ? rangeBearing(fix.latitude, fix.longitude, t.lat as number, t.lon as number) : null;
            alarm.name = t.name;
            alarm.distressKind = c.kind;
            alarm.positionKnown = c.positionKnown;
            alarm.lat = positioned ? round(t.lat, 5) : null;
            alarm.lon = positioned ? round(t.lon, 5) : null;
            alarm.rangeNm = where ? round(where.rangeNm, 2) : null;
            alarm.bearingDeg = where ? round(where.bearingDeg, 0) : null;
        }
        // No longer active (a test, or not heard for the reader's 10 min): the
        // activation is over, and its silence with it.
        for (const mmsi of [...this.distress.keys()]) {
            if (active.has(mmsi)) continue;
            this.distress.delete(mmsi);
            this.recentAcks.delete(`distress:${mmsi}`);
        }
    }

    private newAlarm(kind: AisWatchKind, mmsi: number, target: AisTargetWire, now: number): AisWatchAlarm {
        return {
            key: `${kind}:${mmsi}:${now}`,
            kind,
            mmsi,
            name: target.name,
            cpaNm: null,
            tcpaMin: null,
            rangeNm: null,
            bearingDeg: null,
            lat: null,
            lon: null,
            raisedAt: now,
            ackedAt: null,
            lost: null,
        };
    }

    /** This pass's numbers onto the alarm: the card shows the newest computed CPA. */
    private fill(alarm: AisWatchAlarm, g: Graded): void {
        const a = g.assessment;
        alarm.name = g.target.name || alarm.name;
        alarm.cpaNm = round(a.cpaNm, 2);
        alarm.tcpaMin = round(a.tcpaMin, 1);
        alarm.rangeNm = round(a.rangeNm, 2);
        alarm.bearingDeg = round(a.bearingDeg, 0);
        alarm.lat = round(g.target.lat, 5);
        alarm.lon = round(g.target.lon, 5);
        alarm.lost = null;
    }

    private stateFor(signalkDown: boolean, own: AisWatchOwn, atAnchor: boolean, now: number): AisWatchState {
        if (signalkDown) return 'blind';
        if (own === 'no-fix' || own === 'unknown') return 'no-fix';
        // Stopped at a berth (no anchor watch): nothing can sound, so a quiet receiver is not news.
        if (own === 'stopped' && !atAnchor) return 'armed';
        const anchored = own === 'stopped' && atAnchor;
        const silentSince = Math.max(this.lastAisAt ?? 0, this.armedAt ?? now);
        return now - silentSince >= (anchored ? LATCH.atAnchorBlindAfterMs : LATCH.blindAfterMs) ? 'blind' : 'armed';
    }

    /** The open alarms, most urgent first (distress, close quarters, then the soonest), bounded. */
    private publish(): void {
        const all = [...this.distress.values(), ...[...this.encounters.values()].map((e) => e.alarm)];
        all.sort(
            (x, y) =>
                URGENCY[x.kind] - URGENCY[y.kind] ||
                (x.tcpaMin ?? Number.POSITIVE_INFINITY) - (y.tcpaMin ?? Number.POSITIVE_INFINITY) ||
                x.mmsi - y.mmsi,
        );
        this.published = all.slice(0, AIS_WATCH_MAX_ALARMS);
    }
}
