/**
 * Where a trip actually starts and ends.
 *
 * Shane 2026-09-04: "i have a trip from newport -> coral sea, coral sea ->
 * mackay, and mackay -> whitsundays, however the trip says newport -> coral
 * sea??? it should be newport -> whitsundays."
 *
 * He is right, and the cause is that a multi-leg trip is not one row. The
 * voyage record holds only LEG ONE's ports; the rest of the trip lives in
 * sailed legs (VoyageLegService) and in chained draft voyages, which the leg
 * picker already knew how to reassemble and nothing else did. Every label in
 * the app read `voyage.departure_port → voyage.destination_port` and so
 * described the first hop as though it were the whole passage.
 *
 * The rule, in Shane's words: the origin of leg one and the destination of the
 * final leg.
 */
import type { Voyage } from './VoyageService';
import type { PassageLeg } from '../types/navigation';

export function normPort(s: string | null | undefined): string {
    return (s ?? '').trim().toLowerCase();
}

/**
 * Extend the active voyage forward through any draft whose departure matches
 * the running endpoint. Greedy first match, oldest draft first.
 *
 * Moved here from LegPickerDropdown so labels and the picker agree by
 * construction: two copies of this walk would eventually disagree about how
 * long a trip is, which is exactly the class of bug being fixed.
 */
export function chainDraftsOntoActive(active: Voyage, drafts: Voyage[]): { consumed: Voyage[]; remaining: Voyage[] } {
    const consumed: Voyage[] = [];
    const remaining = [...drafts].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    let endpoint = normPort(active.destination_port);
    if (!endpoint) return { consumed: [], remaining };

    let extended = true;
    while (extended) {
        extended = false;
        const idx = remaining.findIndex((d) => normPort(d.departure_port) === endpoint);
        if (idx < 0) break;
        const next = remaining.splice(idx, 1)[0];
        consumed.push(next);
        endpoint = normPort(next.destination_port);
        if (!endpoint) break;
        extended = true;
    }
    return { consumed, remaining };
}

export interface TripEndpoints {
    origin: string | null;
    destination: string | null;
}

/**
 * The whole trip's endpoints, from every source that can extend it.
 *
 * Precedence for the destination, furthest first: the last chained draft, then
 * the last sailed leg's actual arrival, then that leg's PLANNED destination
 * (it is still at sea and has not arrived), then the voyage's own field.
 */
export function tripEndpoints(
    voyage: Voyage | null,
    sailedLegs: PassageLeg[] = [],
    chainedDrafts: Voyage[] = [],
): TripEndpoints {
    if (!voyage) return { origin: null, destination: null };

    const legs = [...sailedLegs].sort((a, b) => a.leg_number - b.leg_number);
    const origin = legs[0]?.departure_port?.trim() || voyage.departure_port || null;

    const lastDraft = chainedDrafts[chainedDrafts.length - 1];
    const lastLeg = legs[legs.length - 1];
    const destination =
        lastDraft?.destination_port?.trim() ||
        lastLeg?.arrival_port?.trim() ||
        lastLeg?.planned_destination?.trim() ||
        voyage.destination_port ||
        null;

    return { origin, destination };
}

/** "Newport → Whitsundays", or null when there is not enough to say. */
export function tripRouteLabel(
    voyage: Voyage | null,
    sailedLegs: PassageLeg[] = [],
    chainedDrafts: Voyage[] = [],
): string | null {
    const { origin, destination } = tripEndpoints(voyage, sailedLegs, chainedDrafts);
    return origin && destination ? `${origin} → ${destination}` : null;
}
