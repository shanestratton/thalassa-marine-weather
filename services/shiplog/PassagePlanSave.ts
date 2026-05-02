/**
 * Passage Plan Save — extracted from ShipLogService.
 *
 * Converts a VoyagePlan into ship log entries and saves them
 * to Supabase (or offline queue). Self-contained, no class dependency.
 */

import { supabase } from '../supabase';
import { ShipLogEntry } from '../../types';
import { calculateDistanceNM, calculateBearing, formatPositionDMS, toDbFormat, SHIP_LOGS_TABLE } from './helpers';
import { queueOfflineEntry } from './OfflineQueue';
import { fetchRoutesAndTracks, invalidateRoutesAndTracks } from './RoutesAndTracks';
import { createLogger } from '../../utils/logger';

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
    const parts = name.split(',').map((s) => s.trim());
    if (parts.length <= 2) return parts.filter(Boolean).join(', ');
    return parts.slice(0, -1).filter(Boolean).join(', ');
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

/**
 * Save a passage plan's route to the logbook as a "planned_route" voyage.
 * These entries show as suggested/uncharted tracks with restricted actions.
 */
export async function savePassagePlanToLogbook(plan: import('../../types').VoyagePlan): Promise<string | null> {
    try {
        // Diagnostic: log exactly what origin/destination are at save
        // time. If the saved logbook entry comes out as "Queensland →
        // South Province" instead of "Newport QLD → Port Moselle NC",
        // this line tells us whether the bad name arrived in the plan
        // or got built from something else further down. Uses .warn
        // because .info is silenced in production builds (createLogger).
        log.warn(`savePassagePlan input — origin="${plan.origin}", destination="${plan.destination}"`);

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
            // Re-throw the sentinel; swallow other errors (RoutesAndTracks
            // fetch failures shouldn't block save — duplicate check is a
            // helpful guard, not a hard requirement).
            if (e instanceof Error && e.message === DUPLICATE_PASSAGE_PLAN_ERROR) throw e;
            log.warn('savePassagePlan: duplicate check failed (non-fatal)', e);
        }

        const voyageId = `planned_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const now = new Date().toISOString();

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
            // Rough duration estimate: parse from plan or default 12h
            const durationHrs = parseFloat(plan.durationApprox) || 12;
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
                id: `${voyageId}_${i}`,
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

        // Try Supabase first, fall back to offline queue
        let savedOnline = false;
        if (supabase) {
            try {
                const {
                    data: { user },
                } = await supabase.auth.getUser();
                if (user) {
                    const dbEntries = entries.map((e) => toDbFormat({ ...e, userId: user.id }));
                    const { error } = await supabase.from(SHIP_LOGS_TABLE).insert(dbEntries);
                    if (error) {
                        log.warn('savePassagePlan: Supabase insert failed, queuing offline:', error.message);
                    } else {
                        savedOnline = true;
                    }
                } else {
                    log.warn('savePassagePlan: No authenticated user, queuing offline');
                }
            } catch (_networkError) {
                log.warn('savePassagePlan: Network error, queuing offline');
            }
        }

        // Fallback: queue all entries to offline queue
        if (!savedOnline) {
            for (const entry of entries) {
                await queueOfflineEntry(entry);
            }
        }

        log.info(
            `✓ Saved planned route "${plan.origin} → ${plan.destination}" with ${entries.length} waypoints (${cumulativeNM.toFixed(1)} NM) [${savedOnline ? 'online' : 'offline'}]`,
        );

        // Drop the RoutesAndTracks 60s cache so the chart picker shows
        // this route immediately on next open. Without this the user
        // could save → swap to charts within 60s → not see their new
        // route → think the save failed.
        invalidateRoutesAndTracks();

        // Fire-and-forget: auto-create a draft voyage from this passage plan
        // and activate it so the Passage Planning card appears
        try {
            const { createVoyage } = await import('../VoyageService');
            const departureName = typeof plan.origin === 'string' ? trimCountrySuffix(plan.origin) : 'Departure';
            const destinationName =
                typeof plan.destination === 'string' ? trimCountrySuffix(plan.destination) : 'Arrival';
            const voyageName = `${departureName} → ${destinationName}`;

            const { voyage: v, error: vErr } = await createVoyage({
                voyage_name: voyageName,
                departure_port: departureName,
                destination_port: destinationName,
                crew_count: 1,
            });
            if (v) {
                log.info(`✓ Auto-created draft voyage "${voyageName}" from passage plan`);
                // Activate using the Supabase voyage ID (not the logbook entry ID)
                const { setActivePassage } = await import('../PassagePlanService');
                setActivePassage(v.id);
            } else {
                log.warn(`Auto-create voyage skipped: ${vErr}`);
            }
        } catch (e) {
            log.warn('Auto-create voyage from passage plan failed (non-critical):', e);
        }

        // Notify any open Passage Planning surfaces to refresh their
        // dropdown. Without this, a user already on the Passage Planning
        // page when the save lands won't see the new route in the
        // active-passage dropdown until they navigate away and back —
        // because the dropdown's load runs once on mount.
        try {
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
