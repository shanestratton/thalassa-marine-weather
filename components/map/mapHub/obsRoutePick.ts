/**
 * Pulling a route up on Obs, and what the passage HUD makes of it (build 124).
 *
 * Shane, 2026-10-08: "the HUD is not working on the obs page when you pull up a
 * route????". It never had: a route picked in Layers → Routes only drew its
 * line, and the pick switched the Passage overlay off — even when it was the
 * route being followed, which left the strip running with no ghost, waypoints
 * or framing under it.
 *
 * ONE RULE: the HUD follows the route on screen.
 *   - Picking the FOLLOWED route keeps the Passage overlay; the HUD is the
 *     followed route's, live.
 *   - Picking any other route turns the overlay off, as it always did, and the
 *     HUD PREVIEWS that route until it is cleared or replaced: labelled, from its
 *     first point, at a departure the skipper chooses. Clear it and the followed
 *     route's live strip (or the recording's) is back.
 *   - Picking the running recording's own track keeps the overlay while no
 *     route is followed (the overlay is drawing that track); any other track,
 *     or any track while a route is followed, turns it off. A sailed track is
 *     never previewed: nothing lies ahead on it (the chart key says so).
 * Pulling a route up opens the HUD's readings. Nothing here follows anything:
 * no startFollowing, no plan-link rows, no destination flag, no 24 h drop.
 */
import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import type { RouteOrTrack } from '../../../services/shiplog/RoutesAndTracks';
import type { RoutePoint } from '../../../services/routeProgress';
import { useFollowRouteStore } from '../../../stores/followRouteStore';
import { sanitizeRouteCoordinates } from '../../../utils/routeCoordinates';
import { setPassageOverlay } from '../../../stores/chartPassageOverlay';
import {
    setPassageHudOpen,
    setPassageHudPreviewRoute,
    usePassageHudPreviewRoute,
} from '../../../stores/passageHudStore';

export interface FollowedRouteRef {
    isFollowing: boolean;
    voyageId: string | null;
    routeCoords: readonly RoutePoint[];
}

type RouteSetter = Dispatch<SetStateAction<RouteOrTrack | null>> | ((item: RouteOrTrack | null) => void);

/** ~1 m: the same line, not a neighbouring one. */
const SAME_POINT_DEG = 1e-5;

function sameLine(a: readonly RoutePoint[], b: readonly RoutePoint[]): boolean {
    return (
        a.length >= 2 &&
        a.length === b.length &&
        a.every((p, i) => Math.abs(p.lat - b[i].lat) <= SAME_POINT_DEG && Math.abs(p.lon - b[i].lon) <= SAME_POINT_DEG)
    );
}

/**
 * The picked route IS the one being followed: the same saved/logbook id, or
 * the very same line point for point. A name is not enough — two routes can
 * share one, and the follow store keeps the exact line, not the label. The
 * store keeps it SANITISED (startFollowing: no repeated vertex, no 0,0), while
 * the picker hands over the saved trace's raw points, so the pick is compared
 * as the store would keep it.
 */
export function isFollowedRoutePick(item: Pick<RouteOrTrack, 'id' | 'points'>, followed: FollowedRouteRef): boolean {
    if (!followed.isFollowing || followed.routeCoords.length < 2) return false;
    if (followed.voyageId && item.id === followed.voyageId) return true;
    return sameLine(sanitizeRouteCoordinates(item.points), followed.routeCoords);
}

/** Layers → Routes: a saved route picked, or None. */
export function pickObsRoute(
    item: RouteOrTrack | null,
    set: { setActiveChartRoute: RouteSetter; setActiveChartTrack: RouteSetter; setPickedRoute: RouteSetter },
): void {
    set.setActiveChartRoute(item);
    set.setPickedRoute(item);
    if (!item) {
        setPassageOverlay(false);
        return;
    }
    set.setActiveChartTrack(null);
    // A manual choice owns the chart: the background passage refresh must not
    // re-add the other line — unless the choice IS the followed route, whose
    // overlay is the same passage.
    if (!isFollowedRoutePick(item, useFollowRouteStore.getState())) setPassageOverlay(false);
    // Pulling a route up is asking to see it on the HUD.
    setPassageHudOpen(true);
}

/**
 * Layers → Tracks: a sailed track picked, or None. Never a preview. The
 * overlay stays on only when it is drawing THIS track: the running
 * recording's, with no route followed. With a route followed the overlay
 * draws the route instead (useActiveVoyageChartSync), and its whole-route
 * overview would pull the camera off the track the skipper asked to see.
 */
export function pickObsTrack(
    item: RouteOrTrack | null,
    set: {
        setActiveChartRoute: RouteSetter;
        setActiveChartTrack: RouteSetter;
        setPickedRoute: RouteSetter;
        /** The recording running or paused, whose track the Passage overlay draws. */
        activeVoyageId: string | null;
    },
): void {
    set.setActiveChartTrack(item);
    if (item) {
        set.setActiveChartRoute(null);
        set.setPickedRoute(null);
    }
    const { isFollowing, routeCoords } = useFollowRouteStore.getState();
    const overlayDrawsThisTrack =
        !!item && !!set.activeVoyageId && item.id === set.activeVoyageId && !(isFollowing && routeCoords.length >= 2);
    if (!overlayDrawsThisTrack) setPassageOverlay(false);
}

/**
 * The route the HUD previews: the one picked from Layers → Routes while it is
 * still the line on screen, and not the followed route. Published to the HUD
 * store by the chart that owns the HUD only — an embedded or pin-view chart
 * (`publishes` false) never touches it — and cleared when that chart goes.
 * Returns the preview only while the HUD store holds it, so the chart and the
 * strip agree: an account change clears the store, and with it the chart's
 * idea that a preview is up (the previous owner's pick is not re-published).
 */
export function useObsRoutePreview(args: {
    activeChartRoute: RouteOrTrack | null;
    pickedRoute: RouteOrTrack | null;
    /** This chart owns the HUD (not embedded, not a pin view). */
    publishes: boolean;
    /** The HUD may show here now (not a location picker). */
    allowed: boolean;
}): RouteOrTrack | null {
    const isFollowing = useFollowRouteStore((s) => s.isFollowing);
    const voyageId = useFollowRouteStore((s) => s.voyageId);
    const routeCoords = useFollowRouteStore((s) => s.routeCoords);
    const { activeChartRoute, pickedRoute, publishes, allowed } = args;
    // MapHub renders often; the line comparison runs only when its inputs change.
    const preview = useMemo(
        () =>
            publishes &&
            allowed &&
            pickedRoute !== null &&
            activeChartRoute === pickedRoute &&
            pickedRoute.points.length >= 2 &&
            !isFollowedRoutePick(pickedRoute, { isFollowing, voyageId, routeCoords })
                ? pickedRoute
                : null,
        [publishes, allowed, pickedRoute, activeChartRoute, isFollowing, voyageId, routeCoords],
    );
    useEffect(() => {
        if (!publishes) return;
        setPassageHudPreviewRoute(preview ? { id: preview.id, label: preview.label, points: preview.points } : null);
    }, [publishes, preview]);
    useEffect(() => {
        if (!publishes) return;
        return () => setPassageHudPreviewRoute(null);
    }, [publishes]);
    const published = usePassageHudPreviewRoute();
    return preview && published && published.id === preview.id && published.points === preview.points ? preview : null;
}
