import { calculateDistance } from '../../utils/navigationCalculations';
/** The answering cell must fit inside the actual confirmed coast-clearance
 * circle, with 100 m spare. No nearest-berth or cached selected-point verdict. */
export function comfortCaptureCellFits(
    evidence: { latitude: number; longitude: number; coastDistanceNm: number } | null,
    capture: { latitude: number; longitude: number },
    snappedKm: number | null | undefined,
): boolean {
    if (
        !evidence ||
        typeof snappedKm !== 'number' ||
        ![
            evidence.latitude,
            evidence.longitude,
            evidence.coastDistanceNm,
            capture.latitude,
            capture.longitude,
            snappedKm,
        ].every(Number.isFinite) ||
        Math.abs(evidence.latitude) > 90 ||
        Math.abs(evidence.longitude) > 180 ||
        Math.abs(capture.latitude) > 90 ||
        Math.abs(capture.longitude) > 180 ||
        !(evidence.coastDistanceNm > 0 && evidence.coastDistanceNm <= 100) ||
        snappedKm < 0
    )
        return false;
    const offsetKm =
        calculateDistance(evidence.latitude, evidence.longitude, capture.latitude, capture.longitude) * 1.852;
    return snappedKm + offsetKm + 0.1 < evidence.coastDistanceNm * 1.852;
}
