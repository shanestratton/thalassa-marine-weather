/** Root-owned identities only. No owner, source or enrollment revision comes from HTTP JSON. */
import { radarContextKey } from './contextSession.js';
import { wakePairingId, wakeEnrollmentRevision } from '../wakeKeeper/contract.js';
import type { SignalKNotificationSnapshot } from '../signalkProtocol.js';
import type { ChartDevicePublic } from '../encDevices.js';
import type { RadarServerContext } from './watch.js';
import type { RadarController } from './radarWatchContract.js';
export function radarServerContext(
    ownerId: unknown,
    piDeviceId: unknown,
    relayId: unknown,
    source: Pick<SignalKNotificationSnapshot, 'state' | 'session'> | null,
): RadarServerContext | null {
    if (typeof relayId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(relayId)) return null;
    const contextToken = radarContextKey(ownerId, piDeviceId, relayId, source);
    if (!contextToken || typeof ownerId !== 'string' || typeof piDeviceId !== 'string' || typeof relayId !== 'string')
        return null;
    return {
        ownerId,
        piDeviceId,
        pairingId: wakePairingId(ownerId, piDeviceId, relayId),
        feedId: `pi:${piDeviceId}:${contextToken.slice(0, 24)}`,
        contextToken,
    };
}
const same = (a: RadarServerContext | null, b: RadarServerContext) =>
    !!a &&
    a.ownerId === b.ownerId &&
    a.piDeviceId === b.piDeviceId &&
    a.pairingId === b.pairingId &&
    a.feedId === b.feedId &&
    a.contextToken === b.contextToken;
export function createRadarControllerVerifier(
    current: () => RadarServerContext | null,
    list: () => Promise<ChartDevicePublic[]>,
): (controller: RadarController, context: RadarServerContext) => Promise<boolean> {
    return async (controller, context) => {
        if (!same(current(), context)) return false;
        const devices = await list(); // Errors are unavailable evidence, never a confirmed revocation.
        if (!same(current(), context)) return false;
        const device = devices.find((d) => d.id === controller.deviceId);
        return !!device && wakeEnrollmentRevision(device) === controller.enrollmentRevision;
    };
}
