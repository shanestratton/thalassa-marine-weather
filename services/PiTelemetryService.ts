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
 */
import { NmeaStore } from './NmeaStore';
import { AisStore } from './AisStore';
import { piCache } from './PiCacheService';
import { snapshotFromWire, wireNumber } from './telemetryWire';
import type { AisTarget } from '../types/navigation';
import { createLogger } from '../utils/createLogger';

const log = createLogger('PiTelemetry');

export const PI_TELEMETRY_POLL_MS = 2_000;
export const PI_TELEMETRY_RETRY_MS = 15_000;
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
        cog: wireNumber(r.cog) ?? 0,
        sog: wireNumber(r.sog) ?? 0,
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
            const baseUrl = piCache.getBaseUrl();
            if (!baseUrl) {
                this.lostPi('unreachable');
                return PI_TELEMETRY_RETRY_MS;
            }
            // Read even while the gateway socket is connected: the store will
            // refuse the snapshot (the socket is the boat itself), but the
            // policy needs to know the Pi is back so it can give the gateway
            // its slot back.
            const res = await pinnedPiRequest({
                url: `${baseUrl}/api/telemetry`,
                readTimeout: READ_TIMEOUT_MS,
                responseType: 'text',
            });
            if (res.status < 200 || res.status >= 300) {
                this.lostPi('unreachable');
                return PI_TELEMETRY_RETRY_MS;
            }
            const body = JSON.parse(res.data) as LanPayload;
            const now = Date.now();
            this.lastSeenAtMs = now;
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
            return PI_TELEMETRY_RETRY_MS;
        } finally {
            this.inFlight = false;
        }
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
