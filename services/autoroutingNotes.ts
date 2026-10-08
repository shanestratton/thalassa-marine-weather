/**
 * The lines every Auto route carries whatever it finds (package 125-06).
 *
 * Shane, 2026-10-08, a fresh Auto route from Port of Airlie to Nara Inlet:
 * "8 route notes · review required". Three of the eight are on every Auto
 * route — what it is (a proposal, not cleared for navigation), how it was
 * routed (this phone, these charts, this draft and margin), and that beam and
 * length are not used yet — so a route that found nothing still asked for a
 * review of three notes. They stay in the route's warnings, saved with it and
 * listed on Review under their own heading; the count, folded and on Review,
 * is of what this route found.
 */

/** First line of every Auto proposal: what it is, before anything it found. */
export const THALASSA_PLANNED_ONLY_WARNING =
    'Proposal only: not cleared for navigation. Review every leg against the chart before you save or use it.';

/** How every Auto route was routed: this line's start, its draft and margin after. */
export const THALASSA_ROUTED_ON_PHONE = 'Routed on this phone by Thalassa from your installed charts:';

/** What the router does not read yet, said on every route. */
export const ROUTER_BEAM_LENGTH_UNUSED = 'Beam and length are not used by the router yet.';

/** A line every Auto route carries, whatever it found. */
export function isStandingRouteNote(note: string): boolean {
    return (
        note === THALASSA_PLANNED_ONLY_WARNING ||
        note === ROUTER_BEAM_LENGTH_UNUSED ||
        note.startsWith(THALASSA_ROUTED_ON_PHONE)
    );
}

/** The notes about what this route found: the ones to review. */
export function routeNotesToReview(notes: readonly string[]): string[] {
    return notes.filter((note) => !isStandingRouteNote(note));
}
