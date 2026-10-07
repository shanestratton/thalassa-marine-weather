/**
 * BoatLinkService — the one owner of "where is this phone, how does the boat
 * reach it, and how fresh is it". Every screen that says so reads this
 * snapshot: the NMEA Gateway page, the Vessel page row, the Instrument Panel
 * pill, the System status box, Remote Access, and the instrument policy that
 * decides whether a silent Pi's fallback socket may open.
 *
 * Shane 2026-10-07: "so we have two ways, a: on the yacht, which should be
 * apparent via our gps and the fact that we are on the same network (maybe),
 * or we are not on the yacht. in which case we are connecting via, tailnet …
 * also there may not always be a pi, but there could still be a way to
 * connect, like via the ydwg01 device … make it as tight as tight can be".
 *
 * The rules live in boatLinkModel.ts (pure). This file only gathers the facts
 * — the instrument store, the Pi lane's path, the gateway socket, this
 * phone's interfaces and its last fix, and the boat's — and keeps the two
 * pieces of memory the rules need to stay still: the last DECIDED place (so
 * one inconclusive fix, or a lane blinking, cannot flip "Away" to "Aboard"),
 * and the route shown (so the sentence under the pill does not change words
 * until a new lane has held for ten seconds).
 *
 * It reads; it never opens a connection, asks for a permission, or starts the
 * GPS. The phone's fix is whatever a screen's passive watch last delivered,
 * or the one kept across a relaunch.
 */
import { NmeaStore, type NmeaStoreState } from '../NmeaStore';
import { NmeaListenerService, type NmeaConnectionInfo } from '../NmeaListenerService';
import { NMEA_USABLE_MAX_AGE_MS } from '../nmea/nmeaCadence';
import { PiTelemetryService } from '../PiTelemetryService';
import { getPairing } from '../PiPairingService';
import { GpsService } from '../GpsService';
import { storedPhoneFix } from '../phoneLastFix';
import { piCache } from '../PiCacheService';
import { getInterfaces } from '../network/networkContext';
import { authScopedStorageKey, getAuthIdentityScope } from '../authIdentityScope';
import { readRegisteredSocketOwner } from './socketOwner';
import { createLogger } from '../../utils/createLogger';
import {
    atBoatsLastBerth,
    boatWifiEvidence,
    describeBoatLink,
    echoSameNetwork,
    fallbackSocketPermitted,
    gatewayShortName,
    hairpinProven,
    metresBetween,
    networkFactsFrom,
    networkNameFor,
    phoneMayStandInForBoat,
    resolveData,
    resolveKind,
    resolveLane,
    resolveWhere,
    UNKNOWN_NETWORK,
    WHERE_CONFIRM_MS,
    WHERE_HOLD_MS,
    type BoatLinkWords,
    type DataResult,
    type Lane,
    type LinkKind,
    type NetworkFacts,
    type PlaceFix,
    type SocketOwner,
    type SocketStatus,
    type StoreFacts,
    type Where,
    type WhereResult,
} from './boatLinkModel';

/** A new route must hold this long before the sentence under the pill changes. */
export const ROUTE_HOLD_MS = 10_000;
/** How often the snapshot is re-evaluated while a screen watches it (ages, holds). */
export const BOAT_LINK_TICK_MS = 2_000;
/** Interfaces change on Wi-Fi joins and VPN toggles, not by the second. */
const NETWORK_REFRESH_MS = 15_000;
/** The boat's last fix is rewritten no more often than this unless she has moved. */
const HELD_FIX_MIN_INTERVAL_MS = 60_000;
const HELD_FIX_MIN_MOVE_M = 50;
/**
 * The boat's last fix, per account (authScopedStorageKey) and per boat: the
 * own boat keeps this key, a crewed boat's is `…:crew:<skipper id>` — the
 * scheme weatherPosition's held fix uses. A fix is also stamped with the Pi
 * it was read beside, and dropped once a different Pi is paired.
 */
