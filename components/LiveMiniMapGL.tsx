/**
 * LiveMiniMapGL — the little Log map in Mapbox GL on Relief + Sat (125-13a,
 * Shane 2026-10-09: "replace the little and the big map with our relief +
 * sat"). Loaded lazily by LiveMiniMap, whose props it takes.
 *
 * The map is built ONCE per visit, while its card is on screen
 * (useLogMapOnScreen), and removed when the card leaves or unmounts: a Log
 * map is an extra WebGL context beside Obs's, and each build is a billed
 * Mapbox load. Props only ever change its data (setData), never rebuild it.
 * Where the web view has no WebGL (Lockdown Mode, a GPU process refusing a
 * context), the card stays a plain box that still taps open and shut, and
 * this visit does not ask Mapbox again.
 *
 * What it draws, as the Leaflet map did: the followed route in violet beneath
 * the recorded track (sky-blue, or violet for a planned route), glow under
 * core; a green start dot; the live boat in cyan at the latest fix, or an end
 * dot. A live card re-frames on every fix; the fullscreen map stops following
 * at the skipper's first touch.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type mapboxgl from 'mapbox-gl';
import type { ShipLogEntry } from '../types';
import { isTrackworthyEntry } from '../services/shiplog/helpers';
import { stripInitialTrackWarmupRebounds } from '../services/shiplog/initialTrackWarmupGuard';
import { sanitizeRouteCoordinates, type RouteCoordinate } from '../utils/routeCoordinates';
import { miniMapBoxClass, type LiveMiniMapProps } from './LiveMiniMap';
import {
    createLogMap,
    fitLogMap,
    LOG_MAP_WORLD_VIEW,
    logMapBounds,
    logMapToken,
    setLogMapData,
    unwrapLongitudes,
    type LogMapView,
    type LonLat,
} from './map/logMap';
import {
    BOAT_DOT,
    END_DOT,
    FOLLOWED_ROUTE_CORE,
    FOLLOWED_ROUTE_GLOW,
    START_DOT,
    TRACK_CORE,
    TRACK_GLOW,
} from './map/logMapColours';
import { useLogMapOnScreen } from './map/useLogMapOnScreen';

const EMPTY_ROUTE: readonly RouteCoordinate[] = [];
const ROUTE = 'log-route';
const TRACK = 'log-track';
const POINTS = 'log-points';
/** Leaflet's z14 and z15, in Mapbox's 512 px zoom. */
const POINT_ZOOM = 13;
const MAX_FIT_ZOOM = 14;
const FIT_PADDING = 16;

interface TrackShape {
    line: LonLat[];
    isPlanned: boolean;
}

/** Trackworthy fixes in time order: turn pins and (0,0) placeholders never draw. */
function trackShape(entries: ShipLogEntry[]): TrackShape {
    const valid = stripInitialTrackWarmupRebounds(entries).filter(isTrackworthyEntry);
    const sorted = [...valid].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return {
        line: unwrapLongitudes(sorted.map((e) => [e.longitude as number, e.latitude as number])),
        isPlanned: sorted.some((e) => e.source === 'planned_route'),
    };
}

const routeLine = (coords: readonly RouteCoordinate[]): LonLat[] =>
    unwrapLongitudes(sanitizeRouteCoordinates(coords).map((c) => [c.lon, c.lat]));

const lineFeature = (line: LonLat[], properties: Record<string, string> = {}): GeoJSON.Feature => ({
    type: 'Feature',
    properties,
    geometry: line.length >= 2 ? { type: 'LineString', coordinates: line } : (null as unknown as GeoJSON.Geometry),
});

const trackFeature = ({ line, isPlanned }: TrackShape) =>
    lineFeature(
        line,
        isPlanned ? { glow: FOLLOWED_ROUTE_GLOW, core: FOLLOWED_ROUTE_CORE } : { glow: TRACK_GLOW, core: TRACK_CORE },
    );

function pointFeatures({ line, isPlanned }: TrackShape, isLive: boolean): GeoJSON.FeatureCollection {
    const point = (coordinates: LonLat, role: string, fill: string): GeoJSON.Feature => ({
        type: 'Feature',
        properties: { role, fill },
        geometry: { type: 'Point', coordinates },
    });
    const features: GeoJSON.Feature[] = [];
    if (line.length > 0) {
        features.push(point(line[0], 'start', START_DOT));
        const last = line[line.length - 1];
        if (isLive) features.push(point(last, 'boat', BOAT_DOT));
        else if (line.length > 1) features.push(point(last, 'end', isPlanned ? FOLLOWED_ROUTE_GLOW : END_DOT));
    }
    return { type: 'FeatureCollection', features };
}

