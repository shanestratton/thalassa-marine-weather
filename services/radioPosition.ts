/** Read-only position sources for the radio. Telemetry report clocks are not GPS observation clocks. */
import { NmeaStore } from './NmeaStore';
import { NmeaListenerService } from './NmeaListenerService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';
import type { GpsPosition } from './GpsService';

export type RadioPositionSource = 'bus' | 'pi' | 'cloud' | 'phone';
export interface RadioPositionFix {
    latitude: number;
    longitude: number;
    /** The coordinate observation time, never the response/report time. */
    timestamp: number;
    source: RadioPositionSource;
    sourceLabel: string;
    isVessel: boolean;
    /** Selected fleet association, not proof that this receiver is physically aboard that vessel. */
    vesselId?: string | null;
    /** Public receiver identity for resetting an operator's confirmation after a source change. */
    receiverKey?: string;
    /** Metres/second; null when the source has no independently fresh movement reading. */
    speed: number | null;
    heading: number | null;
    accuracy: number | null;
}

export const RADIO_LOCAL_FIX_MAX_AGE_MS = 10_000;
export const RADIO_CLOUD_FIX_MAX_AGE_MS = 60_000;

const SOURCE_LABELS: Record<RadioPositionSource, string> = {
    bus: 'Boat GPS',
    pi: 'Boat GPS (via Pi)',
    cloud: 'Boat GPS (via cloud)',
    phone: 'Phone GPS',
};

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonNegative = (value: unknown): number | null => (finiteNumber(value) && value >= 0 ? value : null);
const course = (value: unknown): number | null => (finiteNumber(value) && value >= 0 && value < 360 ? value : null);

/** Canonicalise source claims and reject malformed/future observations at every async boundary. */
export function validateRadioPosition(fix: RadioPositionFix | null, now = Date.now()): RadioPositionFix | null {
    if (
        !fix ||
        !Object.hasOwn(SOURCE_LABELS, fix.source) ||
        !finiteNumber(fix.latitude) ||
        Math.abs(fix.latitude) > 90 ||
        !finiteNumber(fix.longitude) ||
        Math.abs(fix.longitude) > 180 ||
        !finiteNumber(fix.timestamp) ||
        fix.timestamp <= 0 ||
        fix.timestamp > now
    ) {
        return null;
    }
    return {
        latitude: fix.latitude,
        longitude: fix.longitude,
        timestamp: fix.timestamp,
        source: fix.source,
        sourceLabel: SOURCE_LABELS[fix.source],
        isVessel: fix.source !== 'phone',
        vesselId:
            fix.source !== 'phone' && typeof fix.vesselId === 'string' && fix.vesselId.trim() ? fix.vesselId : null,
        receiverKey: fix.receiverKey ?? fix.source,
        speed: nonNegative(fix.speed),
        heading: course(fix.heading),
        accuracy: nonNegative(fix.accuracy),
    };
}

export function radioPositionIsFresh(fix: RadioPositionFix, now = Date.now()): boolean {
    return (
        validateRadioPosition(fix, now) !== null &&
        now - fix.timestamp <= (fix.source === 'cloud' ? RADIO_CLOUD_FIX_MAX_AGE_MS : RADIO_LOCAL_FIX_MAX_AGE_MS)
    );
}

export function radioPhonePosition(fix: GpsPosition | null, now = Date.now()): RadioPositionFix | null {
    return fix
        ? validateRadioPosition(
              {
                  ...fix,
                  source: 'phone',
                  sourceLabel: SOURCE_LABELS.phone,
                  isVessel: false,
                  // GpsService maps unknown native speed to zero. That cannot
                  // establish a stationary receiver for an emergency call.
                  speed: fix.speed > 0 ? fix.speed : null,
              },
              now,
          )
        : null;
}

/** Only the direct socket qualifies here. LAN/cloud aggregate stamps are report times. */
export function readRadioBusPosition(
    now = Date.now(),
    observedAfter = Number.NEGATIVE_INFINITY,
): RadioPositionFix | null {
    const state = NmeaStore.getState();
    if (state.connectionStatus !== 'connected' || state.remote) return null;
    if (
        [state.latitude.lastUpdated, state.longitude.lastUpdated].some(
            (timestamp) => !finiteNumber(timestamp) || timestamp <= 0 || timestamp > now,
        )
    ) {
        return null;
    }
    const timestamp = Math.min(state.latitude.lastUpdated, state.longitude.lastUpdated);
    const freshMetric = (metric: { value: number | null; lastUpdated: number }): number | null =>
        metric.lastUpdated > 0 &&
        metric.lastUpdated > observedAfter &&
        metric.lastUpdated <= now &&
        now - metric.lastUpdated <= RADIO_LOCAL_FIX_MAX_AGE_MS
            ? metric.value
            : null;
    const sog = nonNegative(freshMetric(state.sog));
    return validateRadioPosition(
        {
            latitude: state.latitude.value!,
            longitude: state.longitude.value!,
            timestamp,
            source: 'bus',
            sourceLabel: SOURCE_LABELS.bus,
            isVessel: true,
            speed: sog === null ? null : sog / 1.9438444924406,
            heading: freshMetric(state.cog),
            accuracy: null,
        },
        now,
    );
}

/**
 * A connected socket alone cannot prove the cached coordinates came from it:
 * NmeaStore retains remote metrics across reconnect until new sentences arrive.
 * Require both coordinates to have been observed after this direct-feed boundary.
 */
