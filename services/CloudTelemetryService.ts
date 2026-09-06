/**
 * CloudTelemetryService — the boat's instrument snapshot from the cloud.
 *
 * Shane 2026-09-06, on the order the phone should read the boat in: "a: vpn,
 * b: supabase, c: dont know". The gateway socket (boat LAN, or the same LAN
 * over Tailscale) is (a) and always wins. When it is not connected, this
 * service reads the row the Pi keeps in vessel_telemetry (b) and feeds it
 * into the same NmeaStore the Instrument Panel already draws from, marked
 * REMOTE so the panel says so. When there is no row, or it is older than a
 * minute, the panel says nothing rather than something stale (c).
 *
 * Reads only. Row-level security decides what this account may see: the
 * skipper's own boat, and the boats they crew on. Polling, not realtime, for
 * the first cut — five seconds on ordinary internet, a minute on a satellite
 * link — and only while a screen that wants it is mounted.
 */
import { supabase, getCurrentUserId } from './supabase';
import { NmeaStore, type RemoteInstrumentSnapshot } from './NmeaStore';
import { satelliteModeActive } from './networkPolicy';
import { subscribeAuthIdentityScope } from './authIdentityScope';
import { createLogger } from '../utils/createLogger';

const log = createLogger('CloudTelemetry');

export const CLOUD_TELEMETRY_POLL_MS = 5_000;
export const CLOUD_TELEMETRY_SATELLITE_POLL_MS = 60_000;
/** Older than this and the snapshot is history, not the boat. */
export const CLOUD_TELEMETRY_LIVE_MAX_AGE_MS = 60_000;
/** The Pi counts as the primary device while its snapshot is this fresh. */
export const PI_PRIMARY_MAX_AGE_MS = 60_000;

export interface CloudTelemetry {
    ownerId: string;
    boatId: string | null;
    source: 'pi' | 'device';
    deviceLabel: string | null;
    /** Epoch ms of the instrument reading the Pi reported. */
    reportedAt: number;
    /** Epoch ms when this phone read the row. */
    receivedAt: number;
    snapshot: RemoteInstrumentSnapshot;
}

type Listener = (latest: CloudTelemetry | null) => void;

type TelemetryRow = Record<string, unknown> & { owner_id: string };

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The cloud row as the store wants it. Exported for the unit test. */
export function rowToTelemetry(row: TelemetryRow, receivedAt = Date.now()): CloudTelemetry | null {
    const reportedAt = typeof row.reported_at === 'string' ? Date.parse(row.reported_at) : Number.NaN;
    if (!Number.isFinite(reportedAt) || typeof row.owner_id !== 'string') return null;
    const source = row.source === 'device' ? 'device' : 'pi';
    const deviceLabel =
        typeof row.device_label === 'string' && row.device_label.trim() ? row.device_label.trim() : null;
    return {
        ownerId: row.owner_id,
        boatId: typeof row.boat_id === 'string' ? row.boat_id : null,
        source,
        deviceLabel,
        reportedAt,
        receivedAt,
        snapshot: {
            source,
            deviceLabel,
            reportedAt,
            lat: num(row.lat),
            lon: num(row.lon),
            sogKts: num(row.sog_kts),
            cogDeg: num(row.cog_deg),
            headingDeg: num(row.heading_deg),
            stwKts: num(row.stw_kts),
            twsKts: num(row.tws_kts),
            twaDeg: num(row.twa_deg),
            twdDeg: num(row.twd_deg),
            awsKts: num(row.aws_kts),
            awaDeg: num(row.awa_deg),
            depthM: num(row.depth_m),
            heelDeg: num(row.heel_deg),
            pitchDeg: num(row.pitch_deg),
            waterTempC: num(row.water_temp_c),
            rudderDeg: num(row.rudder_deg),
            rpm: num(row.rpm),
            voltageV: num(row.voltage_v),
        },
    };
}

/** Prefer the account's own boat; otherwise the freshest boat it crews on. */
export function pickRow(rows: TelemetryRow[], userId: string | null): TelemetryRow | null {
    if (rows.length === 0) return null;
    const own = userId ? rows.find((r) => r.owner_id === userId) : undefined;
    if (own) return own;
    return [...rows].sort((a, b) => {
        const ta = typeof a.reported_at === 'string' ? Date.parse(a.reported_at) : 0;
        const tb = typeof b.reported_at === 'string' ? Date.parse(b.reported_at) : 0;
        return tb - ta;
    })[0];
}

class CloudTelemetryServiceClass {
    private retainCount = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private latest: CloudTelemetry | null = null;
    private listeners = new Set<Listener>();
    private polling = false;

    constructor() {
        subscribeAuthIdentityScope(() => {
            // Another account must never see the previous one's boat.
            this.setLatest(null);
            NmeaStore.clearRemote();
        });
    }

    /** A screen wants the boat. The first caller starts polling; the last release stops it. */
    retain(): void {
        this.retainCount += 1;
        if (this.retainCount === 1) this.start();
    }

    release(): void {
        this.retainCount = Math.max(0, this.retainCount - 1);
        if (this.retainCount === 0) this.stop();
    }

    getLatest(): CloudTelemetry | null {
        return this.latest;
    }

    subscribe(cb: Listener): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    /** The Pi is publishing the boat right now, so phones stand down. */
    piIsPrimary(now = Date.now()): boolean {
        const t = this.latest;
        return t !== null && t.source === 'pi' && now - t.reportedAt <= PI_PRIMARY_MAX_AGE_MS;
    }

    private start(): void {
        if (this.timer) return;
        void this.poll();
        this.timer = setInterval(() => void this.poll(), this.pollInterval());
    }

    private stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        NmeaStore.clearRemote();
        this.setLatest(null);
    }

    private pollInterval(): number {
        return satelliteModeActive() ? CLOUD_TELEMETRY_SATELLITE_POLL_MS : CLOUD_TELEMETRY_POLL_MS;
    }

    private setLatest(next: CloudTelemetry | null): void {
        this.latest = next;
        for (const cb of this.listeners) cb(next);
    }

    private async poll(): Promise<void> {
        if (this.polling || !supabase) return;
        // (a) beats (b): a connected gateway socket is the boat itself.
        if (NmeaStore.getState().connectionStatus === 'connected') return;
        this.polling = true;
        try {
            const userId = await getCurrentUserId();
            if (!userId) {
                this.setLatest(null);
                NmeaStore.clearRemote();
                return;
            }
            const { data, error } = await supabase
                .from('vessel_telemetry')
                .select('*')
                .order('reported_at', { ascending: false })
                .limit(5);
            if (error) {
                log.warn('vessel_telemetry read failed:', error.message);
                return; // keep what we have; the store's own freshness will age it out
            }
            const row = pickRow((data ?? []) as TelemetryRow[], userId);
            const telemetry = row ? rowToTelemetry(row) : null;
            this.setLatest(telemetry);
            if (telemetry && Date.now() - telemetry.reportedAt <= CLOUD_TELEMETRY_LIVE_MAX_AGE_MS) {
                NmeaStore.ingestRemote(telemetry.snapshot);
            } else {
                NmeaStore.clearRemote();
            }
        } catch (error) {
            log.warn('vessel_telemetry poll failed:', error);
        } finally {
            this.polling = false;
        }
    }
}

export const CloudTelemetryService = new CloudTelemetryServiceClass();
