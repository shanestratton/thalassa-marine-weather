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
}

export const LiveMiniMap: React.FC<LiveMiniMapProps> = memo(
    ({ entries, height = 160, isLive = false, className = '' }) => {
        const containerRef = useRef<HTMLDivElement>(null);
        const mapRef = useRef<L.Map | null>(null);
        const layerGroupRef = useRef<L.LayerGroup | null>(null);
        const hasFitRef = useRef(false);

        // Create map once
        useEffect(() => {
            if (!containerRef.current || mapRef.current) return;

            const map = L.map(containerRef.current, {
                zoomControl: false,
                attributionControl: false,
                dragging: true,
                scrollWheelZoom: false,
                doubleClickZoom: false,
                boxZoom: false,
                keyboard: false,
                touchZoom: true,
                fadeAnimation: false,
                zoomAnimation: false,
            });

            // CARTO dark base — route through Pi Cache when available
            L.tileLayer(piCache.leafletTileTemplate('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'), {
                maxZoom: 19,
            }).addTo(map);

            // EMODnet bathymetry overlay REMOVED 2026-06-12 — its
            // "baselayer" tiles are a light, fully-painted basemap, so
            // blended at 35% below z12 (exactly where a whole track
            // fits) they washed the dark map near-white and drowned the
            // track line.

            // OpenSeaMap overlay
            L.tileLayer(piCache.leafletTileTemplate('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'), {
                maxZoom: 18,
                opacity: 0.7,
            }).addTo(map);

            const layerGroup = L.layerGroup().addTo(map);
            layerGroupRef.current = layerGroup;
            mapRef.current = map;

            // Default center while entries load
            map.setView([-27.207, 153.108], 12);

            setTimeout(() => map.invalidateSize(), 150);

            // Auto-resize when container changes size (e.g. flex-grow)
            const ro = new ResizeObserver(() => map.invalidateSize());
            ro.observe(containerRef.current);

            return () => {
                ro.disconnect();
                map.remove();
                mapRef.current = null;
                layerGroupRef.current = null;
                hasFitRef.current = false;
            };
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

            // Track color
            const mainColor = isPlanned ? '#a78bfa' : '#38bdf8';

            // Track lines
            if (coords.length >= 2) {
                // Glow
                L.polyline(coords, {
                    color: mainColor,
                    weight: 6,
                    opacity: 0.15,
                    lineCap: 'round',
                    lineJoin: 'round',
                }).addTo(lg);

                // Main line
                L.polyline(coords, {
                    color: mainColor,
                    weight: 2.5,
                    opacity: 0.9,
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

            // Fit bounds
            if (coords.length >= 2) {
                const bounds = L.latLngBounds(coords);
                if (isLive || !hasFitRef.current) {
                    map.fitBounds(bounds, { padding: [16, 16], maxZoom: 15, animate: false });
                    hasFitRef.current = true;
                }
            } else if (coords.length === 1) {
                map.setView(coords[0], 14, { animate: false });
                hasFitRef.current = true;
            }
        }, [entries, isLive]);

        useEffect(() => {
            const timer = setTimeout(updateLayers, 100);
            return () => clearTimeout(timer);
        }, [updateLayers]);

        return (
            <div
                ref={containerRef}
                className={`w-full rounded-xl overflow-hidden border border-white/5 ${className}`}
                style={{ height }}
            />
        );
    },
);

LiveMiniMap.displayName = 'LiveMiniMap';