const HELD_FIX_KEY = 'thalassa_boatlink_boat_fix';
/** 'own', or 'crew:<skipper id>'. */
type BoatKey = string;

export interface BoatLinkSnapshot extends BoatLinkWords {
    where: Where;
    whereReason: WhereResult['reason'];
    separationM: number | null;
    /** The lane filling the instruments now. */
    lane: Lane;
    /** The route the words describe (held for ROUTE_HOLD_MS across a change). */
    routeLane: Lane;
    kind: LinkKind;
    networkName: 'Tailscale' | 'your VPN';
    data: DataResult;
    /** Aboard on the boat's Wi-Fi, a VPN up, and the Pi saw the request come back in through the router. */
    hairpin: boolean;
    socketOwner: SocketOwner;
    /** May a silent Pi's fallback socket open from here? */
    fallbackPermitted: boolean;
    /** May this phone's GPS stand in for the boat's position (phoneMayStandInForBoat)? */
    phoneStandsInForBoat: boolean;
    piPaired: boolean;
}

type Listener = () => void;

const log = createLogger('BoatLink');
const warned = new Set<string>();

/**
 * Read one input, or fall back. A status line must never take a screen down
 * with it: an input that throws reads as "not known", and says so once in the
 * device log (log.warn, which production builds keep).
 */
function safely<T>(name: string, read: () => T, fallback: T): T {
    try {
        return read();
    } catch (error) {
        if (!warned.has(name)) {
            warned.add(name);
            log.warn(`${name} unavailable:`, error instanceof Error ? error.message : String(error));
        }
        return fallback;
    }
}

const NO_PATH = { answeredVia: null, seenFrom: null, seenAt: null } as const;
const NO_CONNECTION: NmeaConnectionInfo = {
    status: 'disconnected',
    enabled: false,
    host: '',
    port: 0,
    deviceId: null,
    deviceLabel: 'gateway',
    transport: 'tcp',
};

function validFix(lat: unknown, lon: unknown): lat is number {
    return (
        typeof lat === 'number' &&
        typeof lon === 'number' &&
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        Math.abs(lat) <= 90 &&
        Math.abs(lon) <= 180 &&
        !(lat === 0 && lon === 0)
    );
}

const METRIC_KEYS = [
    'tws',
    'twa',
    'aws',
    'awa',
    'stw',
    'heading',
    'depth',
    'sog',
    'cog',
    'waterTemp',
    'rudder',
    'rpm',
    'voltage',
    'latitude',
    'longitude',
    'heel',
] as const satisfies readonly (keyof NmeaStoreState)[];

function storeFacts(state: NmeaStoreState, now: number): StoreFacts {
    const usableReading = METRIC_KEYS.some((key) => {
        const metric = state[key];
        return (
            metric.value !== null &&
            Number.isFinite(metric.value) &&
            metric.freshness !== 'dead' &&
            now - metric.lastUpdated <= NMEA_USABLE_MAX_AGE_MS
        );
    });
    const remote = state.connectionStatus === 'remote' ? state.remote : null;
    return {
        status: state.connectionStatus,
        via: remote?.via ?? null,
        source: remote?.source ?? null,
        readingAt: remote
            ? remote.reportedAt
            : state.connectionStatus === 'connected' && state.lastAnyUpdate > 0
              ? state.lastAnyUpdate
              : null,
        usableReading,
    };
}

class BoatLinkServiceClass {
    private listeners = new Set<Listener>();
    private unsubs: Array<() => unknown> = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private snapshot: BoatLinkSnapshot | null = null;
    private snapshotKey = '';

    private decided: { where: 'aboard' | 'ashore'; at: number } | null = null;
    private pending: { where: 'aboard' | 'ashore'; since: number } | null = null;
    private route: { lane: Lane; kind: LinkKind } = { lane: 'none', kind: 'none' };
    private routeCandidate: { lane: Lane; kind: LinkKind; since: number } | null = null;
    /** The Pi lane shown before the lanes went quiet, and since when (bridges a brief gap). */
    private routeBeforeGap: { lane: Lane; kind: LinkKind; since: number } | null = null;
    private lastReading: { at: number; lane: Lane } | null = null;

