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
