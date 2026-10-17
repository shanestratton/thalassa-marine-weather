import {
    anchorSafeZoneContains,
    anchorZoneOffset,
    isAnchorAreaRevision as validAreaRevision,
    parseAnchorBoundary,
    sameAnchorSafeArea,
} from '../_shared/anchorSafeZone.ts';
export { isAnchorAreaRevision as validAreaRevision } from '../_shared/anchorSafeZone.ts';

/** The owner authorised an exact circle+zone+revision. The Pi cannot change or omit it. */
export const validAreaVessel = (value: unknown): value is string | null =>
    value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128);
export function validAreaReport(
    stored: unknown,
    revision: unknown,
    payload: Record<string, unknown>,
    gpsAvailable: boolean,
    vesselId?: unknown,
): boolean {
    const area = stored == null ? null : parseAnchorBoundary(stored);
    if (stored != null && !area) return false;
    if (revision != null && (!validAreaRevision(revision) || payload.safeAreaRevision !== revision)) return false;
    if (area && !validAreaRevision(revision)) return false;
    if (area && (!validAreaVessel(vesselId) || payload.safeAreaVesselId !== vesselId)) return false;
    const anchor = payload.anchor as Record<string, unknown> | null;
    const received = payload.safeZone == null && !area ? null : parseAnchorBoundary({
        version: 1,
        frame: { latitude: anchor?.latitude, longitude: anchor?.longitude, radiusM: payload.swingRadius },
        zone: payload.safeZone ?? null,
    });
    if (payload.safeZone != null && !received) return false;
    if (!sameAnchorSafeArea(area, received)) return false;
    if (!area) return true;
    if (
        (area.zone && payload.safeZoneWatch !== 'pi') ||
        anchor?.latitude !== area.frame.latitude ||
        anchor?.longitude !== area.frame.longitude ||
        payload.swingRadius !== area.frame.radiusM
    ) {
        return false;
    }
    if (!gpsAvailable) return true;
    if (typeof payload.isAlarm !== 'boolean') return false;
    const position = payload.vessel as { latitude: number; longitude: number },
        offset = anchorZoneOffset(area.frame, position);
    const inside = area.zone
        ? anchorSafeZoneContains(area.zone, area.frame, position)
        : offset
        ? Math.hypot(...offset) <= area.frame.radiusM
        : null;
    // Confirmation remains the Pi's distinct-fix rule; a false pending flag outside is not holding.
    return inside !== null && !(payload.isAlarm === true && inside === true);
}
