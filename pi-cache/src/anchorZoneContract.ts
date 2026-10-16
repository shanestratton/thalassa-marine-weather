import {
    parseAnchorBoundary,
    isAnchorAreaRevision,
    type AnchorBoundaryEnvelope,
    type AnchorSafeZone,
} from './anchorSafeZone.js';
import type { AnchorWatchAssignment } from './anchorBroadcaster.js';

export function assignmentSafeArea(a: {
    anchorLat: number;
    anchorLon: number;
    swingRadius: number;
    safeZone?: unknown;
}): AnchorBoundaryEnvelope | null {
    return a.safeZone === undefined
        ? null
        : parseAnchorBoundary({
              version: 1,
              frame: { latitude: a.anchorLat, longitude: a.anchorLon, radiusM: a.swingRadius },
              zone: a.safeZone,
          });
}
/** A new watch cannot inherit a mutable object or silently drop a prior custom boundary. */
export function normalizeAnchorAssignment(
    value: AnchorWatchAssignment,
    previous?: AnchorWatchAssignment | null,
): AnchorWatchAssignment | null {
    if (
        !value ||
        !/^[A-Za-z0-9]{12}$/.test(value.sessionCode) ||
        !Number.isFinite(value.anchorLat) ||
        Math.abs(value.anchorLat) > 90 ||
        !Number.isFinite(value.anchorLon) ||
        Math.abs(value.anchorLon) > 180 ||
        !Number.isFinite(value.swingRadius) ||
        value.swingRadius < 5 ||
        value.swingRadius > 5000 ||
        (previous?.safeAreaRevision && value.safeZone === undefined) ||
        (value.safeZone !== undefined && !isAnchorAreaRevision(value.safeAreaRevision)) ||
        (value.safeZone !== undefined &&
            !(
                value.safeAreaVesselId === null ||
                (typeof value.safeAreaVesselId === 'string' &&
                    value.safeAreaVesselId.length > 0 &&
                    value.safeAreaVesselId.length <= 128)
            )) ||
        (value.safeAreaRevision !== undefined && value.safeZone === undefined)
    )
        return null;
    const area = assignmentSafeArea(value);
    if (value.safeZone != null && !area) return null;
    const setup = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
    return Object.freeze({
        sessionCode: value.sessionCode,
        anchorLat: value.anchorLat,
        anchorLon: value.anchorLon,
        swingRadius: value.swingRadius,
        ...(setup(value.rodeLength) !== undefined ? { rodeLength: setup(value.rodeLength) } : {}),
        ...(setup(value.waterDepth) !== undefined ? { waterDepth: setup(value.waterDepth) } : {}),
        ...(value.safeZone !== undefined ? { safeZone: (area?.zone ?? null) as AnchorSafeZone | null } : {}),
        ...(value.safeAreaRevision
            ? { safeAreaRevision: value.safeAreaRevision, safeAreaVesselId: value.safeAreaVesselId }
            : {}),
    });
}
