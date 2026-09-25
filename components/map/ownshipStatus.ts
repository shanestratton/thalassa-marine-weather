import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import type { SyncState } from '../../services/AnchorWatchSyncService';
import type { ShoreAlarmSnapshot } from '../../services/ShoreWatchAlarmService';
import { calculateDistance } from '../../utils/navigationCalculations';

type MarkerPosition = { latitude: number; longitude: number; speed: number | null };

/** Speed cannot tell us whether an anchor is down. Only an active watch may
 * supply that label; remote data must also belong to the current paired session
 * and the receiver represented by this marker, not the phone ashore. */
export function ownshipStatusLabel(
    position: MarkerPosition,
    viaVessel: boolean,
    local: Pick<AnchorWatchSnapshot, 'state' | 'gpsSource'>,
    sync: Pick<SyncState, 'role' | 'sessionCode'>,
    shore: Pick<ShoreAlarmSnapshot, 'sessionCode' | 'position' | 'stale' | 'cause'>,
    now = Date.now(),
): string {
    const localReceiverMatches = local.gpsSource !== 'nmea' || viaVessel;
    if (localReceiverMatches && local.state === 'alarm') return 'Anchor alarm';
    if (localReceiverMatches && local.state === 'watching') return 'Anchored';

    const remote = shore.position;
    const remoteAge = remote ? now - Math.min(remote.timestamp, remote.vessel.timestamp) : Infinity;
    const remoteMatches =
        viaVessel &&
        sync.role === 'shore' &&
        !!sync.sessionCode &&
        sync.sessionCode === shore.sessionCode &&
        !shore.stale &&
        remoteAge >= -5_000 &&
        remoteAge < 35_000 &&
        remote &&
        calculateDistance(position.latitude, position.longitude, remote.vessel.latitude, remote.vessel.longitude) *
            1852 <=
            50;
    if (remoteMatches) return remote.isAlarm || shore.cause === 'drag' ? 'Anchor alarm' : 'Anchored';

    if (position.speed === null || !Number.isFinite(position.speed) || position.speed < 0) return 'SOG —';
    const knots = position.speed * 1.94384;
    return knots < 0.3 ? 'Stopped' : `${knots.toFixed(1)} kts`;
}
