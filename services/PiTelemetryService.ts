/**
 * PiTelemetryService — the boat off the Pi, over the boat LAN.
 *
 * Shane 2026-09-07: "no more signal k or ydwg-02 on the actual phone unless
 * there is no pi available." The YDWG-02 has three TCP client slots and the
 * Pi already holds two, so every phone that opened its own socket was one
 * crew member away from exhausting the gateway. The phone's order is now:
 *
 *   a — THE PI OVER THE BOAT LAN: this lane. GET /api/telemetry on the pinned
 *       HTTPS lane every two seconds; the whole bus plus every AIS target
 *       Signal K has decoded, into the same NmeaStore and AisStore the
 *       Instrument Panel and the chart already draw from. Marked `via: 'lan'`,
 *       which the store ranks above the cloud and counts as the boat's own GPS.
 *   b — THE PI'S CLOUD ROW (CloudTelemetryService), when screens ask for it.
 *   c — THE GATEWAY SOCKET DIRECT — only when no Pi is paired, or the Pi has
 *       gone quiet (InstrumentSourcePolicy). Never opened from here.
 *
 * A Pi that answers with a quiet bus (ashore, instruments off) is PRESENT:
 * the gauges empty honestly and nothing opens the gateway for that. A Pi that
 * does not answer at all is what the policy waits a minute on.
 *
 * `via: 'lan'` means DIRECT FROM THE PI — the boat's own receivers, read at
 * bus latency — and nothing about where this phone is. The boat-network
 * address answers just as well from 900 km away over a VPN that carries her
 * network (Shane 2026-10-07: a Tailscale subnet route from the boat's router
 * made every screen say "Aboard" at home). Where the phone is comes from
 * services/boatLink, by position; this lane only records which saved address
 * answered and, from a newer Pi, the address the Pi saw the request come from
 * and the Pi's own address that took it.
 */
import { NmeaStore } from './NmeaStore';
import { AisStore } from './AisStore';
import { piCache } from './PiCacheService';
import { snapshotFromWire, wireNumber } from './telemetryWire';
import type { AisTarget } from '../types/navigation';
import { createLogger } from '../utils/createLogger';
import { AIS_COG_NOT_AVAILABLE, AIS_SOG_NOT_AVAILABLE } from '../utils/collisionRule';

const log = createLogger('PiTelemetry');

export const PI_TELEMETRY_POLL_MS = 2_000;
export const PI_TELEMETRY_RETRY_MS = 15_000;
/**
 * The first misses retry quickly. Over 5G and a VPN a 3 s read times out now
 * and then; waiting the full 15 s after every single one cost the lane its
 * 20 s budget on the second, and every label in the app flipped with it
 * (Shane 2026-10-07). Only a run of misses backs off to PI_TELEMETRY_RETRY_MS.
 */
export const PI_TELEMETRY_QUICK_RETRY_MS: readonly number[] = [2_000, 5_000];
/** The Pi's answer about this phone's path counts for this long after it was given. */
export const PI_PATH_FRESH_MS = 30_000;
/** A LAN snapshot older than this is a quiet bus, not the boat. */
export const PI_TELEMETRY_LIVE_MAX_AGE_MS = 20_000;
/** The Pi counts as present / live while its last answer is this recent. */
export const PI_TELEMETRY_PRESENT_WINDOW_MS = 10_000;
/** The phone's AisStore caps at 500 and sweeps at ten minutes; the Pi sends at most 300. */
export const PI_TELEMETRY_AIS_CAP = 300;
const READ_TIMEOUT_MS = 3_000;

export type PiTelemetryState = 'off' | 'searching' | 'live' | 'quiet' | 'unreachable';
type Listener = (state: PiTelemetryState) => void;

interface LanPayload {
    available?: unknown;
    telemetry?: unknown;
    ais?: unknown;
    /** Newer Pis: the address this request arrived from, and at (pi-cache/src/requestPath.ts). */
    path?: unknown;
}

/** Which saved address answered, and what the Pi saw of this phone's request. */
export interface PiPathInfo {
    answeredVia: 'lan-host' | 'tailnet-host' | null;
    /** The address the request arrived from. */
    seenFrom: string | null;
    /** The Pi's own address that took it: on the boat's network, its LAN address. */
    seenAt: string | null;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Field(raw: unknown, field: 'seen_from' | 'seen_at'): string | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const value = (raw as Record<string, unknown>)[field];
    if (typeof value !== 'string') return null;
    const match = IPV4.exec(value.trim());
    if (!match || match.slice(1).some((part) => Number(part) > 255)) return null;
    return value.trim();
}

