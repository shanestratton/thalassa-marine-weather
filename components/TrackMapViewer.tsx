/**
 * Track Map Viewer
 * Full-screen voyage track visualization with playback scrubber.
 *
 * Features:
 *   - CARTO dark base + OpenSeaMap seamark overlay
 *   - Color-coded track segments (water=blue, land=green)
 *   - Start/End/Waypoint markers with popup info
 *   - Butter-smooth playback scrubber with play/pause
 *   - Animated vessel marker that moves along the track
 *   - Floating weather HUD showing conditions at current position
 *
 * Map is created ONCE on open, layers updated separately.
 */

import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { ShipLogEntry } from '../types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

interface TrackMapViewerProps {
    isOpen: boolean;
    onClose: () => void;
    entries: ShipLogEntry[];
}

// ── Vessel Icon (Leaflet DivIcon) ──
const VESSEL_ICON_HTML = `<div style="
    width: 20px; height: 20px;
    background: #00f0ff;
    border: 2px solid white;
    border-radius: 50%;
    box-shadow: 0 0 12px rgba(0,240,255,0.6), 0 2px 8px rgba(0,0,0,0.4);
"></div>`;

export const TrackMapViewer: React.FC<TrackMapViewerProps> = ({ isOpen, onClose, entries }) => {
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<L.Map | null>(null);
    const layerGroupRef = useRef<L.LayerGroup | null>(null);
    const hasFitBoundsRef = useRef(false);

    // Playback state
    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackIndex, setPlaybackIndex] = useState(0);
    const [showHUD, setShowHUD] = useState(false);
    const vesselMarkerRef = useRef<L.Marker | null>(null);
    const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const trailLayerRef = useRef<L.LayerGroup | null>(null);

    // Scrubber refs (direct DOM for butter-smooth dragging)
    const trackRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);
    const fillRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);

    // Sorted entries for playback
    const sortedEntriesRef = useRef<ShipLogEntry[]>([]);

    const sortedEntries = useMemo(() => {
        const valid = entries.filter(e => e.latitude && e.longitude);
        const sorted = [...valid].sort((a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        );
        sortedEntriesRef.current = sorted;
        return sorted;
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
            setShowHUD(false);
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

        // Fit bounds on first load only
        if (!hasFitBoundsRef.current) {
            const bounds = L.latLngBounds(trackCoords);
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
        }
    }, [entries]);

    // Trigger layer update
    useEffect(() => {
        if (!isOpen) return;
        const timer = setTimeout(updateTrackLayers, 300);
        return () => clearTimeout(timer);
    }, [isOpen, updateTrackLayers]);

    // ── Playback engine ──
    const moveVesselTo = useCallback((index: number) => {
        const sorted = sortedEntriesRef.current;
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
                // Start playing — show the HUD
                setShowHUD(true);
                const sorted = sortedEntriesRef.current;
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
        const maxIdx = sortedEntriesRef.current.length - 1;
        return Math.max(0, Math.min(maxIdx, Math.round(ratio * maxIdx)));
    }, []);

    const handlePointerDown = useCallback((e: React.PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        isDraggingRef.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);

        // Show HUD when scrubbing
        setShowHUD(true);

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
    const totalDistance = sortedEntries.length > 0
        ? (sortedEntries[sortedEntries.length - 1].cumulativeDistanceNM || 0).toFixed(1)
        : '0.0';
    const waypointCount = entries.filter(e => e.entryType === 'waypoint').length;

    // Current entry for scrubber label + HUD
    const currentEntry = sortedEntries[playbackIndex] || null;
    const timeLabel = currentEntry
        ? new Date(currentEntry.timestamp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
        : '--:--';
    const dateLabel = currentEntry
        ? new Date(currentEntry.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
        : '';

    const maxIdx = sortedEntries.length - 1;
    const pct = maxIdx > 0 ? (playbackIndex / maxIdx) * 100 : 0;

    // ── Compute elapsed duration from first entry to current ──
    const elapsedLabel = (() => {
        if (!currentEntry || !sortedEntries[0]) return '';
        const ms = new Date(currentEntry.timestamp).getTime() - new Date(sortedEntries[0].timestamp).getTime();
        const hrs = Math.floor(ms / 3600000);
        const mins = Math.floor((ms % 3600000) / 60000);
        return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    })();

    return (
        <div className="fixed inset-x-0 top-0 z-[9999] bg-slate-900 flex flex-col rounded-b-2xl overflow-hidden" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 64px + 8px)' }}>
            {/* Header */}
            <div className="bg-slate-800/95 backdrop-blur-md border-b border-white/10 flex items-center justify-between" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))', paddingLeft: '16px', paddingRight: '16px', paddingBottom: '12px' }}>
                <div>
                    <h2 className="text-lg font-bold text-white">Voyage Track</h2>
                    <div className="text-[11px] text-slate-400 flex gap-3 mt-0.5">
                        <span>{totalDistance} NM</span>
                        <span>{sortedEntries.length} pts</span>
                        <span>{waypointCount} wpts</span>
                    </div>
                </div>
                <button
                    onClick={onClose}
                    className="w-9 h-9 bg-slate-700 hover:bg-slate-600 rounded-full flex items-center justify-center transition-colors"
                >
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>

            {/* Map Container */}
            <div className="relative flex-1 min-h-0">
                <div ref={mapRef} className="absolute inset-0" />

                {/* ═══ FLOATING WEATHER HUD ═══ */}
                {showHUD && currentEntry && (
                    <div className="absolute top-3 left-3 right-3 z-[1000] pointer-events-none">
                        <div className="bg-slate-900/90 backdrop-blur-xl rounded-xl border border-white/10 shadow-2xl p-3 pointer-events-auto"
                            style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
                        >
                            {/* Top row: Time, Date, Elapsed */}
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-black text-white font-mono">{timeLabel}</span>
                                    <span className="text-[11px] text-slate-500">{dateLabel}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    {elapsedLabel && (
                                        <span className="text-[11px] text-sky-400 font-bold">⏱ {elapsedLabel}</span>
                                    )}
                                    <button
                                        onClick={() => setShowHUD(false)}
                                        className="w-5 h-5 flex items-center justify-center rounded-full bg-white/10 text-white/60 hover:text-white transition-colors pointer-events-auto"
                                    >
                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </button>
                                </div>
                            </div>

                            {/* Metrics grid */}
                            <div className="grid grid-cols-5 gap-1">
                                {/* Speed */}
                                <HUDCell
                                    label="SOG"
                                    value={currentEntry.speedKts != null ? currentEntry.speedKts.toFixed(1) : '--'}
                                    unit="kts"
                                    color="text-sky-400"
                                />
                                {/* Distance */}
                                <HUDCell
                                    label="DIST"
                                    value={currentEntry.cumulativeDistanceNM != null ? currentEntry.cumulativeDistanceNM.toFixed(1) : '--'}
                                    unit="NM"
                                    color="text-sky-400"
                                />
                                {/* Course */}
                                <HUDCell
                                    label="COG"
                                    value={currentEntry.courseDeg != null ? `${Math.round(currentEntry.courseDeg)}°` : '--'}
                                    color="text-sky-400"
                                />
                                {/* Air Temp */}
                                <HUDCell
                                    label="TEMP"
                                    value={currentEntry.airTemp != null ? `${Math.round(currentEntry.airTemp)}°` : '--'}
                                    color="text-emerald-400"
                                />
                                {/* Wind */}
                                <HUDCell
                                    label="WIND"
                                    value={currentEntry.windSpeed != null ? Math.round(currentEntry.windSpeed).toString() : '--'}
                                    unit={currentEntry.windDirection || ''}
                                    color="text-emerald-400"
                                />
                            </div>

                            {/* Second row — only if data exists */}
                            {(currentEntry.waveHeight != null || currentEntry.pressure != null || currentEntry.waterTemp != null || currentEntry.visibility != null || currentEntry.seaState != null) && (
                                <div className="grid grid-cols-5 gap-1 mt-1 pt-1 border-t border-white/5">
                                    {/* Wave */}
                                    <HUDCell
                                        label="WAVE"
                                        value={currentEntry.waveHeight != null ? currentEntry.waveHeight.toFixed(1) : '--'}
                                        unit="m"
                                        color="text-purple-400"
                                    />
                                    {/* Pressure */}
                                    <HUDCell
                                        label="HPA"
                                        value={currentEntry.pressure != null ? Math.round(currentEntry.pressure).toString() : '--'}
                                        color="text-purple-400"
                                    />
                                    {/* Water Temp */}
                                    <HUDCell
                                        label="WATER"
                                        value={currentEntry.waterTemp != null ? `${Math.round(currentEntry.waterTemp)}°` : '--'}
                                        color="text-purple-400"
                                    />
                                    {/* Visibility */}
                                    <HUDCell
                                        label="VIS"
                                        value={currentEntry.visibility != null ? currentEntry.visibility.toFixed(0) : '--'}
                                        unit="NM"
                                        color="text-purple-400"
                                    />
                                    {/* Sea State */}
                                    <HUDCell
                                        label="SEA"
                                        value={currentEntry.seaState != null ? currentEntry.seaState.toString() : '--'}
                                        unit={currentEntry.beaufortScale != null ? `F${currentEntry.beaufortScale}` : ''}
                                        color="text-purple-400"
                                    />
                                </div>
                            )}

                            {/* Notes */}
                            {currentEntry.notes && (
                                <div className="mt-1.5 pt-1.5 border-t border-white/5">
                                    <p className="text-[10px] text-slate-400 leading-relaxed truncate">📝 {currentEntry.notes}</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Legend dots — bottom of map */}
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-[1000] flex gap-3 bg-black/60 backdrop-blur-md rounded-lg px-3 py-1.5">
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                        <span className="text-[9px] text-slate-400">Start</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full bg-red-500"></div>
                        <span className="text-[9px] text-slate-400">End</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full bg-amber-500"></div>
                        <span className="text-[9px] text-slate-400">Wpt</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full" style={{ background: '#00f0ff', boxShadow: '0 0 4px rgba(0,240,255,0.5)' }}></div>
                        <span className="text-[9px] text-slate-400">Vessel</span>
                    </div>
                </div>
            </div>

            {/* ═══ PLAYBACK SCRUBBER ═══ */}
            <div className="bg-slate-900/95 backdrop-blur-xl border-t border-white/[0.08] px-4 py-3">
                <div className="flex items-center gap-3">
                    {/* Play / Pause */}
                    <button
                        onClick={togglePlayback}
                        className="w-11 h-11 flex items-center justify-center rounded-xl bg-sky-500/20 border border-sky-500/30 shrink-0 active:scale-90 transition-transform"
                    >
                        {isPlaying ? (
                            <svg className="w-5 h-5 text-sky-400" fill="currentColor" viewBox="0 0 24 24">
                                <rect x="6" y="4" width="4" height="16" rx="1" />
                                <rect x="14" y="4" width="4" height="16" rx="1" />
                            </svg>
                        ) : (
                            <svg className="w-5 h-5 text-sky-400" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                        )}
                    </button>

                    {/* Custom track */}
                    <div
                        ref={trackRef}
                        className="flex-1 relative h-11 flex items-center cursor-pointer"
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
                    <div className="shrink-0 text-right min-w-[56px]">
                        <p className="text-xs font-black text-white font-mono">{timeLabel}</p>
                        <p className="text-[10px] text-slate-500 font-bold">
                            {currentEntry?.speedKts != null ? `${currentEntry.speedKts.toFixed(1)}kts` : ''}
                        </p>
                    </div>
                </div>

                {/* Progress bar label — track position */}
                <div className="flex justify-between mt-1.5 px-1">
                    <span className="text-[10px] text-slate-600 font-mono">{playbackIndex + 1} / {sortedEntries.length}</span>
                    <span className="text-[10px] text-slate-600 font-mono">{currentEntry?.cumulativeDistanceNM?.toFixed(1) || '0.0'} NM</span>
                </div>
            </div>
        </div>
    );
};

// ── HUD Metric Cell ──
const HUDCell: React.FC<{
    label: string;
    value: string;
    unit?: string;
    color?: string;
}> = ({ label, value, unit, color = 'text-white' }) => (
    <div className="flex flex-col items-center">
        <span className={`text-[9px] font-bold tracking-widest uppercase ${color} opacity-70`}>{label}</span>
        <div className="flex items-baseline gap-0.5">
            <span className="text-xs font-mono font-bold text-white">{value}</span>
            {unit && <span className="text-[8px] text-slate-500">{unit}</span>}
        </div>
    </div>
);
