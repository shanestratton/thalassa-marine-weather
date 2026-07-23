/**
 * Passage Plan Save — extracted from ShipLogService.
 *
 * Converts a VoyagePlan into ship log entries and saves them
 * to Supabase (or offline queue). Self-contained, no class dependency.
 */

import { supabase, getCurrentUser } from '../supabase';
import { ShipLogEntry } from '../../types';
import { calculateDistanceNM, calculateBearing, formatPositionDMS, toDbFormat, SHIP_LOGS_TABLE } from './helpers';
import { addVoyageTombstone, queueOfflineEntry } from './OfflineQueue';
import { fetchRoutesAndTracks, invalidateRoutesAndTracks } from './RoutesAndTracks';
import { createLogger } from '../../utils/createLogger';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';

const log = createLogger('PassagePlanSave');

/**
 * Sentinel thrown when the caller tries to save a passage plan whose
 * (departure → destination) pair already exists in the logbook for the
 * same calendar day. Callsites should `catch` and show a "this route
 * already exists for that day, change the date" toast — distinct from
 * the generic "Save failed" path.
 */
export const DUPLICATE_PASSAGE_PLAN_ERROR = 'DUPLICATE_PASSAGE_PLAN';

/** Normalise a name for case/whitespace-insensitive matching. */
function normaliseName(s: string): string {
    return s.trim().toLowerCase();
}

/**
 * Trim country / generic-region suffixes from a route name while
 * preserving the user's typed specificity.
 *
 *   "Newport, QLD"                           → "Newport, QLD"   (kept)
 *   "Port Moselle, NC"                       → "Port Moselle, NC" (kept)
 *   "Newport, QLD, AU"                       → "Newport, QLD"   (drop AU)
 *   "Newport, Queensland, Australia"         → "Newport, Queensland" (drop AU)
 *   "Port Moselle, New Caledonia, NC"        → "Port Moselle, New Caledonia" (drop NC dup)
 *   "Newport"                                → "Newport"
 *
 * The old code did `.split(',')[0]` which collapsed "Newport, QLD" to
 * just "Newport" — losing the state the user explicitly typed. The new
 * logic keeps everything except a trailing country abbrev / full
 * country name. If the result has 3+ comma segments, drop the last
 * (assume it's country); otherwise keep verbatim.
 */
function trimCountrySuffix(name: string): string {
    const parts = name
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (parts.length === 0) return name;
    if (parts.length === 1) return parts[0];
    // If the trailing segment looks like a country/region ISO code
    // (2-4 uppercase letters: NC, QLD, NSW, AU, USA, etc.) drop it.
    // This handles both "Newport, QLD" → "Newport" and "Nouméa, NC" →
    // "Nouméa" so the Log Book and Passage Planning dropdown both
    // display the city name only — no more inconsistent "Newport →
    // Nouméa" vs "Newport → Port Moselle" mismatch between views.
    const last = parts[parts.length - 1];
    if (/^[A-Z]{2,4}$/.test(last)) {
        const trimmed = parts.slice(0, -1);
        return trimmed.join(', ');
    }
    // 3+ parts but trailing segment isn't a code — drop the last anyway
    // (assume it's a country name like "Australia"). 2 parts where
    // trailing isn't a code (e.g. "Brisbane, Queensland") — keep both.
    if (parts.length >= 3) return parts.slice(0, -1).join(', ');
    return parts.join(', ');
}

/**
 * Parse a human-readable duration string back to hours.
 *
 * Handles all the formats the formatter produces:
 *   "5 hours"  → 5
 *   "23 hours" → 23
 *   "5 days"   → 120
 *   "5d 9h"    → 129
 *   "144h"     → 144
 *
 * The old `parseFloat(durationApprox)` collapsed "5 days" to 5 (treated
 * as hours), making the saved voyage's eta come out at depDate + 5
 * hours instead of 5 days. Then weather-window accept flows that
 * preserved (newEta - newDep) = (oldEta - oldDep) compounded the bad
 * delta until the displayed duration was nonsense like "74d 11h".
 *
 * Returns null if no number parsed (caller falls back to a default).
 */
