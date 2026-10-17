import type { MarineModelSnapshot } from '../types/weather';
import type { VesselProfile } from '../types';
import type { ComfortPreference } from './comfortPreference';
import { seaComfort, validComfortPart } from './seaComfort';
/** Same admitted cohort for the number, partitions and comfort. A retained
 * receipt never renews itself, and a forecast hour never becomes current. */
export function admittedComfortMarine(marine: MarineModelSnapshot | undefined, current: boolean, now = Date.now()) {
    if (
        !marine ||
        !marine.parts ||
        typeof marine.parts !== 'object' ||
        !['total', 'windSea', 'swell', 'secondarySwell'].every((key) => key in marine.parts) ||
        ![marine.parts.total, marine.parts.windSea, marine.parts.swell, marine.parts.secondarySwell].every(
            validComfortPart,
        ) ||
        !marine.requested ||
        !Number.isFinite(marine.requested.latitude) ||
        !Number.isFinite(marine.requested.longitude) ||
        Math.abs(marine.requested.latitude) > 90 ||
        Math.abs(marine.requested.longitude) > 180 ||
        marine.status !== 'available' ||
        marine.waveModel !== 'meteofrance_wave' ||
        marine.motionModel !== 'best_match' ||
        marine.fetchedAtMs === null ||
        !Number.isFinite(marine.fetchedAtMs) ||
        marine.fetchedAtMs < now - 3600000 ||
        marine.fetchedAtMs > now + 5000 ||
        marine.waveValidAtMs === null ||
        !Number.isFinite(marine.waveValidAtMs) ||
        (current && (marine.waveValidAtMs < now - 1800000 || marine.waveValidAtMs > now + 300000))
    )
        return null;
    return marine;
}
export function comfortForMarine(
    marine: MarineModelSnapshot | undefined,
    vessel?: Pick<VesselProfile, 'type' | 'length'> | null,
    preference?: ComfortPreference | null,
    current = false,
    now = Date.now(),
) {
    const admitted = admittedComfortMarine(marine, current, now);
    return admitted ? seaComfort(admitted.parts, vessel, preference) : null;
}
