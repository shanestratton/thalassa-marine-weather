/**
 * TrackMapViewerGL — the big Log track map in Mapbox GL on Relief + Sat
 * (125-13b, Shane 2026-10-09: "replace the little and the big map with our
 * relief + sat ?? remove the old satellite map"). Loaded lazily by
 * TrackMapViewer, which keeps the dialog, the playback and every control; this
 * draws the map under them through the Log-map helper (map/logMap.ts), so the
 * base, the credits, the tile rule and the no-WebGL guard are 125-13a's.
 *
 * Built when the viewer opens and removed when it closes: while open it is
 * one extra WebGL context beside Obs's hidden map (the iOS WebContent 2 GB
 * cap), and each build is a billed Mapbox load. Never registered as THE chart
 * (chartMapRegistry). Props only ever change its data, never rebuild it.
 *
 * What it draws, as the Leaflet viewer did (map/trackMapFeatures.ts): the
 * followed route under the track; the track by forecast wind or water/land,
 * a planned route in violet; GPS dots, turn dots, the start and the end; the
 * playback boat on top. A tap shows the conditions logged at the nearest fix
 * (or the turn, on a turn dot); a tap with one open closes it. It frames the
 * route and the track once, then leaves the view to the skipper.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import type { ShipLogEntry } from '../types';
import { nearestTrackEntry } from '../services/shiplog/trackViz';
import type { RouteCoordinate } from '../utils/routeCoordinates';
import {
    createLogMap,
    fitLogMap,
    LOG_MAP_WORLD_VIEW,
    logMapBounds,
    logMapPaddingFits,
    logMapToken,
    nearLongitude,
    setLogMapData,
    type LogMapPadding,
    type LogMapView,
    type LonLat,
} from './map/logMap';
import { BOAT_DOT, FOLLOWED_ROUTE_CORE, FOLLOWED_ROUTE_GLOW } from './map/logMapColours';
import {
    followedRouteLine,
    middleLongitude,
    trackMapDrawing,
    trackTime,
    TURN_DOT,
    type TrackColourMode,
    type TrackMapDrawing,
} from './map/trackMapFeatures';

export interface TrackMapViewerGLProps {
    entries: ShipLogEntry[];
    /** The route being followed, already sanitised by the viewer. */
    followedRoute: readonly RouteCoordinate[];
    colorMode: TrackColourMode;
    /** The playback fixes in time order: a tap snaps to the nearest. */
    tapEntries: ShipLogEntry[];
    /**
     * No map here (no WebGL, no token): the viewer says so and carries on.
     * 'chunk' comes only from the viewer's stand-in when this file's own
     * chunk failed to load.
     */
    onUnavailable: (cause?: 'chunk') => void;
    /**
     * The room the viewer's own controls take over the map (header, back
     * button, dock, legend), measured as a frame is made, so the track is
     * framed in the clear part of the screen. Undefined: a plain margin.
     */
    framePadding?: () => LogMapPadding | undefined;
}

export interface TrackMapViewerGLHandle {
    /** Put the playback boat at this fix or frame (raw lat/lon; drawn beside the line). */
    moveVessel(lat: number, lon: number): void;
}

const ROUTE = 'track-route';
const TRACK = 'track-line';
const FIXES = 'track-fixes';
const TURNS = 'track-turns';
const ENDS = 'track-ends';
const VESSEL = 'track-vessel';
/** Leaflet's maxZoom 16 and lone-point z14, in Mapbox's 512 px zoom. */
const MAX_FIT_ZOOM = 15;
const POINT_ZOOM = 13;
const FIT_PADDING = 40;
/** How far from a turn dot (px) a tap still means the turn. */
const TURN_TAP_PX = 12;

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const lineOf = (coordinates: LonLat[]): GeoJSON.FeatureCollection =>
    coordinates.length < 2
        ? EMPTY
        : {
              type: 'FeatureCollection',
              features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }],
          };
const pointOf = (coordinates: LonLat | null): GeoJSON.FeatureCollection =>
    coordinates
        ? {
              type: 'FeatureCollection',
              features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates } }],
          }
        : EMPTY;

const ROUND = { 'line-cap': 'round', 'line-join': 'round' } as const;

