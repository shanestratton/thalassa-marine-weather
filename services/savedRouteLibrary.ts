/**
 * Saved-route library compatibility model.
 *
 * `SavedTrace` rows in `saved_routes` are the canonical, editable route
 * records. Older builds also mirrored a planned route into `ship_logs`; those
 * mirrors used to be visible only on the Log page. Keep them available from
 * Plan as a best-effort compatibility fallback without turning the Log back
 * into a mixture of intentions and sailed history.
 *
 * The logbook fallback is intentionally not described as exhaustive:
 * `fetchRoutesAndTracks()` reads the newest ship-log window. Canonical saved
 * routes remain the durable source of truth.
 */

import type { AuthIdentityScope } from './authIdentityScope';
import { isAuthIdentityScopeCurrent } from './authIdentityScope';
import type { SavedTrace, TracePoint } from './routeTracer';
import type { RouteOrTrack } from './shiplog/RoutesAndTracks';
import { withTimeout } from '../utils/deadline';

const FINGERPRINT_SCALE = 100_000; // ~1.1 m latitude; absorbs storage float noise.
const CANONICAL_SYNC_DEADLINE_MS = 9_000;
const LEGACY_LIBRARY_DEADLINE_MS = 9_000;
const LOGBOOK_ROUTE_LOAD_DEADLINE_MS = 12_000;

export type SavedRouteLibraryItem =
    | {
          source: 'saved-trace';
          key: string;
          routeId: string;
          label: string;
          points: TracePoint[];
          timestamp: number;
      }
    | {
          source: 'logbook-route';
          key: string;
          voyageId: string;
          label: string;
          sublabel: string;
          points: TracePoint[];
          timestamp: number;
          isLocal: boolean;
          /** Canonical trace this legacy-looking row mirrors, when known. */
          savedRouteId?: string;
      };

function finiteCoordinate(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Direction-sensitive geometry identity used only for mirror de-duplication.
 *
 * Coordinates are quantised to metre scale so JSON/cloud round-trip noise
 * cannot create two rows. Consecutive duplicate vertices are ignored, while
 * every genuine bend and travel direction remains significant. Returning null
 * for malformed/degenerate geometry keeps unsafe rows out of the library.
 */
export function savedRouteGeometryFingerprint(points: readonly TracePoint[]): string | null {
    const encoded: string[] = [];
    let previous = '';

    for (const point of points) {
        if (!point || !finiteCoordinate(point.lat, -90, 90) || !finiteCoordinate(point.lon, -180, 180)) {
            return null;
        }
        const lat = Math.round(point.lat * FINGERPRINT_SCALE);
        const lon = Math.round(point.lon * FINGERPRINT_SCALE);
        const vertex = `${lat},${lon}`;
        if (vertex === previous) continue;
        encoded.push(vertex);
        previous = vertex;
    }

    if (encoded.length < 2) return null;
    return `${encoded.length}:${encoded.join('|')}`;
}

function timestampOf(trace: SavedTrace): number {
    const parsed = new Date(trace.updatedAt ?? trace.createdAt).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function validPoints(points: readonly TracePoint[]): TracePoint[] | null {
    return savedRouteGeometryFingerprint(points) ? points.map((point) => ({ lat: point.lat, lon: point.lon })) : null;
}

/**
 * Merge canonical routes with planned-log compatibility rows.
 *
 * Canonical rows always win a geometry collision. Distinct canonical rows are
 * preserved because two deliberately named routes may share a line; repeated
 * legacy mirrors collapse to their newest copy.
 */
export function mergeSavedRouteLibrary(
    canonical: readonly SavedTrace[],
    legacyRoutes: readonly RouteOrTrack[],
): SavedRouteLibraryItem[] {
    const canonicalFingerprints = new Set<string>();
    const canonicalIds = new Set(canonical.map((trace) => trace.id));
    const items: SavedRouteLibraryItem[] = [];

    for (const trace of canonical) {
        const fingerprint = savedRouteGeometryFingerprint(trace.points);
        const points = validPoints(trace.points);
        if (!fingerprint || !points) continue;
        canonicalFingerprints.add(fingerprint);
        items.push({
            source: 'saved-trace',
            key: `saved:${trace.id}`,
            routeId: trace.id,
            label: trace.name,
            points,
            timestamp: timestampOf(trace),
        });
    }

    const legacyFingerprints = new Set<string>();
    const newestLegacyFirst = [...legacyRoutes].sort((left, right) => right.timestamp - left.timestamp);
    for (const route of newestLegacyFirst) {
        // A planned-log route carrying a canonical id is a mirror, not an
        // independent saved route. If its trace was deleted/tombstoned, do
        // not let the older compatibility store resurrect it in Plan.
        if (route.savedRouteId && !canonicalIds.has(route.savedRouteId)) continue;
        const fingerprint = savedRouteGeometryFingerprint(route.points);
        const points = validPoints(route.points);
        if (!fingerprint || !points || canonicalFingerprints.has(fingerprint) || legacyFingerprints.has(fingerprint)) {
            continue;
        }
        legacyFingerprints.add(fingerprint);
        items.push({
            source: 'logbook-route',
            key: `logbook:${route.id}`,
            voyageId: route.id,
            label: route.label,
            sublabel: route.sublabel,
            points,
            timestamp: Number.isFinite(route.timestamp) ? route.timestamp : 0,
            isLocal: route.isLocal,
            ...(route.savedRouteId ? { savedRouteId: route.savedRouteId } : {}),
        });
    }

    return items.sort((left, right) => right.timestamp - left.timestamp);
}

/**
 * Identity-fenced Plan-library loader. A legacy fetch failure must never hide
 * the canonical offline routes already on this device.
 */
export async function loadSavedRouteLibrary(
    expectedScope: AuthIdentityScope,
    onCanonical?: (routes: SavedRouteLibraryItem[]) => void,
): Promise<SavedRouteLibraryItem[]> {
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];

    const { loadSavedTraces } = await import('./routeTracer');
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];

    const canonical = loadSavedTraces(expectedScope);
    onCanonical?.(mergeSavedRouteLibrary(canonical, []));

    // Start the durable account sync and compatibility discovery in parallel,
    // only after local rows have painted. A skipper opening Plan directly on a
    // second device must see saved_routes rows without first visiting Vessel;
    // neither network path may hold the offline library hostage.
    const syncedCanonicalPromise = withTimeout(
        import('./savedRoutesSync')
            .then(({ syncSavedRoutes }) => (isAuthIdentityScopeCurrent(expectedScope) ? syncSavedRoutes() : canonical))
            .catch(() => canonical),
        canonical,
        CANONICAL_SYNC_DEADLINE_MS,
    );
    const legacyPromise = withTimeout(
        import('./shiplog/RoutesAndTracks')
            .then(({ fetchRoutesAndTracks }) =>
                isAuthIdentityScopeCurrent(expectedScope)
                    ? fetchRoutesAndTracks()
                    : { routes: [] as RouteOrTrack[], tracks: [] as RouteOrTrack[] },
            )
            .catch(() => ({ routes: [] as RouteOrTrack[], tracks: [] as RouteOrTrack[] })),
        { routes: [] as RouteOrTrack[], tracks: [] as RouteOrTrack[] },
        LEGACY_LIBRARY_DEADLINE_MS,
    );

    const syncedCanonical = await syncedCanonicalPromise;
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];
    onCanonical?.(mergeSavedRouteLibrary(syncedCanonical, []));

    const legacy = (await legacyPromise).routes;
    if (!isAuthIdentityScopeCurrent(expectedScope)) return [];

    return mergeSavedRouteLibrary(syncedCanonical, legacy);
}

