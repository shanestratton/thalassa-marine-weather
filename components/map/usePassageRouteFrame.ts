import { useCallback, useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { GpsService, type GpsPosition } from '../../services/GpsService';
import { NmeaStore } from '../../services/NmeaStore';
import { LocationStore } from '../../stores/LocationStore';
import { resolveOwnshipPosition } from '../../services/ownshipPosition';
import {
    passageFrameGeometry,
    passageFrameIsVisible,
    passageFramePadding,
    validFramePoint,
    type FramePoint,
} from './passageRouteFrame';
import { chartFitBearing } from './chartOrientation';

const PHONE_MAX_AGE_MS = 10 * 60_000;

interface Args {
    mapRef: React.MutableRefObject<mapboxgl.Map | null>;
    mapReady: boolean;
    /** Main OBS + followed route + HUD, never planner/picker/storm/MOB. */
    enabled: boolean;
    route: readonly FramePoint[];
    /** A new followed voyage resumes overview even if it has identical geometry. */
    routeKey?: string | null;
    /** HUD expansion/look-ahead changes can be signalled before ResizeObserver. */
    layoutKey?: string | number | boolean;
}

/**
 * Whole passage and ownship stay framed until the skipper deliberately inspects
 * the chart. A user gesture pauses this policy; programmatic camera changes do
 * not. Resume is explicit, with no timer that snatches the map mid-inspection.
 */
export function usePassageRouteFrame({ mapRef, mapReady, enabled, route, routeKey, layoutKey }: Args) {
    const [overviewLocked, setOverviewLocked] = useState(true);
    const locked = useRef(true);
    const update = useRef<((force?: boolean) => void) | null>(null);
    const routeRef = useRef(route);
    routeRef.current = route;

    const resumeOverview = useCallback(() => {
        locked.current = true;
        setOverviewLocked(true);
        update.current?.(true);
    }, []);
    const pauseOverview = useCallback(() => {
        locked.current = false;
        setOverviewLocked(false);
    }, []);

    useEffect(() => {
        const map = mapRef.current;
        if (!enabled || !mapReady || !map || route.length < 2) return;
        const container = map.getContainer();
        let disposed = false;
        let frame: ReturnType<typeof setTimeout> | null = null;
        let forcePending = false;
        let fitting = false;
        let phone = GpsService.getLastKnownPosition();
        let lastFit = '';
        let lastFittedCamera = '';
        let lastOwn: FramePoint | null | undefined;
        locked.current = true;
        setOverviewLocked(true);

        const ownPosition = (): FramePoint | null => {
            const now = Date.now();
            const own = resolveOwnshipPosition(NmeaStore.getState(), LocationStore.getState(), { now });
            if (own?.source === 'nmea') return own;
            // Same passive, stamped fallback as PassageHudPane, not the map's
            // searched weather location. Never turn a port selection into GPS.
            if (
                phone &&
                validFramePoint({ lat: phone.latitude, lon: phone.longitude }) &&
                Number.isFinite(phone.timestamp) &&
                now - phone.timestamp >= -5000 &&
                now - phone.timestamp <= PHONE_MAX_AGE_MS
            ) {
                return { lat: phone.latitude, lon: phone.longitude };
            }
            return own;
        };

        const check = () => {
            frame = null;
            const force = forcePending;
            forcePending = false;
            if (disposed || !locked.current || fitting) return;
            const rect = container.getBoundingClientRect();
            if (rect.width < 64 || rect.height < 64) return;
            // The forecast hull travels the route or the straight joining
            // estimate, whose endpoints are already in this frame. No scrub-
            // rate subscription or repeated all-waypoint projection is needed.
            const geometry = passageFrameGeometry(routeRef.current, ownPosition(), null, map.getCenter().lng);
            if (!geometry) return;
            const padding = passageFramePadding(container);
            if (
                !force &&
                passageFrameIsVisible(geometry.points, (point) => map.project(point), rect.width, rect.height, padding)
            )
                return;
            // Pathological camera constraints must not cause a moveend/fit loop.
            const signature = JSON.stringify([geometry.bounds, padding, rect.width, rect.height]);
            const cameraSignature = () =>
                JSON.stringify([map.getCenter(), map.getZoom(), map.getBearing(), map.getPitch()]);
            if (!force && signature === lastFit && cameraSignature() === lastFittedCamera) return;
            lastFit = signature;
            fitting = true;
            try {
                map.fitBounds(geometry.bounds, {
                    padding,
                    maxZoom: 14,
                    duration: 0,
                    // The orientation mode's bearing (127-11a): bearing 0 here
                    // and a turning mode would re-fit and re-turn for ever.
                    bearing: chartFitBearing(map),
                    pitch: 0,
                    retainPadding: false,
                });
                lastFittedCamera = cameraSignature();
            } finally {
                fitting = false;
            }
        };
        const schedule = (force = false) => {
            if (disposed || !locked.current || fitting) return;
            forcePending ||= force;
            if (frame === null) frame = setTimeout(check, 0);
        };
        update.current = schedule;
        const changed = () => schedule();
        const positionChanged = () => {
            const own = ownPosition();
            if (lastOwn !== undefined && own?.lat === lastOwn?.lat && own?.lon === lastOwn?.lon) return;
            lastOwn = own;
            schedule();
        };
        const resized = () => schedule(true);
        const gesture = (event: unknown) => {
            if (!event || typeof event !== 'object' || !('originalEvent' in event) || !event.originalEvent || fitting)
                return;
            locked.current = false;
            setOverviewLocked(false);
        };
        const takePhone = (position: GpsPosition) => {
            phone = position;
            positionChanged();
        };
        lastOwn = ownPosition();
        const unwatch = GpsService.watchPosition(takePhone);
        const unsubNmea = NmeaStore.subscribe(positionChanged);
        const unsubLocation = LocationStore.subscribe(positionChanged);
        const timer = setInterval(positionChanged, 2000);
        map.on('moveend', changed);
        map.on('resize', resized);
        map.on('movestart', gesture);
        map.on('zoomstart', gesture);
        map.on('dragstart', gesture);

        const root = container.closest('main') ?? container.parentElement ?? container;
        const observed = new Set<Element>();
        const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resized);
        const observeFurniture = () => {
            for (const element of [
                container,
                ...root.querySelectorAll(
                    '.thalassa-passage-hud, .thalassa-passage-hud-tab, .thalassa-route-scrubber, [data-passage-frame-occlusion]',
                ),
            ]) {
                if (!observed.has(element)) {
                    observed.add(element);
                    resize?.observe(element);
                }
            }
        };
        observeFurniture();
        // HUD/scrubber mount outside the map canvas. Watch only node insertion,
        // not the thousands of marker transform writes made during playback.
        const mutations = new MutationObserver((entries) => {
            if (
                !entries.some((entry) =>
                    [...entry.addedNodes, ...entry.removedNodes].some(
                        (node) =>
                            node instanceof Element &&
                            (node.matches(
                                '.thalassa-passage-hud, .thalassa-passage-hud-tab, .thalassa-route-scrubber',
                            ) ||
                                !!node.querySelector(
                                    '.thalassa-passage-hud, .thalassa-passage-hud-tab, .thalassa-route-scrubber',
                                )),
                    ),
                )
            )
                return;
            observeFurniture();
            resized();
        });
        mutations.observe(root, { childList: true, subtree: true });
        schedule(true);
        return () => {
            disposed = true;
            update.current = null;
            if (frame !== null) clearTimeout(frame);
            clearInterval(timer);
            unwatch();
            unsubNmea();
            unsubLocation();
            resize?.disconnect();
            mutations.disconnect();
            map.off('moveend', changed);
            map.off('resize', resized);
            map.off('movestart', gesture);
            map.off('zoomstart', gesture);
            map.off('dragstart', gesture);
        };
        // Coordinates changing within the same voyage do not interrupt an
        // intentional inspection. A different followed voyage does.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mapRef, mapReady, enabled, routeKey, route.length >= 2]);

    useEffect(() => update.current?.(), [route]);
    useEffect(() => update.current?.(true), [layoutKey]);
    return { overviewLocked, resumeOverview, pauseOverview };
}
