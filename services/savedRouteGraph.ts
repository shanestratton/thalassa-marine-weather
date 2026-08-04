/**
 * Saved-route graph lifecycle.
 *
 * One Route Tracer save can create a canonical saved_routes row, a planned_*
 * ship_logs mirror, and a voyages planning record. This module is the one
 * place allowed to clean those derived records, always through immutable ids
 * persisted on the trace rather than through a display label or day match.
 */

import { supabase } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import { invalidateRoutesAndTracks } from './shiplog/RoutesAndTracks';
import { deleteVoyageLogOnly } from './shiplog/EntryCrud';
import {
    deleteDraftVoyageById,
    getCachedActiveVoyage,
    getCachedDraftVoyages,
    removeCachedDraftVoyageById,
} from './VoyageService';

export interface SavedRoutePassageLinks {
    plannedRouteId?: string;
    passageVoyageId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlannedRouteId(value: string): boolean {
    return value.startsWith('planned_');
}

function validId(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/** `voyages.id` and saved_routes.passage_voyage_id are UUID columns. */
function isPassageVoyageId(value: unknown): value is string {
    return validId(value) && UUID_RE.test(value.trim());
}

function writeSucceeded(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    const response = result as { error?: unknown; count?: unknown };
    // `count: 'exact'` makes an RLS/no-match write visible. A missing count
    // is tolerated for older PostgREST clients, but an explicit zero never
    // represents a repaired graph link.
    return !response.error && (typeof response.count !== 'number' || response.count > 0);
}

/**
 * Stamp an exact trace id onto an older compatibility graph. This is used only
 * for the recognisable, auto-generated legacy "Nth Leg" records: their
 * geometry survives, but pre-migration builds had no persisted identity link.
 */
export async function linkSavedRoutePassageGraph(
    traceId: string,
    links: SavedRoutePassageLinks,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<boolean> {
    const canonicalId = traceId.trim();
    if (!canonicalId || !isAuthIdentityScopeCurrent(expectedScope) || !supabase || !expectedScope.userId) return false;
    const plannedRouteId = validId(links.plannedRouteId) ? links.plannedRouteId.trim() : null;
    const passageVoyageId = isPassageVoyageId(links.passageVoyageId) ? links.passageVoyageId.trim() : null;
    // Do not stamp a canonical trace onto a sailed log group or accept a
    // malformed historical id that cannot fit the UUID passage column.
    if ((plannedRouteId && !isPlannedRouteId(plannedRouteId)) || (links.passageVoyageId && !passageVoyageId))
        return false;
    if (!plannedRouteId && !passageVoyageId) return false;
    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!isAuthIdentityScopeCurrent(expectedScope) || user?.id !== expectedScope.userId) return false;

        const writes: PromiseLike<unknown>[] = [];
        if (plannedRouteId) {
            writes.push(
                supabase
                    .from('ship_logs')
                    .update({ saved_route_id: canonicalId }, { count: 'exact' })
                    .eq('user_id', expectedScope.userId)
                    .eq('voyage_id', plannedRouteId)
                    .eq('source', 'planned_route'),
            );
        }
        if (passageVoyageId) {
            writes.push(
                supabase
                    .from('voyages')
                    .update({ saved_route_id: canonicalId }, { count: 'exact' })
                    .eq('user_id', expectedScope.userId)
                    .eq('id', passageVoyageId)
                    .eq('status', 'planning'),
            );
        }
        const results = await Promise.all(writes);
        // PostgREST reports rejected writes in the resolved result rather
        // than by rejecting the promise. Treat those as a failed link so a
        // caller never believes an old graph was repaired when (for example)
        // the migration has not reached this device's backend yet.
        return results.length > 0 && results.every(writeSucceeded) && isAuthIdentityScopeCurrent(expectedScope);
    } catch {
        return false;
    }
}

function notifyPassageRouteGraphChanged(scope: AuthIdentityScope): void {
    if (!isAuthIdentityScopeCurrent(scope) || typeof window === 'undefined') return;
    try {
        window.dispatchEvent(
            new CustomEvent('thalassa:passage-route-graph-changed', {
                detail: { scopeKey: scope.key, scopeGeneration: scope.generation },
            }),
        );
    } catch {
        /* non-critical */
    }
}

/**
 * Delete the planning/log mirrors belonging to one canonical trace.
 *
 * It is intentionally idempotent: deleteTrace invokes it immediately, while
 * a background mirror save invokes it again if it finishes after deletion.
 * Both paths converge on the same immutable trace id.
 */
export async function deleteSavedRoutePassageGraph(
    traceId: string,
    links: SavedRoutePassageLinks = {},
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<boolean> {
    const canonicalId = traceId.trim();
    if (!canonicalId || !isAuthIdentityScopeCurrent(expectedScope)) return false;

    const plannedRouteIds = new Set<string>();
    const passageVoyageIds = new Set<string>();
    // These UUIDs came from an immutable link on the trace itself or from a
    // planned-route row already stamped with this canonical trace. They are
    // safe to use for the narrowly-scoped pre-link fallback below; a generic
    // voyage lookup never earns that privilege.
    const exactPassageVoyageIds = new Set<string>();
    const linkedPassageIdsByRoute = new Map<string, Set<string>>();
    const ambiguousLinkedRoutes = new Set<string>();
    const passageStatusById = new Map<string, string>();
    let canonicalHasActivePassage = false;
    let remotePassageStateWasRead = false;
    const addRoutePassageLink = (plannedRouteId: string, passageVoyageId: string): void => {
        if (!isPlannedRouteId(plannedRouteId) || !isPassageVoyageId(passageVoyageId)) return;
        plannedRouteIds.add(plannedRouteId);
        exactPassageVoyageIds.add(passageVoyageId);
        const linksForRoute = linkedPassageIdsByRoute.get(plannedRouteId) ?? new Set<string>();
        linksForRoute.add(passageVoyageId);
        linkedPassageIdsByRoute.set(plannedRouteId, linksForRoute);
    };

    const suppliedPlannedRouteId = validId(links.plannedRouteId) ? links.plannedRouteId.trim() : null;
    const suppliedPassageVoyageId = isPassageVoyageId(links.passageVoyageId) ? links.passageVoyageId.trim() : null;
    if (suppliedPlannedRouteId && isPlannedRouteId(suppliedPlannedRouteId)) {
        plannedRouteIds.add(suppliedPlannedRouteId);
    }
    if (suppliedPlannedRouteId && suppliedPassageVoyageId) {
        addRoutePassageLink(suppliedPlannedRouteId, suppliedPassageVoyageId);
    } else if (suppliedPassageVoyageId) {
        // A planning row with no surviving log mirror is still an exact
        // canonical link, but its status must be known before we touch it.
        passageVoyageIds.add(suppliedPassageVoyageId);
        exactPassageVoyageIds.add(suppliedPassageVoyageId);
    }

    // The links stored locally handle offline deletes. When online, query the
    // reverse links too: this catches a trace deleted before its local link
    // write returned, and safely repairs earlier partially-written saves.
    if (supabase && expectedScope.userId) {
        try {
            const {
                data: { user },
            } = await supabase.auth.getUser();
            if (!isAuthIdentityScopeCurrent(expectedScope) || user?.id !== expectedScope.userId) return false;

            const [logRowsResult, voyageRowsResult] = await Promise.all([
                supabase
                    .from('ship_logs')
                    .select('voyage_id, linked_plan_id')
                    .eq('user_id', expectedScope.userId)
                    .eq('saved_route_id', canonicalId)
                    .eq('source', 'planned_route'),
                supabase
                    .from('voyages')
                    .select('id, status')
                    .eq('user_id', expectedScope.userId)
                    .eq('saved_route_id', canonicalId),
            ]);
            if (!isAuthIdentityScopeCurrent(expectedScope)) return false;

            if (!logRowsResult.error && Array.isArray(logRowsResult.data)) {
                for (const row of logRowsResult.data) {
                    if (validId(row?.voyage_id) && isPlannedRouteId(row.voyage_id.trim())) {
                        plannedRouteIds.add(row.voyage_id.trim());
                        if (isPassageVoyageId(row?.linked_plan_id)) {
                            addRoutePassageLink(row.voyage_id.trim(), row.linked_plan_id.trim());
                        }
                    }
                }
            }
            if (!voyageRowsResult.error && Array.isArray(voyageRowsResult.data)) {
                remotePassageStateWasRead = true;
                for (const row of voyageRowsResult.data) {
                    if (isPassageVoyageId(row?.id) && typeof row.status === 'string') {
                        passageVoyageIds.add(row.id.trim());
                        passageStatusById.set(row.id.trim(), row.status);
                        if (row.status === 'active') canonicalHasActivePassage = true;
                    }
                }
            }

            for (const [plannedRouteId, linkedPassageIds] of linkedPassageIdsByRoute) {
                if (linkedPassageIds.size === 1) {
                    passageVoyageIds.add(Array.from(linkedPassageIds)[0]);
                } else if (linkedPassageIds.size > 1) {
                    // Corrupt mixed groups must never turn a route delete into
                    // a broad deletion of multiple planning records.
                    ambiguousLinkedRoutes.add(plannedRouteId);
                }
            }

            // A linked_plan_id is an immutable UUID but can predate
            // saved_route_id on older rows. Resolve its current status before
            // deleting anything: an active passage keeps its mirror geometry
            // so Passage Summary still has a route after reload.
            const linkedIds = Array.from(passageVoyageIds);
            if (linkedIds.length > 0) {
                const { data: linkedVoyages, error: linkedVoyagesError } = await supabase
                    .from('voyages')
                    .select('id, status')
                    .eq('user_id', expectedScope.userId)
                    .in('id', linkedIds);
                if (!isAuthIdentityScopeCurrent(expectedScope)) return false;
                if (!linkedVoyagesError && Array.isArray(linkedVoyages)) {
                    remotePassageStateWasRead = true;
                    for (const row of linkedVoyages) {
                        if (isPassageVoyageId(row?.id) && typeof row.status === 'string') {
                            passageStatusById.set(row.id.trim(), row.status);
                        }
                    }
                }
            }
        } catch {
            // An unresolved linked passage is deliberately deferred below.
            // Never fall back to names/dates, and never destroy a mirror that
            // may be feeding an active passage on another device.
        }
    }

    // Input-only links never passed through the cloud loop above. Resolve
    // their unique UUID before consulting the offline planning cache.
    for (const [plannedRouteId, linkedPassageIds] of linkedPassageIdsByRoute) {
        if (linkedPassageIds.size === 1) passageVoyageIds.add(Array.from(linkedPassageIds)[0]);
        else if (linkedPassageIds.size > 1) ambiguousLinkedRoutes.add(plannedRouteId);
    }

    // Offline cache can positively identify the current device's planning or
    // active passage. It only supplements server truth; active wins if a
    // stale draft cache also exists.
    const cachedActive = getCachedActiveVoyage();
    if (cachedActive && isPassageVoyageId(cachedActive.id) && passageVoyageIds.has(cachedActive.id)) {
        passageStatusById.set(cachedActive.id, 'active');
    }
    for (const draft of getCachedDraftVoyages()) {
        if (passageVoyageIds.has(draft.id) && passageStatusById.get(draft.id) !== 'active') {
            passageStatusById.set(draft.id, 'planning');
        }
    }

    let touched = false;
    // This is a saved-route graph deletion, not an instruction to abort an
    // underway passage. Keep the durable ship-log tombstone + cloud retry
    // ledger, but deliberately suppress EntryCrud's historical linked-plan
    // cascade. The draft-only deletion below handles the exact planning row;
    // it refuses anything active, completed, or aborted.
    for (const plannedRouteId of plannedRouteIds) {
        if (!isAuthIdentityScopeCurrent(expectedScope) || !isPlannedRouteId(plannedRouteId)) return touched;
        const linkedPassageIds = linkedPassageIdsByRoute.get(plannedRouteId);
        const linkedPassageIsActiveOrUnresolved =
            canonicalHasActivePassage ||
            ambiguousLinkedRoutes.has(plannedRouteId) ||
            Boolean(
                linkedPassageIds &&
                Array.from(linkedPassageIds).some((voyageId) => {
                    const status = passageStatusById.get(voyageId);
                    return status === 'active' || status === undefined;
                }),
            );
        // An old trace can know a planned_* mirror without yet knowing the
        // planning UUID. When we cannot read the remote status, defer that
        // destructive mirror cleanup until a later authenticated sync rather
        // than risking an active passage on another device.
        const hasNoLinkedPassageId = !linkedPassageIds || linkedPassageIds.size === 0;
        if (linkedPassageIsActiveOrUnresolved || (hasNoLinkedPassageId && !remotePassageStateWasRead)) continue;
        const deleted = await deleteVoyageLogOnly(plannedRouteId);
        touched = deleted || touched;
    }

    for (const voyageId of passageVoyageIds) {
        if (!isAuthIdentityScopeCurrent(expectedScope)) return touched;
        // Only a positively identified planning record belongs in the
        // Saved Routes picker. An active/unknown/completed row stays intact;
        // the canonical tombstone keeps its mirror hidden and a later sync
        // retries cleanup once it is safe.
        if (passageStatusById.get(voyageId) !== 'planning') continue;
        const allowUnlinkedSavedRoute = exactPassageVoyageIds.has(voyageId);
        removeCachedDraftVoyageById(voyageId, expectedScope, canonicalId, { allowUnlinkedSavedRoute });
        if (supabase) {
            const deleted = await deleteDraftVoyageById(voyageId, canonicalId, {
                // A legacy trace can hold the exact passage UUID even though
                // the backfill of voyages.saved_route_id never completed.
                // Delete that null-linked row, but never a row linked to a
                // different trace (enforced by VoyageService).
                allowUnlinkedSavedRoute,
            });
            touched = deleted || touched;
        }
    }

    // ONLY announce when this cleanup actually deleted something. This pair
    // used to fire unconditionally — and syncSavedRoutes re-runs this retry
    // for every retained tombstone on every planning-page reload, while
    // CrewManagement reloads on BOTH of these events. Graph-linked tombstones
    // are excluded from compaction by design, so one retained tombstone closed
    // a self-sustaining ~1.5s reload loop (each cycle nulling the routes cache
    // and refetching 10k log entries): the 51%-CPU resource kill and the 2.0GB
    // per-process jetsam of 2026-08-04. A no-op retry must stay silent.
    if (touched && isAuthIdentityScopeCurrent(expectedScope)) {
        invalidateRoutesAndTracks(expectedScope);
        notifyPassageRouteGraphChanged(expectedScope);
    }
    return touched;
}
