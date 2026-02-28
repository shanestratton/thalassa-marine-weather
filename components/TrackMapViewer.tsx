/**
 * Track Map Viewer
 * Full-screen voyage track visualization with playback scrubber.
 *
 * Features:
 *   - CARTO dark base + OpenSeaMap seamark overlay
 *   - Color-coded track segments (water=blue, land=green)
 *   - Start/End/Waypoint markers with popup info
 *   - Butter-smooth playback scrubber (matches SynopticScrubber style)
 *   - Animated vessel marker that moves along the track
 *   - Speed & weather info in scrubber label
 *
 * Map is created ONCE on open, layers updated separately.
 */

import React, { useEffect, useRef, useCallback, useState, memo } from 'react';
import { ShipLogEntry } from '../types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface TrackMapViewerProps {
    isOpen: boolean;
    onClose: () => void;
    entries: ShipLogEntry[];
    plannedEntries?: ShipLogEntry[];  // Optional: linked planned route for overlay comparison
}

// ── Vessel Icon (Leaflet DivIcon) ──
const VESSEL_ICON_HTML = `<div style="
    width: 20px; height: 20px;
    background: #00f0ff;
    border: 2px solid white;
    border-radius: 50%;
    box-shadow: 0 0 12px rgba(0,240,255,0.6), 0 2px 8px rgba(0,0,0,0.4);
"></div>`;

