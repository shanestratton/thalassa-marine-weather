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

    // --- THRESHOLDS ---
    // 20 NM = 37.04 km
    const OFFSHORE_THRESHOLD_KM = 37.04;
    // 5km grid snap (OpenMeteo Marine)
    const IS_ON_WATER_THRESHOLD_KM = 5.0;
    // 5 NM = 9.26 km. Relaxed to 15km to account for grid resolution (~27km).
    const INLAND_THRESHOLD_KM = 15.0;

    // 1. OFFSHORE vs DEEP INLAND CHECK
    if (distToLandKm === null || distToLandKm > OFFSHORE_THRESHOLD_KM) {

        // --- AMBIGUITY HANDLER ---
        // We are "Far from known Land".
        // Scenarios:
        // A) Deep Ocean (Lat/Lon: -21, 66). distToLand: 9999, distToWater: 0 (or 9999 if API fails). Elev: 0.
        // B) Desert (Lat/Lon: 25, 130). distToLand: 200+. distToWater: 500+. Elev: 300m.

        // PRIORITY 1: ELEVATION
        // If we have definitive elevation data, use it.
        // > 10m is almost certainly Land (Inland).
        // < 10m could be Ocean or Low-lying coast. Since we are > 92km from named land, implies Offshore.
        if (elevation !== undefined && elevation !== null) {
            if (elevation > 10) return 'inland';
            // If elevation is low (0m), and we are > 92km from land, we are likely OFFSHORE.
            return 'offshore';
        }

        // PRIORITY 2: WATER DISTANCE (Fallback if elevation missing)
        // If we found valid water nearby (< 15km), it's Offshore.
        // If we found NO water (dist > 15km), it's *probably* Inland...
        // ...UNLESS the marine API just failed (9999).
        // Safer to default to OFFSHORE if we are unsure, to keep "WP" behavior for sailors.
        if (distToWaterKm < INLAND_THRESHOLD_KM) {
            return 'offshore'; // Near water, far from land -> Offshore
        }

        // Far from land, Far from water (or unknown water), No elevation.
        // If distToWaterKm is "Sentinel 9999", it means Marine API found no waves.
        // No waves implies LAND (Inland), or at least not "Offshore" in the nautical sense.
        // We previously defaulted to OFFSHORE, but that causes inland deserts/plains to be marked Offshore.
        if (distToWaterKm > 2000) {
            // FAIL-SAFE: If Marine API failed (9999) AND Geocode API failed (null),
            // we have zero information. Defaulting to 'inland' hides the marine UI, which is bad for sailors with spotty connection.
            // Better to show empty marine data (Offshore/Coastal) than nothing.
            // However, if we validly know we are far from water (e.g. 500km returned), we might keep inland.
            // But 9999 is the error code.
            if (distToWaterKm === 9999) return 'offshore';
            return 'inland';
        }

        // If we really are offshore (distToWaterKm is small/valid), we handled it above.
        // This catch-all might not be reached if logic is sound, but default to 'inland' is safer for "lost on land".
        // UPDATE: Default to 'offshore' to prevent "hiding" the app in error states.
        return 'offshore';
    }

    // We are within 50nm of land. We are either COASTAL or INLAND.

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

    // 2.2 PROXIMITY-TO-LAND COASTAL FALLBACK
    // If we are close to land (< 3km), the marine ring search may fail
    // (all 5 ring points inside a bay/harbour/land mask → distToWaterKm = 9999).
    // But being < 3km from the coast at low elevation is definitively COASTAL.
    // This prevents harbours, marinas, and beach towns from being misclassified as inland.
    if (distToLandKm !== null && distToLandKm < 3 && isLowElevation) {
        return 'coastal';
    }

    // 2.3 NEAR-COAST RELAXED THRESHOLD
    // If within 10km of land and elevation is very low (< 10m), very likely coastal.
    // Catches estuaries, tidal flats, and coastal plains where marine grid has no wave data.
    if (distToLandKm !== null && distToLandKm < 10 && elevation !== undefined && elevation !== null && elevation < 10) {
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
