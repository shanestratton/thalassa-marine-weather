/**
 * Track Map Viewer
 * Full-screen voyage track visualization with playback scrubber.
 *
 * Features:
 *   - Relief + Sat in Mapbox GL (125-13b): our seafloor relief at sea,
 *     satellite imagery on land, OpenSeaMap seamarks; the old satellite
 *     tiles are gone. Drawn by TrackMapViewerGL, loaded lazily so the Log
 *     page's own chunk carries no map engine.
 *   - Color-coded track segments (forecast wind, or water/land)
 *   - Start/End/turn markers, tap anywhere for the conditions logged there
 *   - Butter-smooth playback scrubber with play/pause
 *   - Animated vessel marker that moves along the track
 *   - Floating weather HUD showing conditions at current position
 *
 * The map is created when the viewer opens and removed when it closes;
 * props only change its data.
 */

import React, { Suspense, lazy, useEffect, useLayoutEffect, useRef, useCallback, useState, useMemo } from 'react';
import { ShipLogEntry } from '../types';
import { EditIcon, MapPinIcon, SailBoatIcon, CompassIcon, RouteIcon, ClockIcon, WindIcon } from './Icons';
import { isTrackworthyEntry, calculateDistanceNM } from '../services/shiplog/helpers';
import { buildSparkline, WIND_BUCKETS, WIND_NODATA_COLOR } from '../services/shiplog/trackViz';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { OverlayPortal } from './ui/OverlayPortal';
import { sanitizeRouteCoordinates, type RouteCoordinate } from '../utils/routeCoordinates';
import { stripInitialTrackWarmupRebounds } from '../services/shiplog/initialTrackWarmupGuard';
import type { TrackMapViewerGLHandle, TrackMapViewerGLProps } from './TrackMapViewerGL';

interface TrackMapViewerProps {
    isOpen: boolean;
    onClose: () => void;
    entries: ShipLogEntry[];
    /** Immediate follow-store geometry, independent of saved logbook rows. */
    followedRouteCoords?: readonly RouteCoordinate[];
}

/** The map's box while its chunk arrives, or where there is no map: the app's dark, nothing in it. */
const PlainMapBox = () => (
    <div className="absolute inset-0">
        <div className="thalassa-log-gl-map is-free track-map-gl relative h-full w-full" />
    </div>
);

/** A chunk that cannot load (a dropped link mid-update): the plain box, and the viewer says so. */
const MapChunkMissing = React.forwardRef<TrackMapViewerGLHandle, TrackMapViewerGLProps>(({ onUnavailable }, _ref) => {
    useEffect(() => onUnavailable('chunk'), [onUnavailable]);
    return <PlainMapBox />;
});
MapChunkMissing.displayName = 'MapChunkMissing';

/** Set when the map's chunk failed to load: the next opening asks for it again. */
let mapChunkMissing = false;
const loadTrackMapGL = () =>
    import('./TrackMapViewerGL').catch(() => {
        mapChunkMissing = true;
        return { default: MapChunkMissing as unknown as typeof import('./TrackMapViewerGL').default };
    });
/** React.lazy keeps what its import gave for the life of the page, a failure included. */
let TrackMapViewerGL = lazy(loadTrackMapGL);
/** On close, after a missing chunk: a fresh lazy, so the next opening tries the import again. */
const retryMissingMapChunk = () => {
    if (!mapChunkMissing) return;
    mapChunkMissing = false;
    TrackMapViewerGL = lazy(loadTrackMapGL);
};

/** The dock's distance above the screen's bottom edge (over the tab bar and the home bar). */
const DOCK_BOTTOM = 'calc(4rem + env(safe-area-inset-bottom) + 8px)';

/** Interpolated playback frames step ~300 m (0.003°); the gap between two fixes, the short way round. */
const shortLonDelta = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;

