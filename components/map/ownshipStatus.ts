import type { AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import type { SyncState } from '../../services/AnchorWatchSyncService';
import type { ShoreAlarmSnapshot } from '../../services/ShoreWatchAlarmService';
import { calculateDistance } from '../../utils/navigationCalculations';
import { ownshipFixLabel, type GpsFixState } from '../gpsFixState';

type MarkerPosition = { latitude: number; longitude: number; speed: number | null };

/** Speed cannot tell us whether an anchor is down. Only an active watch may
 * supply that label; remote data must also belong to the current paired session
 * and the receiver represented by this marker, not the phone ashore.
 *
 * Nor can a fix that is no longer live say 'Stopped' or a speed: the chart
 * drew a live-looking 'Stopped' off a 46 s old phone fix while MOB, Radio and
 * Anchor Watch said NO FIX (UX referee run 8, gps-one-truth). `fix` is the
 * marker's one fix state (gpsFixState, the same gates the System status box
 * uses); once it is not live the badge says 'Last fix 46 s'. Anchor labels
 * still come first: they are the watch's own state, gated by its own GPS
 * watchdog, and an alarm must never be hidden behind a fix age. */
export function ownshipStatusLabel(
    position: MarkerPosition,
    viaVessel: boolean,
    local: Pick<AnchorWatchSnapshot, 'state' | 'gpsSource'>,
    sync: Pick<SyncState, 'role' | 'sessionCode'>,
    shore: Pick<ShoreAlarmSnapshot, 'sessionCode' | 'position' | 'stale' | 'cause'>,
    now = Date.now(),
    fix: GpsFixState | null = null,
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

    const lastFix = fix ? ownshipFixLabel(fix) : null;
    if (lastFix) return lastFix;
    if (position.speed === null || !Number.isFinite(position.speed) || position.speed < 0) return 'SOG —';
    const knots = position.speed * 1.94384;
    return knots < 0.3 ? 'Stopped' : `${knots.toFixed(1)} kts`;
}
