import type { NmeaConnectionStatus } from '../services/NmeaListenerService';
import type { NmeaStoreState } from '../services/NmeaStore';
import { NMEA_USABLE_MAX_AGE_MS } from '../services/nmea/nmeaCadence';
import type { DataState } from '../services/boatLink/boatLinkModel';

export interface NmeaBackboneStatus {
    active: boolean;
    detail: string;
    faulted: boolean;
    /** The sentence-rate chart measures this phone's direct gateway socket only. */
    showRates: boolean;
}

export interface NmeaBackboneStatusInput {
    store: NmeaStoreState;
    directStatus: NmeaConnectionStatus;
    deviceLabel: string;
    lastError: string | null;
    /**
     * Where this phone is, how the boat reaches it and how fresh, in the words
     * every screen uses (services/boatLink): 'Away · Pi over Tailscale · live'.
     * It replaced a '· tailnet' suffix read off the Pi cache's host ladder,
     * which stayed silent whenever the boat's own address answered over a
     * VPN, and so read as aboard from 900 km away (Shane 2026-10-07).
     */
    link?: { statusRow: string; data: { state: DataState } } | null;
    now?: number;
}

const METRIC_KEYS = [
    'tws',
    'twa',
    'twaSigned',
    'heel',
    'pitch',
    'twd',
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
    'hdop',
    'satellites',
] as const satisfies readonly (keyof NmeaStoreState)[];

/** Match the store's small clock-skew allowance, never accept a future-dated feed indefinitely. */
const FUTURE_TOLERANCE_MS = 1_000;
/**
 * Match PiTelemetryService.PI_TELEMETRY_LIVE_MAX_AGE_MS and
 * CloudTelemetryService.CLOUD_TELEMETRY_LIVE_MAX_AGE_MS. Kept as values here
 * because those modules construct service singletons; a status resolver must
 * not import their transport and authentication lifecycle merely for limits.
 */
const REMOTE_MAX_AGE_MS = { lan: 20_000, cloud: 60_000 } as const;

function withinAge(timestamp: number, now: number, maxAge: number): boolean {
    return (
        Number.isFinite(timestamp) &&
        timestamp > 0 &&
        timestamp <= now + FUTURE_TOLERANCE_MS &&
        now - timestamp <= maxAge
    );
}

function hasUsableReading(store: NmeaStoreState, now: number): boolean {
    return METRIC_KEYS.some((key) => {
        const metric = store[key];
        return (
            metric.value !== null &&
            Number.isFinite(metric.value) &&
            metric.freshness !== 'dead' &&
            withinAge(metric.lastUpdated, now, NMEA_USABLE_MAX_AGE_MS)
        );
    });
}

/** Keep a useful first sentence; native socket diagnostics belong on the gateway page. */
function shortFault(raw: string | null): string | null {
    if (!raw) return null;
    const withoutRawTail = raw
        .replace(/\s*\([^()]*SocketError[^()]*\)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!withoutRawTail) return null;
    const firstSentence = /^(.*?[.!?])(\s|$)/.exec(withoutRawTail)?.[1] ?? withoutRawTail;
    return firstSentence.length > 96 ? `${firstSentence.slice(0, 95).trimEnd()}…` : firstSentence;
}

/**
 * The backbone can reach the phone through its direct socket or through the
 * Pi. Reachability alone proves neither instrument data nor its freshness.
 * Keep this resolver free of reads and subscriptions so the same snapshot
 * can be re-evaluated when time passes without a new network event.
 */
export function deriveNmeaBackboneStatus({
    store,
    directStatus,
    deviceLabel,
    lastError,
    link = null,
    now = Date.now(),
}: NmeaBackboneStatusInput): NmeaBackboneStatus {
    const usableReading = hasUsableReading(store, now);
    const said = (fallback: string) => link?.statusRow ?? fallback;

    if (directStatus === 'connected') {
        return {
            active: true,
            detail: said(
                `Connected via ${deviceLabel} · ${usableReading ? 'live vessel data' : 'waiting for instrument data'}`,
            ),
            faulted: false,
            showRates: true,
        };
    }

    const remote = store.connectionStatus === 'remote' ? store.remote : null;
    if (remote) {
        // A phone can publish a fresh position without receiving the NMEA bus.
        // Its cloud row must not make this separate backbone indicator green.
        if (remote.source !== 'pi') {
            return {
                active: false,
                detail: 'Receiving a phone snapshot · no NMEA instrument feed',
                faulted: false,
                showRates: false,
            };
        }

        const maxAge = REMOTE_MAX_AGE_MS[remote.via];
        // Re-reading a frozen snapshot updates receivedAt and metric clocks.
        // Both the Pi's source clock and this phone's receipt must be current.
        if (!withinAge(remote.reportedAt, now, maxAge) || !withinAge(remote.receivedAt, now, maxAge)) {
            return {
                active: false,
                detail: said('Pi instrument readings are out of date · waiting for fresh data'),
                faulted: false,
                showRates: false,
            };
        }

        if (!usableReading) {
            return {
                active: false,
                detail: said('The Pi is reporting · no current instrument readings'),
                faulted: false,
                showRates: false,
            };
        }

        return {
            active: true,
            detail: said(remote.via === 'cloud' ? 'Receiving instruments via the Pi · cloud' : 'Connected via the Pi'),
            faulted: false,
            showRates: false,
        };
    }

    if (directStatus === 'connecting') {
        return {
            active: false,
            detail: said(`Connecting to ${deviceLabel}`),
            faulted: false,
            showRates: false,
        };
    }

    const fault = shortFault(lastError);
    if (link) {
        // A failure is red only when it is the skipper's to fix — their own
        // socket, or a Pi-less boat's gateway with this phone not shown to be
        // away. From ashore an unreachable boat is not a fault.
        const failed = link.data.state === 'failed';
        return {
            active: false,
            detail: failed && fault ? fault : link.statusRow,
            faulted: failed,
            showRates: false,
        };
    }
    return {
        active: false,
        detail: fault ?? (directStatus === 'error' ? 'Gateway connection failed' : 'Not connected'),
        faulted: directStatus === 'error' || fault !== null,
        showRates: false,
    };
}
