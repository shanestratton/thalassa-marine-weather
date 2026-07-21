/**
 * Saved-locations utilities — shared between the Settings → Locations
 * tab and the RoutePlanner "Save / Recall" affordance on each input.
 *
 * The planner embeds exact coordinates in the display name string as
 * `Name (lat.dddd, lon.dddd)` — see useVoyageForm.handleMapSelect for
 * the canonical format. These helpers parse that format both ways so
 * a saved location round-trips cleanly:
 *
 *   user picks map → "Newport (-27.2050, 153.0917)" goes in the form
 *                  → tap ★ Save     → stored as { name: "Newport",
 *                                                 lat: -27.205,
 *                                                 lon: 153.0917 }
 *                  → tap saved item → planner sees the same string again
 *
 * Locations the user TYPED (no map pick, no GPS) are saved as
 * name-only — picking one later re-runs through the planner's normal
 * geocode path, exactly as if the user had typed it.
 */

export interface SavedLocation {
    name: string;
    lat?: number;
    lon?: number;
}

/** Strip a "(lat, lon)" suffix from the planner's display string. */
export function extractDisplayName(plannerString: string): string {
    return plannerString.replace(/\s*\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)\s*$/, '').trim();
}

/** Parse the embedded coords from a planner display string, if present. */
export function extractCoords(plannerString: string): { lat: number; lon: number } | null {
    const m = plannerString.match(/\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/);
    if (!m) return null;
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    return { lat, lon };
}

/** Build the planner-compatible display string from a saved location. */
export function toPlannerString(loc: SavedLocation): string {
    if (typeof loc.lat === 'number' && typeof loc.lon === 'number') {
        return `${loc.name} (${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)})`;
    }
    return loc.name;
}

/** Hydrate a saved-locations list with its coord map, in original order. */
export function hydrateSavedLocations(
    names: string[] | undefined,
    coords: Record<string, { lat: number; lon: number }> | undefined,
): SavedLocation[] {
    return (names || []).map((name) => {
        const c = coords?.[name];
        if (c) return { name, lat: c.lat, lon: c.lon };
        return { name };
    });
}

const MAX_SAVED = 50;

/**
 * Build the settings patch for adding a location. Dedupes case-
 * insensitively by display name — re-saving "Newport" after already
 * having "newport" moves the (newest-cased) entry to the front rather
 * than creating a duplicate. Coords overwrite if newer ones are given.
 */
export function buildSaveLocationPatch(
    currentNames: string[] | undefined,
    currentCoords: Record<string, { lat: number; lon: number }> | undefined,
    plannerString: string,
): {
    savedLocations: string[];
    savedLocationCoords: Record<string, { lat: number; lon: number }>;
} | null {
    const name = extractDisplayName(plannerString);
    if (!name) return null;

    const coords = extractCoords(plannerString);
    const lower = name.toLowerCase();

    const filtered = (currentNames || []).filter((l) => l.toLowerCase() !== lower);
    const nextNames = [name, ...filtered].slice(0, MAX_SAVED);

    const nextCoords: Record<string, { lat: number; lon: number }> = {};
    for (const [key, value] of Object.entries(currentCoords || {})) {
        if (key.toLowerCase() === lower) continue; // drop old-cased entry
        nextCoords[key] = value;
    }
    if (coords) {
        nextCoords[name] = coords;
    }

    return { savedLocations: nextNames, savedLocationCoords: nextCoords };
}

/**
 * How close a tapped point must be to a saved one to count as "the spot
 * you already saved". ~200 m: loose enough that a fat finger re-tapping
 * an anchorage recognises it, tight enough not to claim the next bay.
 */
const SAME_SPOT_M = 200;
const M_PER_DEG_LAT = 110_540;

/**
 * Name this point is already saved under, or null. Lets the map inspect
 * popup show "✓ Saved as Hydeaway Bay" instead of offering a duplicate.
 * Longitude degrees are scaled by latitude, so the tolerance stays ~200 m
 * of real distance rather than ballooning near the poles.
 */
export function findSavedAt(
    coords: Record<string, { lat: number; lon: number }> | undefined,
    lat: number,
    lon: number,
): string | null {
    if (!coords) return null;
    const lonScale = Math.cos((lat * Math.PI) / 180);
    let best: { name: string; d: number } | null = null;
    for (const [name, c] of Object.entries(coords)) {
        if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lon)) continue;
        const dLat = (c.lat - lat) * M_PER_DEG_LAT;
        const dLon = (c.lon - lon) * M_PER_DEG_LAT * lonScale;
        const d = Math.hypot(dLat, dLon);
        if (d <= SAME_SPOT_M && (!best || d < best.d)) best = { name, d };
    }
    return best ? best.name : null;
}

/**
 * Pick a name that won't clobber a DIFFERENT spot already saved under it.
 *
 * The store is keyed by NAME (buildSaveLocationPatch dedupes case-
 * insensitively and overwrites the coords), but the map popup asks "is
 * THIS POINT saved?" by COORDS. Those two keys disagree exactly where it
 * hurts: reverse geocoding is locality-level, so two anchorages 500 m
 * apart in one bay both come back "Airlie Beach, QLD, AU". Saving the
 * second would silently move the first — and banking several spots in
 * one bay is the whole point of the feature.
 *
 * So: same name AND same spot → reuse it (a genuine re-save/rename).
 * Same name, different spot → suffix " (2)", " (3)" … The suffix carries
 * no comma, so it survives the planner-string round-trip untouched.
 */
export function disambiguateSavedName(
    names: string[] | undefined,
    coords: Record<string, { lat: number; lon: number }> | undefined,
    name: string,
    lat: number,
    lon: number,
): string {
    const taken = new Map((names || []).map((n) => [n.toLowerCase(), n]));

    const isFree = (candidate: string): boolean => {
        const existing = taken.get(candidate.toLowerCase());
        if (existing === undefined) return true;
        // Held by this very spot? Then it's ours to overwrite.
        const c = coords?.[existing];
        if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return false;
        const lonScale = Math.cos((lat * Math.PI) / 180);
        const d = Math.hypot((c.lat - lat) * M_PER_DEG_LAT, (c.lon - lon) * M_PER_DEG_LAT * lonScale);
        return d <= SAME_SPOT_M;
    };

    if (isFree(name)) return name;
    for (let n = 2; n <= MAX_SAVED + 1; n++) {
        const candidate = `${name} (${n})`;
        if (isFree(candidate)) return candidate;
    }
    return `${name} (${MAX_SAVED + 2})`;
}

/**
 * Build the settings patch for removing a location by name. Removes
 * the matching entry from both `savedLocations` and `savedLocationCoords`.
 */
export function buildRemoveLocationPatch(
    currentNames: string[] | undefined,
    currentCoords: Record<string, { lat: number; lon: number }> | undefined,
    name: string,
): {
    savedLocations: string[];
    savedLocationCoords: Record<string, { lat: number; lon: number }>;
} {
    const lower = name.toLowerCase();
    const nextNames = (currentNames || []).filter((l) => l.toLowerCase() !== lower);
    const nextCoords: Record<string, { lat: number; lon: number }> = {};
    for (const [key, value] of Object.entries(currentCoords || {})) {
        if (key.toLowerCase() === lower) continue;
        nextCoords[key] = value;
    }
    return { savedLocations: nextNames, savedLocationCoords: nextCoords };
}
