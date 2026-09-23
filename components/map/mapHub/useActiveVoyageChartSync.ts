/**
 * Passage overlay — the current followed geometry and the active voyage's
 * sailed track. The followed plan is independent of the recording voyage:
 * Log can follow a saved route before Cast Off, and its id names that saved
 * route rather than the recording's UUID.
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createLogger } from '../../../utils/createLogger';
import { getCachedActiveVoyage } from '../../../services/VoyageService';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
} from '../../../services/authIdentityScope';
import type { RouteOrTrack } from '../../../services/shiplog/RoutesAndTracks';
import { useFollowRouteStore } from '../../../stores/followRouteStore';
import { calculateDistance } from '../../../utils/navigationCalculations';

const log = createLogger('MapHub');

export interface ActiveVoyageChartSync {
    activeVoyageMode: boolean;
    activeVoyageId: string | null;
    activeVoyageName: string | null;
}

export function useActiveVoyageChartSync(
    setActiveChartRoute: Dispatch<SetStateAction<RouteOrTrack | null>>,
    setActiveChartTrack: Dispatch<SetStateAction<RouteOrTrack | null>>,
    /**
     * The chart's opt-in "Passage" overlay switch. Disabling it removes only
     * this hook's selections, preserving independently picked routes/tracks.
     */
    overlayEnabled = true,
): ActiveVoyageChartSync {
    /** Mirror recording state for the vessel marker and sailed track.
     *  Cast Off / End Voyage publishes this event immediately. The followed
     *  route below has its own lifecycle and does not require a recording. */
    const initialActiveVoyage = useMemo(() => getCachedActiveVoyage(), []);
    const [activeVoyageMode, setActiveVoyageMode] = useState<boolean>(initialActiveVoyage?.status === 'active');
    const [activeVoyageId, setActiveVoyageId] = useState<string | null>(
        initialActiveVoyage?.status === 'active' ? initialActiveVoyage.id : null,
    );
    const [activeVoyageName, setActiveVoyageName] = useState<string | null>(
        initialActiveVoyage?.status === 'active' ? initialActiveVoyage.voyage_name : null,
    );
    const [identityScope, setIdentityScope] = useState(getAuthIdentityScope);
    useEffect(() => {
        const sync = () => {
            setIdentityScope(getAuthIdentityScope());
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

    const isFollowing = useFollowRouteStore((state) => state.isFollowing);
    const voyagePlan = useFollowRouteStore((state) => state.voyagePlan);
    const routeCoords = useFollowRouteStore((state) => state.routeCoords);
    const followedRouteId = useFollowRouteStore((state) => state.voyageId);
    const followStartedAt = useFollowRouteStore((state) => state.startedAt);
    const followedRoute = useMemo<RouteOrTrack | null>(() => {
        if (!isFollowing || !voyagePlan || routeCoords.length < 2) return null;
        // The store sanitizes and locks the line selected in Log. Keep that
        // exact array, including its direction and every intermediate bend;
        // neither names nor sparse plan waypoints can identify this geometry.
        const bbox: RouteOrTrack['bbox'] = [Infinity, Infinity, -Infinity, -Infinity];
        let distanceNm = 0;
        routeCoords.forEach((point, index) => {
            bbox[0] = Math.min(bbox[0], point.lon);
            bbox[1] = Math.min(bbox[1], point.lat);
            bbox[2] = Math.max(bbox[2], point.lon);
            bbox[3] = Math.max(bbox[3], point.lat);
            if (index > 0) {
                const previous = routeCoords[index - 1];
                distanceNm += calculateDistance(previous.lat, previous.lon, point.lat, point.lon);
            }
        });
        const timestamp = Date.parse(followStartedAt ?? '');
        return {
            id: followedRouteId || 'current-followed-route',
            label: `${voyagePlan.origin} → ${voyagePlan.destination}`,
            sublabel: 'Current followed route',
            points: routeCoords,
            bbox,
            timestamp: Number.isFinite(timestamp) ? timestamp : 0,
            distanceNm,
            isLocal: true,
            kind: 'sea',
        };
    }, [isFollowing, voyagePlan, routeCoords, followedRouteId, followStartedAt]);

    // Object ownership, not id equality: a manual picker result may have the
    // same saved-route id, but switching the overlay off must not erase it.
    const autoRouteRef = useRef<RouteOrTrack | null>(null);
    useEffect(() => {
        const previous = autoRouteRef.current;
        const next = overlayEnabled ? followedRoute : null;
        autoRouteRef.current = next;
        setActiveChartRoute((current) => next ?? (current === previous ? null : current));
    }, [overlayEnabled, followedRoute, identityScope, setActiveChartRoute]);

    const autoTrackRef = useRef<RouteOrTrack | null>(null);
    useEffect(() => {
        const previous = autoTrackRef.current;
        autoTrackRef.current = null;
        setActiveChartTrack((current) => (current === previous ? null : current));
        if (!overlayEnabled || !activeVoyageMode || !activeVoyageId) return;
        let cancelled = false;
        let requestGeneration = 0;
        // Only the sailed track needs a fetch. Keep it bounded to the active
        // recording, both initially and on the minute refresh/change event.
        const refreshTrail = async () => {
            const request = ++requestGeneration;
            const isCurrent = () =>
                !cancelled && request === requestGeneration && isAuthIdentityScopeCurrent(identityScope);
            try {
                const { fetchVoyageAsTrack } = await import('../../../services/shiplog/RoutesAndTracks');
                if (!isCurrent()) return;
                const track = await fetchVoyageAsTrack(activeVoyageId);
                // A temporarily unavailable trail must not erase the fixes
                // already shown. Voyage/identity/overlay changes clear their
                // owned selection synchronously at the start of this effect.
                if (!isCurrent() || !track) return;
                const previousTrack = autoTrackRef.current;
                const next =
                    previousTrack?.id === track.id &&
                    previousTrack.points.length === track.points.length &&
                    previousTrack.points.every(
                        (point, index) =>
                            point.lat === track.points[index].lat && point.lon === track.points[index].lon,
                    )
                        ? previousTrack
                        : track;
                autoTrackRef.current = next;
                setActiveChartTrack(next);
            } catch (e) {
                log.warn('Active voyage trail refresh failed:', e);
            }
        };
        void refreshTrail();

        const onRefresh = () => void refreshTrail();
        window.addEventListener('thalassa:routes-and-tracks-changed', onRefresh);
        // Extend the trail as new GPS points come in — one voyage's fetch,
        // not the career's.
        const t = setInterval(() => void refreshTrail(), 60_000);
        return () => {
            cancelled = true;
            window.removeEventListener('thalassa:routes-and-tracks-changed', onRefresh);
            clearInterval(t);
        };
    }, [overlayEnabled, activeVoyageMode, activeVoyageId, identityScope, setActiveChartTrack]);

    return { activeVoyageMode, activeVoyageId, activeVoyageName };
}
