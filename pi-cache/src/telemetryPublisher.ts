/**
 * TelemetryPublisher — the Pi tells the cloud what the boat's instruments say.
 *
 * Shane 2026-09-06: the Pi is the primary device ("one source of truth") and
 * crew should see the Instrument Panel anywhere without a VPN. Every few
 * seconds this reads Signal K's self document, converts the bus to the units
 * the panel draws (trackSignalk.readTelemetrySnapshot) and POSTs one snapshot
 * to the telemetry-relay Edge Function with the pairing credential the diary
 * relay already holds. The function keeps one row per skipper; the phones
 * read it when they have no gateway socket.
 *
 * What it will not do: publish while the skipper's Pi policy forbids ordinary
 * internet (satellite), publish when unpaired, hold a service-role key, or
 * hammer a cloud that is refusing it — failures back off to five minutes.
 */
import { fetchSelfDocument, type BroadcastDeps } from './anchorBroadcaster.js';
import { readTelemetrySnapshot, type TelemetrySnapshot } from './trackSignalk.js';

export const TELEMETRY_RELAY_PATH = '/functions/v1/telemetry-relay';
export const PUBLISH_INTERVAL_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

type FetchLike = BroadcastDeps['fetchImpl'];

export interface TelemetryPublisherDeps {
    fetchImpl: FetchLike;
    signalkOrigin: string;
    /** Full URL of the telemetry-relay function, built from the trusted Supabase origin. */
    endpoint: string;
    /** The public anon key the gateway checks; read live because /api/configure can change it. */
    anonKey: () => string;
    /** The pairing credential, or null while unpaired. */
    credentials: () => { relayId: string; token: string } | null;
    /** The skipper's Pi-local network policy. */
    internetAllowed: () => boolean;
    deviceLabel: string;
    intervalMs?: number;
    now?: () => number;
    supplement?: (snapshot: TelemetrySnapshot | null) => Promise<TelemetrySnapshot | null>;
}

export type PublishOutcome =
    | 'sent'
    | 'no-data'
    | 'not-paired'
    | 'internet-off'
    | 'no-anon-key'
    | 'unauthorised'
    | 'rejected'
    | 'unreachable';

export interface TelemetryPublisherStatus {
    running: boolean;
    lastOutcome: PublishOutcome | null;
    lastSentAt: number | null;
    consecutiveFailures: number;
    nextDelayMs: number;
}

/** The wire shape the Edge Function parses (parse.ts): snake_case, bounded there. */
export function buildTelemetryBody(snapshot: TelemetrySnapshot, deviceLabel: string): Record<string, unknown> {
    return {
        source: 'pi',
        device_label: deviceLabel.slice(0, 60),
        reported_at: snapshot.reportedAt,
        lat: snapshot.lat,
        lon: snapshot.lon,
        sog_kts: snapshot.sogKts,
        cog_deg: snapshot.cogDeg,
        heading_deg: snapshot.headingDeg,
        stw_kts: snapshot.stwKts,
        tws_kts: snapshot.twsKts,
        twa_deg: snapshot.twaDeg,
        twd_deg: snapshot.twdDeg,
        aws_kts: snapshot.awsKts,
        awa_deg: snapshot.awaDeg,
        depth_m: snapshot.depthM,
        heel_deg: snapshot.heelDeg,
        pitch_deg: snapshot.pitchDeg,
        water_temp_c: snapshot.waterTempC,
        pressure_hpa: snapshot.pressureHpa,
        rudder_deg: snapshot.rudderDeg,
        rpm: snapshot.rpm,
        voltage_v: snapshot.voltageV,
        ...(snapshot.extra ? { extra: snapshot.extra } : {}),
    };
}

export class TelemetryPublisher {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private inFlight = false;
    private consecutiveFailures = 0;
    private lastOutcome: PublishOutcome | null = null;
    private lastSentAt: number | null = null;

    constructor(private readonly deps: TelemetryPublisherDeps) {}

    start(): void {
        if (this.running) return;
        this.running = true;
        this.schedule(0);
    }

    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    status(): TelemetryPublisherStatus {
        return {
            running: this.running,
            lastOutcome: this.lastOutcome,
            lastSentAt: this.lastSentAt,
            consecutiveFailures: this.consecutiveFailures,
            nextDelayMs: this.nextDelayMs(),
        };
    }

    /** Interval doubled per consecutive failure, capped — a refusing cloud is not hammered. */
    nextDelayMs(): number {
        const base = this.deps.intervalMs ?? PUBLISH_INTERVAL_MS;
        if (this.consecutiveFailures === 0) return base;
        return Math.min(MAX_BACKOFF_MS, base * 2 ** this.consecutiveFailures);
    }

    private schedule(delayMs: number): void {
        if (!this.running) return;
        this.timer = setTimeout(() => {
            void this.publishOnce()
                .catch(() => 'unreachable' as PublishOutcome)
                .finally(() => this.schedule(this.nextDelayMs()));
        }, delayMs);
        this.timer.unref?.();
    }

    /** One attempt. Never throws; the outcome says what happened. */
    async publishOnce(): Promise<PublishOutcome> {
        if (this.inFlight) return this.lastOutcome ?? 'no-data';
        this.inFlight = true;
        try {
            const outcome = await this.attempt();
            if (outcome !== this.lastOutcome) {
                // One line per change of state, never per tick: the journal
                // answers "why is the row not there" without filling itself.
                console.log(`[telemetry] publisher: ${outcome}`);
            }
            this.lastOutcome = outcome;
            if (outcome === 'sent') {
                this.consecutiveFailures = 0;
                this.lastSentAt = (this.deps.now ?? Date.now)();
            } else if (outcome === 'unreachable' || outcome === 'rejected' || outcome === 'unauthorised') {
                this.consecutiveFailures += 1;
            }
            return outcome;
        } finally {
            this.inFlight = false;
        }
    }

    private async attempt(): Promise<PublishOutcome> {
        if (!this.deps.internetAllowed()) return 'internet-off';
        const credential = this.deps.credentials();
        if (!credential) return 'not-paired';
        const anonKey = this.deps.anonKey();
        if (!anonKey) return 'no-anon-key';

        const doc = await fetchSelfDocument({ fetchImpl: this.deps.fetchImpl, signalkOrigin: this.deps.signalkOrigin });
        const bus = doc === null ? null : readTelemetrySnapshot(doc, this.deps.now);
        const snapshot = this.deps.supplement ? await this.deps.supplement(bus) : bus;
        if (!snapshot) return 'no-data';

        let response: Awaited<ReturnType<FetchLike>>;
        try {
            response = await this.deps.fetchImpl(this.deps.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    apikey: anonKey,
                    Authorization: `Bearer ${anonKey}`,
                    'X-Thalassa-Pi-Relay-Id': credential.relayId,
                    'X-Thalassa-Pi-Relay-Token': credential.token,
                },
                body: JSON.stringify(buildTelemetryBody(snapshot, this.deps.deviceLabel)),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch {
            return 'unreachable';
        }
        if (response.status === 401 || response.status === 403) return 'unauthorised';
        if (!response.ok) return 'rejected';
        return 'sent';
    }
}