export const TrackMapViewer: React.FC<TrackMapViewerProps> = React.memo((props) => {
    const { isOpen, onClose, entries, followedRouteCoords } = props;
    /** The map (lazy): moves the playback boat. Null while its chunk arrives, or with no map. */
    const mapHandleRef = useRef<TrackMapViewerGLHandle | null>(null);
    /** The map area: what the track is framed inside. */
    const mapAreaRef = useRef<HTMLDivElement>(null);
    const dockRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLDivElement>(null);
    const legendRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(isOpen, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });
    /**
     * No map this opening, and why: 'device' (no WebGL, no token) or 'chunk'
     * (the map's own code did not load). A plain box and a word why.
     */
    const [mapUnavailable, setMapUnavailable] = useState<'device' | 'chunk' | null>(null);
    const markMapUnavailable = useCallback((cause?: 'chunk') => setMapUnavailable(cause ?? 'device'), []);
    /**
     * How far down the playback HUD (and its waypoint banner) reaches, in px:
     * the back button moves below it on a short screen rather than sit on it.
     */
    const [hudBottom, setHudBottom] = useState(0);
    const hudObserverRef = useRef<ResizeObserver | null>(null);
    const hudRef = useCallback((node: HTMLDivElement | null) => {
        hudObserverRef.current?.disconnect();
        hudObserverRef.current = null;
        if (!node) {
            setHudBottom(0);
            return;
        }
        const measure = () => setHudBottom(node.offsetTop + node.offsetHeight);
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        hudObserverRef.current = new ResizeObserver(measure);
        hudObserverRef.current.observe(node);
    }, []);
    /**
     * Where the track can be framed: inside the map, clear of the header (and
     * its wind key), the back button, the dock and the legend, with room for
     * the map's credits above the dock. Undefined until the map area has a size.
     */
    const framePadding = useCallback(() => {
        const area = mapAreaRef.current?.getBoundingClientRect();
        if (!area || area.width === 0 || area.height === 0) return undefined;
        const header = headerRef.current?.getBoundingClientRect();
        const back = closeButtonRef.current?.getBoundingClientRect();
        const floor = Math.min(
            dockRef.current?.getBoundingClientRect().top ?? area.bottom,
            legendRef.current?.getBoundingClientRect().top ?? area.bottom,
        );
        return {
            top: Math.max(24, (header ? header.bottom - area.top : 0) + 16),
            // The credits' ⓘ and wordmark ride just above the dock.
            bottom: Math.max(24, area.bottom - floor + 44),
            left: Math.max(24, (back ? back.right - area.left : 0) + 12),
            right: 24,
        };
    }, []);

    // Track colour mode — 'wind' paints the line by the (forecast) wind
    // at each point; 'plain' is the old water/land scheme.
    const [colorMode, setColorMode] = useState<'wind' | 'plain'>('wind');

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
    const playIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Sorted entries for playback
    const sortedEntriesRef = useRef<ShipLogEntry[]>([]);

    const sortedEntries = useMemo(() => {
        // Playback follows the track LINE — turn pins (past positions)
        // and manual entries (possibly stale cached fix) are markers,
        // not vertices; including them made the playback vessel (and the
        // polyline) zig-zag to positions out of sequence.
        const geometryEntries = stripInitialTrackWarmupRebounds(entries);
        const valid = geometryEntries.filter(isTrackworthyEntry);
        // When a planned route is overlaid with a sailed voyage, playback and
        // statistics must describe the recorded voyage only. The map
        // (map/trackMapFeatures.ts) still draws both, each its own line.
        const sailed = valid.filter((entry) => entry.source !== 'planned_route');
        const playbackEntries = sailed.length >= 2 ? sailed : valid;
        const sorted = [...playbackEntries].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        sortedEntriesRef.current = sorted;
        return sorted;
    }, [entries]);

    const sanitizedFollowedRoute = useMemo(() => sanitizeRouteCoordinates(followedRouteCoords), [followedRouteCoords]);

    // Speed sparkline geometry (memoized — the 20 Hz playback cursor must
    // NOT recompute the whole path). Drawn in a fixed 240×34 viewBox.
    const SPARK_W = 240;
    const SPARK_H = 34;
    const sparkline = useMemo(() => buildSparkline(sortedEntries, SPARK_W, SPARK_H), [sortedEntries]);

    // Max forecast wind across the voyage (for the header chip). null if
    // no point carried wind data (offshore cache-miss).
    const maxWindKt = useMemo(() => {
        let m = -1;
        for (const e of sortedEntries) if (typeof e.windSpeed === 'number' && e.windSpeed > m) m = e.windSpeed;
        return m >= 0 ? Math.round(m) : null;
    }, [sortedEntries]);

    // Pre-build interpolated animation frames for smooth playback
    // Each frame is { lat, lon, entryIndex } — entryIndex maps back to sortedEntries
    const animFramesRef = useRef<{ lat: number; lon: number; entryIndex: number }[]>([]);
    const animFrames = useMemo(() => {
        const sorted = sortedEntries;
        const frames: { lat: number; lon: number; entryIndex: number }[] = [];
        if (sorted.length === 0) return frames;

        for (let i = 0; i < sorted.length; i++) {
            const cur = sorted[i];
            frames.push({ lat: cur.latitude!, lon: cur.longitude!, entryIndex: i });

            if (i < sorted.length - 1) {
                const nxt = sorted[i + 1];
                const dlat = nxt.latitude! - cur.latitude!;
                // The short way round: past Fiji, 179.9 to -179.9 is 0.2°, not 359.8°.
                const dlon = shortLonDelta(cur.longitude!, nxt.longitude!);
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
        return frames;
    }, [sortedEntries]);
    // togglePlayback reads the frames from a ref so its own identity stays
    // stable across playback ticks; the assignment mirrors the memo above and
    // happens at exactly the same point in the render as it always did.
    animFramesRef.current = animFrames;

    // Reset playback when the viewer opens. Closing stops it: LogPage and
    // PassageSummaryCard keep the viewer mounted and only close it, so the
    // unmount cleanup below never runs then, and a loop left running would
    // move the boat (and the scrubber) on the next opening's map. Closing
    // also forgets a missing map, so the next opening tries again: the map is
    // made per opening, and a chunk that failed to load is asked for afresh.
    useEffect(() => {
        if (!isOpen) {
            setMapUnavailable(null);
            retryMissingMapChunk();
            return;
        }
        setPlaybackIndex(0);
        setIsPlaying(false);
        setShowHUD(false);
        return () => {
            if (playIntervalRef.current) clearInterval(playIntervalRef.current);
            playIntervalRef.current = null;
            if (waypointTimerRef.current) clearTimeout(waypointTimerRef.current);
            waypointTimerRef.current = null;
            setIsPlaying(false);
            setActiveWaypoint(null);
        };
    }, [isOpen]);

    // ── Playback engine (uses interpolated frames) ──
    const moveVesselTo = useCallback((index: number) => {
        const sorted = sortedEntriesRef.current;
        if (!sorted.length || index < 0 || index >= sorted.length) return;
        const entry = sorted[index];
        mapHandleRef.current?.moveVessel(entry.latitude!, entry.longitude!);
    }, []);

    // Move vessel to an interpolated frame position (no scrubber update)
    const moveVesselToFrame = useCallback((frame: { lat: number; lon: number }) => {
        mapHandleRef.current?.moveVessel(frame.lat, frame.lon);
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

                // One loop at a time: a loop this replaced could never be paused.
                if (playIntervalRef.current) clearInterval(playIntervalRef.current);
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

                    // Update playbackIndex when we cross into a new entry —
                    // the <input type="range"> scrubber follows from that.
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

        // Only surface the callout for MEANINGFUL waypoints. The system
        // waypoints — Voyage Start / Voyage End / the rolling Latest
        // Position — just duplicate what the HUD box above already shows
        // (time, position, speed), so their callout is noise; skip them.
        const SYSTEM_WAYPOINT_NAMES = ['Voyage Start', 'Voyage End', 'Latest Position'];
        const isMeaningfulWaypoint =
            entry.entryType === 'waypoint' && !SYSTEM_WAYPOINT_NAMES.includes(entry.waypointName ?? '');

        if (isMeaningfulWaypoint) {
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
        } else {
            // Non-waypoint or a system waypoint — clear any open callout.
            if (waypointTimerRef.current) clearTimeout(waypointTimerRef.current);
            setActiveWaypoint(null);
        }
    }, [playbackIndex, showHUD]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (playIntervalRef.current) clearInterval(playIntervalRef.current);
            if (waypointTimerRef.current) clearTimeout(waypointTimerRef.current);
        };
    }, []);

    // Stats. Distance = MAX cumulative, matching every other surface
    // (VoyageHeader, voyage cards) — the last-sorted entry is the
    // 'Voyage End' pin, which historically carried cumulative 0 and
    // made every completed voyage read "0.0 NM" here. Fallback for
    // voyages whose stored cumulatives are all zero (legacy data):
    // haversine-sum the polyline.
    //
    // Memoised, and above the early return so hook order holds: playback
    // re-renders this component ~20 times a second, and without the memo each
    // of those walked the whole track again for a number that only changes
    // when the entries do.
    const totalDistance = useMemo(() => {
        if (sortedEntries.length === 0) return '0.0';
        let nm = sortedEntries.reduce((max, e) => Math.max(max, e.cumulativeDistanceNM || 0), 0);
        if (nm === 0 && sortedEntries.length > 1) {
            for (let i = 1; i < sortedEntries.length; i++) {
                nm += calculateDistanceNM(
                    sortedEntries[i - 1].latitude!,
                    sortedEntries[i - 1].longitude!,
                    sortedEntries[i].latitude!,
                    sortedEntries[i].longitude!,
                );
            }
        }
        return nm.toFixed(1);
    }, [sortedEntries]);

    // The dock (speed line + scrubber) grows with the text size; its height,
    // written on the dialog, lifts the map's credits clear of it (index.css,
    // .track-map-gl) and keeps the back button above it.
    const hasDock = sortedEntries.length >= 2;
    useLayoutEffect(() => {
        const root = dialogRef.current;
        if (!isOpen || !root) return;
        const dock = dockRef.current;
        const write = () => root.style.setProperty('--track-dock-h', `${dock?.offsetHeight ?? 0}px`);
        write();
        if (!dock || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(write);
        observer.observe(dock);
        return () => observer.disconnect();
    }, [isOpen, hasDock, dialogRef]);

    if (!isOpen) return null;

    // Route geometry can arrive synchronously before the first GPS fix. In
    // that state the map is useful (and should be visible), but playback and
    // recorded-track controls remain hidden until two real fixes exist.
    const hasPlaybackTrack = sortedEntries.length >= 2;
    const hasFollowedRoute = sanitizedFollowedRoute.length >= 2;
    const isTrackLoading = !hasPlaybackTrack && !hasFollowedRoute;

    // Current entry for scrubber label + HUD
    const currentEntry = sortedEntries[playbackIndex] || null;
    const timeLabel = currentEntry
        ? new Date(currentEntry.timestamp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })
        : '--:--';
    const dateLabel = currentEntry
        ? new Date(currentEntry.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
        : '';

    const maxIdx = sortedEntries.length - 1;

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
        <OverlayPortal
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Voyage track viewer"
            className="bg-slate-900 flex flex-col overflow-hidden animate-in fade-in duration-200 transform-gpu"
        >
            {/* Title, colour mode and its key — top (hidden during the playback
                HUD). One row, so the title wraps before it runs under the
                toggle; the wind key on its own row below. Only the controls
                take touches: the rest of the strip is the map's. */}
            {!showHUD && (
                <div
                    ref={headerRef}
                    className="absolute top-0 left-0 right-0 z-1001 px-3 pointer-events-none"
                    style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
                >
                    <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1 pl-1">
                            <h2 className="text-sm font-bold text-white uppercase tracking-widest drop-shadow-lg">
                                Voyage Track
                            </h2>
                            {hasPlaybackTrack ? (
                                <div className="text-[11px] text-white/60 flex flex-wrap gap-x-3 mt-0.5 font-medium">
                                    <span>{totalDistance} NM</span>
                                    <span>{sortedEntries.length} pts</span>
                                    {maxWindKt !== null && <span>max {maxWindKt} kt</span>}
                                </div>
                            ) : hasFollowedRoute ? (
                                <div className="mt-0.5 text-[11px] font-medium text-violet-200/80">
                                    Followed route · waiting for recorded fixes
                                </div>
                            ) : null}
                        </div>

                        {hasPlaybackTrack && (
                            <div
                                role="group"
                                aria-label="Track colour mode"
                                className="pointer-events-auto shrink-0 flex rounded-full bg-slate-900/90 border border-white/15 p-0.5 shadow-xl"
                            >
                                {(['wind', 'plain'] as const).map((m) => (
                                    <button
                                        key={m}
                                        onClick={() => setColorMode(m)}
                                        aria-pressed={colorMode === m}
                                        className={`px-3 py-1 min-h-[44px] rounded-full text-[10px] font-bold uppercase tracking-wider transition-colors ${
                                            colorMode === m ? 'bg-sky-500 text-white' : 'text-white/60'
                                        }`}
                                    >
                                        {m === 'wind' ? 'Wind' : 'Track'}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Wind key — only in wind mode, honest "forecast" framing */}
                    {hasPlaybackTrack && colorMode === 'wind' && (
                        <div className="mt-2 inline-block max-w-full rounded-xl bg-slate-900/85 border border-white/10 px-2.5 py-2 shadow-xl">
                            <div className="text-[9px] font-bold uppercase tracking-wider text-white/70 mb-1">
                                Forecast wind (kt)
                            </div>
                            <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                                {WIND_BUCKETS.map((b) => (
                                    <div key={b.key} className="flex flex-col items-center gap-0.5">
                                        <span className="w-4 h-2 rounded-xs" style={{ background: b.color }} />
                                        <span className="text-[10px] text-white/70 leading-none">{b.label}</span>
                                    </div>
                                ))}
                                <div className="flex flex-col items-center gap-0.5 ml-1">
                                    <span className="w-4 h-2 rounded-xs" style={{ background: WIND_NODATA_COLOR }} />
                                    <span className="text-[10px] text-white/70 leading-none">n/a</span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Back chevron — middle-left of screen, or just below the playback
                HUD where the HUD and its waypoint banner reach that far, but
                never lower than just above the dock: it is the only way out on
                a phone (no Escape key), so where it must meet the HUD it lies
                on top of it, never under the dock. Its top is its centre. */}
            <div
                className="absolute z-1001 px-3"
                style={{
                    top: `min(max(50%, ${hudBottom + 30}px), calc(100% - ${DOCK_BOTTOM} - var(--track-dock-h, 0px) - 30px))`,
                    transform: 'translateY(-50%)',
                }}
            >
                <button
                    ref={closeButtonRef}
                    onClick={onClose}
                    aria-label="Close track map viewer"
                    className="w-11 h-11 bg-slate-900/90 hover:bg-slate-800 rounded-full flex items-center justify-center border border-white/20 shadow-2xl transition-all hover:scale-110 active:scale-95 shrink-0"
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

            {/* Map Container — Mapbox GL on Relief + Sat, made as the viewer
                opens (lazily: the Log page's chunk carries no map engine). The
                dock's measured height (--track-dock-h, on the dialog) lifts the
                map's credits clear of the speed line and the scrubber. */}
            <div ref={mapAreaRef} className="relative flex-1 min-h-0">
                <Suspense fallback={<PlainMapBox />}>
                    <TrackMapViewerGL
                        ref={mapHandleRef}
                        entries={entries}
                        followedRoute={sanitizedFollowedRoute}
                        colorMode={colorMode}
                        tapEntries={sortedEntries}
                        onUnavailable={markMapUnavailable}
                        framePadding={framePadding}
                    />
                </Suspense>

                {/* No map here: say so plainly, and why; the track's figures and
                    playback still work. Inset on the left, clear of the back
                    button's column. */}
                {mapUnavailable && (
                    <div className="absolute inset-x-0 top-[38%] z-3 flex justify-center pl-[64px] pr-6 pointer-events-none">
                        <div
                            role="status"
                            className="w-full max-w-xs rounded-xl bg-slate-900/85 border border-white/10 px-3 py-2 text-center shadow-xl"
                        >
                            <p className="text-[12px] font-bold text-white/85">
                                {mapUnavailable === 'chunk'
                                    ? 'The map didn’t load.'
                                    : 'This device can’t draw the map.'}
                            </p>
                            <p className="mt-0.5 text-[11px] text-white/60">
                                {mapUnavailable === 'chunk'
                                    ? 'Close and open it again to retry. The track’s figures and playback still work.'
                                    : 'The track’s figures and playback still work.'}
                            </p>
                        </div>
                    </div>
                )}

                {/* Loading overlay — entries still hydrating, nothing on the map yet */}
                {isTrackLoading && (
                    <div className="absolute inset-0 z-1000 flex items-center justify-center pointer-events-none">
                        <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/80 border border-white/10 shadow-xl">
                            <div className="w-4 h-4 rounded-full border-2 border-sky-400/30 border-t-sky-400 animate-spin" />
                            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                                Loading track…
                            </span>
                        </div>
                    </div>
                )}

                {/* ═══ FLOATING WEATHER HUD ═══ */}
                {showHUD && currentEntry && (
                    <div ref={hudRef} className="absolute top-3 left-3 right-3 z-1000 pointer-events-none">
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
                                        <span className="inline-flex items-center gap-1 text-[11px] text-sky-400 font-bold">
                                            <ClockIcon className="w-3 h-3" />
                                            {elapsedLabel}
                                        </span>
                                    )}
                                    <button
                                        aria-label="Hide voyage details"
                                        onClick={() => setShowHUD(false)}
                                        className="hit-target-44 p-2.5 -m-2.5 text-white/60 hover:text-white transition-colors pointer-events-auto"
                                    >
                                        <span className="w-5 h-5 flex items-center justify-center rounded-full bg-white/10">
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
                                        </span>
                                    </button>
                                </div>
                            </div>

                            {/* Metrics grid — cells with no captured value
                                fold into invisible spacers (see HUDCell)
                                instead of showing "--". Planned routes
                                (saved before sailing) only have DIST; live-
                                tracked sails populate SOG/COG too; everything
                                else needs a weather snapshot at capture time
                                to be filled in. */}
                            {(() => {
                                const hasSog = currentEntry.speedKts != null;
                                const hasDist = currentEntry.cumulativeDistanceNM != null;
                                const hasCog = currentEntry.courseDeg != null;
                                const hasTemp = currentEntry.airTemp != null;
                                const hasWind = currentEntry.windSpeed != null;
                                const anyTelemetry = hasSog || hasDist || hasCog || hasTemp || hasWind;
                                if (!anyTelemetry) {
                                    // Pure planned-route waypoint — no fix
                                    // recorded. Tell the user instead of
                                    // showing a row of dashes that look
                                    // like real but missing data.
                                    return (
                                        <div className="text-[11px] text-slate-500 italic text-center py-1">
                                            Planned route — no live telemetry recorded
                                        </div>
                                    );
                                }
                                return (
                                    <div className="grid grid-cols-5 gap-1">
                                        <HUDCell
                                            label="SOG"
                                            value={hasSog ? currentEntry.speedKts!.toFixed(1) : ''}
                                            unit="kts"
                                            color="text-sky-400"
                                            hasValue={hasSog}
                                        />
                                        <HUDCell
                                            label="DIST"
                                            value={hasDist ? currentEntry.cumulativeDistanceNM!.toFixed(1) : ''}
                                            unit="NM"
                                            color="text-sky-400"
                                            hasValue={hasDist}
                                        />
                                        <HUDCell
                                            label="COG"
                                            value={hasCog ? `${Math.round(currentEntry.courseDeg!)}°` : ''}
                                            color="text-sky-400"
                                            hasValue={hasCog}
                                        />
                                        <HUDCell
                                            label="TEMP"
                                            value={hasTemp ? `${Math.round(currentEntry.airTemp!)}°` : ''}
                                            color="text-emerald-400"
                                            hasValue={hasTemp}
                                        />
                                        <HUDCell
                                            label="WIND"
                                            value={hasWind ? Math.round(currentEntry.windSpeed!).toString() : ''}
                                            unit={currentEntry.windDirection || ''}
                                            color="text-emerald-400"
                                            hasValue={hasWind}
                                        />
                                    </div>
                                );
                            })()}

                            {/* Second row — only render the row at all if at
                                least one cell has a value. Cells with no
                                captured value collapse to invisible spacers
                                (matches the first-row treatment). */}
                            {(() => {
                                const hasWave = currentEntry.waveHeight != null;
                                const hasPressure = currentEntry.pressure != null;
                                const hasWater = currentEntry.waterTemp != null;
                                const hasVis = currentEntry.visibility != null;
                                const hasSea = currentEntry.seaState != null;
                                const hasBft = currentEntry.beaufortScale != null;
                                if (!(hasWave || hasPressure || hasWater || hasVis || hasSea || hasBft)) return null;
                                return (
                                    <div className="grid grid-cols-6 gap-1 mt-1 pt-1 border-t border-white/5">
                                        <HUDCell
                                            label="WAVE"
                                            value={hasWave ? (currentEntry.waveHeight! / 3.28084).toFixed(1) : ''}
                                            unit="m"
                                            color="text-purple-400"
                                            hasValue={hasWave}
                                        />
                                        <HUDCell
                                            label="HPA"
                                            value={hasPressure ? Math.round(currentEntry.pressure!).toString() : ''}
                                            color="text-purple-400"
                                            hasValue={hasPressure}
                                        />
                                        <HUDCell
                                            label="WATER"
                                            value={hasWater ? `${Math.round(currentEntry.waterTemp!)}°` : ''}
                                            color="text-purple-400"
                                            hasValue={hasWater}
                                        />
                                        <HUDCell
                                            label="VIS"
                                            value={hasVis ? currentEntry.visibility!.toFixed(0) : ''}
                                            unit="NM"
                                            color="text-purple-400"
                                            hasValue={hasVis}
                                        />
                                        <HUDCell
                                            label="SEA"
                                            value={hasSea ? currentEntry.seaState!.toString() : ''}
                                            color="text-purple-400"
                                            hasValue={hasSea}
                                        />
                                        <HUDCell
                                            label="BFT"
                                            value={hasBft ? `F${currentEntry.beaufortScale}` : ''}
                                            color="text-purple-400"
                                            hasValue={hasBft}
                                        />
                                    </div>
                                );
                            })()}

                            {/* Notes */}
                            {currentEntry.notes && (
                                <div className="mt-1.5 pt-1.5 border-t border-white/5">
                                    <p className="text-[11px] text-slate-400 leading-relaxed truncate inline-flex items-center gap-1.5">
                                        <EditIcon className="w-3 h-3 shrink-0" />
                                        <span className="truncate">{currentEntry.notes}</span>
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* ═══ WAYPOINT BANNER — persists when crossing a waypoint ═══ */}
                        {activeWaypoint && (
                            <div
                                className="mt-2 bg-slate-900/92 rounded-xl border border-amber-500/40 p-3 pointer-events-auto animate-in fade-in slide-in-from-top-2 duration-300"
                                style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
                            >
                                <div className="flex items-start gap-2">
                                    <span className="text-amber-300 mt-0.5">
                                        <MapPinIcon className="w-4 h-4" />
                                    </span>
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
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-amber-500/20 text-[11px] font-bold text-amber-200">
                                                    <SailBoatIcon className="w-3 h-3" />
                                                    {activeWaypoint.speedKts.toFixed(1)} kts
                                                </span>
                                            )}
                                            {activeWaypoint.courseDeg != null && (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-amber-500/20 text-[11px] font-bold text-amber-200">
                                                    <CompassIcon className="w-3 h-3" rotation={0} />
                                                    {activeWaypoint.courseDeg}°
                                                </span>
                                            )}
                                            {activeWaypoint.distanceNM != null && activeWaypoint.distanceNM > 0 && (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-amber-500/20 text-[11px] font-bold text-amber-200">
                                                    <RouteIcon className="w-3 h-3" />
                                                    {activeWaypoint.distanceNM.toFixed(1)} NM
                                                </span>
                                            )}
                                            {activeWaypoint.windSpeed != null && activeWaypoint.windSpeed > 0 && (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-sky-500/20 text-[11px] font-bold text-sky-200">
                                                    <WindIcon className="w-3 h-3" />
                                                    {activeWaypoint.windSpeed} kts {activeWaypoint.windDir || ''}
                                                </span>
                                            )}
                                        </div>

                                        {/* Three lines at most: a long note would run
                                            the banner under the dock on a small phone. */}
                                        {activeWaypoint.notes && (
                                            <p className="text-[11px] text-amber-200/70 mt-1 leading-relaxed line-clamp-3">
                                                {activeWaypoint.notes}
                                            </p>
                                        )}
                                    </div>
                                    <button
                                        aria-label="Dismiss active waypoint"
                                        onClick={() => setActiveWaypoint(null)}
                                        className="hit-target-44 p-2.5 -m-2.5 text-amber-300/60 hover:text-white transition-colors shrink-0"
                                    >
                                        <span className="w-5 h-5 flex items-center justify-center rounded-full bg-white/10">
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
                                        </span>
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* Legend dots — bottom of map, above the home indicator, centred
                    across the full width (and wrapping rather than running off a
                    narrow screen) */}
                {(hasPlaybackTrack || hasFollowedRoute) && (
                    <div
                        ref={legendRef}
                        className="absolute inset-x-0 z-1000 flex justify-center px-2 pointer-events-none"
                        style={{ bottom: 'calc(env(safe-area-inset-bottom) + 0.5rem)' }}
                    >
                        <div
                            aria-label="Track legend"
                            className="flex flex-wrap justify-center gap-x-3 gap-y-1 bg-black/60 rounded-lg px-3 py-1.5"
                        >
                            {hasFollowedRoute && (
                                <div className="flex items-center gap-1">
                                    <div
                                        aria-hidden="true"
                                        className="h-0.5 w-3 rounded-full bg-violet-300 shadow-[0_0_4px_rgba(167,139,250,0.8)]"
                                    />
                                    <span className="text-[11px] text-slate-400">Route</span>
                                </div>
                            )}
                            {hasPlaybackTrack && (
                                <>
                                    <div className="flex items-center gap-1">
                                        <div aria-hidden="true" className="w-2 h-2 rounded-full bg-emerald-500"></div>
                                        <span className="text-[11px] text-slate-400">Start</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <div aria-hidden="true" className="w-2 h-2 rounded-full bg-red-500"></div>
                                        <span className="text-[11px] text-slate-400">End</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <div aria-hidden="true" className="w-2 h-2 rounded-full bg-amber-500"></div>
                                        <span className="text-[11px] text-slate-400">Turn</span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <div
                                            aria-hidden="true"
                                            className="w-2 h-2 rounded-full"
                                            style={{
                                                background: '#00f0ff',
                                                boxShadow: '0 0 4px rgba(0,240,255,0.5)',
                                            }}
                                        ></div>
                                        <span className="text-[11px] text-slate-400">Vessel</span>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* ═══ THE DOCK — the speed line over the scrubber, one column, so
                larger text can never slide one under the other. Its height is
                measured for the map's credits, which sit just above it. ═══ */}
            {hasPlaybackTrack && (
                <div
                    ref={dockRef}
                    className="absolute left-2 right-2 z-1001 flex flex-col gap-1.5"
                    style={{ bottom: DOCK_BOTTOM }}
                >
                    {/* ═══ SPEED SPARKLINE — sits just above the scrubber, cursor
                tracks the playback position ═══ */}
                    {sparkline.path && (
                        <div
                            className="px-2.5 pt-1.5 pb-1 rounded-xl border border-white/10 shadow-lg"
                            style={{ background: 'rgba(15, 23, 42, 0.85)' }}
                        >
                            <div className="flex items-center justify-between mb-0.5">
                                <span className="text-[9px] font-bold uppercase tracking-wider text-white/60">
                                    Speed
                                </span>
                                <span className="text-[9px] font-mono text-white/60">
                                    {sparkline.maxKts.toFixed(0)} kt max
                                </span>
                            </div>
                            <svg
                                aria-hidden="true"
                                viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                                preserveAspectRatio="none"
                                className="w-full"
                                style={{ height: 34 }}
                            >
                                <path
                                    d={`${sparkline.path}L${SPARK_W} ${SPARK_H}L0 ${SPARK_H}Z`}
                                    fill="rgba(34,197,94,0.18)"
                                />
                                <path
                                    d={sparkline.path}
                                    fill="none"
                                    stroke="#22c55e"
                                    strokeWidth={1.2}
                                    vectorEffect="non-scaling-stroke"
                                />
                                <line
                                    x1={sparkline.xs[playbackIndex] ?? 0}
                                    x2={sparkline.xs[playbackIndex] ?? 0}
                                    y1={0}
                                    y2={SPARK_H}
                                    stroke="#ffffff"
                                    strokeWidth={1}
                                    vectorEffect="non-scaling-stroke"
                                    opacity={0.8}
                                />
                            </svg>
                        </div>
                    )}

                    {/* ═══ PLAYBACK SCRUBBER — matches app-wide scrubber pattern ═══ */}
                    <div
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl border border-white/10 shadow-lg"
                        style={{ background: 'rgba(15, 23, 42, 0.85)' }}
                    >
                        <style>{`
                    .track-slider { -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer; }
                    .track-slider::-webkit-slider-runnable-track { height: 3px; background: rgba(255,255,255,0.15); border-radius: 2px; }
                    .track-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #22c55e; margin-top: -5.5px; box-shadow: 0 0 6px rgba(34,197,94,0.5); }
                `}</style>
                        <button
                            aria-label={isPlaying ? 'Pause playback' : 'Play track'}
                            onClick={togglePlayback}
                            className="p-2 -m-2 shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center text-white/70 active:scale-90 transition-transform"
                        >
                            <span className="w-6 h-6 flex items-center justify-center">
                                {isPlaying ? (
                                    <svg width="16" height="16" viewBox="0 0 10 10" fill="currentColor">
                                        <rect x="1" y="1" width="3" height="8" rx="0.5" />
                                        <rect x="6" y="1" width="3" height="8" rx="0.5" />
                                    </svg>
                                ) : (
                                    <svg width="16" height="16" viewBox="0 0 10 10" fill="currentColor">
                                        <polygon points="2,1 9,5 2,9" />
                                    </svg>
                                )}
                            </span>
                        </button>
                        <input
                            type="range"
                            min={0}
                            max={maxIdx}
                            value={playbackIndex}
                            aria-label="Track playback position"
                            aria-valuetext={`${dateLabel} ${timeLabel}`.trim()}
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
            )}
        </OverlayPortal>
    );
});

// ── HUD Metric Cell ──
//
// `hasValue` controls visibility — true means the underlying entry
// field was populated; false collapses the cell to an empty
// placeholder so the grid keeps its layout but doesn't show a
// useless "--" for fields that were never captured (planned routes
// have no live telemetry; offline-tracked sails may miss weather).
const HUDCell: React.FC<{
    label: string;
    value: string;
    unit?: string;
    color?: string;
    hasValue?: boolean;
}> = ({ label, value, unit, color = 'text-white', hasValue = true }) => {
    if (!hasValue) {
        // Render an invisible spacer so sibling cells don't reflow.
        // Same width as a real cell — keeps the grid columns aligned.
        return <div className="flex flex-col items-center opacity-0 select-none" aria-hidden="true" />;
    }
    return (
        <div className="flex flex-col items-center">
            <span className={`text-[11px] font-bold tracking-widest uppercase ${color}`}>{label}</span>
            <div className="flex items-baseline gap-0.5">
                <span className="text-sm font-mono font-black text-white">{value}</span>
                {unit && <span className="text-[11px] text-slate-400">{unit}</span>}
            </div>
        </div>
    );
};