/** The Pi's echo of this phone's source address, or null from an older Pi or anything odd. */
export function seenFromWire(raw: unknown): string | null {
    return ipv4Field(raw, 'seen_from');
}

/** The Pi's own address that took the request, or null from an older Pi or anything odd. */
export function seenAtWire(raw: unknown): string | null {
    return ipv4Field(raw, 'seen_at');
}

/** One AIS target off the wire (pi-cache/src/lanTelemetry.ts AisTargetWire), or null when it is not one. */
export function aisTargetFromWire(raw: unknown): AisTarget | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const mmsi = wireNumber(r.mmsi);
    const lat = wireNumber(r.lat);
    const lon = wireNumber(r.lon);
    const lastUpdated = wireNumber(r.lastUpdated);
    if (mmsi === null || !Number.isInteger(mmsi) || lat === null || lon === null || lastUpdated === null) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return {
        mmsi,
        lat,
        lon,
        lastUpdated,
        name: typeof r.name === 'string' ? r.name : '',
        // Missing is 'not available' (ITU 360 / 102.3), never 0 (build 125, 125-01).
        // The Pi's serialiser (pi-cache/src/lanTelemetry.ts) still sends a missing
        // Signal K course or speed as 0 until its 126-04 update, so on that lane
        // this guard does not yet catch them.
        cog: wireNumber(r.cog) ?? AIS_COG_NOT_AVAILABLE,
        sog: wireNumber(r.sog) ?? AIS_SOG_NOT_AVAILABLE,
        heading: wireNumber(r.heading) ?? 511,
        navStatus: wireNumber(r.navStatus) ?? 15,
        shipType: wireNumber(r.shipType) ?? 0,
        callSign: typeof r.callSign === 'string' ? r.callSign : '',
        destination: typeof r.destination === 'string' ? r.destination : '',
    };
}

class PiTelemetryServiceClass {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private inFlight = false;
    private state: PiTelemetryState = 'off';
    /** The Pi answered — live bus or quiet. */
    private lastSeenAtMs: number | null = null;
    /** The Pi's answer carried a current snapshot. */
    private lastLiveAtMs: number | null = null;
    private listeners = new Set<Listener>();
    /** Misses in a row; the first few retry quickly. */
    private misses = 0;
    /** Try the Pi's own tailnet address next (after the boat-network one missed). */
    private tryRemoteNext = false;
    private path: (PiPathInfo & { at: number }) | null = null;

    start(): void {
        if (this.running) return;
        this.running = true;
        this.setState('searching');
        void this.poll();
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        NmeaStore.clearRemote('lan');
        this.lastSeenAtMs = null;
        this.lastLiveAtMs = null;
        this.misses = 0;
        this.tryRemoteNext = false;
        this.path = null;
        this.setState('off');
    }

    isRunning(): boolean {
        return this.running;
    }

    getState(): PiTelemetryState {
        return this.state;
    }

    /** When the Pi last answered at all, or null. The policy's "is there a Pi" clock. */
    lastSeenAt(): number | null {
        return this.lastSeenAtMs;
    }

    /** The Pi answered within the window: it is HERE, whatever the bus is doing. */
    isPresent(now = Date.now()): boolean {
        return this.lastSeenAtMs !== null && now - this.lastSeenAtMs <= PI_TELEMETRY_PRESENT_WINDOW_MS;
    }

    /** The Pi handed over a current snapshot within the window. */
    isLive(now = Date.now()): boolean {
        return this.lastLiveAtMs !== null && now - this.lastLiveAtMs <= PI_TELEMETRY_PRESENT_WINDOW_MS;
    }

    /**
     * How the last answer travelled: which saved address answered, and the
     * address the Pi saw this phone's request come from. Says nothing about
     * where the phone is — the boat's own address answers over any VPN that
     * carries her network (services/boatLink/boatLinkModel.ts).
     */
    pathInfo(now = Date.now()): PiPathInfo {
        if (!this.path || now - this.path.at > PI_PATH_FRESH_MS)
            return { answeredVia: null, seenFrom: null, seenAt: null };
        return { answeredVia: this.path.answeredVia, seenFrom: this.path.seenFrom, seenAt: this.path.seenAt };
    }

    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** One read of the Pi, now — the poller's step, exposed for tests and the policy. */
    async pollOnce(): Promise<PiTelemetryState> {
        await this.readPi();
        return this.state;
    }

    /** Tests only. */
    resetForTests(): void {
        this.stop();
        this.listeners.clear();
    }

    private setState(next: PiTelemetryState): void {
        if (this.state === next) return;
        this.state = next;
        for (const cb of this.listeners) cb(next);
    }