/** The overlays, bottom to top, above everything the base draws. Idempotent; run on every style load. */
function addOverlayLayers(map: mapboxgl.Map) {
    const layers: mapboxgl.AnyLayer[] = [
        {
            id: 'track-route-glow',
            type: 'line',
            source: ROUTE,
            layout: ROUND,
            paint: { 'line-color': FOLLOWED_ROUTE_GLOW, 'line-width': 10, 'line-opacity': 0.28 },
        },
        {
            id: 'track-route-core',
            type: 'line',
            source: ROUTE,
            layout: ROUND,
            paint: { 'line-color': FOLLOWED_ROUTE_CORE, 'line-width': 3 },
        },
        {
            id: 'track-line-glow',
            type: 'line',
            source: TRACK,
            layout: ROUND,
            paint: { 'line-color': ['get', 'glow'], 'line-width': 11, 'line-opacity': 0.26 },
        },
        {
            id: 'track-line-core',
            type: 'line',
            source: TRACK,
            layout: ROUND,
            paint: { 'line-color': ['get', 'core'], 'line-width': 3.5 },
        },
        {
            id: 'track-fixes',
            type: 'circle',
            source: FIXES,
            paint: {
                'circle-radius': 2,
                'circle-color': ['get', 'fill'],
                'circle-opacity': 0.85,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 0.5,
            },
        },
        {
            id: 'track-turns',
            type: 'circle',
            source: TURNS,
            paint: {
                'circle-radius': 4,
                'circle-color': TURN_DOT,
                'circle-opacity': 0.9,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 1,
            },
        },
        {
            id: 'track-ends-halo',
            type: 'circle',
            source: ENDS,
            paint: { 'circle-radius': 13, 'circle-color': ['get', 'glow'], 'circle-blur': 0.8 },
        },
        {
            id: 'track-ends',
            type: 'circle',
            source: ENDS,
            paint: {
                'circle-radius': 6.5,
                'circle-color': ['get', 'core'],
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2.5,
            },
        },
        {
            id: 'track-vessel-halo',
            type: 'circle',
            source: VESSEL,
            paint: { 'circle-radius': 16, 'circle-color': BOAT_DOT, 'circle-opacity': 0.35, 'circle-blur': 0.8 },
        },
        {
            id: 'track-vessel',
            type: 'circle',
            source: VESSEL,
            paint: {
                'circle-radius': 10,
                'circle-color': BOAT_DOT,
                'circle-stroke-color': '#ffffff',
                'circle-stroke-width': 2,
            },
        },
    ];
    for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer(layer);
}

const text = (tag: string, content: string, style: Partial<CSSStyleDeclaration> = {}) => {
    const node = document.createElement(tag);
    node.textContent = content;
    Object.assign(node.style, style);
    return node;
};

/**
 * What was logged at a fix: the time, the FORECAST wind and sea at capture,
 * and the GPS-measured SOG and COG. Built as text, never HTML: an imported
 * track's fields are someone else's words.
 */
