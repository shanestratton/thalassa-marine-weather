/**
 * Fetch a saved route's waypoints from the account.
 *
 * WHY THIS EXISTS. The Route Tracer's library is localStorage — see
 * loadSavedTraces. So a route traced on the iPad is not on the phone, and a
 * route traced before a reinstall is not on the same phone afterwards. The Log
 * page's follow picker blocks such a route with "This route has no saved trace
 * on this device", and the fix it offers is to open Route Tracer, which reads
 * the very same store and therefore cannot open it either. A closed loop, and
 * the likeliest reason a punter finds a saved route simply unfollowable
 * (Shane, 2026-08-17: "when a punter wants to follow a route, it is just not
 * letting them").
 *
 * The waypoints were never actually lost — `saved_routes` has them. This is
 * the one honest way out of that loop.
 *
 * The decoder here is the STRICT one, deliberately. services/savedRoutesSync
 * filters malformed pairs out and carries on with whatever is left, which is
 * defensible for redrawing a list and indefensible for a line somebody steers:
 * a route quietly two waypoints shorter is a different route, and the two it
 * dropped are the ones that went round something.
 */
import { supabase, isSupabaseConfigured } from './supabase';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from './authIdentityScope';
import type { TracePoint } from './routeTracer';
import { createLogger } from '../utils/createLogger';

const log = createLogger('savedRoutePoints');

/** Trip-chain and mirror fields a second device needs to group legs under
 *  their passage and to publish the right planned mirror (2026-09-08). */
export interface SavedRouteFetchExtras {
    tripId?: string;
    legOrdinal?: number;
    destName?: string;
    plannedRouteId?: string;
    passageVoyageId?: string;
    updatedAt?: string;
}

export type SavedRouteFetch =
    | ({ ok: true; id: string; name: string; points: TracePoint[] } & SavedRouteFetchExtras)
    | { ok: false; reason: string };

export function savedRouteFetchExtras(row: Record<string, unknown>): SavedRouteFetchExtras {
    return {
        ...(typeof row.trip_id === 'string' && row.trip_id ? { tripId: row.trip_id } : {}),
        ...(typeof row.leg_ordinal === 'number' && Number.isInteger(row.leg_ordinal) && row.leg_ordinal > 0
            ? { legOrdinal: row.leg_ordinal }
            : {}),
        ...(typeof row.dest_name === 'string' && row.dest_name ? { destName: row.dest_name } : {}),
        ...(typeof row.planned_route_id === 'string' && row.planned_route_id
            ? { plannedRouteId: row.planned_route_id }
            : {}),
        ...(typeof row.passage_voyage_id === 'string' && row.passage_voyage_id
            ? { passageVoyageId: row.passage_voyage_id }
            : {}),
        ...(typeof row.updated_at === 'string' && row.updated_at ? { updatedAt: row.updated_at } : {}),
    };
}

/**
 * Decode a `saved_routes.points` value. Rejects the whole route if ANY pair is
 * malformed rather than silently returning a shorter one.
 */
export function decodeSavedRoutePoints(raw: unknown): TracePoint[] | null {
    if (!Array.isArray(raw)) return null;
    const points: TracePoint[] = [];
    for (const pair of raw) {
        if (
            !Array.isArray(pair) ||
            pair.length < 2 ||
            typeof pair[0] !== 'number' ||
            !Number.isFinite(pair[0]) ||
            typeof pair[1] !== 'number' ||
            !Number.isFinite(pair[1])
        ) {
            return null;
        }
        points.push({ lat: pair[0], lon: pair[1] });
    }
    return points.length >= 2 ? points : null;
}

export async function fetchSavedRoutePoints(savedRouteId: string): Promise<SavedRouteFetch> {
    const id = savedRouteId.trim();
    if (!id) return { ok: false, reason: 'This route has no saved-route link to fetch.' };

    const scope = getAuthIdentityScope();
    if (!isSupabaseConfigured() || !supabase || !scope.userId) {
        // Said plainly rather than as a generic failure: the waypoints exist,
        // they are simply not reachable from here, and the skipper can act on
        // that. A bare "couldn't load" invites retrying at anchor forever.
        return { ok: false, reason: 'Connect to fetch this route — its waypoints are not on this device.' };
    }

    try {
        const { data, error } = await supabase
            .from('saved_routes')
            .select(
                'id, name, points, deleted, trip_id, leg_ordinal, dest_name, planned_route_id, passage_voyage_id, updated_at',
            )
            .eq('id', id)
            .maybeSingle();

        if (!isAuthIdentityScopeCurrent(scope)) {
            return { ok: false, reason: 'Account changed while fetching this route.' };
        }
        if (error) {
            log.warn('saved_routes fetch failed:', error.message);
            return { ok: false, reason: 'Connect to fetch this route — its waypoints are not on this device.' };
        }
        if (!data || data.deleted === true) {
            return { ok: false, reason: 'This route has been deleted from your account.' };
        }

        const points = decodeSavedRoutePoints(data.points);
        if (!points) {
            return { ok: false, reason: 'This route’s waypoints are unreadable. Rebuild it in Route Tracer.' };
        }
        return {
            ok: true,
            id,
            name: typeof data.name === 'string' ? data.name : 'Saved route',
            points,
            ...savedRouteFetchExtras(data as Record<string, unknown>),
        };
    } catch (e) {
        log.warn('saved_routes fetch threw:', (e as Error)?.message || e);
        return { ok: false, reason: 'Connect to fetch this route — its waypoints are not on this device.' };
    }
}
