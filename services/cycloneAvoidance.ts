/**
 * cycloneAvoidance.ts — Builds an ExclusionField from active tropical
 * cyclones for use by the isochrone routing engine.
 *
 * Active cyclones are loaded from CycloneTrackingService (ATCF + NOAA
 * NHC + IBTrACS, with synthetic forecasts for non-Atlantic basins).
 * Each cyclone carries a `currentPosition` and a `forecastTrack` of
 * NHC-issued positions out to 5 days. We interpolate that track at
 * query time to get the storm's expected position, then test whether
 * the candidate point lies within a safety radius of that position.
 *
 * Safety radii by intensity:
 *
 *   Stage    | Wind (kts) | Radius (NM)
 *   ---------+------------+-------------
 *   TD       | < 34       |  50
 *   TS       | 34-63      |  75
 *   Cat 1    | 64-82      | 100
 *   Cat 2    | 83-95      | 125
 *   Cat 3    | 96-113     | 150
 *   Cat 4    | 114-135    | 200
 *   Cat 5    | ≥ 137      | 250
 *
 * These match the avoidance radii commercial weather routers use for
 * trans-ocean passages. Coastal-only cruisers should use higher radii;
 * blue-water racers might accept tighter ones.
 *
 * Forward-only avoidance: a cyclone moving away from the route at
 * 25 kts and 36 hours behind is no threat. We only consider track
 * positions within ±24 hours of the candidate's arrival time at that
 * point. Beyond that the storm has likely dissipated (ATCF cuts off
 * forecasts after 120 h).
 */

import { createLogger } from '../utils/createLogger';
import type { ExclusionField } from './isochrone/types';
import { fetchActiveCyclones, type ActiveCyclone } from './weather/CycloneTrackingService';

const log = createLogger('CycloneAvoid');

export { buildCycloneExclusionFromCyclones } from './isochrone/cycloneField';
import { buildCycloneExclusionFromCyclones } from './isochrone/cycloneField';
export async function buildCycloneExclusionField(
    departureTime: string,
    routeBbox?: { north: number; south: number; east: number; west: number },
): Promise<ExclusionField | null> {
    let cyclones: ActiveCyclone[];
    try {
        cyclones = await fetchActiveCyclones();
    } catch (e) {
        log.warn('cyclone fetch failed — routing without exclusion zones:', e);
        return null;
    }

    return buildCycloneExclusionFromCyclones(cyclones, departureTime, routeBbox);
}
