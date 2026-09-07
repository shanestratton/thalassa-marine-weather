/**
 * instrumentPanelStatus — why is the instrument panel blank?
 *
 * A blank panel used to have four completely different causes and one
 * appearance. No gateway ever configured, a gateway that isn't connected, a
 * connected gateway that hasn't sent anything yet, and a gateway that sends
 * some sentences but not the one this tile wants — all of them rendered as
 * empty tiles with no explanation.
 *
 * Shane, 2026-08-09: "the ydwg-02 is connected, the gps is working, however
 * there is nothing showing on the instrument panel". The cause that day was a
 * fifth thing again — the store that feeds the panel was never started, so a
 * healthy gateway streamed into nothing while the panel reported no feed. The
 * bug is fixed; this exists so the NEXT one announces itself instead of
 * looking identical to the last four.
 *
 * The rule, same as everywhere else in the voice and alarm paths: silence must
 * never be indistinguishable from working.
 *
 * Pure — state in, words out.
 */
import type { NmeaConnectionStatus } from '../services/NmeaListenerService';
import type { DataFreshness } from '../services/NmeaStore';

export interface PanelMetric {
    value: number | null;
    freshness: DataFreshness;
}

export type PanelState =
    | 'no-gateway'
    | 'disconnected'
    | 'error'
    | 'connecting'
    | 'waiting'
    | 'stale'
    | 'live'
    | 'remote';

export interface PanelDiagnosis {
    state: PanelState;
    /** Short badge text for the header. */
    label: string;
    /**
     * A sentence explaining a blank or degraded panel, or null when the panel
     * is showing live numbers and needs no explanation.
     */
    detail: string | null;
    /** Whether `detail` describes a problem the skipper can act on. */
    actionable: boolean;
}

export function diagnosePanel(params: {
    /** Has a gateway host/port ever been saved? */
    gatewayConfigured: boolean;
    connectionStatus: NmeaConnectionStatus | 'remote';
    /** Every metric the panel can display. */
    metrics: readonly PanelMetric[];
    /** Seconds since the socket connected, when known. */
    secondsSinceConnect?: number | null;
    /** Who is feeding the store from the cloud, when nothing is wired. */
    remote?: {
        source: 'pi' | 'device';
        deviceLabel: string | null;
        /** The Pi over the boat LAN, or its cloud row; absent means the cloud. */
        via?: 'lan' | 'cloud';
        ageSeconds: number;
    } | null;
    /**
     * Crew only: has the skipper shared the Instrument Panel with this account?
     * 'none' for a skipper, or anyone who crews on nothing.
     */
    crewShare?: 'none' | 'shared' | 'not-shared';
}): PanelDiagnosis {
    const {
        gatewayConfigured,
        connectionStatus,
        metrics,
        secondsSinceConnect = null,
        remote = null,
        crewShare = 'none',
    } = params;

    // No socket, but the boat is reporting through the cloud — say so, and say
    // how old. Not 'live' and not 'no gateway': a crew phone on the train has
    // neither a gateway nor a fault.
    if (connectionStatus === 'remote') {
        // The Pi's hostname (deviceLabel) stays out of the punter's eye —
        // Shane 2026-09-07: it is the internal Pi name, not the boat's.
        const who = remote?.source === 'device' ? 'the skipper’s phone' : 'the Pi';
        const age = remote ? Math.max(0, Math.round(remote.ageSeconds)) : null;
        // Over the boat LAN the Pi IS the boat at bus latency: that is live,
        // and the gateway's TCP slots stay the Pi's (Shane 2026-09-07).
        if (remote?.via === 'lan') {
            return {
                state: 'live',
                label: 'Live · Pi',
                detail: `Reading the boat through the Pi on the boat network — reported ${age === null ? 'moments' : `${age} s`} ago.`,
                actionable: false,
            };
        }
        return {
            state: 'remote',
            label: 'Remote',
            detail: `Reading the boat through the cloud — ${who} reported ${age === null ? 'moments' : `${age} s`} ago.`,
            actionable: false,
        };
    }

    if (!gatewayConfigured) {
        // Shane 2026-09-07: the panel is invite-only. A crew phone with no
        // gateway of its own is the normal case, not a fault — say what is
        // actually missing: the skipper's share, or the boat reporting.
        if (crewShare === 'not-shared') {
            return {
                state: 'no-gateway',
                label: 'Not shared',
                detail: 'The skipper has not shared the Instrument Panel with you yet. Ask them to switch it on for you under Crew.',
                actionable: false,
            };
        }
        if (crewShare === 'shared') {
            return {
                state: 'no-gateway',
                label: 'Boat quiet',
                detail: 'The boat is not reporting right now. Her Pi publishes every few seconds while it is on and online.',
                actionable: false,
            };
        }
        return {
            state: 'no-gateway',
            label: 'No gateway',
            detail: 'No NMEA gateway set up yet. Add one on the Vessel → NMEA Gateway page.',
            actionable: true,
        };
    }

    if (connectionStatus === 'error') {
        return {
            state: 'error',
            label: 'Error',
            detail: 'The gateway refused the connection. Check it is powered and on this network.',
            actionable: true,
        };
    }

    if (connectionStatus === 'connecting') {
        return { state: 'connecting', label: 'Connecting', detail: 'Connecting to the gateway…', actionable: false };
    }

    if (connectionStatus === 'disconnected') {
        return {
            state: 'disconnected',
            label: 'No feed',
            detail: 'Gateway not connected. Open Vessel → NMEA Gateway and tap Connect.',
            actionable: true,
        };
    }

    // Connected from here down. What is actually arriving?
    const present = metrics.filter((m) => m.value !== null && m.freshness !== 'dead');

    if (present.length === 0) {
        // A connected socket that delivers nothing is the case most easily
        // mistaken for a broken app. Say which side is quiet, and — after long
        // enough that "give it a second" stops being true — say it is wrong.
        const stalled = secondsSinceConnect !== null && secondsSinceConnect > 15;
        return {
            state: 'waiting',
            label: stalled ? 'No data' : 'Waiting',
            detail: stalled
                ? 'Connected, but the gateway has sent no instrument data. Check the NMEA backbone is powered ' +
                  'and that the gateway is set to output the sentences you expect.'
                : 'Connected. Waiting for the first sentences…',
            actionable: stalled,
        };
    }

    if (present.every((m) => m.freshness === 'stale')) {
        return {
            state: 'stale',
            label: 'Stale',
            detail: 'Readings have stopped updating. The socket is open but the instruments have gone quiet.',
            actionable: true,
        };
    }

    return { state: 'live', label: 'Live', detail: null, actionable: false };
}

/**
 * Which named instruments are missing while others are arriving?
 *
 * A gateway happily sends GPS and depth while the wind transducer is
 * unplugged. Naming the absent ones turns "why is the wind rose empty" into a
 * job on the boat rather than a suspicion about the app.
 *
 * Returns [] when nothing is arriving at all — the panel-level message already
 * covers that, and listing every instrument would be noise.
 */
export function missingInstruments(named: ReadonlyArray<{ name: string; metrics: readonly PanelMetric[] }>): string[] {
    const anyPresent = named.some((group) => group.metrics.some((m) => m.value !== null && m.freshness !== 'dead'));
    if (!anyPresent) return [];
    return named
        .filter((group) => group.metrics.every((m) => m.value === null || m.freshness === 'dead'))
        .map((group) => group.name);
}
