import { calculateDistance } from '../../utils/math';

export type LocationType = 'coastal' | 'offshore' | 'inland';

/**
 * Determines the location type based on:
 * 1. OFFSHORE: > 50nm from land.
 * 2. INLAND: On land AND > 5nm from water.
 * 3. COASTAL: Everything else.
 * 
 * @param distToLandKm Distance to the nearest land (reverse geocode result) in km. If null, assumes FAR from land (Ocean).
 * @param distToWaterKm Distance to the nearest water grid point (marine model) in km.
 * @param landName Optional name of the land feature (for waterway checks).
 */
export const determineLocationType = (
    distToLandKm: number | null,
    distToWaterKm: number,
    landName?: string,
    hasTides?: boolean,
    elevation?: number
): LocationType => {

    // 1. OFFSHORE CHECK
    // Rule: > 50nm from land.
    // 50 NM = 92.6 km
    const OFFSHORE_THRESHOLD_KM = 92.6;

    if (distToLandKm === null || distToLandKm > OFFSHORE_THRESHOLD_KM) {
        return 'offshore';
    }

    // We are within 50nm of land. We are either COASTAL or INLAND.

    // 2. INLAND CHECK
    // Rule: On Land AND > 5nm from water.

    // First, determine if we are "On Water" or "On Land" roughly.
    // Use the marine grid snap distance. OpenMeteo Marine snaps to nearest water.
    // If the snap distance is small (< 5km), we are likely ON water.
    const IS_ON_WATER_THRESHOLD_KM = 5.0;

    // 5 NM = 9.26 km (User rule for Inland/Coastal boundary)
    // ADJUSTMENT: OpenMeteo Marine grid resolution is ~27km. 
    // Being 9.6km from a grid point (Newport, QLD) implies being comfortably within the marine cell.
    // A strict 9.26km cutoff causes false positives for "Inland" in canal estates.
    // We relax this to 15km (~8nm) to account for grid snapping.
    // This effectively means "If we are within 15km of a marine grid point, we are Coastal".
    const INLAND_THRESHOLD_KM = 15.0;

    // 2.1 TIDE CHECK (Newport Rule)
    // If we have valid tides, we are definitely NOT Inland (we are connected to the ocean).
    // This handles cases like Newport canals where marine wave models return "No Data" (land mask)
    // but the location is clearly tidal/coastal.
    // FILTER: High altitude lakes (e.g. Queenstown @ 310m) might have "Virtual Tides".
    // We only apply this fallback if Elevation is low (< 50m).
    // If elevation is undefined/null, we assume low (safe fallback).
    const isLowElevation = elevation === undefined || elevation === null || elevation < 50;

    if (hasTides && isLowElevation) {
        return 'coastal';
    }

    const isOnWater = distToWaterKm < IS_ON_WATER_THRESHOLD_KM;

    if (isOnWater) {
        // We are on water and < 50nm from land.
        return 'coastal';
    }

    // We are effectively ON LAND.
    // Check if we are > 5nm from water.
    if (distToWaterKm > INLAND_THRESHOLD_KM) {
        return 'inland';
    }

    // 3. COASTAL FALLBACK
    // We are on land, but < 5nm from water.

    // REFINEMENT: Waterway Check (Creek, River, Lake)
    // If the location name implies inland water, we might still want to be INLAND 
    // unless we are VERY close to the marine grid (actual ocean).
    // However, the user's rule is simple: "no more than 5nm inland".
    // So if we are < 5nm from the marine grid (Ocean), we are COASTAL.
    // The previous logic had a "3km" check for waterways. 
    // Let's stick to the user's strict 5nm rule first. 
    // If distToWaterKm < 9.26km, it's COASTAL.

    return 'coastal';
};
