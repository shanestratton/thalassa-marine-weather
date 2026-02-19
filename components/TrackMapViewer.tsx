/**
 * Track Map Viewer
 * Full-screen voyage track visualization using the map API
 * 
 * FIX: Map is created ONCE on open, layers updated separately.
 * Previously, the useEffect destroyed & recreated the entire map on every
 * entries change, causing flash and zoom snap-back.
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { ShipLogEntry } from '../types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface TrackMapViewerProps {
    isOpen: boolean;
    onClose: () => void;
    entries: ShipLogEntry[];
}

export const TrackMapViewer: React.FC<TrackMapViewerProps> = ({ isOpen, onClose, entries }) => {
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<L.Map | null>(null);
    const layerGroupRef = useRef<L.LayerGroup | null>(null);
    const hasFitBoundsRef = useRef(false);

    // Create map ONCE when opened
    useEffect(() => {
        if (!isOpen || !mapRef.current) return;

        // Don't recreate if map already exists
        if (mapInstanceRef.current) {
            // Just invalidate size in case container resized
            setTimeout(() => mapInstanceRef.current?.invalidateSize(), 100);
            return;
        }

        const map = L.map(mapRef.current, {
            zoomControl: true,
            attributionControl: false,
            // Prevent zoom animation flash
            zoomAnimation: true,
            fadeAnimation: true,
        });

        // Dark nautical tile layer
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
        }).addTo(map);

        // Layer group for track data (updated separately)
        const layerGroup = L.layerGroup().addTo(map);
        layerGroupRef.current = layerGroup;
        mapInstanceRef.current = map;

        // Invalidate size after DOM settles
        setTimeout(() => map.invalidateSize(), 200);

        return () => {
            if (mapInstanceRef.current) {
                mapInstanceRef.current.remove();
                mapInstanceRef.current = null;
                layerGroupRef.current = null;
                hasFitBoundsRef.current = false;
            }
        };
    }, [isOpen]);

    // Update track layers when entries change (WITHOUT recreating the map)
    const updateTrackLayers = useCallback(() => {
        const map = mapInstanceRef.current;
        const layerGroup = layerGroupRef.current;
        if (!map || !layerGroup) return;

        // Clear existing track layers
        layerGroup.clearLayers();

        // Filter entries with valid coordinates
        const validEntries = entries.filter(e => e.latitude && e.longitude);
        if (validEntries.length < 2) return;

        // Sort chronologically
        const sortedEntries = [...validEntries].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        // Build track segments colored by water/land status
        const trackCoords = sortedEntries.map(e => [e.latitude!, e.longitude!] as [number, number]);

        // Build color-segmented polylines (land=green, water=blue)
        let currentSegment: [number, number][] = [];
        let currentIsWater = sortedEntries[0].isOnWater ?? true;

        const addSegment = (coords: [number, number][], isWater: boolean) => {
            if (coords.length < 2) return;
            const color = isWater ? '#38bdf8' : '#34d399';

            // Glow layer
            L.polyline(coords, {
                color,
                weight: 8,
                opacity: 0.2,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(layerGroup);

            // Main track line
            L.polyline(coords, {
                color,
                weight: 3,
                opacity: 1,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(layerGroup);
        };

        sortedEntries.forEach((entry, i) => {
            const isWater = entry.isOnWater ?? true;
            const coord: [number, number] = [entry.latitude!, entry.longitude!];

            if (isWater !== currentIsWater && currentSegment.length > 0) {
                // Finish current segment (include this point for continuity)
                currentSegment.push(coord);
                addSegment(currentSegment, currentIsWater);
                // Start new segment from this point
                currentSegment = [coord];
                currentIsWater = isWater;
            } else {
                currentSegment.push(coord);
            }
        });
        // Flush final segment
        addSegment(currentSegment, currentIsWater);

        // Start marker (green dot)
        const startIcon = L.divIcon({
            html: `<div style="
                width: 24px;
                height: 24px;
                background: #34d399;
                border: 3px solid white;
                border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            "></div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            className: ''
        });

        L.marker([sortedEntries[0].latitude!, sortedEntries[0].longitude!], { icon: startIcon })
            .addTo(layerGroup)
            .bindPopup(`<div style="font-size: 12px;">
                <strong style="color: #34d399;">START</strong><br/>
                ${new Date(sortedEntries[0].timestamp).toLocaleString()}<br/>
                ${sortedEntries[0].positionFormatted || ''}
            </div>`);

        // End marker (red dot)
        const endIcon = L.divIcon({
            html: `<div style="
                width: 24px;
                height: 24px;
                background: #ef4444;
                border: 3px solid white;
                border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            "></div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            className: ''
        });

        const lastEntry = sortedEntries[sortedEntries.length - 1];
        L.marker([lastEntry.latitude!, lastEntry.longitude!], { icon: endIcon })
            .addTo(layerGroup)
            .bindPopup(`<div style="font-size: 12px;">
                <strong style="color: #ef4444;">END</strong><br/>
                ${new Date(lastEntry.timestamp).toLocaleString()}<br/>
                ${lastEntry.positionFormatted || ''}
            </div>`);

        // Waypoint markers (amber dots)
        sortedEntries
            .filter(e => e.entryType === 'waypoint')
            .forEach(entry => {
                const wpIcon = L.divIcon({
                    html: `<div style="
                        width: 16px;
                        height: 16px;
                        background: #f59e0b;
                        border: 2px solid white;
                        border-radius: 50%;
                        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                    "></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8],
                    className: ''
                });

                L.marker([entry.latitude!, entry.longitude!], { icon: wpIcon })
                    .addTo(layerGroup)
                    .bindPopup(`<div style="font-size: 12px;">
                        <strong style="color: #f59e0b;">${entry.waypointName || 'Waypoint'}</strong><br/>
                        ${new Date(entry.timestamp).toLocaleString()}<br/>
                        ${entry.notes || ''}
                    </div>`);
            });

        // GPS position dots — show ALL individual coords as tiny dots
        sortedEntries.forEach(entry => {
            if (entry.entryType === 'waypoint') return; // Already has marker
            L.circleMarker([entry.latitude!, entry.longitude!], {
                radius: 2,
                fillColor: entry.isOnWater ? '#38bdf8' : '#34d399',
                fillOpacity: 0.6,
                stroke: false,
            }).addTo(layerGroup);
        });

        // Fit bounds ONLY on first load — don't snap zoom when entries update during tracking
        if (!hasFitBoundsRef.current) {
            const bounds = L.latLngBounds(trackCoords);
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16, animate: false });
            hasFitBoundsRef.current = true;
        }
    }, [entries]);

    // Trigger layer update when entries change or map is ready
    useEffect(() => {
        if (!isOpen) return;
        // Small delay to ensure map is initialized
        const timer = setTimeout(updateTrackLayers, 300);
        return () => clearTimeout(timer);
    }, [isOpen, updateTrackLayers]);

    if (!isOpen) return null;

    // Calculate voyage stats
    const validEntries = entries.filter(e => e.latitude && e.longitude);
    const sortedEntries = [...validEntries].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const totalDistance = sortedEntries.length > 0
        ? (sortedEntries[sortedEntries.length - 1].cumulativeDistanceNM || 0).toFixed(1)
        : '0.0';

    const waypointCount = entries.filter(e => e.entryType === 'waypoint').length;

    return (
        <div className="fixed inset-0 z-[9999] bg-slate-900 flex flex-col">
            {/* Header */}
            <div className="bg-slate-800 border-b border-white/10 p-4 flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white">Voyage Track</h2>
                    <div className="text-xs text-slate-400 flex gap-4 mt-1">
                        <span>{totalDistance} NM</span>
                        <span>{sortedEntries.length} positions</span>
                        <span>{waypointCount} waypoints</span>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="w-10 h-10 bg-slate-700 hover:bg-slate-600 rounded-full flex items-center justify-center transition-colors"
                >
                    <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {/* Map Container */}
            <div ref={mapRef} className="flex-1" />

            {/* Legend */}
            <div className="bg-slate-800 border-t border-white/10 p-3 flex justify-center gap-6 text-xs">
                <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-green-500"></div>
                    <span className="text-slate-300">Start</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500"></div>
                    <span className="text-slate-300">End</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-amber-500"></div>
                    <span className="text-slate-300">Waypoint</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-6 h-0.5 bg-sky-400 rounded"></div>
                    <span className="text-slate-300">Water</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-6 h-0.5 bg-emerald-400 rounded"></div>
                    <span className="text-slate-300">Land</span>
                </div>
            </div>
        </div>
    );
};
