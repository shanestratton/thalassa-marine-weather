/**
 * BoundingBoxOverlay — Draggable, resizable Leaflet rectangle for selecting
 * a GRIB download bounding box on the map.
 *
 * Renders 4 corner handles + coordinate labels. Emits bbox changes on drag.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { GribBoundingBox } from '../../types';

interface BoundingBoxOverlayProps {
    /** The Leaflet map instance to attach to */
    map: L.Map | null;
    /** Current bounding box coordinates */
    bbox: GribBoundingBox;
    /** Called when user drags/resizes the box */
    onChange: (bbox: GribBoundingBox) => void;
    /** Whether the overlay is active/visible */
    active: boolean;
}

// Handle CSS size
const HANDLE_SIZE = 14;

export const BoundingBoxOverlay: React.FC<BoundingBoxOverlayProps> = ({ map, bbox, onChange, active }) => {
    const rectangleRef = useRef<L.Rectangle | null>(null);
    const handlesRef = useRef<L.Marker[]>([]);
    const [localBbox, setLocalBbox] = useState(bbox);

    // Sync external bbox changes
    useEffect(() => { setLocalBbox(bbox); }, [bbox]);

    // Create/update the rectangle and handles
    useEffect(() => {
        if (!map || !active) {
            cleanup();
            return;
        }

        // Ensure Leaflet is available
        const L = (window as unknown as { L: typeof import('leaflet') }).L;
        if (!L) return;

        // Create rectangle
        const bounds: L.LatLngBoundsExpression = [
            [localBbox.south, localBbox.west],
            [localBbox.north, localBbox.east],
        ];

        if (rectangleRef.current) {
            rectangleRef.current.setBounds(bounds);
        } else {
            rectangleRef.current = L.rectangle(bounds, {
                color: '#0ea5e9',
                weight: 2,
                fillColor: '#0ea5e9',
                fillOpacity: 0.08,
                dashArray: '8 4',
                interactive: false,
            }).addTo(map);
        }

        // Create corner handles
        updateHandles(L, map, localBbox);

        return () => cleanup();
    }, [map, active]);

    // Update rectangle position when bbox changes
    useEffect(() => {
        if (!rectangleRef.current) return;
        const L = (window as unknown as { L: typeof import('leaflet') }).L;
        if (!L) return;

        const bounds: L.LatLngBoundsExpression = [
            [localBbox.south, localBbox.west],
            [localBbox.north, localBbox.east],
        ];
        rectangleRef.current.setBounds(bounds);
        updateHandles(L, map!, localBbox);
    }, [localBbox]);

    const updateHandles = useCallback((L: typeof import('leaflet'), mapInstance: L.Map, bb: GribBoundingBox) => {
        // Remove existing handles
        for (const h of handlesRef.current) mapInstance.removeLayer(h);
        handlesRef.current = [];

        const corners: { lat: number; lng: number; corner: 'nw' | 'ne' | 'sw' | 'se' }[] = [
            { lat: bb.north, lng: bb.west, corner: 'nw' },
            { lat: bb.north, lng: bb.east, corner: 'ne' },
            { lat: bb.south, lng: bb.west, corner: 'sw' },
            { lat: bb.south, lng: bb.east, corner: 'se' },
        ];

        for (const c of corners) {
            const icon = L.divIcon({
                className: 'grib-bbox-handle',
                html: `<div style="
                    width:${HANDLE_SIZE}px;height:${HANDLE_SIZE}px;
                    background:#0ea5e9;border:2px solid #fff;border-radius:3px;
                    box-shadow:0 2px 8px rgba(0,0,0,0.4);cursor:grab;
                "></div>`,
                iconSize: [HANDLE_SIZE, HANDLE_SIZE],
                iconAnchor: [HANDLE_SIZE / 2, HANDLE_SIZE / 2],
            });

            const marker = L.marker([c.lat, c.lng], {
                icon,
                draggable: true,
                zIndexOffset: 1000,
            }).addTo(mapInstance);

            marker.on('drag', (e: L.LeafletEvent) => {
                const pos = (e.target as L.Marker).getLatLng();
                setLocalBbox(prev => {
                    const updated = { ...prev };
                    switch (c.corner) {
                        case 'nw': updated.north = pos.lat; updated.west = pos.lng; break;
                        case 'ne': updated.north = pos.lat; updated.east = pos.lng; break;
                        case 'sw': updated.south = pos.lat; updated.west = pos.lng; break;
                        case 'se': updated.south = pos.lat; updated.east = pos.lng; break;
                    }
                    return updated;
                });
            });

            marker.on('dragend', () => {
                setLocalBbox(current => {
                    // Normalize: ensure north > south, east > west
                    const normalized: GribBoundingBox = {
                        north: Math.max(current.north, current.south),
                        south: Math.min(current.north, current.south),
                        east: Math.max(current.east, current.west),
                        west: Math.min(current.east, current.west),
                    };
                    onChange(normalized);
                    return normalized;
                });
            });

            handlesRef.current.push(marker);
        }
    }, [onChange]);

    const cleanup = useCallback(() => {
        if (rectangleRef.current && map) {
            map.removeLayer(rectangleRef.current);
            rectangleRef.current = null;
        }
        for (const h of handlesRef.current) {
            if (map) map.removeLayer(h);
        }
        handlesRef.current = [];
    }, [map]);

    if (!active) return null;

    // Coordinate display overlay (positioned outside the map in the React tree)
    return (
        <div className="absolute bottom-2 left-2 z-[500] bg-black/80 backdrop-blur-sm border border-white/10 rounded-xl px-3 py-2">
            <p className="text-[9px] font-bold text-sky-400 uppercase tracking-widest mb-1">Bounding Box</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                <span className="text-[9px] text-gray-400">N</span>
                <span className="text-[10px] text-white font-mono">{localBbox.north.toFixed(2)}°</span>
                <span className="text-[9px] text-gray-400">S</span>
                <span className="text-[10px] text-white font-mono">{localBbox.south.toFixed(2)}°</span>
                <span className="text-[9px] text-gray-400">W</span>
                <span className="text-[10px] text-white font-mono">{localBbox.west.toFixed(2)}°</span>
                <span className="text-[9px] text-gray-400">E</span>
                <span className="text-[10px] text-white font-mono">{localBbox.east.toFixed(2)}°</span>
            </div>
        </div>
    );
};
