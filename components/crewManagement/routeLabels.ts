/**
 * CrewManagement — route label parsing and display names.
 *
 * Pure string helpers moved verbatim out of components/CrewManagement.tsx.
 */
import { stripLegBadge } from '../../services/routeTracer';
import { formatPlannedRouteLabel, formatStoredPlannedRouteName } from '../../services/shiplog/plannedRouteNaming';
import { type Voyage } from '../../services/VoyageService';

// These labels are generated exclusively by the Route Tracer's chained-leg
// flow. A pre-link build could leave such a mirror behind after its canonical
// leg disappeared; promote the surviving geometry back to a normal saved
// route instead of showing a nonsensical orphaned "2nd Leg" here.
const GENERATED_LEG_BADGE_ANYWHERE_RE = /\s*\(\d+(?:st|nd|rd|th) Leg\)/i;

export function isLegacyGeneratedLeg(label: string): boolean {
    return GENERATED_LEG_BADGE_ANYWHERE_RE.test(label);
}

export function legacyGeneratedLegName(label: string): string {
    // Preserve the whole human route label. A surviving “A → B (2nd Leg)” is
    // promoted to the first/only route, not silently reduced to just “A”.
    return stripLegBadge(
        label
            .replace(GENERATED_LEG_BADGE_ANYWHERE_RE, '')
            .replace(/\s+—\s+start\s*$/i, '')
            .trim(),
    );
}

/**
 * Split a route label into its two endpoints.
 *
 * Two separators are in circulation: routeAutoName builds "Newport - Lady
 * Musgrave" and logbook labels build "Newport → Lady Musgrave". A label with
 * neither (a hand-typed "Winter delivery run") has no endpoints to give, and
 * returning the whole string as the departure is worse than returning nothing
 * — it puts a route name where a port name is expected.
 */
export function splitRouteEndpoints(label: string): [string | undefined, string | undefined] {
    for (const separator of [' → ', ' - ']) {
        const parts = label.split(separator);
        if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
            const departure = parts[0].trim();
            const arrival = parts[1].trim();
            // "x → x" is a naming artefact (multi-leg trace legs can carry
            // the leg title in both ports). A self-to-self passage isn't
            // real: keep the name as the departure and leave the
            // destination honestly empty rather than duplicating it into
            // Cast Off (Shane 2026-08-04: "newport 2nd leg - newport 2nd
            // leg??????").
            if (departure.toLocaleLowerCase() === arrival.toLocaleLowerCase()) return [departure, undefined];
            return [departure, arrival];
        }
    }
    return [undefined, undefined];
}

/**
 * Legacy saved traces stored their internal endpoint markers as the voyage
 * title. Keep matching against the original database fields, but never make
 * a skipper read "… start → … end" in the Saved Routes selector.
 */
export function savedRouteDisplayName(
    voyage: Pick<Voyage, 'voyage_name' | 'departure_port' | 'destination_port'>,
): string {
    return (
        formatStoredPlannedRouteName(voyage.voyage_name) ??
        (voyage.departure_port || voyage.destination_port
            ? formatPlannedRouteLabel(voyage.departure_port, voyage.destination_port)
            : '? → ?')
    );
}