export function createRadioBusReader(): { read: () => RadioPositionFix | null; dispose: () => void } {
    const isDirect = (state: ReturnType<typeof NmeaStore.getState>) =>
        state.connectionStatus === 'connected' && !state.remote;
    let direct = isDirect(NmeaStore.getState());
    let observedAfter = direct ? Date.now() : Number.POSITIVE_INFINITY;
    const connectionKey = () => {
        const info = NmeaListenerService.getConnectionInfo();
        return `${info.deviceId ?? 'gateway'}:${info.host}:${info.port}`;
    };
    let connectedReceiver = connectionKey();
    const observe = (state: ReturnType<typeof NmeaStore.getState>) => {
        const nextDirect = isDirect(state);
        const nextReceiver = connectionKey();
        if (nextDirect !== direct || nextReceiver !== connectedReceiver) {
            direct = nextDirect;
            connectedReceiver = nextReceiver;
            observedAfter = nextDirect ? Date.now() : Number.POSITIVE_INFINITY;
        }
    };
    const dispose = NmeaStore.subscribe(observe);
    return {
        read: () => {
            observe(NmeaStore.getState());
            const fix = readRadioBusPosition(Date.now(), observedAfter);
            return fix && fix.timestamp > observedAfter
                ? { ...fix, receiverKey: `bus:${connectedReceiver}:${observedAfter}` }
                : null;
        },
        dispose,
    };
}

/** The Pi already publishes extra.position_at; older firmware without it cannot prove GPS freshness. */
export function radioTelemetryPosition(
    raw: unknown,
    source: 'pi' | 'cloud',
    now = Date.now(),
): RadioPositionFix | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (row.source !== 'pi') return null; // Never promote a phone-uploaded cloud row to vessel GPS.
    const extra = row.extra as Record<string, unknown> | null;
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
    return validateRadioPosition(
        {
            latitude: row.lat as number,
            longitude: row.lon as number,
            timestamp: extra.position_at as number,
            source,
            sourceLabel: SOURCE_LABELS[source],
            isVessel: true,
            vesselId: source === 'cloud' && typeof row.boat_id === 'string' ? row.boat_id : null,
            // The telemetry wire has no SOG/COG leaf timestamps. Its heartbeat
            // cannot prove those movement values belong to this GPS observation.
            speed: null,
            heading: null,
            accuracy: null,
        },
        now,
    );
}

export async function readRadioPiPosition(signal: AbortSignal): Promise<RadioPositionFix | null> {
    const scope = getAuthIdentityScope();
    try {
        const [{ getPairing, pinnedPiRequest }, { piCache }] = await Promise.all([
            import('./PiPairingService'),
            import('./PiCacheService'),
        ]);
        const pairing = getPairing();
        const baseUrl = piCache.getBaseUrl();
        if (signal.aborted || !isAuthIdentityScopeCurrent(scope) || !pairing || !baseUrl) return null;
        const response = await pinnedPiRequest({
            url: `${baseUrl}/api/telemetry`,
            connectTimeout: 2_000,
            readTimeout: 2_000,
            responseType: 'text',
        });
        const currentPairing = getPairing();
        if (
            signal.aborted ||
            !isAuthIdentityScopeCurrent(scope) ||
            currentPairing?.deviceId !== pairing.deviceId ||
            currentPairing?.publicKeySpki !== pairing.publicKeySpki ||
            response.status < 200 ||
            response.status >= 300
        ) {
            return null;
        }
        const body = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        const fix = body?.available === true ? radioTelemetryPosition(body.telemetry, 'pi') : null;
        // A pin/fingerprint is public identity material, not a relay credential.
        return fix
            ? { ...fix, receiverKey: `pi:${pairing.deviceId}:${pairing.fingerprint ?? pairing.publicKeySpki}` }
            : null;
    } catch {
        return null;
    }
}

export async function readRadioCloudPosition(
    signal: AbortSignal,
    vesselId: string | null,
): Promise<RadioPositionFix | null> {
    const scope = getAuthIdentityScope();
    if (!vesselId?.trim()) return null;
    try {
        const { supabase, getCurrentUserId } = await import('./supabase');
        if (signal.aborted || !supabase || !isAuthIdentityScopeCurrent(scope)) return null;
        const userId = await getCurrentUserId(scope);
        if (signal.aborted || !userId || !isAuthIdentityScopeCurrent(scope)) return null;
        const { data, error } = await supabase
            .from('vessel_telemetry')
            .select('boat_id,source,lat,lon,extra,reported_at')
            .eq('source', 'pi')
            .eq('boat_id', vesselId)
            .order('reported_at', { ascending: false })
            .limit(1)
            .abortSignal(signal);
        if (signal.aborted || error || !isAuthIdentityScopeCurrent(scope)) return null;
        const row = data?.[0];
        if (row?.boat_id !== vesselId) return null;
        const fix = radioTelemetryPosition(row, 'cloud');
        if (!fix) return null;
        // The current Pi publishes its public deviceId in this existing extra
        // field. boat_id alone is only the relay owner's active selection.
        const identity = row.extra?.wind_history_identity;
        const receiver = typeof identity === 'string' && identity.trim() ? identity : `unidentified:${fix.timestamp}`;
        // Older firmware cannot support reusable physical-receiver confirmation:
        // scope that confirmation to one observation instead of guessing a device.
        return { ...fix, receiverKey: `cloud:${vesselId}:${receiver}` };
    } catch {
        return null;
    }
}
