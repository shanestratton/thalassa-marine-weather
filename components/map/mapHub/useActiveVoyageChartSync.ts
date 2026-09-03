/**
 * Active Voyage Mode — the voyages-cache mirror and the chart's auto-selection
 * of the active voyage's planned route and sailed track.
 *
 * Lifted out of MapHub.tsx verbatim during the MapHub break-up. The three
 * state slots, the cache-mirror effect and the route/track auto-select effect
 * were already contiguous in the body (only the derived
 * `effectiveVesselTrackingVisible` const sat between the two effects, and a
 * plain const is not a hook), so the hook keeps MapHub's hook order exactly as
 * it was.
 *
 * The logger name stays 'MapHub' verbatim so the device lines this writes are
 * unchanged.
 */
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { createLogger } from '../../../utils/createLogger';
import { getCachedActiveVoyage } from '../../../services/VoyageService';
import { subscribeAuthIdentityScope } from '../../../services/authIdentityScope';
import type { RouteOrTrack } from '../../../services/shiplog/RoutesAndTracks';

const log = createLogger('MapHub');

export interface ActiveVoyageChartSync {
    activeVoyageMode: boolean;
    activeVoyageId: string | null;
    activeVoyageName: string | null;
}

export function useActiveVoyageChartSync(
    setActiveChartRoute: Dispatch<SetStateAction<RouteOrTrack | null>>,
    setActiveChartTrack: Dispatch<SetStateAction<RouteOrTrack | null>>,
): ActiveVoyageChartSync {
    /** Active Voyage Mode flag — mirrored from the voyages cache. When
     *  true, the chart auto-displays the boat's GPS position, the live
     *  voyage track, and the planned route, regardless of which weather
     *  layer is on. Listens for `thalassa:active-voyage-changed` so the
     *  flag flips the moment Cast Off / End Voyage runs. */
    const initialActiveVoyage = useMemo(() => getCachedActiveVoyage(), []);
    const [activeVoyageMode, setActiveVoyageMode] = useState<boolean>(initialActiveVoyage?.status === 'active');
    const [activeVoyageId, setActiveVoyageId] = useState<string | null>(
        initialActiveVoyage?.status === 'active' ? initialActiveVoyage.id : null,
    );
    const [activeVoyageName, setActiveVoyageName] = useState<string | null>(
        initialActiveVoyage?.status === 'active' ? initialActiveVoyage.voyage_name : null,
    );
    useEffect(() => {
        const sync = () => {
            const activeVoyage = getCachedActiveVoyage();
            const isActive = activeVoyage?.status === 'active';
            setActiveVoyageMode(isActive);
            setActiveVoyageId(isActive ? activeVoyage.id : null);
            setActiveVoyageName(isActive ? activeVoyage.voyage_name : null);
        };
        const unsubscribeIdentity = subscribeAuthIdentityScope(sync);
        window.addEventListener('thalassa:active-voyage-changed', sync);
        return () => {
            unsubscribeIdentity();
            window.removeEventListener('thalassa:active-voyage-changed', sync);
        };
    }, []);

    /** Auto-select the active voyage's planned route + sailed track on
     *  the chart so the skipper sees "I am here, I came from there, I'm
     *  heading there" from one glance — no manual route/track picking
     *  required while underway. Match planned route by normalised name
     *  (matches the same scheme CrewManagement uses); match track by
     *  voyage.id (ShipLogService.startTracking seeds entries.voyageId
     *  with the voyages-table UUID at Cast Off time). */
    useEffect(() => {
        if (!activeVoyageMode || !activeVoyageId) return;
        let cancelled = false;
        // FULL fetch — matches the planned route by name (routes need the
        // whole list) AND seeds the sailed track. Runs on mount and when a
        // save/delete fires the change event; NOT on the 60s tick (the plan
        // is fixed for the voyage, so re-listing every route every minute
        // was pure waste — audit rank 7).
        const syncRouteAndTrack = async () => {
            try {
                const { fetchRoutesAndTracks } = await import('../../../services/shiplog/RoutesAndTracks');
                const { routes, tracks } = await fetchRoutesAndTracks(true);
                if (cancelled) return;
                const norm = (s: string) => s.trim().toLowerCase();
                if (activeVoyageName) {
                    const wantLabel = norm(activeVoyageName);
                    const matchedRoute = routes.find((r) => norm(r.label) === wantLabel) ?? null;
                    if (matchedRoute) setActiveChartRoute((cur) => (cur?.id === matchedRoute.id ? cur : matchedRoute));
                }
                const matchedTrack = tracks.find((t) => t.id === activeVoyageId) ?? null;
                if (matchedTrack) {
                    setActiveChartTrack((cur) =>
                        cur?.id === matchedTrack.id && cur.points.length === matchedTrack.points.length
                            ? cur
                            : matchedTrack,
                    );
                }
            } catch (e) {
                log.warn('Active voyage auto-select failed:', e);
            }
        };
        // INCREMENTAL trail refresh — fetches ONLY the active voyage's
        // entries (bounded by that one passage), not the whole log. Replaces
        // the rendered track only when it actually GREW (point count changed),
        // so the trail genuinely extends AND unchanged ticks cost no re-render.
        const refreshTrail = async () => {
            try {
                const { fetchVoyageAsTrack } = await import('../../../services/shiplog/RoutesAndTracks');
                const track = await fetchVoyageAsTrack(activeVoyageId);
                if (cancelled || !track) return;
                setActiveChartTrack((cur) =>
                    cur?.id === track.id && cur.points.length === track.points.length ? cur : track,
                );
            } catch (e) {
                log.warn('Active voyage trail refresh failed:', e);
            }
        };
        void syncRouteAndTrack();

        const onRefresh = () => void syncRouteAndTrack();
        window.addEventListener('thalassa:routes-and-tracks-changed', onRefresh);
        // Extend the trail as new GPS points come in — one voyage's fetch,
        // not the career's.
        const t = setInterval(() => void refreshTrail(), 60_000);
        return () => {
            cancelled = true;
            window.removeEventListener('thalassa:routes-and-tracks-changed', onRefresh);
            clearInterval(t);
        };
    }, [activeVoyageMode, activeVoyageId, activeVoyageName, setActiveChartRoute, setActiveChartTrack]);

    return { activeVoyageMode, activeVoyageId, activeVoyageName };
}
