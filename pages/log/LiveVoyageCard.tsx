/**
 * LiveVoyageCard — the live-recording card of the Ship's Log (stats, engine
 * toggle, live mini map and its fullscreen overlay), extracted verbatim from
 * pages/LogPage.tsx. Rendered only while tracking WITH a known voyage id; the
 * caller keeps that guard.
 */
import React from 'react';
import { LiveMiniMap } from '../../components/LiveMiniMap';
import { OverlayPortal } from '../../components/ui/OverlayPortal';
import type { RouteCoordinate } from '../../utils/routeCoordinates';
import type { deriveLiveStats } from './logPageDerive';

export const LiveVoyageCard: React.FC<{
    liveStats: ReturnType<typeof deriveLiveStats>;
    engineGroupId: string;
    engineRunning: boolean | undefined;
    toggleEngine: (running: boolean) => void;
    liveMapExpanded: boolean;
    showTrackMap: boolean;
    followedRouteCoords: readonly RouteCoordinate[];
    liveFix: { lat: number; lon: number } | null;
    currentFix: { lat: number; lon: number } | null;
    openLiveMap: () => void;
    closeLiveMap: () => void;
    expandLiveMapRef: React.RefObject<HTMLButtonElement>;
    shrinkLiveMapRef: React.RefObject<HTMLButtonElement>;
    liveMapDialogRef: React.RefObject<HTMLDivElement>;
    liveMapTitleId: string;
}> = ({
    liveStats,
    engineGroupId,
    engineRunning,
    toggleEngine,
    liveMapExpanded,
    showTrackMap,
    followedRouteCoords,
    liveFix,
    currentFix,
    openLiveMap,
    closeLiveMap,
    expandLiveMapRef,
    shrinkLiveMapRef,
    liveMapDialogRef,
    liveMapTitleId,
}) => {
    const { activeEntries, first, dist, durationHrs, durationMins, liveAvgSpeed } = liveStats;
    return (
        <div className="flex-1 min-h-0 flex flex-col rounded-2xl bg-linear-to-br from-emerald-500/10 to-slate-900/80 border border-emerald-500/20 p-4 mx-4 mt-2 mb-2">
            <div className="flex items-center gap-2 mb-3 shrink-0">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-xs font-bold text-red-400 uppercase tracking-wider">Live Recording</span>
            </div>
            {first?.waypointName &&
                first.waypointName !== 'Voyage Start' &&
                first.waypointName !== 'Latest Position' && (
                    <div className="text-xs text-slate-400 mb-3 shrink-0">Departed: {first.waypointName}</div>
                )}
            <div className="grid grid-cols-3 gap-3 shrink-0">
                <div>
                    <div className="text-2xl font-extrabold text-emerald-400 tabular-nums">
                        {(dist ?? 0).toFixed(1)}
                    </div>
                    <div className="text-[11px] text-slate-500 uppercase">NM</div>
                </div>
                <div>
                    <div className="text-2xl font-extrabold text-emerald-400 tabular-nums">
                        {durationHrs}h {durationMins}m
                    </div>
                    <div className="text-[11px] text-slate-500 uppercase">Duration</div>
                </div>
                <div>
                    <div className="text-2xl font-extrabold text-emerald-400 tabular-nums">
                        {(liveAvgSpeed ?? 0).toFixed(1)}
                    </div>
                    <div className="text-[11px] text-slate-500 uppercase">Avg kts</div>
                </div>
            </div>

            {/* Engine on/off — declares propulsion so the
                                                voyage's sail/motor split is real data. */}
            <div className="flex items-center gap-2 mt-3 shrink-0">
                <span id={engineGroupId} className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                    Engine
                </span>
                <div
                    role="group"
                    aria-labelledby={engineGroupId}
                    className="flex rounded-full bg-slate-900/60 border border-white/10 p-0.5"
                >
                    <button
                        aria-pressed={engineRunning === true}
                        onClick={() => toggleEngine(true)}
                        className={`hit-target-44 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider transition-colors ${
                            engineRunning === true ? 'bg-amber-500 text-white' : 'text-white/55'
                        }`}
                    >
                        Motor
                    </button>
                    <button
                        aria-pressed={engineRunning === false}
                        onClick={() => toggleEngine(false)}
                        className={`hit-target-44 px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider transition-colors ${
                            engineRunning === false ? 'bg-emerald-500 text-white' : 'text-white/55'
                        }`}
                    >
                        Sailing
                    </button>
                </div>
                {engineRunning === undefined && <span className="text-[11px] text-white/70">— tap to log</span>}
            </div>

            {/* Live Mini Map — grows to fill all remaining space.
                                                Tap to expand fullscreen. Until the first accepted
                                                fix lands there's nothing to draw, so say what's
                                                happening instead of showing a silent empty map.
                                                UNMOUNTED while any fullscreen map is open — iOS
                                                WebKit composites Leaflet's transformed layers above
                                                fixed overlays regardless of z-index, so a live map
                                                redrawing underneath bled through as a second track. */}
            <div className="mt-3 flex-1 min-h-[100px] relative">
                {!liveMapExpanded && !showTrackMap && (
                    <LiveMiniMap
                        entries={activeEntries}
                        followedRouteCoords={followedRouteCoords}
                        initialCenter={liveFix ?? currentFix}
                        height="100%"
                        isLive={true}
                        onTap={openLiveMap}
                    />
                )}
                {!showTrackMap && (
                    <button
                        ref={expandLiveMapRef}
                        type="button"
                        aria-label="Expand live map"
                        onClick={openLiveMap}
                        className="absolute bottom-2 right-2 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-slate-900/85 text-white/80 shadow-lg backdrop-blur-xs transition-transform active:scale-95"
                    >
                        <svg
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            aria-hidden="true"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 9V4m0 0h5M4 4l6 6m10-1V4m0 0h-5m5 0l-6 6M4 15v5m0 0h5m-5 0l6-6m10 1v5m0 0h-5m5 0l-6-6"
                            />
                        </svg>
                    </button>
                )}
            </div>

            {/* ── Fullscreen live map — tap map (or chevron) to shrink ──
                                                transform-gpu promotes the overlay to its own composited
                                                layer so iOS can't paint underlying map tiles above it. */}
            {liveMapExpanded && (
                <OverlayPortal
                    ref={liveMapDialogRef}
                    className="bg-slate-950 transform-gpu"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={liveMapTitleId}
                >
                    <LiveMiniMap
                        entries={activeEntries}
                        followedRouteCoords={followedRouteCoords}
                        height="100%"
                        isLive={true}
                        freeZoom={true}
                        onTap={closeLiveMap}
                        className="rounded-none! border-0!"
                    />

                    {/* Top info bar — same stats as the card */}
                    <div
                        className="absolute top-0 left-0 right-0 z-1001 px-4 pointer-events-none"
                        style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
                    >
                        <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <span
                                id={liveMapTitleId}
                                className="text-xs font-bold text-red-400 uppercase tracking-wider drop-shadow-lg"
                            >
                                Live Recording
                            </span>
                        </div>
                        <div className="text-[13px] text-white/90 flex gap-4 mt-1.5 font-bold drop-shadow-lg tabular-nums">
                            <span>{(dist ?? 0).toFixed(1)} NM</span>
                            <span>
                                {durationHrs}h {durationMins}m
                            </span>
                            <span>{(liveAvgSpeed ?? 0).toFixed(1)} avg kts</span>
                            <span>{activeEntries.length} pts</span>
                        </div>
                        <div className="text-[10px] text-white/40 mt-1 drop-shadow-lg">Tap map to shrink</div>
                    </div>

                    {/* Explicit collapse affordance */}
                    <button
                        ref={shrinkLiveMapRef}
                        type="button"
                        aria-label="Shrink map"
                        onClick={closeLiveMap}
                        className="absolute right-4 z-1001 w-11 h-11 rounded-full bg-slate-900/80 border border-white/10 text-white/80 flex items-center justify-center active:scale-95 transition-transform"
                        style={{ top: 'max(16px, env(safe-area-inset-top))' }}
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M9 9L4 4m0 0v4m0-4h4m7 5l5-5m0 0v4m0-4h-4M9 15l-5 5m0 0v-4m0 4h4m7-5l5 5m0 0v-4m0 4h-4"
                            />
                        </svg>
                    </button>
                </OverlayPortal>
            )}
        </div>
    );
};