export const TrackMapViewer: React.FC<TrackMapViewerProps> = ({ isOpen, onClose, entries, plannedEntries }) => {
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<L.Map | null>(null);
    const layerGroupRef = useRef<L.LayerGroup | null>(null);
    const hasFitBoundsRef = useRef(false);

    // Playback state
    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackIndex, setPlaybackIndex] = useState(0);
    const vesselMarkerRef = useRef<L.Marker | null>(null);
    const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const trailLayerRef = useRef<L.LayerGroup | null>(null);

    // Scrubber refs (direct DOM for butter-smooth dragging)
    const trackRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);
    const fillRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);

    // Sorted entries for playback
    const sortedEntries = useRef<ShipLogEntry[]>([]);

    useEffect(() => {
        const valid = entries.filter(e => e.latitude && e.longitude);
        sortedEntries.current = [...valid].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
    }, [entries]);

    // Create map ONCE when opened
    useEffect(() => {
        if (!isOpen || !mapRef.current) return;

        if (mapInstanceRef.current) {
            setTimeout(() => mapInstanceRef.current?.invalidateSize(), 100);
            return;
        }

        const map = L.map(mapRef.current, {
            zoomControl: true,
            attributionControl: false,
            zoomAnimation: true,
            fadeAnimation: true,
        });

        // Dark nautical tile layer (base)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19
        }).addTo(map);

        // EMODnet Bathymetry overlay
        L.tileLayer('https://tiles.emodnet-bathymetry.eu/2020/baselayer/web_mercator/{z}/{x}/{y}.png', {
            maxZoom: 12,
            opacity: 0.35,
        }).addTo(map);

        // OpenSeaMap seamark overlay
        L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
            maxZoom: 18,
            opacity: 0.85,
        }).addTo(map);

        // Layer group for track data
        const layerGroup = L.layerGroup().addTo(map);
        layerGroupRef.current = layerGroup;

        // Trail layer for playback
        const trailLayer = L.layerGroup().addTo(map);
        trailLayerRef.current = trailLayer;

        mapInstanceRef.current = map;
        setTimeout(() => map.invalidateSize(), 200);

        return () => {
            if (playIntervalRef.current) clearInterval(playIntervalRef.current);
            if (mapInstanceRef.current) {
                mapInstanceRef.current.remove();
                mapInstanceRef.current = null;
                layerGroupRef.current = null;
                trailLayerRef.current = null;
                vesselMarkerRef.current = null;
                hasFitBoundsRef.current = false;
            }
        };
    }, [isOpen]);

    // Reset playback when modal opens/closes
    useEffect(() => {
        if (isOpen) {
            setPlaybackIndex(0);
            setIsPlaying(false);
        }
    }, [isOpen]);

    // Update track layers when entries change
    const updateTrackLayers = useCallback(() => {
        const map = mapInstanceRef.current;
        const layerGroup = layerGroupRef.current;
        if (!map || !layerGroup) return;

        layerGroup.clearLayers();

        const validEntries = entries.filter(e => e.latitude && e.longitude);
        if (validEntries.length < 2) return;

        const sorted = [...validEntries].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );

        const trackCoords = sorted.map(e => [e.latitude!, e.longitude!] as [number, number]);

        // Detect if this is a planned route
        const isPlannedRoute = sorted.some(e => e.source === 'planned_route');

        // Color-segmented polylines
        let currentSegment: [number, number][] = [];
        let currentIsWater = sorted[0].isOnWater ?? true;

        const addSegment = (coords: [number, number][], isWater: boolean) => {
            if (coords.length < 2) return;
            // Planned routes use violet, regular tracks use blue/green
            const color = isPlannedRoute ? '#a78bfa' : (isWater ? '#38bdf8' : '#34d399');

            L.polyline(coords, {
                color, weight: 8, opacity: 0.2,
                lineCap: 'round', lineJoin: 'round'
            }).addTo(layerGroup);

            L.polyline(coords, {
                color, weight: 3, opacity: 1,
                lineCap: 'round', lineJoin: 'round'
            }).addTo(layerGroup);
        };

        sorted.forEach((entry) => {
            const isWater = entry.isOnWater ?? true;
            const coord: [number, number] = [entry.latitude!, entry.longitude!];

            if (isWater !== currentIsWater && currentSegment.length > 0) {
                currentSegment.push(coord);
                addSegment(currentSegment, currentIsWater);
                currentSegment = [coord];
                currentIsWater = isWater;
            } else {
                currentSegment.push(coord);
            }
        });
        addSegment(currentSegment, currentIsWater);

        // Start marker
        const startIcon = L.divIcon({
            html: `<div style="width:24px;height:24px;background:#34d399;border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.4)"></div>`,
            iconSize: [24, 24], iconAnchor: [12, 12], className: ''
        });
        L.marker([sorted[0].latitude!, sorted[0].longitude!], { icon: startIcon })
            .addTo(layerGroup)
            .bindPopup(`<div style="font-size:12px"><strong style="color:#34d399">START</strong><br/>${new Date(sorted[0].timestamp).toLocaleString()}<br/>${sorted[0].positionFormatted || ''}</div>`);

        // End marker
        const endIcon = L.divIcon({
            html: `<div style="width:24px;height:24px;background:#ef4444;border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.4)"></div>`,
            iconSize: [24, 24], iconAnchor: [12, 12], className: ''
        });
        const lastEntry = sorted[sorted.length - 1];
        L.marker([lastEntry.latitude!, lastEntry.longitude!], { icon: endIcon })
            .addTo(layerGroup)
            .bindPopup(`<div style="font-size:12px"><strong style="color:#ef4444">END</strong><br/>${new Date(lastEntry.timestamp).toLocaleString()}<br/>${lastEntry.positionFormatted || ''}</div>`);

        // Waypoint markers
        sorted.filter(e => e.entryType === 'waypoint').forEach(entry => {
            const wpIcon = L.divIcon({
                html: `<div style="width:16px;height:16px;background:#f59e0b;border:2px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`,
                iconSize: [16, 16], iconAnchor: [8, 8], className: ''
            });
            L.marker([entry.latitude!, entry.longitude!], { icon: wpIcon })
                .addTo(layerGroup)
                .bindPopup(`<div style="font-size:12px"><strong style="color:#f59e0b">${entry.waypointName || 'Waypoint'}</strong><br/>${new Date(entry.timestamp).toLocaleString()}<br/>${entry.notes || ''}</div>`);
        });

        // GPS dots
        sorted.forEach(entry => {
            if (entry.entryType === 'waypoint') return;
            L.circleMarker([entry.latitude!, entry.longitude!], {
                radius: 2,
                fillColor: entry.isOnWater ? '#38bdf8' : '#34d399',
                fillOpacity: 0.6,
                stroke: false,
            }).addTo(layerGroup);
        });

        // ═══ PLANNED ROUTE OVERLAY (violet dashed line) ═══
        let allBoundsCoords = [...trackCoords];

        if (plannedEntries && plannedEntries.length >= 2) {
            const planned = [...plannedEntries]
                .filter(e => e.latitude && e.longitude)
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

            if (planned.length >= 2) {
                const planCoords = planned.map(e => [e.latitude!, e.longitude!] as [number, number]);
                allBoundsCoords = [...allBoundsCoords, ...planCoords];

                // Violet glow
                L.polyline(planCoords, {
                    color: '#a78bfa', weight: 8, opacity: 0.15,
                    lineCap: 'round', lineJoin: 'round',
                }).addTo(layerGroup);

                // Violet dashed core
                L.polyline(planCoords, {
                    color: '#a78bfa', weight: 2.5, opacity: 0.7,
                    lineCap: 'round', lineJoin: 'round',
                    dashArray: '10 8',
                }).addTo(layerGroup);

                // Planned waypoint dots (small violet)
                planned.forEach(e => {
                    L.circleMarker([e.latitude!, e.longitude!], {
                        radius: 3, fillColor: '#c4b5fd', fillOpacity: 0.8,
                        color: 'white', weight: 1,
                    }).addTo(layerGroup);
                });

                // ═══ DEVIATION MARKERS — where actual diverged from plan ═══
                // Haversine helper for NM
                const hav = (lat1: number, lon1: number, lat2: number, lon2: number) => {
                    const R = 3440.065;
                    const dLat = (lat2 - lat1) * Math.PI / 180;
                    const dLon = (lon2 - lon1) * Math.PI / 180;
                    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
                    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                };

                // Sample every ~10th actual point
                const step = Math.max(1, Math.floor(sorted.length / 30));
                let maxDeviation = 0;
                let maxDevPt: [number, number] | null = null;

                for (let i = 0; i < sorted.length; i += step) {
                    const pt = sorted[i];
                    if (!pt.latitude || !pt.longitude) continue;

                    // Find nearest planned point
                    let minDist = Infinity;
                    for (const pp of planned) {
                        const d = hav(pt.latitude, pt.longitude, pp.latitude!, pp.longitude!);
                        if (d < minDist) minDist = d;
                    }

                    if (minDist > maxDeviation) {
                        maxDeviation = minDist;
                        maxDevPt = [pt.latitude, pt.longitude];
                    }

                    // Show orange deviation dot if > 0.5 NM off plan
                    if (minDist > 0.5) {
                        L.circleMarker([pt.latitude, pt.longitude], {
                            radius: 4,
                            fillColor: '#f97316',
                            fillOpacity: 0.7,
                            color: '#f97316',
                            weight: 1,
                        }).addTo(layerGroup)
                            .bindPopup(`<div style="font-size:11px"><strong style="color:#f97316">⚠ Deviation</strong><br/>${minDist.toFixed(1)} NM off plan</div>`);
                    }
                }

                // Max deviation marker (larger, red)
                if (maxDevPt && maxDeviation > 0.5) {
                    L.circleMarker(maxDevPt, {
                        radius: 7,
                        fillColor: '#ef4444',
                        fillOpacity: 0.8,
                        color: 'white',
                        weight: 2,
                    }).addTo(layerGroup)
                        .bindPopup(`<div style="font-size:11px"><strong style="color:#ef4444">📍 Max Deviation</strong><br/>${maxDeviation.toFixed(1)} NM off planned route</div>`)
                        .openPopup();
                }
            }
        }

        // Fit bounds on first load only (include both tracks)
        if (!hasFitBoundsRef.current) {
            const bounds = L.latLngBounds(allBoundsCoords);
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16, animate: false });
            hasFitBoundsRef.current = true;
        }

        // Create vessel marker for playback (initially hidden)
        if (!vesselMarkerRef.current && map) {
            const vesselIcon = L.divIcon({
                html: VESSEL_ICON_HTML,
                iconSize: [20, 20],
                iconAnchor: [10, 10],
                className: '',
            });
            const marker = L.marker([sorted[0].latitude!, sorted[0].longitude!], {
                icon: vesselIcon,
                zIndexOffset: 1000,
            });
            vesselMarkerRef.current = marker;
            // Don't add to map yet — added on first scrub/play
        }
    }, [entries, plannedEntries]);

    // Trigger layer update
    useEffect(() => {
        if (!isOpen) return;
        const timer = setTimeout(updateTrackLayers, 300);
        return () => clearTimeout(timer);
    }, [isOpen, updateTrackLayers]);

    // ── Playback engine ──
    const moveVesselTo = useCallback((index: number) => {
        const sorted = sortedEntries.current;
        if (!sorted.length || index < 0 || index >= sorted.length) return;

        const entry = sorted[index];
        const marker = vesselMarkerRef.current;
        const map = mapInstanceRef.current;
        if (!marker || !map) return;

        // Ensure marker is on map
        if (!map.hasLayer(marker)) {
            marker.addTo(map);
        }

        marker.setLatLng([entry.latitude!, entry.longitude!]);

        // Update scrubber visuals directly (no React re-render during drag)
        const pct = sorted.length > 1 ? (index / (sorted.length - 1)) * 100 : 0;
        if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
        if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    }, []);

    // Play/pause
    const togglePlayback = useCallback(() => {
        setIsPlaying(prev => {
            if (!prev) {
                // Start playing
                const sorted = sortedEntries.current;
                if (!sorted.length) return false;

                // If at end, restart
                let startIdx = playbackIndex;
                if (startIdx >= sorted.length - 1) {
                    startIdx = 0;
                    setPlaybackIndex(0);
                }

                const interval = setInterval(() => {
                    setPlaybackIndex(idx => {
                        const next = idx + 1;
                        if (next >= sorted.length) {
                            clearInterval(interval);
                            playIntervalRef.current = null;
                            setIsPlaying(false);
                            return idx;
                        }
                        moveVesselTo(next);
                        return next;
                    });
                }, 80); // ~12.5 fps for smooth animation

                playIntervalRef.current = interval;
                moveVesselTo(startIdx);
                return true;
            } else {
                // Pause
                if (playIntervalRef.current) {
                    clearInterval(playIntervalRef.current);
                    playIntervalRef.current = null;
                }
                return false;
            }
        });
    }, [playbackIndex, moveVesselTo]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (playIntervalRef.current) clearInterval(playIntervalRef.current);
        };
    }, []);

    // ── Scrubber pointer handlers ──
    const positionToIndex = useCallback((clientX: number) => {
        const track = trackRef.current;
        if (!track) return 0;
        const rect = track.getBoundingClientRect();
        const ratio = (clientX - rect.left) / rect.width;
        const maxIdx = sortedEntries.current.length - 1;
        return Math.max(0, Math.min(maxIdx, Math.round(ratio * maxIdx)));
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        isDraggingRef.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);

        // Pause if playing
        if (playIntervalRef.current) {
            clearInterval(playIntervalRef.current);
            playIntervalRef.current = null;
            setIsPlaying(false);
        }

        const idx = positionToIndex(e.clientX);
        setPlaybackIndex(idx);
        moveVesselTo(idx);

        if (thumbRef.current) {
            thumbRef.current.style.transform = 'translate(-50%, -50%) scale(1.4)';
        }
    }, [positionToIndex, moveVesselTo]);

    const handlePointerMove = useCallback((e: React.PointerEvent) => {
        if (!isDraggingRef.current) return;
        e.preventDefault();

        const idx = positionToIndex(e.clientX);
        setPlaybackIndex(idx);
        moveVesselTo(idx);
    }, [positionToIndex, moveVesselTo]);

    const handlePointerUp = useCallback((e: React.PointerEvent) => {
        if (!isDraggingRef.current) return;
        isDraggingRef.current = false;

        const idx = positionToIndex(e.clientX);
        setPlaybackIndex(idx);
        moveVesselTo(idx);

        if (thumbRef.current) {
            thumbRef.current.style.transform = 'translate(-50%, -50%) scale(1)';
        }
    }, [positionToIndex, moveVesselTo]);

    if (!isOpen) return null;

    // Stats
    const validEntries = entries.filter(e => e.latitude && e.longitude);
    const sorted = [...validEntries].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    const totalDistance = sorted.length > 0
        ? (sorted[sorted.length - 1].cumulativeDistanceNM || 0).toFixed(1)
        : '0.0';
    const waypointCount = entries.filter(e => e.entryType === 'waypoint').length;

    // Current entry for scrubber label
    const currentEntry = sorted[playbackIndex] || null;
    const timeLabel = currentEntry
        ? new Date(currentEntry.timestamp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
        : '--:--';
    const speedLabel = currentEntry?.speedKts != null
        ? `${currentEntry.speedKts.toFixed(1)} kts`
        : '';
    const tempLabel = currentEntry?.airTemp != null
        ? `${(typeof currentEntry.airTemp === 'number' ? currentEntry.airTemp.toFixed(0) : currentEntry.airTemp)}°C`
        : '';

    const maxIdx = sorted.length - 1;
    const pct = maxIdx > 0 ? (playbackIndex / maxIdx) * 100 : 0;

    return (
        <div className="fixed inset-0 z-[9999] bg-slate-900 flex flex-col">
            {/* Header */}
            <div className="bg-slate-800 border-b border-white/10 p-4 flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white">Voyage Track</h2>
                    <div className="text-xs text-slate-400 flex gap-4 mt-1">
                        <span>{totalDistance} NM</span>
                        <span>{sorted.length} positions</span>
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

            {/* ═══ PLAYBACK SCRUBBER (matches SynopticScrubber style) ═══ */}
            <div className="bg-slate-900/95 backdrop-blur-xl border-t border-white/[0.08] px-4 py-3">
                <div className="flex items-center gap-3">
                    {/* Play / Pause */}
                    <button
                        onClick={togglePlayback}
                        className="w-10 h-10 flex items-center justify-center rounded-xl bg-sky-500/20 border border-sky-500/30 shrink-0 active:scale-90 transition-transform"
                    >
                        <span className="text-base">{isPlaying ? '⏸' : '▶️'}</span>
                    </button>

                    {/* Custom track */}
                    <div
                        ref={trackRef}
                        className="flex-1 relative h-10 flex items-center cursor-pointer"
                        style={{ touchAction: 'none' }}
                        onPointerDown={handlePointerDown}
                        onPointerMove={handlePointerMove}
                        onPointerUp={handlePointerUp}
                        onPointerCancel={handlePointerUp}
                    >
                        {/* Track background */}
                        <div className="w-full h-1.5 bg-white/10 rounded-full relative overflow-hidden">
                            {/* Active fill */}
                            <div
                                ref={fillRef}
                                className="absolute inset-y-0 left-0 bg-sky-500/40 rounded-full"
                                style={{ width: `${pct}%`, willChange: 'width' }}
                            />
                        </div>

                        {/* Thumb */}
                        <div
                            ref={thumbRef}
                            className="absolute top-1/2 w-5 h-5 -ml-[0.5px] bg-sky-400 rounded-full shadow-lg shadow-sky-400/30 border-2 border-white/40 pointer-events-none"
                            style={{
                                left: `${pct}%`,
                                transform: 'translate(-50%, -50%) scale(1)',
                                transition: isDraggingRef.current ? 'none' : 'transform 0.15s ease-out',
                                willChange: 'left, transform',
                            }}
                        />

                        {/* Touch target expansion */}
                        <div className="absolute inset-0" />
                    </div>

                    {/* Time + info label */}
                    <div className="shrink-0 text-right min-w-[64px]">
                        <p className="text-xs font-black text-white">{timeLabel}</p>
                        <p className="text-[11px] text-gray-500 font-bold uppercase tracking-widest">
                            {speedLabel}{speedLabel && tempLabel ? ' · ' : ''}{tempLabel}
                        </p>
                    </div>
                </div>
            </div>

            {/* Legend */}
            <div className="bg-slate-800 border-t border-white/10 p-3 flex justify-center gap-4 flex-wrap text-xs">
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
                    <div className="w-3 h-3 rounded-full" style={{ background: '#00f0ff', boxShadow: '0 0 6px rgba(0,240,255,0.5)' }}></div>
                    <span className="text-slate-300">Vessel</span>
                </div>
                {plannedEntries && plannedEntries.length >= 2 && (
                    <>
                        <div className="flex items-center gap-2">
                            <div className="w-4 h-0.5 bg-violet-400" style={{ borderTop: '2px dashed #a78bfa' }}></div>
                            <span className="text-violet-300">Planned</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full bg-orange-500"></div>
                            <span className="text-orange-300">Deviation</span>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