function conditionsContent(e: ShipLogEntry): HTMLElement {
    const root = document.createElement('div');
    const date = new Date(e.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    root.append(text('div', `${date} · ${trackTime(e.timestamp)}`, { fontSize: '12px', fontWeight: '700' }));
    const grid = text('div', '', {
        fontSize: '11px',
        lineHeight: '1.5',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        columnGap: '10px',
        marginTop: '2px',
    });
    const wind =
        typeof e.windSpeed === 'number'
            ? `${Math.round(e.windSpeed)} kt${e.windDirection ? ' ' + e.windDirection : ''}`
            : '—';
    grid.append(text('div', `💨 ${wind}`));
    if (typeof e.waveHeight === 'number') grid.append(text('div', `🌊 ${e.waveHeight.toFixed(1)} m`));
    if (typeof e.speedKts === 'number') grid.append(text('div', `⛵ ${e.speedKts.toFixed(1)} kt SOG`));
    if (typeof e.courseDeg === 'number') grid.append(text('div', `🧭 ${Math.round(e.courseDeg)}°`));
    root.append(grid);
    return root;
}

function turnContent({ from, to, time }: Record<string, unknown>): HTMLElement {
    const root = document.createElement('div');
    root.append(text('div', `${String(from)} → ${String(to)}`, { fontSize: '12px', fontWeight: '700' }));
    root.append(text('div', String(time ?? ''), { fontSize: '11px', opacity: '0.7' }));
    return root;
}

const TrackMapViewerGL = forwardRef<TrackMapViewerGLHandle, TrackMapViewerGLProps>(function TrackMapViewerGL(
    { entries, followedRoute, colorMode, tapEntries, onUnavailable, framePadding },
    ref,
) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    /** The style is in and the overlays exist: data can be set. */
    const drawnRef = useRef(false);
    const hasFitRef = useRef(false);
    /** The skipper has panned or zoomed: a resize no longer re-frames. */
    const userMovedRef = useRef(false);
    const popupRef = useRef<mapboxgl.Popup | null>(null);
    /** The playback boat, raw [lon, lat], until playback starts: none. */
    const vesselRef = useRef<LonLat | null>(null);

    const drawing = useMemo(() => trackMapDrawing(entries, colorMode), [entries, colorMode]);
    const trackMiddle = middleLongitude(drawing.line);
    const route = useMemo(() => followedRouteLine(followedRoute, trackMiddle), [followedRoute, trackMiddle]);
    /** Where taps, the boat and popups are placed: beside what is drawn. */
    const middle = trackMiddle ?? middleLongitude(route) ?? 0;

    // Latest values for the create-once effect, the style-load and tap handlers.
    const drawingRef = useRef<TrackMapDrawing>(drawing);
    drawingRef.current = drawing;
    const routeRef = useRef(route);
    routeRef.current = route;
    const middleRef = useRef(middle);
    middleRef.current = middle;
    const tapEntriesRef = useRef(tapEntries);
    tapEntriesRef.current = tapEntries;
    const onUnavailableRef = useRef(onUnavailable);
    onUnavailableRef.current = onUnavailable;
    const followedRouteRef = useRef(followedRoute);
    followedRouteRef.current = followedRoute;
    const framePaddingRef = useRef(framePadding);
    framePaddingRef.current = framePadding;
    /** The followed route the frame was last made for (a new one earns a new frame). */
    const routeKeyRef = useRef(followedRoute);
    /** How many vertices the map last drew (0 to some, or back, earns a new frame). */
    const drawnLineLengthRef = useRef(drawing.line.length);

    const token = logMapToken();

    /**
     * The frame's margins: clear of the viewer's controls where they leave
     * room for a track between them, else the plain margin (a short
     * landscape screen, or nothing measured yet).
     */
    const padding = useCallback((): LogMapPadding => {
        const box = containerRef.current;
        const measured = framePaddingRef.current?.();
        if (!box || measured === undefined) return FIT_PADDING;
        return logMapPaddingFits(box.clientWidth, box.clientHeight, measured) ? measured : FIT_PADDING;
    }, []);

    /** Frame the route and the track, once (and again after a reset). */
    const fitVisible = useCallback(() => {
        const map = mapRef.current;
        if (!map || hasFitRef.current) return;
        const visible = [...routeRef.current, ...drawingRef.current.line];
        if (visible.length === 0) return;
        if (fitLogMap(map, visible, { padding: padding(), maxZoom: MAX_FIT_ZOOM, pointZoom: POINT_ZOOM }))
            hasFitRef.current = true;
    }, [padding]);

    const drawVessel = useCallback(() => {
        const map = mapRef.current;
        const boat = vesselRef.current;
        if (!map || !drawnRef.current) return;
        setLogMapData(map, VESSEL, pointOf(boat && [nearLongitude(boat[0], middleRef.current), boat[1]]));
    }, []);

    useImperativeHandle(
        ref,
        () => ({
            moveVessel(lat: number, lon: number) {
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
                vesselRef.current = [lon, lat];
                drawVessel();
            },
        }),
        [drawVessel],
    );

    // Build the map once, as the viewer opens; remove it as it closes.
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        if (!token) {
            onUnavailableRef.current();
            return;
        }

        // FRAME FROM THE DATA ALREADY IN HAND, so the first tiles fetched are
        // the ones about to be looked at: the route and the track, else the
        // whole world (never one harbour: a global app).
        const seeds = [...routeRef.current, ...drawingRef.current.line];
        let view: LogMapView;
        hasFitRef.current = false;
        if (seeds.length === 1) {
            view = { center: seeds[0], zoom: POINT_ZOOM };
            hasFitRef.current = true;
        } else if (seeds.length > 1) {
            view = { bounds: logMapBounds(seeds)!, padding: padding(), maxZoom: MAX_FIT_ZOOM };
            hasFitRef.current = true;
        } else view = { ...LOG_MAP_WORLD_VIEW };

        const map = createLogMap({
            container,
            token,
            view,
            gestures: 'free',
            doubleClickZoom: true,
            keyboard: true,
            onStyle: (m) => {
                const d = drawingRef.current;
                // Whatever changed while the style was on its way is drawn now,
                // and a route that changed meanwhile is framed now.
                drawnLineLengthRef.current = d.line.length;
                if (routeKeyRef.current !== followedRouteRef.current) {
                    routeKeyRef.current = followedRouteRef.current;
                    hasFitRef.current = false;
                }
                setLogMapData(m, ROUTE, lineOf(routeRef.current));
                setLogMapData(m, TRACK, d.track);
                setLogMapData(m, FIXES, d.fixes);
                setLogMapData(m, TURNS, d.turns);
                setLogMapData(m, ENDS, d.ends);
                setLogMapData(m, VESSEL, EMPTY);
                addOverlayLayers(m);
                drawnRef.current = true;
                drawVessel();
                fitVisible();
            },
        });
        if (!map) {
            onUnavailableRef.current();
            return;
        }
        mapRef.current = map;

        const showPopup = (at: LonLat, content: HTMLElement, className: string) => {
            const popup = new mapboxgl.Popup({
                closeButton: true,
                closeOnClick: false,
                className,
                offset: 8,
                maxWidth: '240px',
                focusAfterOpen: false,
            })
                .setLngLat(at)
                .setDOMContent(content)
                .addTo(map);
            popupRef.current = popup;
            popup.on('close', () => {
                if (popupRef.current === popup) popupRef.current = null;
            });
            // A tap on the bubble closes it too.
            popup.getElement()?.addEventListener('click', () => popup.remove());
        };

        // A tap is a toggle: with a bubble open it closes it and opens nothing;
        // otherwise a turn dot under the finger shows the turn, and anywhere
        // else the conditions logged at the nearest fix.
        map.on('click', (event: mapboxgl.MapMouseEvent) => {
            if (popupRef.current) {
                popupRef.current.remove();
                return;
            }
            const { x, y } = event.point;
            const turn = map.getLayer('track-turns')
                ? map.queryRenderedFeatures(
                      [
                          [x - TURN_TAP_PX, y - TURN_TAP_PX],
                          [x + TURN_TAP_PX, y + TURN_TAP_PX],
                      ],
                      { layers: ['track-turns'] },
                  )[0]
                : undefined;
            if (turn) {
                const at = (turn.geometry as GeoJSON.Point).coordinates as LonLat;
                showPopup(at, turnContent(turn.properties ?? {}), 'track-turn-popup');
                return;
            }
            const near = nearestTrackEntry(tapEntriesRef.current, event.lngLat.lat, event.lngLat.lng);
            if (!near) return;
            showPopup(
                [nearLongitude(near.longitude, event.lngLat.lng), near.latitude],
                conditionsContent(near),
                'track-cond-popup',
            );
        });

        // The skipper's own pan or pinch (Mapbox gives those an originalEvent;
        // our own framing has none) keeps the view theirs through a resize.
        map.on('movestart', (event: { originalEvent?: Event }) => {
            if (event.originalEvent) userMovedRef.current = true;
        });

        // Keep the canvas the size of its box (a rotation, the split pane), and
        // re-frame for the new size until the skipper has moved it.
        let observer: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') {
            let last = { w: container.clientWidth, h: container.clientHeight };
            observer = new ResizeObserver(() => {
                const w = container.clientWidth;
                const h = container.clientHeight;
                if (w === 0 || h === 0 || (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 2)) return;
                last = { w, h };
                map.resize();
                if (userMovedRef.current) return;
                hasFitRef.current = false;
                fitVisible();
            });
            observer.observe(container);
        }

        return () => {
            observer?.disconnect();
            popupRef.current?.remove();
            popupRef.current = null;
            drawnRef.current = false;
            mapRef.current = null;
            hasFitRef.current = false;
            userMovedRef.current = false;
            map.remove();
        };
        // The token is fixed per build; everything else reaches the map as data.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    // Every fix (and the Wind/Track toggle): the track and its dots. The frame
    // stays put for a live fix; it is made again only when the track first
    // becomes drawable beside a route, or vanishes. (Before the route's
    // effect: a first track moves the route's middle too, and one frame
    // takes in both.)
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !drawnRef.current) return;
        setLogMapData(map, TRACK, drawing.track);
        setLogMapData(map, FIXES, drawing.fixes);
        setLogMapData(map, TURNS, drawing.turns);
        setLogMapData(map, ENDS, drawing.ends);
        const before = drawnLineLengthRef.current;
        drawnLineLengthRef.current = drawing.line.length;
        if ((before === 0) !== (drawing.line.length === 0)) hasFitRef.current = false;
        fitVisible();
        drawVessel();
    }, [drawing, fitVisible, drawVessel]);

    // The followed route: its own source, so the track is never redrawn for it;
    // a new route to follow earns a new frame.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !drawnRef.current) return;
        setLogMapData(map, ROUTE, lineOf(route));
        if (routeKeyRef.current !== followedRoute) {
            routeKeyRef.current = followedRoute;
            hasFitRef.current = false;
        }
        fitVisible();
    }, [route, followedRoute, fitVisible]);

    // Mapbox makes its box position: relative, so the box fills a positioned
    // frame rather than being one (an absolute box would collapse to nothing).
    return (
        <div className="absolute inset-0">
            <div ref={containerRef} className="thalassa-log-gl-map is-free track-map-gl relative h-full w-full" />
        </div>
    );
});

export default TrackMapViewerGL;
