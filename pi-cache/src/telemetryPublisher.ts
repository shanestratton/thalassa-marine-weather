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
 *
 * 129-08, the cloud's quiet-boat watchdog: it must hear the Pi whenever the
 * Pi is up and online, even when her bus has gone silent, and know when the
 * bus last spoke (extra.bus_at_ms, readTelemetrySnapshot). So every post says
 * when the Pi sent it by its own clock (sent_at, which the relay checks for
 * age), while reported_at stays the readings' own time; a bus the supplement
 * set aside because its GPS clock stalled still goes, as it is, when nothing
 * fresher has replaced it; Signal K not answering sends the bus as last read;
 * and a supplement's own snapshot carries the bus's bus_at_ms. Nothing old is
 * ever dated as new.
 */
import { fetchSelfDocument, type BroadcastDeps } from './anchorBroadcaster.js';
import { appendSystemsExtra } from './systemsTelemetry.js';
import { readTelemetrySnapshot, type TelemetrySnapshot } from './trackSignalk.js';

export const TELEMETRY_RELAY_PATH = '/functions/v1/telemetry-relay';
export const PUBLISH_INTERVAL_MS = 5_000;
export const MAX_BACKOFF_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

type FetchLike = BroadcastDeps['fetchImpl'];

export interface TelemetryPublisherDeps {
    fetchImpl: FetchLike;
    signalkOrigin: string;
    selfDocument?: BroadcastDeps['selfDocument'];
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
    /**
     * The night watch's three cloud keys (126-04a, aisWatch.ts cloudExtra()),
     * so a phone ashore can say whether the Pi is watching. They go FIRST in
     * `extra`: the relay keeps at most 40 keys in insertion order and drops
     * the rest without a word (supabase/functions/telemetry-relay/parse.ts).
     */
    aisWatchExtra?: () => Record<string, number | string> | null;
    /**
     * Keys written LAST in `extra` (126-04b: the night watch's word on whether
     * the Pi can wake the skipper's phone). The relay keeps the first 40 keys,
     * so when the bus fills them, these are the ones it drops: a capability
     * word may be lost (the phone then claims nothing), an instrument may not.
     */
    trailingExtra?: () => Record<string, number | string> | null;
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

/**
 * The wire shape the Edge Function parses (parse.ts): snake_case, bounded
 * there. `leadingExtra` goes first in `extra`, ahead of everything the bus and
 * the supplements put there: the relay keeps the first 40 keys only.
 */
export function buildTelemetryBody(
    snapshot: TelemetrySnapshot,
    deviceLabel: string,
    leadingExtra?: Record<string, number | string> | null,
    trailingExtra?: Record<string, number | string> | null,
): Record<string, unknown> {
    const trailing = trailingExtra && Object.keys(trailingExtra).length > 0 ? trailingExtra : null;
    const critical = leadingExtra || trailing ? { ...leadingExtra, ...snapshot.extra, ...trailing } : snapshot.extra;
    const extra = appendSystemsExtra(critical, snapshot.systemsExtra);
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
        ...(extra ? { extra } : {}),
    };
}

/**
 * The snapshot with the bus's bus_at_ms (when the bus has one), first among
 * its keys: a supplement's own snapshot, made because the bus was set aside,
 * still says when the bus last spoke.
 */
function withBusTime(snapshot: TelemetrySnapshot | null, bus: TelemetrySnapshot | null): TelemetrySnapshot | null {
    const busAt = bus?.extra?.bus_at_ms;
    if (!snapshot || typeof busAt !== 'number' || snapshot.extra?.bus_at_ms !== undefined) return snapshot;
    return { ...snapshot, extra: { bus_at_ms: busAt, ...snapshot.extra } };
}

export class TelemetryPublisher {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private inFlight = false;
    private consecutiveFailures = 0;
    private lastOutcome: PublishOutcome | null = null;
    private lastSentAt: number | null = null;
    /** The bus as last read off Signal K, with its own times (129-08). */
    private lastBus: TelemetrySnapshot | null = null;

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

        const now = this.deps.now ?? Date.now;
        const doc = await fetchSelfDocument({
            fetchImpl: this.deps.fetchImpl,
            signalkOrigin: this.deps.signalkOrigin,
            selfDocument: this.deps.selfDocument,
        });
        const read = doc === null ? null : readTelemetrySnapshot(doc, now);
        if (read) this.lastBus = read;
        // Signal K not answering, or restarted with nothing: the bus as last
        // read, dated as it was then (Signal K keeps a dead bus's values so).
        const bus = read ?? this.lastBus;
        const supplemented = this.deps.supplement ? await this.deps.supplement(bus) : bus;
        // The supplement sets aside a bus whose GPS clock has stalled. With
        // nothing fresher to send instead, the bus goes as it is, still dated
        // by that clock: the cloud hears the Pi, and nothing old reads as new.
        const snapshot = withBusTime(supplemented ?? bus, bus);
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
                body: JSON.stringify({
                    ...buildTelemetryBody(
                        snapshot,
                        this.deps.deviceLabel,
                        this.deps.aisWatchExtra?.(),
                        this.deps.trailingExtra?.(),
                    ),
                    // When the Pi sent it, by its own clock: the relay checks
                    // this for age, so a stalled reading still gets through.
                    sent_at: new Date(now()).toISOString(),
                }),
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