    private network: NetworkFacts = UNKNOWN_NETWORK;
    private networkAt = 0;
    private networkInFlight = false;
    private heldWrite: { key: BoatKey; at: number; lat: number; lon: number } | null = null;
    /** The cloud row's owner, once the cloud reader has loaded (kept out of this module's imports). */
    private cloudOwner: (() => string | null) | null = null;
    private cloudReaderLoading = false;

    /** Watch the snapshot. The first watcher starts the gathering; the last one stops it. */
    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);
        if (this.listeners.size === 1) this.start();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) this.stop();
        };
    };

    /**
     * The current snapshot (a stable object until something visible changes),
     * for useSyncExternalStore. Never notifies: React may call it mid-render.
     */
    getSnapshot = (): BoatLinkSnapshot => this.snapshot ?? this.evaluate(Date.now(), false);

    /** Re-evaluate now. Cheap and synchronous; the policy calls it on its own tick. */
    evaluate(now = Date.now(), notify = true): BoatLinkSnapshot {
        this.refreshNetworkSoon(now);
        this.loadCloudReader();
        const state = safely<NmeaStoreState | null>('instrument store', () => NmeaStore.getState(), null);
        const store: StoreFacts = state
            ? storeFacts(state, now)
            : { status: 'disconnected', via: null, source: null, readingAt: null, usableReading: false };
        const lane = resolveLane(store);
        const pi = safely('Pi path', () => PiTelemetryService.pathInfo(now), NO_PATH);
        const pairing = safely('pairing', () => getPairing(), null);
        const piPaired = pairing !== null;
        const piHost = piPaired ? safely('Pi host', () => piCache.getLanHost(), null) : null;
        const piOnTailscale = piPaired && safely('Pi remote access', () => !!piCache.getRemoteBaseUrl(), false);
        const info = safely('gateway socket', () => NmeaListenerService.getConnectionInfo(), NO_CONNECTION);
        // The saved gateway, not the socket's current host: before the socket
        // has ever been configured this session the listener holds its factory
        // default, and the fallback question is about the skipper's gateway.
        const saved = safely('saved gateway', () => NmeaListenerService.getSavedConfig(), null);
        const gatewaySaved = saved !== null;
        const gatewayHost = saved?.host ?? null;
        const socketStatus: SocketStatus = info.status;
        const socketOwner = this.socketOwner(info.enabled, piPaired);
        const network = this.network;

        // ── WHERE ──
        const phone = this.phoneFix(now);
        const boatKey = this.linkBoatKey(state, piPaired, gatewaySaved);
        const boat = this.boatFix(state, boatKey, pairing?.deviceId ?? null, now);
        const raw = resolveWhere({
            now,
            phone,
            boat,
            sameNetwork: echoSameNetwork(network, pi),
            previous: this.decided,
        });
        const where = this.settleWhere(raw, now);

        // ── DATA ──
        if (lane !== 'none' && store.usableReading && store.readingAt !== null) {
            this.lastReading = { at: store.readingAt, lane };
        }
        const data = resolveData({
            now,
            lane,
            where: where.where,
            store,
            socket: {
                status: socketStatus,
                owner: socketOwner,
                retrying: safely('socket retry', () => NmeaListenerService.isReconnecting(), false),
            },
            piQuiet:
                piPaired &&
                safely(
                    'Pi lane',
                    () => PiTelemetryService.getState() === 'quiet' && PiTelemetryService.isPresent(now),
                    false,
                ),
            lastReading: this.lastReading,
        });

        // ── LINK ──
        // The route the words describe is the live lane, held a moment across
        // a change. A lane that has gone is said in the past tense while its
        // last reading ages on screen — never as a link that is still up.
        const kindOf = (l: Lane) => resolveKind({ lane: l, where: where.where, network, pi, gatewayHost, piHost });
        const route = this.settleRoute(lane, kindOf(lane), now);
        const lastLane = route.lane === 'none' && data.state === 'stale' ? (this.lastReading?.lane ?? null) : null;
        const last = lastLane && lastLane !== 'none' ? { lane: lastLane, kind: kindOf(lastLane) } : null;
        const networkName = networkNameFor({
            network,
            pi,
            lane: route.lane !== 'none' ? route.lane : (last?.lane ?? 'none'),
            gatewayHost,
            piOnTailscale,
        });

        const words = describeBoatLink({
            where,
            lane: route.lane,
            kind: route.kind,
            networkName,
            data,
            setup: {
                piPaired,
                gatewaySaved,
                gatewayLabel: gatewayShortName(info.deviceId, info.deviceLabel),
            },
            socket: { status: socketStatus, owner: socketOwner },
            last,
        });

        const directHost = lane === 'socket' ? gatewayHost : lane === 'pi-direct' ? (pi.seenAt ?? piHost) : null;
        const next: BoatLinkSnapshot = {
            ...words,
            where: where.where,
            whereReason: where.reason,
            separationM: where.separationM,
            lane,
            routeLane: route.lane,
            kind: route.kind,
            networkName,
            data,
            hairpin: hairpinProven(where.where, network, pi, piHost),
            socketOwner,
            fallbackPermitted: fallbackSocketPermitted(
                where.where,
                network,
                gatewayHost,
                atBoatsLastBerth({ now, phone, boat }),
            ),
            phoneStandsInForBoat: phoneMayStandInForBoat({
                where,
                lane,
                data: data.state,
                directEvidence: boatWifiEvidence(network, directHost),
            }),
            piPaired,
        };
        const key = JSON.stringify([
            next.pill,
            next.line,
            next.whereNote,
            next.statusRow,
            next.hub,
            next.where,
            next.lane,
            next.routeLane,
            next.kind,
            next.hairpin,
            next.fallbackPermitted,
            next.phoneStandsInForBoat,
            next.socketOwner,
            next.data.state,
        ]);
        if (key !== this.snapshotKey || !this.snapshot) {
            this.snapshotKey = key;
            this.snapshot = next;
            if (notify) for (const listener of this.listeners) listener();
        }
        return this.snapshot;
    }

    /** Is this phone with the boat? Only position (or the Pi seeing this phone's own Wi-Fi address) says so. */
    phoneIsWithBoat(now = Date.now()): boolean {
        return this.evaluate(now).where === 'aboard';
    }

    /**
     * May this phone's GPS stand in for the boat's position? Aboard by
     * position; or, on a boat whose bus has no GPS, a live direct lane on the
     * boat's own network with no VPN up (boatLinkModel.phoneMayStandInForBoat).
     */
    phoneStandsInForBoat(now = Date.now()): boolean {
        return this.evaluate(now).phoneStandsInForBoat;
    }

    /** Tests only. */
    resetForTests(): void {
        this.stop();
        this.listeners.clear();
        this.snapshot = null;
        this.snapshotKey = '';
        this.decided = null;
        this.pending = null;
        this.route = { lane: 'none', kind: 'none' };
        this.routeCandidate = null;
        this.routeBeforeGap = null;
        this.lastReading = null;
        this.network = UNKNOWN_NETWORK;
        this.networkAt = 0;
        this.networkInFlight = false;
        this.heldWrite = null;
    }

    /** Tests only: take these interfaces now instead of waiting for the next refresh. */
    async refreshNetworkForTests(): Promise<void> {
        this.networkAt = 0;
        await this.refreshNetwork(Date.now());
    }

    // ── Internals ──

    private start(): void {
        const recompute = () => void this.evaluate();
        const noop = () => undefined;
        this.unsubs = [
            safely<() => unknown>('store watch', () => NmeaStore.subscribe(recompute), noop),
            safely<() => unknown>('socket watch', () => NmeaListenerService.onStatusChange(recompute), noop),
            safely<() => unknown>('Pi lane watch', () => PiTelemetryService.subscribe(recompute), noop),
        ];
        this.timer = setInterval(recompute, BOAT_LINK_TICK_MS);
        this.evaluate(Date.now(), false);
        void this.refreshNetwork(Date.now());
    }

    private stop(): void {
        for (const unsub of this.unsubs) unsub();
        this.unsubs = [];
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    private socketOwner(enabled: boolean, piPaired: boolean): SocketOwner {
        const registered = readRegisteredSocketOwner();
        if (registered) return registered;
        if (!enabled) return 'none';
        // Nothing registered (a page or fixture outside the app's boot): with
        // a Pi paired only the policy's fallback opens a socket on its own.
        return piPaired ? 'policy' : 'boot';
    }

    /**
     * A change of side (aboard ↔ ashore) must be seen twice, at least
     * WHERE_CONFIRM_MS apart, before anything says so — against a decision
     * that still holds. From unknown, or from a decision older than
     * WHERE_HOLD_MS (the app suspended aboard last night, foregrounded at
     * home this morning), the first decisive reading stands: an expired
     * "Aboard" must not hold back a fresh "Away" for ten seconds, in which a
     * silent Pi's fallback could open a gateway socket from ashore.
     */
    private settleWhere(raw: WhereResult, now: number): WhereResult {
        const decisive = raw.reason === 'together' || raw.reason === 'apart' || raw.reason === 'same-network';
        if (!decisive || raw.where === 'unknown') {
            this.pending = null;
            return raw;
        }
        const side = raw.where;
        if (!this.decided || this.decided.where === side || now - this.decided.at > WHERE_HOLD_MS) {
            this.decided = { where: side, at: now };
            this.pending = null;
            return raw;
        }
        if (!this.pending || this.pending.where !== side) {
            this.pending = { where: side, since: now };
        } else if (now - this.pending.since >= WHERE_CONFIRM_MS) {
            this.decided = { where: side, at: now };
            this.pending = null;
            return raw;
        }
        return { where: this.decided.where, reason: 'held', separationM: raw.separationM };
    }

    /**
     * The route the words describe. Between the Pi's own two lanes (direct and
     * its internet updates) a new one must hold for ROUTE_HOLD_MS before the
     * sentence changes — they trade places on a jittery link, and the words
     * must not blink with them — and a gap shorter than that between them is
     * bridged. Anything involving the gateway socket or a phone's share
     * changes at once: a closed socket is never described as connected
     * (review 2026-10-07), and going quiet is said at once too.
     */
    private settleRoute(lane: Lane, kind: LinkKind, now: number): { lane: Lane; kind: LinkKind } {
        const piLane = (l: Lane) => l === 'pi-direct' || l === 'cloud';
        const set = (next: { lane: Lane; kind: LinkKind }) => {
            this.route = { lane: next.lane, kind: next.kind };
            this.routeCandidate = null;
            return this.route;
        };
        if (this.route.lane === lane && this.route.kind === kind) {
            this.routeCandidate = null;
            return this.route;
        }
        if (lane === 'none') {
            this.routeBeforeGap = piLane(this.route.lane) ? { ...this.route, since: now } : null;
            return set({ lane, kind });
        }
        if (this.route.lane === 'none') {
            const before = this.routeBeforeGap;
            this.routeBeforeGap = null;
            // Back from a brief gap: as though it never happened.
            if (before && piLane(lane) && now - before.since < ROUTE_HOLD_MS) {
                this.route = { lane: before.lane, kind: before.kind };
                if (before.lane === lane && before.kind === kind) return set(this.route);
                this.routeCandidate = { lane, kind, since: now };
                return this.route;
            }
            return set({ lane, kind });
        }
        if (!piLane(lane) || !piLane(this.route.lane)) return set({ lane, kind });
        if (!this.routeCandidate || this.routeCandidate.lane !== lane || this.routeCandidate.kind !== kind) {
            this.routeCandidate = { lane, kind, since: now };
        } else if (now - this.routeCandidate.since >= ROUTE_HOLD_MS) {
            return set({ lane, kind });
        }
        return this.route;
    }

    /** This phone's newest fix: a screen's passive watch, else the one kept across a relaunch. */
    private phoneFix(now: number): PlaceFix | null {
        const live = safely('phone fix', () => GpsService.getLastKnownPosition(), null);
        const liveFix: PlaceFix | null =
            live && validFix(live.latitude, live.longitude)
                ? { lat: live.latitude, lon: live.longitude, at: live.timestamp, accuracyM: live.accuracy }
                : null;
        const stored = safely('kept phone fix', () => storedPhoneFix(now), null);
        const storedFix: PlaceFix | null = stored ? { lat: stored.lat, lon: stored.lon, at: stored.timestamp } : null;
        if (liveFix && (!storedFix || liveFix.at >= storedFix.at)) return liveFix;
        return storedFix;
    }

    /**
     * Which boat this phone's links point at: the paired Pi's, else the saved
     * gateway's (the own boat), else whichever boat's cloud row the store is
     * showing. 'own' or 'crew:<skipper id>'.
     */
    private linkBoatKey(state: NmeaStoreState | null, piPaired: boolean, gatewaySaved: boolean): BoatKey {
        if (piPaired) return this.piBoatKey();
        if (gatewaySaved) return 'own';
        const remote = state?.connectionStatus === 'remote' ? state.remote : null;
        if (remote?.via === 'cloud') return this.cloudBoatKey() ?? 'own';
        return 'own';
    }

    /** Whose boat the store's current position is from, or null when that is not known. */
    private feedBoatKey(state: NmeaStoreState): BoatKey | null {
        if (state.connectionStatus === 'connected') return 'own';
        const remote = state.connectionStatus === 'remote' ? state.remote : null;
        if (!remote) return null;
        return remote.via === 'lan' ? this.piBoatKey() : this.cloudBoatKey();
    }

    private ownerKey(ownerId: string | null | undefined): BoatKey {
        const me = safely('account', () => getAuthIdentityScope().userId, null);
        return !ownerId || ownerId === me ? 'own' : `crew:${ownerId}`;
    }

    /** The paired Pi's boat: whose diary relay it carries, else the own boat. */
    private piBoatKey(): BoatKey {
        const status = safely('Pi status', () => piCache.getStatus(), null);
        return this.ownerKey(status?.diaryRelayConfigured ? status.diaryRelayOwnerId : null);
    }

    /** The cloud row's boat, or null before the cloud reader has loaded or read a row. */
    private cloudBoatKey(): BoatKey | null {
        const owner = this.cloudOwner ? safely('cloud row', this.cloudOwner, null) : null;
        return owner ? this.ownerKey(owner) : null;
    }

    /**
     * The cloud reader is loaded lazily, as the instrument policy loads it:
     * it brings the backend client with it, and this module is on the boot
     * path. Until it has loaded, a cloud row's owner is unknown and the row
     * counts as the linked boat's, as it always has.
     */
    private loadCloudReader(): void {
        if (this.cloudOwner || this.cloudReaderLoading) return;
        this.cloudReaderLoading = true;
        void import('../CloudTelemetryService')
            .then(({ CloudTelemetryService }) => {
                this.cloudOwner = () => CloudTelemetryService.getLatest()?.ownerId ?? null;
            })
            .catch(() => {
                /* no cloud reader: owners stay unknown */
            })
            .finally(() => {
                this.cloudReaderLoading = false;
            });
    }

    /**
     * The boat's fix: whatever is in the instrument store (the bus, the Pi
     * direct, or her cloud row — all her own receivers), else the last one
     * this device kept for her. Never a phone's: a 'device' cloud row is a
     * phone. Never another boat's: a crewed boat's cloud row on screen is not
     * where the paired Pi's boat is (an owner the cloud reader has not named
     * yet counts as hers, as it always has).
     */
    private boatFix(
        state: NmeaStoreState | null,
        boatKey: BoatKey,
        piDeviceId: string | null,
        now: number,
    ): PlaceFix | null {
        if (!state) return this.heldBoatFix(boatKey, piDeviceId, now);
        const remote = state.connectionStatus === 'remote' ? state.remote : null;
        const lat = state.latitude.value;
        const lon = state.longitude.value;
        const feedKey = this.feedBoatKey(state);
        if (
            remote?.source !== 'device' &&
            (feedKey === null || feedKey === boatKey) &&
            validFix(lat, lon) &&
            state.latitude.freshness !== 'dead'
        ) {
            const at = remote
                ? (remote.positionSampleAt ?? remote.reportedAt)
                : Math.min(state.latitude.lastUpdated, state.longitude.lastUpdated);
            const accuracy = state.gpsAccuracyM?.value;
            const fix: PlaceFix = { lat, lon: lon as number, at, accuracyM: accuracy ?? null };
            this.keepBoatFix(fix, boatKey, piDeviceId, now);
            return fix;
        }
        return this.heldBoatFix(boatKey, piDeviceId, now);
    }

    private heldKey(boatKey: BoatKey): string {
        return authScopedStorageKey(boatKey === 'own' ? HELD_FIX_KEY : `${HELD_FIX_KEY}:${boatKey}`);
    }

    private keepBoatFix(fix: PlaceFix, boatKey: BoatKey, piDeviceId: string | null, now: number): void {
        const last = this.heldWrite?.key === boatKey ? this.heldWrite : null;
        const moved = !last || metresBetween(last, fix) >= HELD_FIX_MIN_MOVE_M;
        if (!moved && last && now - last.at < HELD_FIX_MIN_INTERVAL_MS) return;
        try {
            localStorage.setItem(
                this.heldKey(boatKey),
                JSON.stringify({
                    lat: fix.lat,
                    lon: fix.lon,
                    at: fix.at,
                    accuracyM: fix.accuracyM ?? null,
                    pi: piDeviceId,
                }),
            );
            this.heldWrite = { key: boatKey, at: now, lat: fix.lat, lon: fix.lon };
        } catch {
            /* no storage: the fix simply does not outlive this session */
        }
    }

    private heldBoatFix(boatKey: BoatKey, piDeviceId: string | null, now: number): PlaceFix | null {
        try {
            const key = this.heldKey(boatKey);
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const stored = JSON.parse(raw) as (Partial<PlaceFix> & { pi?: unknown }) | null;
            if (!stored || !validFix(stored.lat, stored.lon)) return null;
            // Kept beside another Pi: re-paired, perhaps to another boat.
            if (typeof stored.pi === 'string' && piDeviceId && stored.pi !== piDeviceId) {
                localStorage.removeItem(key);
                return null;
            }
            if (
                typeof stored.at !== 'number' ||
                !Number.isFinite(stored.at) ||
                stored.at <= 0 ||
                stored.at > now + 5_000
            )
                return null;
            return { lat: stored.lat, lon: stored.lon as number, at: stored.at, accuracyM: stored.accuracyM ?? null };
        } catch {
            return null;
        }
    }

    private refreshNetworkSoon(now: number): void {
        if (now - this.networkAt >= NETWORK_REFRESH_MS) void this.refreshNetwork(now);
    }

    private async refreshNetwork(now: number): Promise<void> {
        if (this.networkInFlight) return;
        this.networkInFlight = true;
        this.networkAt = now;
        try {
            const next = networkFactsFrom(await getInterfaces());
            const changed = JSON.stringify(next) !== JSON.stringify(this.network);
            this.network = next;
            if (changed && this.listeners.size > 0) this.evaluate();
        } catch {
            /* no interface data: the place comes from GPS alone */
        } finally {
            this.networkInFlight = false;
        }
    }
}

export const BoatLinkService = new BoatLinkServiceClass();