function parseDurationToHours(s: string | undefined | null): number | null {
    if (!s || typeof s !== 'string') return null;
    const trimmed = s.trim().toLowerCase();
    // "Xd Yh" — captures both day and hour components
    const dh = trimmed.match(/^(\d+(?:\.\d+)?)\s*d(?:ays?)?(?:\s+(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*$/);
    if (dh) {
        const days = parseFloat(dh[1]);
        const hours = dh[2] ? parseFloat(dh[2]) : 0;
        return days * 24 + hours;
    }
    // "X hours" / "X h"
    const h = trimmed.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*$/);
    if (h) return parseFloat(h[1]);
    // "X minutes" / "X min" / "X m" — short traces emit these; unparsed they
    // fell through to the 12-hour default and a 30-min trace saved log
    // entries spread across half a day (Route Tracer audit, 2026-07-08).
    const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\s*$/);
    if (m) return parseFloat(m[1]) / 60;
    // Bare number — assume hours (back-compat)
    const bare = trimmed.match(/^(\d+(?:\.\d+)?)\s*$/);
    if (bare) return parseFloat(bare[1]);
    return null;
}

/** Produce a YYYY-MM-DD day key from an ISO timestamp or Date. */
function dayKey(iso: string | number | Date): string {
    const d = new Date(iso);
    if (!isFinite(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
}

/**
 * Marker we prefix the saved geometry blob with so RoutesAndTracks can
 * recognise + parse it when reconstructing the route polyline. Stored
 * on the first ("Departure") entry's notes field — chosen over a new
 * column because the existing schema doesn't have a JSON-blob field
 * and we want this to ship without a migration.
 */
export const ROUTE_GEOMETRY_NOTES_PREFIX = '__route_geometry__::';

/** Short, deterministic namespace component; uniqueness comes from the UUID. */
function scopeFingerprint(scope: AuthIdentityScope): string {
    let hash = 2166136261;
    for (let index = 0; index < scope.key.length; index++) {
        hash ^= scope.key.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

/**
 * Allocate every immutable identifier for one logical passage save together.
 * These IDs are created before the first remote write and survive an ambiguous
 * online result unchanged when the same rows move to the offline queue.
 */
function allocatePassageIdentifiers(
    scope: AuthIdentityScope,
    entryCount: number,
): {
    voyageId: string;
    operationIds: string[];
} {
    const createdAt = Date.now();
    const batchId = crypto.randomUUID().replace(/-/g, '');
    const operationPrefix = `passage_${scopeFingerprint(scope)}_${batchId}`;
    return {
        voyageId: `planned_${createdAt}_${batchId.slice(0, 12)}`,
        operationIds: Array.from({ length: entryCount }, (_, index) => `${operationPrefix}_${index}`),
    };
}

/**
 * Queue a planned route as one logical batch. Individual appends are durable,
 * so a later failure is compensated with a voyage tombstone before failure is
 * reported. The tombstone is owner-scoped and prevents both partial replay and
 * resurrection by an online request whose outcome was ambiguous.
 */
async function queuePassageBatch(
    entries: Partial<ShipLogEntry>[],
    operationIds: string[],
    voyageId: string,
    scope: AuthIdentityScope,
): Promise<void> {
    try {
        for (let index = 0; index < entries.length; index++) {
            if (!isAuthIdentityScopeCurrent(scope)) {
                throw new Error('Account changed before the passage batch could be queued');
            }
            await queueOfflineEntry(entries[index], {
                operationId: operationIds[index],
                expectedScope: scope,
            });
            if (!isAuthIdentityScopeCurrent(scope)) {
                throw new Error('Account changed while the passage batch was being queued');
            }
        }
    } catch (error) {
        try {
            await addVoyageTombstone(voyageId, scope);
        } catch (rollbackError) {
            // A changed identity is expected to reject this call rather than
            // touch the new owner's queue. Same-owner storage failures remain
            // visible in diagnostics and the save is never acknowledged.
            log.error('savePassagePlan: passage batch rollback could not be persisted', rollbackError);
        }
        throw error;
    }
}

/**
 * Save a passage plan's route to the logbook as a "planned_route" voyage.
 * These entries show as suggested/uncharted tracks with restricted actions.
 */
export async function savePassagePlanToLogbook(inputPlan: import('../../types').VoyagePlan): Promise<string | null> {
    const operationScope = getAuthIdentityScope();
    // Callers retain and edit VoyagePlan objects. Snapshot every field before
    // the first await so a later UI edit cannot change what this operation
    // authenticates, de-duplicates, inserts, or queues.
    const plan =
        typeof structuredClone === 'function'
            ? structuredClone(inputPlan)
            : (JSON.parse(JSON.stringify(inputPlan)) as import('../../types').VoyagePlan);
    try {
        if (!isAuthIdentityScopeCurrent(operationScope)) return null;
        // Diagnostic: log exactly what origin/destination are at save
        // time. If the saved logbook entry comes out as "Queensland →
        // South Province" instead of "Newport QLD → Port Moselle NC",
        // this line tells us whether the bad name arrived in the plan
        // or got built from something else further down. Uses .warn
        // because .info is silenced in production builds (createLogger).
        // Also log the date — Gemini sometimes hallucinates departureDate
        // and we need to see what's actually arriving here.
        log.warn(
            `savePassagePlan input — origin="${plan.origin}", destination="${plan.destination}", departureDate=${plan.departureDate ?? '(none)'}`,
        );

        // ── Duplicate check ─────────────────────────────────────────────
        // Prevent the same (origin → destination) pair on the same calendar
        // day from creating a second logbook route. Identical-name passages
        // are still allowed — they just need a different departure date so
        // the user can tell them apart in the logbook + active passage
        // dropdown. See DUPLICATE_PASSAGE_PLAN_ERROR for the sentinel
        // callers should catch.
        const proposedDeparture = typeof plan.origin === 'string' ? trimCountrySuffix(plan.origin) : 'Departure';
        const proposedArrival = typeof plan.destination === 'string' ? trimCountrySuffix(plan.destination) : 'Arrival';
        const proposedLabel = normaliseName(`${proposedDeparture} → ${proposedArrival}`);
        const proposedDay = dayKey(plan.departureDate || new Date());

        try {
            const { routes } = await fetchRoutesAndTracks();
            if (!isAuthIdentityScopeCurrent(operationScope)) return null;
            const isDuplicate = routes.some((r) => {
                if (normaliseName(r.label) !== proposedLabel) return false;
                return dayKey(r.timestamp) === proposedDay;
            });
            if (isDuplicate) {
                log.warn(
                    `savePassagePlan: refusing duplicate "${proposedLabel}" on ${proposedDay} — already in logbook`,
                );
                throw new Error(DUPLICATE_PASSAGE_PLAN_ERROR);
            }
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(operationScope)) return null;
            // Re-throw the sentinel; swallow other errors (RoutesAndTracks
            // fetch failures shouldn't block save — duplicate check is a
            // helpful guard, not a hard requirement).
            if (e instanceof Error && e.message === DUPLICATE_PASSAGE_PLAN_ERROR) throw e;
            log.warn('savePassagePlan: duplicate check failed (non-fatal)', e);
        }

        // Build waypoint chain: origin → waypoints → destination
        const allPoints: { lat: number; lon: number; name: string; isWP: boolean }[] = [];

        if (plan.originCoordinates) {
            allPoints.push({
                lat: plan.originCoordinates.lat,
                lon: plan.originCoordinates.lon,
                name: typeof plan.origin === 'string' ? trimCountrySuffix(plan.origin) : 'Departure',
                isWP: false,
            });
        }

        for (const wp of plan.waypoints || []) {
            if (wp.coordinates) {
                allPoints.push({
                    lat: wp.coordinates.lat,
                    lon: wp.coordinates.lon,
                    name: wp.name || 'Waypoint',
                    isWP: true,
                });
            }
        }

        if (plan.destinationCoordinates) {
            allPoints.push({
                lat: plan.destinationCoordinates.lat,
                lon: plan.destinationCoordinates.lon,
                name: typeof plan.destination === 'string' ? trimCountrySuffix(plan.destination) : 'Arrival',
                isWP: false,
            });
        }

        if (allPoints.length < 2) {
            log.error('Passage plan has insufficient waypoints');
            return null;
        }

        const { voyageId, operationIds } = allocatePassageIdentifiers(operationScope, allPoints.length);
        const now = new Date().toISOString();

        // Create entries with distance calculations
        let cumulativeNM = 0;
        const entries: Partial<ShipLogEntry>[] = [];

        for (let i = 0; i < allPoints.length; i++) {
            const pt = allPoints[i];
            let distNM = 0;
            let courseDeg: number | undefined;

            if (i > 0) {
                const prev = allPoints[i - 1];
                distNM = calculateDistanceNM(prev.lat, prev.lon, pt.lat, pt.lon);
                courseDeg = calculateBearing(prev.lat, prev.lon, pt.lat, pt.lon);
            }
            cumulativeNM += distNM;

            // Timestamps: spread entries over the estimated duration
            const depDate = plan.departureDate ? new Date(plan.departureDate) : new Date();
            const fraction = allPoints.length > 1 ? i / (allPoints.length - 1) : 0;
            // Rough duration estimate: parse from plan or default 12h.
            // plan.durationApprox is one of "X hours" / "Xd Yh" /
            // "X days". The old code did `parseFloat(plan.durationApprox)`
            // which extracts the leading number — meaning "5 days"
            // resolved to 5 HOURS (not 120 hours), and "5d 9h" to 5
            // hours. That's why a 6-day passage showed as 6h in the
            // saved voyage's eta and "74d 11h" once a weather-window
            // accept compounded the error through old/new diff math.
            const durationHrs = parseDurationToHours(plan.durationApprox) ?? 12;
            const entryTime = new Date(depDate.getTime() + fraction * durationHrs * 3600000);

            // Store the full bathymetric route geometry on the first
            // (Departure) entry's `notes` field so a future view of this
            // saved route can re-render the curved sea path, not just
            // the straight-line polyline between waypoints. The marker
            // prefix lets RoutesAndTracks.ts recognise + parse it back
            // out without a schema change. The Gemini human-readable
            // summary is preserved on the SECOND entry (or appended
            // after the marker on first) so the picker sublabel stays
            // useful.
            let firstNote: string | undefined;
            if (i === 0) {
                const summary = `Planned: ${plan.origin} → ${plan.destination}`;
                if (plan.routeGeoJSON?.geometry?.coordinates) {
                    firstNote =
                        ROUTE_GEOMETRY_NOTES_PREFIX +
                        JSON.stringify(plan.routeGeoJSON.geometry.coordinates) +
                        '\n' +
                        summary;
                } else {
                    firstNote = summary;
                }
            }

            entries.push({
                // ship_logs.id is a UUID column — Supabase rejects any
                // other format with "invalid input syntax for type uuid".
                // We were generating string IDs like
                // "planned_<ts>_<rand>_<i>" which got REJECTED on insert
                // and silently fell through to the offline queue. So
                // ship_logs in Supabase had nothing, the dropdown's
                // fetchRoutesAndTracks returned 0 routes, the active
                // passage dropdown was empty, and the user thought the
                // save just wasn't working. The voyageId field is text
                // (so the "planned_" prefix is fine for that — it's how
                // RoutesAndTracks distinguishes routes from tracks).
                id: crypto.randomUUID(),
                voyageId,
                timestamp: entryTime.toISOString(),
                latitude: pt.lat,
                longitude: pt.lon,
                positionFormatted: formatPositionDMS(pt.lat, pt.lon),
                distanceNM: Math.round(distNM * 100) / 100,
                cumulativeDistanceNM: Math.round(cumulativeNM * 100) / 100,
                courseDeg,
                entryType: pt.isWP ? 'waypoint' : 'auto',
                source: 'planned_route',
                waypointName: pt.name,
                notes: firstNote,
                isOnWater: true,
                createdAt: now,
            });
        }

        // Authenticate once before either remote write. The draft is created
        // first so its exact ID can be stamped into the initial ship-log
        // upsert as well as every possible offline replay.
        let savedOnline = false;
        let draftVoyageId: string | null = null;
        let draftVoyageName: string | null = null;
        if (supabase && operationScope.userId) {
            try {
                const user = await getCurrentUser();
                if (!isAuthIdentityScopeCurrent(operationScope)) return null;
                if (user) {
                    if (user.id !== operationScope.userId) return null;
                    const ownerId = operationScope.userId;
                    const departureName =
                        typeof plan.origin === 'string' ? trimCountrySuffix(plan.origin) : 'Departure';
                    const destinationName =
                        typeof plan.destination === 'string' ? trimCountrySuffix(plan.destination) : 'Arrival';
                    draftVoyageName = `${departureName} → ${destinationName}`;

                    try {
                        const { createVoyage } = await import('../VoyageService');
                        if (!isAuthIdentityScopeCurrent(operationScope)) return null;
                        const departureTimeIso = entries[0]?.timestamp ?? null;
                        const lastTs = entries[entries.length - 1]?.timestamp ?? null;
                        const etaIso =
                            departureTimeIso && lastTs && Date.parse(lastTs) > Date.parse(departureTimeIso)
                                ? lastTs
                                : null;
                        const { voyage: draft, error: draftError } = await createVoyage({
                            voyage_name: draftVoyageName,
                            departure_port: departureName,
                            destination_port: destinationName,
                            crew_count: 1,
                            departure_time: departureTimeIso,
                            eta: etaIso,
                        });
                        if (!isAuthIdentityScopeCurrent(operationScope)) return null;
                        if (draft) {
                            draftVoyageId = draft.id;
                            for (const entry of entries) entry.linkedPlanId = draft.id;
                        } else {
                            log.warn(`Auto-create voyage skipped: ${draftError}`);
                        }
                    } catch (draftError) {
                        if (!isAuthIdentityScopeCurrent(operationScope)) return null;
                        log.warn('Auto-create voyage from passage plan failed (non-critical):', draftError);
                    }

                    const dbEntries = entries.map((entry, index) => {
                        const row = toDbFormat({ ...entry, userId: ownerId });
                        row.client_operation_id = operationIds[index];
                        return row;
                    });
                    const { error } = await supabase.from(SHIP_LOGS_TABLE).upsert(dbEntries, {
                        onConflict: 'user_id,client_operation_id',
                    });
                    if (!isAuthIdentityScopeCurrent(operationScope)) return null;
                    if (error) {
                        log.warn('savePassagePlan: Supabase upsert failed, queuing offline:', error.message);
                    } else if (draftVoyageId) {
                        try {
                            const linkResult = await supabase
                                .from(SHIP_LOGS_TABLE)
                                .update({ linked_plan_id: draftVoyageId }, { count: 'exact' })
                                .eq('user_id', ownerId)
                                .eq('voyage_id', voyageId)
                                .in('client_operation_id', operationIds);
                            if (!isAuthIdentityScopeCurrent(operationScope)) return null;
                            if (linkResult.error || linkResult.count !== entries.length) {
                                log.warn(
                                    'savePassagePlan: exact linked-plan backfill was not confirmed, queuing idempotent replay',
                                );
                            } else {
                                savedOnline = true;
                            }
                        } catch (linkError) {
                            if (!isAuthIdentityScopeCurrent(operationScope)) return null;
                            log.warn(
                                'savePassagePlan: linked-plan backfill failed, queuing idempotent replay',
                                linkError,
                            );
                        }
                    } else {
                        savedOnline = true;
                    }
                } else {
                    log.warn('savePassagePlan: No authenticated user, queuing offline');
                }
            } catch (_networkError) {
                if (!isAuthIdentityScopeCurrent(operationScope)) return null;
                log.warn('savePassagePlan: Network error, queuing offline');
            }
        }

        if (!savedOnline) {
            try {
                await queuePassageBatch(entries, operationIds, voyageId, operationScope);
            } catch (queueError) {
                // If the draft was created before an offline/storage failure,
                // remove that exact owned row so the compensated route leaves
                // no orphan in Passage Planning.
                if (draftVoyageId && isAuthIdentityScopeCurrent(operationScope)) {
                    try {
                        const { deleteVoyageById } = await import('../VoyageService');
                        if (isAuthIdentityScopeCurrent(operationScope)) {
                            await deleteVoyageById(draftVoyageId);
                        }
                    } catch (rollbackError) {
                        if (isAuthIdentityScopeCurrent(operationScope)) {
                            log.error('savePassagePlan: draft rollback failed', rollbackError);
                        }
                    }
                }
                throw queueError;
            }
        }

        if (!isAuthIdentityScopeCurrent(operationScope)) return null;

        log.info(
            `✓ Saved planned route "${plan.origin} → ${plan.destination}" with ${entries.length} waypoints (${cumulativeNM.toFixed(1)} NM) [${savedOnline ? 'online' : 'offline'}]`,
        );

        // Drop the RoutesAndTracks 60s cache so the chart picker shows
        // this route immediately on next open. Without this the user
        // could save → swap to charts within 60s → not see their new
        // route → think the save failed.
        invalidateRoutesAndTracks(operationScope);

        // The draft was created before persistence so its immutable ID could
        // travel with the route. Activate it only after the complete route has
        // reached either Supabase or the durable queue.
        try {
            if (draftVoyageId) {
                const { setActivePassage } = await import('../PassagePlanService');
                if (!isAuthIdentityScopeCurrent(operationScope)) return null;
                setActivePassage(draftVoyageId);
                log.info(`✓ Auto-created draft voyage "${draftVoyageName}" from passage plan`);
            }
        } catch (e) {
            if (!isAuthIdentityScopeCurrent(operationScope)) return null;
            log.warn('Activate voyage from passage plan failed (non-critical):', e);
        }

        // Notify any open Passage Planning surfaces to refresh their
        // dropdown. Without this, a user already on the Passage Planning
        // page when the save lands won't see the new route in the
        // active-passage dropdown until they navigate away and back —
        // because the dropdown's load runs once on mount.
        try {
            if (!isAuthIdentityScopeCurrent(operationScope)) return null;
            if (typeof window !== 'undefined') {
                window.dispatchEvent(
                    new CustomEvent('thalassa:passage-plan-saved', {
                        detail: { voyageId },
                    }),
                );
            }
        } catch {
            /* non-critical */
        }

        return voyageId;
    } catch (err) {
        // Surface the duplicate sentinel so callers can show the
        // "already exists for that day" toast. Other errors get the
        // generic null-return + logged failure.
        if (err instanceof Error && err.message === DUPLICATE_PASSAGE_PLAN_ERROR) {
            throw err;
        }
        log.error('savePassagePlanToLogbook error:', err);
        return null;
    }
}