const ROUND = { 'line-cap': 'round', 'line-join': 'round' } as const;

/** The overlays, above everything the style draws. Idempotent; run on every style load. */
function addOverlayLayers(map: mapboxgl.Map) {
    const layers: mapboxgl.AnyLayer[] = [
        {
            id: 'log-route-glow',
            type: 'line',
            source: ROUTE,
            layout: ROUND,
            paint: { 'line-color': FOLLOWED_ROUTE_GLOW, 'line-width': 10, 'line-opacity': 0.28 },
        },
        {
            id: 'log-route-core',
            type: 'line',
            source: ROUTE,
            layout: ROUND,
            paint: { 'line-color': FOLLOWED_ROUTE_CORE, 'line-width': 3 },
        },
        {
            id: 'log-track-glow',
            type: 'line',
            source: TRACK,
            layout: ROUND,
            paint: { 'line-color': ['get', 'glow'], 'line-width': 9, 'line-opacity': 0.28 },
        },
        {
            id: 'log-track-core',
            type: 'line',
            source: TRACK,
            layout: ROUND,
            paint: { 'line-color': ['get', 'core'], 'line-width': 2.5 },
        },
        {
            id: 'log-points',
            type: 'circle',
            source: POINTS,
            filter: ['!=', ['get', 'role'], 'boat'],
            paint: {
                'circle-radius': 5,
                'circle-color': ['get', 'fill'],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1.5,
            },
        },
        {
            id: 'log-boat-halo',
            type: 'circle',
            source: POINTS,
            filter: ['==', ['get', 'role'], 'boat'],
            paint: { 'circle-radius': 14, 'circle-color': BOAT_DOT, 'circle-opacity': 0.3, 'circle-blur': 0.8 },
        },
        {
            id: 'log-boat',
            type: 'circle',
            source: POINTS,
            filter: ['==', ['get', 'role'], 'boat'],
            paint: {
                'circle-radius': 7,
                'circle-color': BOAT_DOT,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
            },
        },
    ];
    for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer(layer);
}

