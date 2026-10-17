/** Number-free disclosures only. Persisted route metadata cannot introduce
 * source names, coordinates or arbitrary chart prose into saved caveats. */
export const ROUTING_AREA_CAVEATS = [
    'Signed out: no private routing polygons are available.',
    'Marine park footprints use indicative classifications and add caution only; check current local rules.',
    'Retained marine park data has expired; marine park caution is unavailable.',
    'Marine park geometry exceeds this route window’s bounded budget; marine park caution is unavailable.',
    'No verified marine park dataset is retained; marine park caution is unavailable.',
    'The finished passage intersects an indicative marine park footprint. Check current local rules; the footprint grants no permission or clearance.',
    'Offshore charted restricted areas, traffic separation zones and traffic-lane direction have not been fully checked; review original charts and local rules.',
    'Planned course follows charted traffic-lane flow or crosses near a right angle. Check traffic and the applicable rules before proceeding.',
    'Traffic-lane direction is missing, conflicting or ambiguous on this route. Review the current chart and plan the crossing yourself.',
    'Wind and current can make the boat’s actual heading differ from this planned course. Check the crossing from aboard.',
] as const;

export function knownRouteAreaCaveats(value: unknown): string[] {
    return Array.isArray(value) ? ROUTING_AREA_CAVEATS.filter((words) => value.includes(words)) : [];
}
