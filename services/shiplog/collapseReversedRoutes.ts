/**
 * collapseReversedRoutes — fold there-and-back route pairs into one choice.
 *
 * Saving a route and then reversing it with ⇄ stores TWO planned voyages, so
 * the cast-off picker listed "Newport → 23.9°S" and "23.9°S → Newport" as
 * separate 245.4 NM options — every passage appearing twice, and the list
 * growing with the log (Shane 2026-07-19: "yes collapse them").
 *
 * Pure and separately tested because a mistake here does not look like a bug:
 * it looks like a route the skipper saved simply not being offered. Silent
 * omission deserves a test more than a visible crash does.
 */

/** The subset of VoyageSummary this needs — keeps the module free of the DB shape. */
export interface ReversibleRoute {
    voyageId: string;
    totalDistanceNM: number;
    firstLat: number | null;
    firstLon: number | null;
    lastLat: number | null;
    lastLon: number | null;
}

export interface CollapsedRoute<T> {
    summary: T;
    /** A saved reverse of this route was folded into this entry. */
    reversible: boolean;
}

/** Endpoints this close are the same place — berth-scale, not passage-scale. */
const SAME_PLACE_NM = 0.25;

function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3440.065; // nautical miles
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const hasEnds = (v: ReversibleRoute): boolean =>
    v.firstLat != null && v.firstLon != null && v.lastLat != null && v.lastLon != null;

/**
 * Two legs are the same passage reversed when each one's start lands on the
 * other's end AND they are the same length. The length check matters: without
 * it, an inshore run and an offshore run between the same two harbours look
 * like a reversed pair, and collapsing them would hide a genuinely different
 * route behind one that just happens to share its endpoints.
 */
function isReverseOf(a: ReversibleRoute, b: ReversibleRoute): boolean {
    if (!hasEnds(a) || !hasEnds(b)) return false;
    const lenTolerance = Math.max(0.5, 0.02 * Math.max(a.totalDistanceNM, b.totalDistanceNM));
    if (Math.abs(a.totalDistanceNM - b.totalDistanceNM) > lenTolerance) return false;
    return (
        haversineNM(a.firstLat!, a.firstLon!, b.lastLat!, b.lastLon!) <= SAME_PLACE_NM &&
        haversineNM(a.lastLat!, a.lastLon!, b.firstLat!, b.firstLon!) <= SAME_PLACE_NM
    );
}

/**
 * One entry per passage. When a pair is found, the surviving direction is the
 * leg that STARTS nearest `fix` — the way the boat is about to sail, since this
 * runs at cast-off. Without a fix, the first-seen direction is kept and nothing
 * is reordered.
 *
 * Matching is on COORDINATES, never on display names: those arrive
 * asynchronously from reverse-geocoding, so a name-based rule would do nothing
 * on first paint and then reshuffle the list under the skipper's thumb.
 *
 * Input order is otherwise preserved.
 */
export function collapseReversedRoutes<T extends ReversibleRoute>(
    routes: readonly T[],
    fix: { lat: number; lon: number } | null,
): CollapsedRoute<T>[] {
    const taken = new Set<string>();
    const out: CollapsedRoute<T>[] = [];

    for (const route of routes) {
        if (taken.has(route.voyageId)) continue;
        taken.add(route.voyageId);

        const twin = routes.find((o) => !taken.has(o.voyageId) && isReverseOf(route, o));
        if (!twin) {
            out.push({ summary: route, reversible: false });
            continue;
        }
        taken.add(twin.voyageId);

        if (!fix) {
            out.push({ summary: route, reversible: true });
            continue;
        }
        const dRoute = haversineNM(fix.lat, fix.lon, route.firstLat!, route.firstLon!);
        const dTwin = haversineNM(fix.lat, fix.lon, twin.firstLat!, twin.firstLon!);
        out.push({ summary: dTwin < dRoute ? twin : route, reversible: true });
    }

    return out;
}
