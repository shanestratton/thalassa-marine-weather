import { calculateDistance } from '../../utils/math';

export type LocationType = 'coastal' | 'offshore' | 'inland';

/**
 * Determines location type (coastal / offshore / inland).
 *
 * DESIGN PRINCIPLE: This app is for SAILORS. We bias toward coastal/offshore.
 * "inland" requires MULTIPLE confirmatory signals.
 *
 * Key insight: Tides exist everywhere on the ocean — they cannot distinguish
 * coastal from offshore. But tides DO prove you're not inland.
 */
export const determineLocationType = (
    distToLandKm: number | null,
    distToWaterKm: number,
    landName?: string,
    hasTides?: boolean,
    elevation?: number
): LocationType => {

    // --- THRESHOLDS ---
    const OFFSHORE_THRESHOLD_KM = 37.04; // 20 NM
    const IS_ON_WATER_THRESHOLD_KM = 5.0; // 5km marine grid snap
    const INLAND_WATER_THRESHOLD_KM = 15.0; // ~8 NM, relaxed for grid resolution

    const elev = (elevation !== undefined && elevation !== null) ? elevation : -1;
    const hasElevation = elev >= 0;

    // ═══════════════════════════════════════════════════════════════
    // GLOBAL: MARITIME NAME CHECK
    // If location name contains a waterway keyword → NEVER inland.
    // But does NOT force coastal over offshore.
    // ═══════════════════════════════════════════════════════════════
    let isMaritimeName = false;
    if (landName) {
        const MARITIME_KEYWORDS = [
            'river', 'harbour', 'harbor', 'port', 'bay', 'creek',
            'estuary', 'marina', 'channel', 'wharf', 'dock', 'inlet',
            'cove', 'lagoon', 'strait', 'sound', 'reef', 'cape',
            'head', 'point', 'pier', 'jetty', 'quay', 'waterfront',
            'seaside', 'beach', 'coast', 'shore', 'anchorage'
        ];
        const nameLower = landName.toLowerCase();
        isMaritimeName = MARITIME_KEYWORDS.some(kw => nameLower.includes(kw));
    }

    // ═══════════════════════════════════════════════════════════════
    // 1. FAR FROM LAND (distToLandKm null or > 20NM / 37km)
    // Either deep ocean or deep inland (desert / mountain).
    // ═══════════════════════════════════════════════════════════════
    if (distToLandKm === null || distToLandKm > OFFSHORE_THRESHOLD_KM) {

        // Maritime name + far from land = offshore (not coastal — too far)
        if (isMaritimeName) return 'offshore';

        // Elevation > 200m and far from any known land → definitely inland
        if (hasElevation && elev > 200) {
            return 'inland';
        }

        // Near marine water grid → offshore
        if (distToWaterKm < INLAND_WATER_THRESHOLD_KM) {
            return 'offshore';
        }

        // Far from water, moderate elevation (50–200m), no tides → inland
        if (hasElevation && elev > 50 && !hasTides) {
            return 'inland';
        }

        // Far from water sentinel (9999 = API failure) → default offshore
        if (distToWaterKm === 9999) {
            return 'offshore';
        }

        // Genuinely far from everything, large valid water distance → inland
        if (distToWaterKm > 100) {
            return 'inland';
        }

        return 'offshore';
    }

    // ═══════════════════════════════════════════════════════════════
    // 2. WITHIN 20NM OF LAND — Coastal or Inland
    //
    // Now tides matter: if we're near land AND have tides at low
    // elevation, we're coastal (river, harbour, estuary).
    // This does NOT apply in the offshore branch because open ocean
    // always has tides.
    // ═══════════════════════════════════════════════════════════════

    // 2.0 TIDE CHECK (only in near-land context)
    // Tides + low elevation + near land = connected to ocean = coastal.
    // Filter: High-altitude lakes (Queenstown @ 310m) → skip.
    const isLowElevation = !hasElevation || elev < 100;
    if (hasTides && isLowElevation) {
        return 'coastal';
    }

    // 2.0b Maritime name + near land = coastal
    if (isMaritimeName) {
        return 'coastal';
    }

    // 2.1 ON WATER — marine grid has data within 5km
    if (distToWaterKm < IS_ON_WATER_THRESHOLD_KM) {
        return 'coastal';
    }

    // 2.2 PROXIMITY — within 10km of coastline at reasonable elevation
    if (distToLandKm !== null && distToLandKm < 10 && isLowElevation) {
        return 'coastal';
    }

    // 2.3 MULTI-SIGNAL INLAND CHECK
    // Need BOTH high elevation AND far from marine water.
    const farFromWater = distToWaterKm > INLAND_WATER_THRESHOLD_KM;
    const highElevation = hasElevation && elev > 100;

    if (farFromWater && highElevation) {
        return 'inland';
    }

    // 2.4 COASTAL FALLBACK
    // Near land, maybe no wave data (sheltered bay, river, estuary).
    return 'coastal';
};
