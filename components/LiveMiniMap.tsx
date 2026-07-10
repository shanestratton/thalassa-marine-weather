/**
 * LiveMiniMap
 * Compact inline Leaflet map for embedding in voyage cards and the live tracking card.
 * Shows a track polyline on real nautical tiles, auto-fits bounds.
 *
 * Usage:
 *   - Live Recording card: shows active track with pulsing vessel dot
 *   - Planned Route card: shows planned waypoints in violet (dashed)
 *   - Past Voyage card: shows completed track
 *
 * Map is created once, track layers update reactively.
 */

import React, { useEffect, useRef, useCallback, memo } from 'react';
import { ShipLogEntry } from '../types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { piCache } from '../services/PiCacheService';
import { isTrackworthyEntry } from '../services/shiplog/helpers';

interface LiveMiniMapProps {
    entries: ShipLogEntry[];
    height?: number | string; // px number or CSS string like '100%'
    isLive?: boolean; // Show pulsing vessel dot at latest position
    className?: string;
    /**
     * Fired on a clean tap on the map (Leaflet's click — suppressed
     * during pan/pinch, so navigation gestures don't trigger it).
     * Used to expand the mini map to full screen and back.
     */
    onTap?: () => void;
    /**
     * Free-zoom mode (fullscreen). The mini card keeps re-centring on the
     * boat every poll (isLive auto-follow), which is right when it's tiny.
     * Fullscreen, that yanks the user's pinch-zoom back — so once the user
     * touches the map here we RELEASE auto-follow and leave their view put.
     * The initial fit still frames the track on open. Also enables scroll/
     * double-click zoom for desktop.
     */
    freeZoom?: boolean;
}

