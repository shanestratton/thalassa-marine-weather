/**
 * Passage overlay — the current followed geometry and the active voyage's
 * sailed track. The followed plan is independent of the recording voyage:
 * Log can follow a saved route before Cast Off, and its id names that saved
 * route rather than the recording's UUID.
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { createLogger } from '../../../utils/createLogger';
import { useHudRecording } from '../../../hooks/useHudRecording';
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
    hasRecording: boolean;
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
    // The recorder owns the actual trail. A cached named passage can be absent
    // for casual recording, or refer to a completely different voyage.
    const recording = useHudRecording();
    const hasRecording = Boolean(recording.currentVoyageId && (recording.isTracking || recording.isPaused));
    const activeVoyageMode = hasRecording && recording.isTracking && !recording.isPaused;
    const activeVoyageId = hasRecording ? recording.currentVoyageId! : null;
    const [identityScope, setIdentityScope] = useState(getAuthIdentityScope);
    useEffect(() => {
        const sync = () => {
            setIdentityScope(getAuthIdentityScope());
        };
        const unsubscribeIdentity = subscribeAuthIdentityScope(sync);
        sync();
        return () => {
            unsubscribeIdentity();
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
        if (next) setActiveChartTrack(null);
    }, [overlayEnabled, followedRoute, identityScope, setActiveChartRoute, setActiveChartTrack]);

    const autoTrackRef = useRef<RouteOrTrack | null>(null);
    // One chart selection at a time: the followed plan takes precedence;
    // casual recording without a followed route shows the sailed track.
    const showRecordedTrack = overlayEnabled && !followedRoute;
    useEffect(() => {
        const previous = autoTrackRef.current;
        autoTrackRef.current = null;
        setActiveChartTrack((current) => (current === previous ? null : current));
        if (!showRecordedTrack || !activeVoyageId) return;
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
                setActiveChartRoute(null);
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
    }, [showRecordedTrack, activeVoyageId, identityScope, setActiveChartTrack, setActiveChartRoute]);

    return { activeVoyageMode, activeVoyageId, activeVoyageName: null, hasRecording };
}