    private schedule(delayMs: number): void {
        if (!this.running) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.poll(), delayMs);
    }

    private async poll(): Promise<void> {
        const next = await this.readPi();
        this.schedule(next);
    }

    /** Returns the delay before the next read. */
    private async readPi(): Promise<number> {
        if (this.inFlight) return PI_TELEMETRY_POLL_MS;
        this.inFlight = true;
        try {
            const { getPairing, pinnedPiRequest } = await import('./PiPairingService');
            if (!getPairing()) {
                this.lostPi('searching');
                return PI_TELEMETRY_RETRY_MS;
            }
            // The address the health ladder chose, or — after it missed — the
            // Pi's own tailnet address. Off the boat with no route to her
            // network, the ladder can sit on the boat address for minutes
            // (its poll backs off to five), so this lane tries the other one
            // itself rather than wait for the mirror to agree.
            const ladderBase = piCache.getBaseUrl();
            const remoteBase = piCache.getRemoteBaseUrl();
            const baseUrl = this.tryRemoteNext && remoteBase ? remoteBase : ladderBase;
            if (!baseUrl) {
                this.lostPi('unreachable');
                return PI_TELEMETRY_RETRY_MS;
            }
            const answeredVia: PiPathInfo['answeredVia'] =
                remoteBase && baseUrl === remoteBase ? 'tailnet-host' : 'lan-host';
            let res: Awaited<ReturnType<typeof pinnedPiRequest>>;
            try {
                // Read even while the gateway socket is connected: the store will
                // refuse the snapshot (the socket is the boat itself), but the
                // policy needs to know the Pi is back so it can give the gateway
                // its slot back.
                res = await pinnedPiRequest({
                    url: `${baseUrl}/api/telemetry`,
                    readTimeout: READ_TIMEOUT_MS,
                    responseType: 'text',
                });
            } catch (error) {
                // The other address next, when there is one.
                this.tryRemoteNext = !!remoteBase && remoteBase !== ladderBase && baseUrl !== remoteBase;
                throw error;
            }
            if (res.status < 200 || res.status >= 300) {
                this.lostPi('unreachable');
                return this.missDelay();
            }
            const body = JSON.parse(res.data) as LanPayload;
            const now = Date.now();
            this.lastSeenAtMs = now;
            this.misses = 0;
            this.tryRemoteNext = answeredVia === 'tailnet-host' && baseUrl !== ladderBase;
            this.path = { answeredVia, seenFrom: seenFromWire(body.path), seenAt: seenAtWire(body.path), at: now };
            // Traffic first: AIS is worth having even when the bus is quiet.
            this.ingestAis(body.ais);
            const reading =
                body.available === true && typeof body.telemetry === 'object' && body.telemetry !== null
                    ? snapshotFromWire(body.telemetry as Record<string, unknown>, 'lan')
                    : null;
            if (!reading || now - reading.reportedAt > PI_TELEMETRY_LIVE_MAX_AGE_MS) {
                // The Pi is here; the bus is quiet. Empty gauges, no fault, and
                // no reason to open the gateway.
                NmeaStore.clearRemote('lan');
                this.setState('quiet');
                return PI_TELEMETRY_POLL_MS;
            }
            NmeaStore.ingestRemote(reading.snapshot);
            this.lastLiveAtMs = now;
            this.setState('live');
            return PI_TELEMETRY_POLL_MS;
        } catch (error) {
            log.warn('Pi telemetry read failed:', error instanceof Error ? error.message : String(error));
            this.lostPi('unreachable');
            return this.missDelay();
        } finally {
            this.inFlight = false;
        }
    }

    /** One more miss: quick retries first, then the long one. */
    private missDelay(): number {
        this.misses += 1;
        return PI_TELEMETRY_QUICK_RETRY_MS[this.misses - 1] ?? PI_TELEMETRY_RETRY_MS;
    }

    private lostPi(state: 'searching' | 'unreachable'): void {
        // One missed read must not blank a panel the store's watchdog is still
        // ageing honestly; a lane gone for the whole live budget must.
        const now = Date.now();
        if (this.lastLiveAtMs === null || now - this.lastLiveAtMs > PI_TELEMETRY_LIVE_MAX_AGE_MS) {
            NmeaStore.clearRemote('lan');
        }
        this.setState(state);
    }

    private ingestAis(raw: unknown): void {
        if (!Array.isArray(raw)) return;
        let accepted = 0;
        for (const item of raw) {
            const target = aisTargetFromWire(item);
            if (!target) continue;
            AisStore.update(target);
            accepted += 1;
            if (accepted >= PI_TELEMETRY_AIS_CAP) break;
        }
    }
}

export const PiTelemetryService = new PiTelemetryServiceClass();
