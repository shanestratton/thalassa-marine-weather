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
import { createLogger } from '../utils/createLogger';

const _log = createLogger('TrackMapViewer');
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

export const TrackMapViewer: React.FC<TrackMapViewerProps> = React.memo(({ isOpen, onClose, entries }) => {
    const mapRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<L.Map | null>(null);
    const layerGroupRef = useRef<L.LayerGroup | null>(null);
    const hasFitBoundsRef = useRef(false);

    // Playback state
    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackIndex, setPlaybackIndex] = useState(0);
    const [showHUD, setShowHUD] = useState(false);
    const [activeWaypoint, setActiveWaypoint] = useState<{
        name: string;
        notes?: string;
        timestamp: string;
        lat?: number;
        lon?: number;
        speedKts?: number;
        courseDeg?: number;
        distanceNM?: number;
        windSpeed?: number;
        windDir?: string;
    } | null>(null);
    const waypointTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        const valid = entries.filter((e) => e.latitude && e.longitude);
        const sorted = [...valid].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        sortedEntriesRef.current = sorted;
        return sorted;
    }, [entries]);

    // Pre-build interpolated animation frames for smooth playback
    // Each frame is { lat, lon, entryIndex } — entryIndex maps back to sortedEntries
    const animFramesRef = useRef<{ lat: number; lon: number; entryIndex: number }[]>([]);
    useMemo(() => {
        const sorted = sortedEntriesRef.current;
        const frames: { lat: number; lon: number; entryIndex: number }[] = [];
        if (sorted.length === 0) {
            animFramesRef.current = frames;
            return;
        }

        for (let i = 0; i < sorted.length; i++) {
            const cur = sorted[i];
            frames.push({ lat: cur.latitude!, lon: cur.longitude!, entryIndex: i });

            if (i < sorted.length - 1) {
                const nxt = sorted[i + 1];
                const dlat = nxt.latitude! - cur.latitude!;
                const dlon = nxt.longitude! - cur.longitude!;
                const dist = Math.sqrt(dlat * dlat + dlon * dlon); // degrees
                // If gap > ~500m (0.005°), insert intermediate frames (~300m steps)
                const STEP = 0.003; // ~300m per frame
                if (dist > STEP * 1.5) {
                    const steps = Math.min(Math.ceil(dist / STEP), 200); // cap at 200 intermediate frames
                    for (let s = 1; s < steps; s++) {
                        const t = s / steps;
                        frames.push({
                            lat: cur.latitude! + dlat * t,
                            lon: cur.longitude! + dlon * t,
                            entryIndex: i, // still belongs to segment starting at entry i
                        });
                    }
                }
            }
        }
        animFramesRef.current = frames;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sortedEntries]);

    // Create map ONCE when opened
    useEffect(() => {
        if (!isOpen || !mapRef.current) return;

        if (mapInstanceRef.current) {
            setTimeout(() => mapInstanceRef.current?.invalidateSize(), 100);
            return;
        }

        const map = L.map(mapRef.current, {
            zoomControl: false,
            attributionControl: false,
            zoomAnimation: true,
            fadeAnimation: true,
        }).setView([-27.5, 153.1], 6); // Default view — fitBounds overrides when track loads

        // Dark nautical tile layer (base)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
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

        const validEntries = entries.filter((e) => e.latitude && e.longitude);
        if (validEntries.length < 2) return;

        const sorted = [...validEntries].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        const trackCoords = sorted.map((e) => [e.latitude!, e.longitude!] as [number, number]);

        // Detect if this is a planned route
        const isPlannedRoute = sorted.some((e) => e.source === 'planned_route');

        // Color-segmented polylines
        let currentSegment: [number, number][] = [];
        let currentIsWater = sorted[0].isOnWater ?? true;

        const addSegment = (coords: [number, number][], isWater: boolean) => {
            if (coords.length < 2) return;
            const color = isPlannedRoute ? '#a78bfa' : isWater ? '#38bdf8' : '#34d399';

            L.polyline(coords, {
                color,
                weight: 8,
                opacity: 0.2,
                lineCap: 'round',
                lineJoin: 'round',
            }).addTo(layerGroup);

            L.polyline(coords, {
                color,
                weight: 3,
                opacity: 1,
                lineCap: 'round',
                lineJoin: 'round',
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
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            className: '',
        });
        L.marker([sorted[0].latitude!, sorted[0].longitude!], { icon: startIcon }).addTo(layerGroup);

        // End marker
        const endIcon = L.divIcon({
            html: `<div style="width:24px;height:24px;background:#ef4444;border:3px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.4)"></div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
            className: '',
        });
        const lastEntry = sorted[sorted.length - 1];
        L.marker([lastEntry.latitude!, lastEntry.longitude!], { icon: endIcon }).addTo(layerGroup);

        // Waypoint markers
        sorted
            .filter((e) => e.entryType === 'waypoint')
            .forEach((entry) => {
                const wpIcon = L.divIcon({
                    html: `<div style="width:16px;height:16px;background:#f59e0b;border:2px solid white;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.3)"></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8],
                    className: '',
                });
                L.marker([entry.latitude!, entry.longitude!], { icon: wpIcon }).addTo(layerGroup);
            });

        // GPS dots
        sorted.forEach((entry) => {
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

    // ── Playback engine (uses interpolated frames) ──
    const moveVesselTo = useCallback((index: number) => {
        const sorted = sortedEntriesRef.current;
        if (!sorted.length || index < 0 || index >= sorted.length) return;

        const entry = sorted[index];
        const marker = vesselMarkerRef.current;
        const map = mapInstanceRef.current;
        if (!marker || !map) return;

        if (!map.hasLayer(marker)) marker.addTo(map);
        marker.setLatLng([entry.latitude!, entry.longitude!]);

        const pct = sorted.length > 1 ? (index / (sorted.length - 1)) * 100 : 0;
        if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
        if (fillRef.current) fillRef.current.style.width = `${pct}%`;
    }, []);

    // Move vessel to an interpolated frame position (no scrubber update)
    const moveVesselToFrame = useCallback((frame: { lat: number; lon: number }) => {
        const marker = vesselMarkerRef.current;
        const map = mapInstanceRef.current;
        if (!marker || !map) return;
        if (!map.hasLayer(marker)) marker.addTo(map);
        marker.setLatLng([frame.lat, frame.lon]);
    }, []);

    // Play/pause
    const togglePlayback = useCallback(() => {
        setIsPlaying((prev) => {
            if (!prev) {
                setShowHUD(true);
                const frames = animFramesRef.current;
                const sorted = sortedEntriesRef.current;
                if (!frames.length || !sorted.length) return false;

                // Determine starting frame index from current playbackIndex
                let startFrameIdx = 0;
                if (playbackIndex >= sorted.length - 1) {
                    startFrameIdx = 0;
                    setPlaybackIndex(0);
                } else {
                    // Find the frame that corresponds to the current entry
                    startFrameIdx = frames.findIndex((f) => f.entryIndex >= playbackIndex);
                    if (startFrameIdx < 0) startFrameIdx = 0;
                }

                let frameIdx = startFrameIdx;
                const interval = setInterval(() => {
                    frameIdx++;
                    if (frameIdx >= frames.length) {
                        clearInterval(interval);
                        playIntervalRef.current = null;
                        setIsPlaying(false);
                        setPlaybackIndex(sorted.length - 1);
                        moveVesselTo(sorted.length - 1);
                        return;
                    }
                    const frame = frames[frameIdx];
                    moveVesselToFrame(frame);

                    // Update scrubber position smoothly
                    const pct = (frameIdx / (frames.length - 1)) * 100;
                    if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
                    if (fillRef.current) fillRef.current.style.width = `${pct}%`;

                    // Update playbackIndex when we cross into a new entry
                    setPlaybackIndex((prev) => {
                        if (frame.entryIndex !== prev) return frame.entryIndex;
                        return prev;
                    });
                }, 50); // ~20fps — smooth and enjoyable

                playIntervalRef.current = interval;
                moveVesselToFrame(frames[startFrameIdx]);
                return true;
            } else {
                if (playIntervalRef.current) {
                    clearInterval(playIntervalRef.current);
                    playIntervalRef.current = null;
                }
                return false;
            }
        });
    }, [playbackIndex, moveVesselTo, moveVesselToFrame]);

    // Detect waypoint crossing during playback
    useEffect(() => {
        if (!showHUD) return;
        const entry = sortedEntriesRef.current[playbackIndex];
        if (!entry) return;

        if (entry.entryType === 'waypoint') {
            // Clear any existing timer
            if (waypointTimerRef.current) clearTimeout(waypointTimerRef.current);
            setActiveWaypoint({
                name: entry.waypointName || 'Waypoint',
                notes: entry.notes || undefined,
                timestamp: new Date(entry.timestamp).toLocaleTimeString('en-AU', {
                    hour: '2-digit',
                    minute: '2-digit',
                }),
                lat: entry.latitude,
                lon: entry.longitude,
                speedKts: entry.speedKts,
                courseDeg: entry.courseDeg,
                distanceNM: entry.cumulativeDistanceNM,
                windSpeed: entry.windSpeed,
                windDir: entry.windDirection,
            });
            // Auto-dismiss after 6 seconds (more time for extra info)
            waypointTimerRef.current = setTimeout(() => setActiveWaypoint(null), 6000);
        }
    }, [playbackIndex, showHUD]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (playIntervalRef.current) clearInterval(playIntervalRef.current);
            if (waypointTimerRef.current) clearTimeout(waypointTimerRef.current);
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

    const _handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
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
        },
        [positionToIndex, moveVesselTo],
    );

    const _handlePointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!isDraggingRef.current) return;
            e.preventDefault();

            const idx = positionToIndex(e.clientX);
            setPlaybackIndex(idx);
            moveVesselTo(idx);
        },
        [positionToIndex, moveVesselTo],
    );

    const _handlePointerUp = useCallback(
        (e: React.PointerEvent) => {
            if (!isDraggingRef.current) return;
            isDraggingRef.current = false;

            const idx = positionToIndex(e.clientX);
            setPlaybackIndex(idx);
            moveVesselTo(idx);

            if (thumbRef.current) {
                thumbRef.current.style.transform = 'translate(-50%, -50%) scale(1)';
            }
        },
        [positionToIndex, moveVesselTo],
    );

    if (!isOpen) return null;

    // Stats
    const totalDistance =
        sortedEntries.length > 0
            ? (sortedEntries[sortedEntries.length - 1].cumulativeDistanceNM || 0).toFixed(1)
            : '0.0';
    const waypointCount = entries.filter((e) => e.entryType === 'waypoint').length;

    // Current entry for scrubber label + HUD
    const currentEntry = sortedEntries[playbackIndex] || null;
    const timeLabel = currentEntry
        ? new Date(currentEntry.timestamp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
        : '--:--';
    const dateLabel = currentEntry
        ? new Date(currentEntry.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
        : '';

    const maxIdx = sortedEntries.length - 1;
    const _pct = maxIdx > 0 ? (playbackIndex / maxIdx) * 100 : 0;

    // ── Compute elapsed duration from first entry to current ──
    const elapsedLabel = (() => {
        if (!currentEntry || !sortedEntries[0]) return '';
        const ms = new Date(currentEntry.timestamp).getTime() - new Date(sortedEntries[0].timestamp).getTime();
        const days = Math.floor(ms / 86400000);
        const hrs = Math.floor((ms % 86400000) / 3600000);
        const mins = Math.floor((ms % 3600000) / 60000);
        if (days > 0) return `${days}d ${hrs}h`;
        return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    })();

    return (
        <div className="fixed inset-0 z-[9999] bg-slate-900 flex flex-col overflow-hidden">
            {/* Title overlay — top left (hidden during playback HUD) */}
            {!showHUD && (
                <div
                    className="absolute top-0 left-0 right-0 z-[1001] px-4"
                    style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
                >
                    <div>
                        <h2 className="text-sm font-bold text-white uppercase tracking-widest drop-shadow-lg">
                            Voyage Track
                        </h2>
                        <div className="text-[11px] text-white/60 flex gap-3 mt-0.5 font-medium">
                            <span>{totalDistance} NM</span>
                            <span>{sortedEntries.length} pts</span>
                            <span>{waypointCount} wpts</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Back chevron — middle-left of screen */}
            <div className="absolute z-[1001] px-3" style={{ top: '50%', transform: 'translateY(-50%)' }}>
                <button
                    onClick={onClose}
                    aria-label="Close track map viewer"
                    className="w-10 h-10 bg-slate-900/90 hover:bg-slate-800 rounded-full flex items-center justify-center border border-white/20 shadow-2xl transition-all hover:scale-110 active:scale-95 shrink-0"
                >
                    <svg
                        className="w-5 h-5 text-white"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>
            </div>

            {/* Map Container */}
            <div className="relative flex-1 min-h-0">
                <div ref={mapRef} className="absolute inset-0" />

                {/* ═══ FLOATING WEATHER HUD ═══ */}
                {showHUD && currentEntry && (
                    <div className="absolute top-3 left-3 right-3 z-[1000] pointer-events-none">
                        <div
                            className="bg-slate-900/90 rounded-xl border border-white/10 shadow-2xl p-3 pointer-events-auto"
                            style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
                        >
                            {/* Top row: Time, Date, Elapsed */}
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-black text-white font-mono">{timeLabel}</span>
                                    <span className="text-[11px] text-slate-400">{dateLabel}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    {elapsedLabel && (
                                        <span className="text-[11px] text-sky-400 font-bold">⏱ {elapsedLabel}</span>
                                    )}
                                    <button
                                        aria-label="Show HUD"
                                        onClick={() => setShowHUD(false)}
                                        className="w-5 h-5 flex items-center justify-center rounded-full bg-white/10 text-white/60 hover:text-white transition-colors pointer-events-auto"
                                    >
                                        <svg
                                            className="w-3 h-3"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M6 18L18 6M6 6l12 12"
                                            />
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
                                    value={
                                        currentEntry.cumulativeDistanceNM != null
                                            ? currentEntry.cumulativeDistanceNM.toFixed(1)
                                            : '--'
                                    }
                                    unit="NM"
                                    color="text-sky-400"
                                />
                                {/* Course */}
                                <HUDCell
                                    label="COG"
                                    value={
                                        currentEntry.courseDeg != null ? `${Math.round(currentEntry.courseDeg)}°` : '--'
                                    }
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
                                    value={
                                        currentEntry.windSpeed != null
                                            ? Math.round(currentEntry.windSpeed).toString()
                                            : '--'
                                    }
                                    unit={currentEntry.windDirection || ''}
                                    color="text-emerald-400"
                                />
                            </div>

                            {/* Second row — only if data exists */}
                            {(currentEntry.waveHeight != null ||
                                currentEntry.pressure != null ||
                                currentEntry.waterTemp != null ||
                                currentEntry.visibility != null ||
                                currentEntry.seaState != null) && (
                                <div className="grid grid-cols-6 gap-1 mt-1 pt-1 border-t border-white/5">
                                    {/* Wave */}
                                    <HUDCell
                                        label="WAVE"
                                        value={
                                            currentEntry.waveHeight != null
                                                ? (currentEntry.waveHeight / 3.28084).toFixed(1)
                                                : '--'
                                        }
                                        unit="m"
                                        color="text-purple-400"
                                    />
                                    {/* Pressure */}
                                    <HUDCell
                                        label="HPA"
                                        value={
                                            currentEntry.pressure != null
                                                ? Math.round(currentEntry.pressure).toString()
                                                : '--'
                                        }
                                        color="text-purple-400"
                                    />
                                    {/* Water Temp */}
                                    <HUDCell
                                        label="WATER"
                                        value={
                                            currentEntry.waterTemp != null
                                                ? `${Math.round(currentEntry.waterTemp)}°`
                                                : '--'
                                        }
                                        color="text-purple-400"
                                    />
                                    {/* Visibility */}
                                    <HUDCell
                                        label="VIS"
                                        value={
                                            currentEntry.visibility != null ? currentEntry.visibility.toFixed(0) : '--'
                                        }
                                        unit="NM"
                                        color="text-purple-400"
                                    />
                                    {/* Sea State */}
                                    <HUDCell
                                        label="SEA"
                                        value={currentEntry.seaState != null ? currentEntry.seaState.toString() : '--'}
                                        color="text-purple-400"
                                    />
                                    {/* Beaufort */}
                                    <HUDCell
                                        label="BFT"
                                        value={
                                            currentEntry.beaufortScale != null ? `F${currentEntry.beaufortScale}` : '--'
                                        }
                                        color="text-purple-400"
                                    />
                                </div>
                            )}

                            {/* Notes */}
                            {currentEntry.notes && (
                                <div className="mt-1.5 pt-1.5 border-t border-white/5">
                                    <p className="text-[11px] text-slate-400 leading-relaxed truncate">
                                        📝 {currentEntry.notes}
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* ═══ WAYPOINT BANNER — persists when crossing a waypoint ═══ */}
                        {activeWaypoint && (
                            <div
                                className="mt-2 bg-amber-500/15 rounded-xl border border-amber-500/30 p-3 pointer-events-auto animate-in fade-in slide-in-from-top-2 duration-300"
                                style={{ boxShadow: '0 4px 20px rgba(245,158,11,0.2)' }}
                            >
                                <div className="flex items-start gap-2">
                                    <span className="text-base mt-0.5">📍</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-black text-amber-300 uppercase tracking-wider">
                                                {activeWaypoint.name}
                                            </span>
                                            <span className="text-[11px] text-amber-400/60 font-mono">
                                                {activeWaypoint.timestamp}
                                            </span>
                                        </div>

                                        {/* Coordinates */}
                                        {activeWaypoint.lat != null && activeWaypoint.lon != null && (
                                            <p className="text-[11px] text-amber-200/80 font-mono mt-1">
                                                {Math.abs(activeWaypoint.lat).toFixed(4)}°
                                                {activeWaypoint.lat >= 0 ? 'N' : 'S'}{' '}
                                                {Math.abs(activeWaypoint.lon).toFixed(4)}°
                                                {activeWaypoint.lon >= 0 ? 'E' : 'W'}
                                            </p>
                                        )}

                                        {/* Stat pills */}
                                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                                            {activeWaypoint.speedKts != null && activeWaypoint.speedKts > 0 && (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-[11px] font-bold text-amber-200">
                                                    ⛵ {activeWaypoint.speedKts.toFixed(1)} kts
                                                </span>
                                            )}
                                            {activeWaypoint.courseDeg != null && (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-[11px] font-bold text-amber-200">
                                                    🧭 {activeWaypoint.courseDeg}°
                                                </span>
                                            )}
                                            {activeWaypoint.distanceNM != null && activeWaypoint.distanceNM > 0 && (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-[11px] font-bold text-amber-200">
                                                    📟 {activeWaypoint.distanceNM.toFixed(1)} NM
                                                </span>
                                            )}
                                            {activeWaypoint.windSpeed != null && activeWaypoint.windSpeed > 0 && (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-sky-500/20 text-[11px] font-bold text-sky-200">
                                                    🌬️ {activeWaypoint.windSpeed} kts {activeWaypoint.windDir || ''}
                                                </span>
                                            )}
                                        </div>

                                        {activeWaypoint.notes && (
                                            <p className="text-[11px] text-amber-200/70 mt-1 leading-relaxed">
                                                {activeWaypoint.notes}
                                            </p>
                                        )}
                                    </div>
                                    <button
                                        aria-label="Active Waypoint"
                                        onClick={() => setActiveWaypoint(null)}
                                        className="w-5 h-5 flex items-center justify-center rounded-full bg-white/10 text-amber-300/60 hover:text-white transition-colors shrink-0"
                                    >
                                        <svg
                                            className="w-3 h-3"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            strokeWidth={2.5}
                                        >
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M6 18L18 6M6 6l12 12"
                                            />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Legend dots — bottom of map */}
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-[1000] flex gap-3 bg-black/60 rounded-lg px-3 py-1.5">
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                        <span className="text-[11px] text-slate-400">Start</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full bg-red-500"></div>
                        <span className="text-[11px] text-slate-400">End</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div className="w-2 h-2 rounded-full bg-amber-500"></div>
                        <span className="text-[11px] text-slate-400">Wpt</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <div
                            className="w-2 h-2 rounded-full"
                            style={{ background: '#00f0ff', boxShadow: '0 0 4px rgba(0,240,255,0.5)' }}
                        ></div>
                        <span className="text-[11px] text-slate-400">Vessel</span>
                    </div>
                </div>
            </div>

            {/* ═══ PLAYBACK SCRUBBER — matches app-wide scrubber pattern ═══ */}
            <div
                className="absolute left-2 right-2 z-[1001] flex items-center gap-2 px-2.5 py-1.5 rounded-xl border border-white/10 shadow-lg"
                style={{
                    bottom: 'calc(4rem + env(safe-area-inset-bottom) + 8px)',
                    background: 'rgba(15, 23, 42, 0.85)',
                }}
            >
                <style>{`
                    .track-slider { -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer; }
                    .track-slider::-webkit-slider-runnable-track { height: 3px; background: rgba(255,255,255,0.15); border-radius: 2px; }
                    .track-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #22c55e; margin-top: -5.5px; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
                `}</style>
                <button
                    aria-label="Go back"
                    onClick={togglePlayback}
                    className="w-6 h-6 flex items-center justify-center shrink-0 text-white/70 active:scale-90 transition-transform"
                >
                    {isPlaying ? (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                            <rect x="1" y="1" width="3" height="8" rx="0.5" />
                            <rect x="6" y="1" width="3" height="8" rx="0.5" />
                        </svg>
                    ) : (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                            <polygon points="2,1 9,5 2,9" />
                        </svg>
                    )}
                </button>
                <input
                    type="range"
                    min={0}
                    max={maxIdx}
                    value={playbackIndex}
                    onChange={(e) => {
                        setIsPlaying(false);
                        if (playIntervalRef.current) {
                            clearInterval(playIntervalRef.current);
                            playIntervalRef.current = null;
                        }
                        const idx = parseInt(e.target.value);
                        setPlaybackIndex(idx);
                        moveVesselTo(idx);
                        setShowHUD(true);
                    }}
                    className="track-slider flex-1 h-3"
                />
                <span className="text-[11px] font-bold text-white/60 min-w-[44px] text-right font-mono">
                    {timeLabel}
                </span>
            </div>
        </div>
    );
});

// ── HUD Metric Cell ──
const HUDCell: React.FC<{
    label: string;
    value: string;
    unit?: string;
    color?: string;
}> = ({ label, value, unit, color = 'text-white' }) => (
    <div className="flex flex-col items-center">
        <span className={`text-[11px] font-bold tracking-widest uppercase ${color} opacity-70`}>{label}</span>
        <div className="flex items-baseline gap-0.5">
            <span className="text-xs font-mono font-bold text-white">{value}</span>
            {unit && <span className="text-[11px] text-slate-400">{unit}</span>}
        </div>
    </div>
);
