/**
 * CrewManagement — canonical saved-route eligibility for planning rows.
 *
 * Moved verbatim out of components/CrewManagement.tsx.
 */
import { loadSavedTraces } from '../../services/routeTracer';
import { type Voyage } from '../../services/VoyageService';

/**
 * A planning row is eligible for Saved Routes when it carries the canonical
 * trace id itself, or when an older row is tied to that trace by the exact
 * immutable passage UUID. The latter is deliberately restricted to unlinked
 * rows: a conflicting saved_route_id must never be papered over by a stale
 * passage_voyage_id from another graph.
 */
export function isCanonicalSavedRouteDraft(
    draft: Voyage,
    canonicalIds: ReadonlySet<string>,
    canonicalPassageVoyageIds: ReadonlySet<string>,
): boolean {
    return Boolean(
        (draft.saved_route_id && canonicalIds.has(draft.saved_route_id)) ||
        (!draft.saved_route_id && canonicalPassageVoyageIds.has(draft.id)),
    );
}

export function canonicalPassageVoyageIds(traces: ReturnType<typeof loadSavedTraces>): Set<string> {
    return new Set(
        traces
            .map((trace) => trace.passageVoyageId)
            .filter((passageVoyageId): passageVoyageId is string => Boolean(passageVoyageId && passageVoyageId.trim())),
    );
}
