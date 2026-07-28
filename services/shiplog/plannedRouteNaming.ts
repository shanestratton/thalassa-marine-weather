/**
 * Naming helpers for planned-route compatibility mirrors.
 *
 * Route Tracer historically serialised a saved trace named "A - B" as
 * endpoint labels "A - B — start" and "A - B — end". Those are useful
 * internal markers, but are not a useful human route title when joined with
 * an arrow. Detect only that exact generated pair so ordinary route labels
 * retain their meaningful departure → destination form.
 */

function generatedEndpointBase(value: string, endpoint: 'start' | 'end'): string | null {
    const match = value.trim().match(new RegExp(`^(.*?)\\s+(?:—|–|-)\\s*${endpoint}\\s*$`, 'i'));
    const base = match?.[1]?.trim();
    return base || null;
}

function comparable(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

/**
 * Auto-generated trace titles use " - " as their route-name separator, so
 * the final part is the destination locality. Keep ordinary hyphenated place
 * names intact: only the spaced separator carries this meaning.
 */
function finalLocalityToken(value: string): string {
    const parts = value.split(/\s+-\s+/);
    return comparable(parts[parts.length - 1] ?? value);
}

/**
 * Is this string a GENERATED endpoint label — "<title> — start" / "— end" —
 * rather than a real place?
 *
 * The Route Tracer stamps those onto a passage's departure_port and
 * destination_port. They read as a place name to any consumer that does not
 * know better, and the Passage Coordinates panel was rendering
 * "Newport – Moreton Bay – start" under a heading that promises a lat/lon
 * (Shane 2026-07-29: "the passage coords are wrong").
 */
export function isGeneratedEndpointLabel(value: string | null | undefined): boolean {
    if (!value) return false;
    return generatedEndpointBase(value, 'start') !== null || generatedEndpointBase(value, 'end') !== null;
}

/**
 * Return the saved trace title when both endpoint labels are the generated
 * `<title> — start/end` pair. GPS precision can make the two title prefixes
 * differ slightly, so a shared final destination locality is also accepted.
 * The arrival title wins: it is the route's completed/end label.
 *
 * Null means these are real endpoints and must remain distinct.
 */
export function collapseGeneratedTraceEndpointPair(
    departure: string | null | undefined,
    arrival: string | null | undefined,
): string | null {
    if (typeof departure !== 'string' || typeof arrival !== 'string') return null;
    const startBase = generatedEndpointBase(departure, 'start');
    const endBase = generatedEndpointBase(arrival, 'end');
    if (!startBase || !endBase) return null;
    if (comparable(startBase) === comparable(endBase)) return endBase;
    return finalLocalityToken(startBase) === finalLocalityToken(endBase) ? endBase : null;
}

/** Human route label for planned-route pickers and compatibility rows. */
export function formatPlannedRouteLabel(
    departure: string | null | undefined,
    arrival: string | null | undefined,
): string {
    const cleanDeparture = typeof departure === 'string' && departure.trim() ? departure.trim() : 'Departure';
    const cleanArrival = typeof arrival === 'string' && arrival.trim() ? arrival.trim() : 'Arrival';
    return collapseGeneratedTraceEndpointPair(cleanDeparture, cleanArrival) ?? `${cleanDeparture} → ${cleanArrival}`;
}

/**
 * Normalise an already-stored passage title for display.
 *
 * Old trace mirrors persisted the generated endpoints as the voyage name
 * itself ("<title> — start → <title> — end"). Keep every explicit name
 * intact unless it is that exact two-endpoint shape; multi-leg and
 * user-authored names are deliberately left alone.
 */
export function formatStoredPlannedRouteName(value: string | null | undefined): string | null {
    const title = typeof value === 'string' ? value.trim() : '';
    if (!title) return null;
    const endpoints = title.split(/\s*(?:→|->)\s*/);
    if (endpoints.length !== 2) return title;
    return collapseGeneratedTraceEndpointPair(endpoints[0], endpoints[1]) ?? title;
}