export const LiveMiniMap: React.FC<LiveMiniMapProps> = memo(
    ({ entries, height = 160, isLive = false, className = '', onTap, freeZoom = false }) => {
        const containerRef = useRef<HTMLDivElement>(null);
        const mapRef = useRef<L.Map | null>(null);
        const layerGroupRef = useRef<L.LayerGroup | null>(null);
        const hasFitRef = useRef(false);
        // Set once the user manually zooms/pans a free-zoom map — stops
        // the live auto-follow from snapping their view back.
        const userMovedRef = useRef(false);
        // Ref keeps the handler fresh without re-creating the map.
        const onTapRef = useRef<(() => void) | undefined>(onTap);
        onTapRef.current = onTap;

        // Create map once
        useEffect(() => {
            if (!containerRef.current || mapRef.current) return;

            let detachRelease: (() => void) | undefined;

            const map = L.map(containerRef.current, {
                zoomControl: false,
                attributionControl: false,
                dragging: true,
                scrollWheelZoom: freeZoom,
                // doubleClickZoom stays off even in free-zoom — a double
                // tap would also fire the onTap collapse. Pinch (touchZoom)
                // and scroll-wheel cover zooming.
                doubleClickZoom: false,
                boxZoom: false,
                keyboard: false,
                touchZoom: true,
                fadeAnimation: false,
                zoomAnimation: false,
            });

            // Free-zoom: the FIRST real user gesture releases auto-follow.
            // Raw DOM input events fire only for the user — programmatic
            // fitBounds/setView never trigger touchstart/wheel/mousedown,
            // so this can't false-positive on our own re-centring.
            if (freeZoom) {
                const release = () => {
                    userMovedRef.current = true;
                };
                const el = map.getContainer();
                el.addEventListener('touchstart', release, { passive: true });
                el.addEventListener('wheel', release, { passive: true });
                el.addEventListener('mousedown', release);
                detachRelease = () => {
                    el.removeEventListener('touchstart', release);
                    el.removeEventListener('wheel', release);
                    el.removeEventListener('mousedown', release);
                };
            }

            // Esri World Imagery (Shane 2026-07-10: dark carto was too dark —
            // "maybe we could have the satellite layer?"). Matches
            // TrackMapViewer; the neon track palette pops on imagery.
            L.tileLayer(
                piCache.leafletTileTemplate(
                    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                ),
                { maxZoom: 19 },
            ).addTo(map);

            // OpenSeaMap overlay
            L.tileLayer(piCache.leafletTileTemplate('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'), {
                maxZoom: 18,
                opacity: 0.8,
            }).addTo(map);

            const layerGroup = L.layerGroup().addTo(map);
            layerGroupRef.current = layerGroup;
            mapRef.current = map;

            // Tap-to-expand/collapse. Leaflet only fires 'click' on clean
            // taps (pans and pinches are suppressed), so map navigation
            // still works inside the expanded view.
            map.on('click', () => onTapRef.current?.());

            // Default center while entries load
            map.setView([-27.207, 153.108], 12);

            setTimeout(() => map.invalidateSize(), 150);

            // Auto-resize when container changes size (e.g. flex-grow)
            const ro = new ResizeObserver(() => map.invalidateSize());
            ro.observe(containerRef.current);

            return () => {
                detachRelease?.();
                ro.disconnect();
                map.remove();
                mapRef.current = null;
                layerGroupRef.current = null;
                hasFitRef.current = false;
                userMovedRef.current = false;
            };
            // freeZoom is fixed per mount (fullscreen remounts fresh), so
            // it's read at creation and intentionally not a re-create dep.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // Update layers when entries change
        const updateLayers = useCallback(() => {
            const map = mapRef.current;
            const lg = layerGroupRef.current;
            if (!map || !lg) return;

            lg.clearLayers();

            // Trackworthy entries only — turn pins sit at past positions
            // and made the LIVE map zig-zag even after the full viewer
            // was fixed; (0,0) placeholders draw across the planet.
            const valid = entries.filter(isTrackworthyEntry);
            if (valid.length === 0) return;

            const sorted = [...valid].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

            const coords = sorted.map((e) => [e.latitude!, e.longitude!] as [number, number]);
            const isPlanned = sorted.some((e) => e.source === 'planned_route');

            // Bolder colour that reads on the light Voyager base.
            const mainColor = isPlanned ? '#a78bfa' : '#38bdf8';

            // Track lines
            if (coords.length >= 2) {
                // White casing — crisp "chart route" outline on any base.
                L.polyline(coords, {
                    color: '#ffffff',
                    weight: 5,
                    opacity: 0.7,
                    lineCap: 'round',
                    lineJoin: 'round',
                }).addTo(lg);

                // Main line
                L.polyline(coords, {
                    color: mainColor,
                    weight: 2.5,
                    opacity: 1,
                    lineCap: 'round',
                    lineJoin: 'round',
                    dashArray: isPlanned ? '8 6' : undefined,
                }).addTo(lg);
            }

            // Start dot
            L.circleMarker([sorted[0].latitude!, sorted[0].longitude!], {
                radius: 5,
                fillColor: '#34d399',
                fillOpacity: 1,
                color: 'white',
                weight: 1.5,
            }).addTo(lg);

            // Waypoint dots REMOVED 2026-06-12 (Shane: "do away with the
            // wayward waypoints") — auto turn pins landed off-route and
            // cluttered the map. Waypoint rendering returns when the
            // waypoint feature is redesigned.

            // End / live position
            const last = sorted[sorted.length - 1];
            if (isLive) {
                // Pulsing cyan vessel dot via divIcon
                const vesselIcon = L.divIcon({
                    html: `<div style="
                    width: 14px; height: 14px;
                    background: #00f0ff;
                    border: 2px solid white;
                    border-radius: 50%;
                    box-shadow: 0 0 10px rgba(0,240,255,0.6), 0 0 20px rgba(0,240,255,0.3);
                "></div>`,
                    iconSize: [14, 14],
                    iconAnchor: [7, 7],
                    className: '',
                });
                L.marker([last.latitude!, last.longitude!], { icon: vesselIcon }).addTo(lg);
            } else if (sorted.length > 1) {
                // End dot
                L.circleMarker([last.latitude!, last.longitude!], {
                    radius: 5,
                    fillColor: isPlanned ? '#a78bfa' : '#ef4444',
                    fillOpacity: 1,
                    color: 'white',
                    weight: 1.5,
                }).addTo(lg);
            }

            // Fit bounds. Auto-follow keeps the live boat framed every
            // tick — but in free-zoom mode, once the user has moved the
            // map we stop re-fitting so their zoom/pan sticks. The first
            // fit (hasFitRef) always runs to frame the track on open.
            const autoFollow = isLive && !(freeZoom && userMovedRef.current);
            if (coords.length >= 2) {
                if (autoFollow || !hasFitRef.current) {
                    const bounds = L.latLngBounds(coords);
                    map.fitBounds(bounds, { padding: [16, 16], maxZoom: 15, animate: false });
                    hasFitRef.current = true;
                }
            } else if (coords.length === 1 && (autoFollow || !hasFitRef.current)) {
                map.setView(coords[0], 14, { animate: false });
                hasFitRef.current = true;
            }
        }, [entries, isLive, freeZoom]);

        useEffect(() => {
            const timer = setTimeout(updateLayers, 100);
            return () => clearTimeout(timer);
        }, [updateLayers]);

        return (
            <div
                ref={containerRef}
                className={`w-full rounded-xl overflow-hidden border border-white/5 ${onTap ? 'cursor-pointer' : ''} ${className}`}
                style={{ height, background: '#dce6ea' }}
            />
        );
    },
);

LiveMiniMap.displayName = 'LiveMiniMap';