const LiveMiniMapGL: React.FC<LiveMiniMapProps> = ({
    entries,
    followedRouteCoords = EMPTY_ROUTE,
    initialCenter = null,
    height = 160,
    isLive = false,
    className = '',
    onTap,
    freeZoom = false,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    /** The style is in and the overlays exist: data can be set. */
    const drawnRef = useRef(false);
    const hasFitRef = useRef(false);
    /** Set by the skipper's first touch on a free-zoom map: no more auto-follow. */
    const userMovedRef = useRef(false);
    /** Mapbox could not start here (no WebGL): a plain box for the rest of this visit. */
    const failedRef = useRef(false);

    const route = useMemo(() => routeLine(followedRouteCoords), [followedRouteCoords]);
    const track = useMemo(() => trackShape(entries), [entries]);
    // Latest values for the create-once effect and the style-load handler.
    const routeRef = useRef(route);
    routeRef.current = route;
    const trackRef = useRef(track);
    trackRef.current = track;
    const isLiveRef = useRef(isLive);
    isLiveRef.current = isLive;
    const initialCenterRef = useRef(initialCenter);
    initialCenterRef.current = initialCenter;
    const onTapRef = useRef(onTap);
    onTapRef.current = onTap;

    const onScreen = useLogMapOnScreen(containerRef);
    const token = logMapToken();

    /** Frame the route and the track: every fix while live, once otherwise. */
    const fitVisible = useCallback(() => {
        const map = mapRef.current;
        if (!map) return;
        if (freeZoom && userMovedRef.current) return;
        const visible = [...routeRef.current, ...trackRef.current.line];
        if (visible.length === 0) {
            hasFitRef.current = false;
            return;
        }
        if (!isLiveRef.current && hasFitRef.current) return;
        if (fitLogMap(map, visible, { padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM, pointZoom: POINT_ZOOM }))
            hasFitRef.current = true;
    }, [freeZoom]);

    // Build the map once per visit: on screen, with a token.
    useEffect(() => {
        const container = containerRef.current;
        if (!container || !onScreen || !token) return;

        // A tap opens (or, fullscreen, shrinks) the map; never a tap on its
        // credits or wordmark. A card is a picture, so the tap is the box's
        // own click; a free map's clean tap is Mapbox's click (none after a
        // pan or pinch). A box with no map takes the box's click either way.
        const tapCard = (event: MouseEvent) => {
            if ((event.target as Element | null)?.closest?.('.mapboxgl-ctrl')) return;
            onTapRef.current?.();
        };
        const plainBox = () => {
            container.addEventListener('click', tapCard);
            return () => container.removeEventListener('click', tapCard);
        };
        if (failedRef.current) return plainBox();

        // FRAME FROM THE DATA ALREADY IN HAND, so the first tiles fetched are
        // the ones about to be looked at: the route and the track, else the
        // live fix, else the whole world (never one harbour: a global app).
        const seeds = [...routeRef.current, ...trackRef.current.line];
        const live = initialCenterRef.current;
        let view: LogMapView;
        hasFitRef.current = false;
        if (seeds.length === 1) view = { center: seeds[0], zoom: POINT_ZOOM };
        else if (seeds.length > 1) {
            view = { bounds: logMapBounds(unwrapLongitudes(seeds))!, padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM };
            hasFitRef.current = true;
        } else if (live && Number.isFinite(live.lat) && Number.isFinite(live.lon))
            view = { center: [live.lon, live.lat], zoom: POINT_ZOOM };
        else view = { ...LOG_MAP_WORLD_VIEW };

        const map = createLogMap({
            container,
            token,
            view,
            gestures: freeZoom ? 'free' : 'card',
            onStyle: (m) => {
                setLogMapData(m, ROUTE, lineFeature(routeRef.current));
                setLogMapData(m, TRACK, trackFeature(trackRef.current));
                setLogMapData(m, POINTS, pointFeatures(trackRef.current, isLiveRef.current));
                addOverlayLayers(m);
                drawnRef.current = true;
                fitVisible();
            },
        });
        if (!map) {
            failedRef.current = true;
            return plainBox();
        }
        mapRef.current = map;

        const tapFree = () => onTapRef.current?.();
        if (freeZoom) map.on('click', tapFree);
        else container.addEventListener('click', tapCard);

        // Free-zoom: the FIRST real gesture releases auto-follow. Raw input
        // events fire only for the skipper, never for our own framing.
        const release = () => {
            userMovedRef.current = true;
        };
        if (freeZoom) {
            container.addEventListener('touchstart', release, { passive: true });
            container.addEventListener('wheel', release, { passive: true });
            container.addEventListener('mousedown', release);
        }

        // Keep the canvas the size of its box (the live card grows to fill),
        // and re-frame for the new size until the skipper has moved it.
        let observer: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') {
            let last = { w: container.clientWidth, h: container.clientHeight };
            observer = new ResizeObserver(() => {
                const w = container.clientWidth;
                const h = container.clientHeight;
                if (w === 0 || h === 0 || (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 2)) return;
                last = { w, h };
                map.resize();
                hasFitRef.current = false;
                fitVisible();
            });
            observer.observe(container);
        }

        return () => {
            observer?.disconnect();
            container.removeEventListener('click', tapCard);
            container.removeEventListener('touchstart', release);
            container.removeEventListener('wheel', release);
            container.removeEventListener('mousedown', release);
            drawnRef.current = false;
            mapRef.current = null;
            hasFitRef.current = false;
            userMovedRef.current = false;
            map.remove();
        };
        // freeZoom is fixed per mount (fullscreen mounts its own map) and
        // fitVisible follows it, so neither is a rebuild reason.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onScreen, token]);

    // The followed route changes only when following starts or stops, or its
    // weather refresh lands: its own source, so the track is never redrawn
    // for it, and a fresh route earns a fresh frame.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !drawnRef.current) return;
        setLogMapData(map, ROUTE, lineFeature(route));
        if (!(freeZoom && userMovedRef.current)) hasFitRef.current = false;
        fitVisible();
    }, [route, freeZoom, fitVisible]);

    // Every fix: the track, the start dot and the boat.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !drawnRef.current) return;
        setLogMapData(map, TRACK, trackFeature(track));
        setLogMapData(map, POINTS, pointFeatures(track, isLive));
        fitVisible();
    }, [track, isLive, fitVisible]);

    return (
        <div
            ref={containerRef}
            className={`${miniMapBoxClass(!!onTap, className)}${freeZoom ? ' is-free' : ''}`}
            style={{ height }}
        />
    );
};

export default LiveMiniMapGL;