export interface EditableLogbookRoute {
    readonly voyageId: string;
    readonly name: string;
    readonly points: TracePoint[];
}

/**
 * Remove one compatibility-only planned route and, when it carries the exact
 * linked planning UUID, remove that draft too. This is deliberately *not* a
 * name/day cascade: an active passage is never touched, while the Saved
 * Routes selector cannot retain a logbook-deleted planning ghost.
 */
export async function deleteLogbookRouteFromLibrary(
    voyageId: string,
    expectedScope: AuthIdentityScope,
): Promise<boolean> {
    const targetVoyageId = voyageId.trim();
    if (!targetVoyageId.startsWith('planned_') || !isAuthIdentityScopeCurrent(expectedScope)) return false;

    try {
        const [{ deleteVoyageLogOnly }, { fetchVoyageAsTrack }] = await Promise.all([
            import('./shiplog/EntryCrud'),
            import('./shiplog/RoutesAndTracks'),
        ]);
        if (!isAuthIdentityScopeCurrent(expectedScope)) return false;
        const route = await fetchVoyageAsTrack(targetVoyageId).catch(() => null);
        if (!isAuthIdentityScopeCurrent(expectedScope)) return false;
        const deleted = await deleteVoyageLogOnly(targetVoyageId);
        if (!deleted || !isAuthIdentityScopeCurrent(expectedScope)) return false;
        if (route?.linkedPlanId) {
            const { deleteDraftVoyageById } = await import('./VoyageService');
            if (!isAuthIdentityScopeCurrent(expectedScope)) return false;
            await deleteDraftVoyageById(route.linkedPlanId);
        }
        return isAuthIdentityScopeCurrent(expectedScope);
    } catch {
        return false;
    }
}

/**
 * Resolve a legacy library row to its exact stored route geometry. This uses
 * the per-voyage fetch rather than the picker snapshot, then checks the auth
 * generation again before releasing private geometry to MapHub.
 */
export async function loadLogbookRouteForEditing(
    voyageId: string,
    expectedScope: AuthIdentityScope,
): Promise<EditableLogbookRoute | null> {
    const targetVoyageId = voyageId.trim();
    if (!targetVoyageId || !isAuthIdentityScopeCurrent(expectedScope)) return null;

    try {
        const { fetchVoyageAsTrack } = await import('./shiplog/RoutesAndTracks');
        if (!isAuthIdentityScopeCurrent(expectedScope)) return null;
        // Native Capacitor networking may ignore AbortSignal. Keep a stalled
        // marine-LTE request from leaving the tracer stuck on “Loading…” for
        // the platform's multi-minute default timeout; the underlying request
        // may still warm the cache for a retry.
        const route = await withTimeout(fetchVoyageAsTrack(targetVoyageId), null, LOGBOOK_ROUTE_LOAD_DEADLINE_MS).catch(
            () => null,
        );
        if (!isAuthIdentityScopeCurrent(expectedScope) || !route || route.id !== targetVoyageId) return null;

        const points = validPoints(route.points);
        if (!points) return null;
        return {
            voyageId: targetVoyageId,
            name: route.label,
            points,
        };
    } catch {
        return null;
    }
}
