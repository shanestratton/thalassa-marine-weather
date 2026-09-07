/**
 * What the Log page says while the phone's fixes are refused for the track.
 * Shane 2026-09-07: the log follows the boat, not the phone — and it must say
 * so rather than look broken.
 */
import type { PhoneHold } from './GpsSubscriptionManager';

export function describePhoneHold(hold: PhoneHold): string {
    const via =
        hold.boatLane === 'cloud' ? 'through the cloud' : hold.boatLane === 'pi' ? 'through the Pi' : 'on the bus';
    const apart =
        hold.distanceM === null
            ? ''
            : hold.distanceM >= 1852
              ? ` · phone ${(hold.distanceM / 1852).toFixed(1)} NM from her`
              : ` · phone ${Math.round(hold.distanceM)} m from her`;
    if (hold.reason === 'not-aboard') return `Phone GPS held — not aboard${apart}. The log follows the boat.`;
    return `Phone GPS held — her GPS is alive ${via}${apart}. The log follows the boat.`;
}
