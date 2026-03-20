/**
 * FollowRouteBadge — Global persistent banner shown when following a route.
 *
 * Renders a fixed bar at the top of the screen with route info.
 * Pulses amber when route has changed.
 * Expandable popover with change details + GPX download + stop button.
 */

import React, { useState, useCallback } from 'react';
import { useFollowRoute } from '../context/FollowRouteContext';
import { RouteIcon } from './Icons';

import { createLogger } from '../utils/createLogger';

const log = createLogger('FollowRouteBadge');

// ── Stop Following Confirmation Dialog ──

const StopFollowingDialog: React.FC<{
    onConfirm: () => void;
    onCancel: () => void;
    origin?: string;
    destination?: string;
}> = ({ onConfirm, onCancel, origin, destination }) => (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-6" onClick={onCancel}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div
            className="relative w-full max-w-sm bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300"
            onClick={(e) => e.stopPropagation()}
        >
            {/* Header accent */}
            <div className="h-1 bg-gradient-to-r from-red-500 via-amber-500 to-red-500" />

            <div className="p-6 text-center">
                {/* Icon */}
                <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
                    <svg
                        className="w-8 h-8 text-red-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                    >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9" />
                    </svg>
                </div>

                <h3 className="text-lg font-bold text-white mb-2">Stop Following Route?</h3>
                <p className="text-sm text-gray-400 leading-relaxed mb-1">
                    This will remove the route overlay from all maps and stop weather auto-refresh.
                </p>
                {origin && destination && (
                    <p className="text-xs text-sky-400/70 font-mono mt-2">
                        {origin.split(',')[0]} → {destination.split(',')[0]}
                    </p>
                )}
            </div>

            <div className="px-6 pb-6 flex gap-3">
                <button
                    onClick={onCancel}
                    className="flex-1 py-3.5 px-4 rounded-xl bg-white/5 border border-white/10 text-gray-300 font-bold text-sm hover:bg-white/10 transition-all active:scale-[0.97]"
                >
                    Keep Following
                </button>
                <button
                    onClick={onConfirm}
                    className="flex-1 py-3.5 px-4 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 font-bold text-sm hover:bg-red-500/25 transition-all active:scale-[0.97]"
                >
                    Stop Route
                </button>
            </div>
        </div>
    </div>
);

// ── Route Change Alert Panel ──

const RouteChangePanel: React.FC<{
    description: string | null;
    onAccept: () => void;
    onDismiss: () => void;
    onDownloadGPX: () => void;
}> = ({ description, onAccept, onDismiss, onDownloadGPX }) => (
    <div className="absolute top-full left-0 right-0 mt-1 mx-4 z-[9998] animate-in fade-in slide-in-from-top-4 duration-300">
        <div className="bg-slate-900 border border-amber-500/20 rounded-2xl shadow-2xl overflow-hidden">
            <div className="p-4">
                <div className="flex items-start gap-3">
                    <div className="p-1.5 bg-amber-500/10 rounded-lg mt-0.5 shrink-0">
                        <svg
                            className="w-4 h-4 text-amber-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                            />
                        </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                        <h4 className="text-xs text-amber-400 font-bold uppercase tracking-widest mb-1">
                            Route Updated
                        </h4>
                        <p className="text-sm text-gray-300 leading-relaxed">{description}</p>
                        <p className="text-[11px] text-gray-400 mt-1">
                            Old route shown in gray. New route in blue. Accept to confirm the new route.
                        </p>
                    </div>
                </div>

                <div className="flex gap-2 mt-3">
                    <button
                        onClick={onAccept}
                        className="flex-1 py-2.5 rounded-xl bg-sky-500/15 border border-sky-500/30 text-sky-400 text-xs font-bold uppercase tracking-wider hover:bg-sky-500/25 transition-all active:scale-[0.97]"
                    >
                        Accept New Route
                    </button>
                    <button
                        onClick={onDownloadGPX}
                        className="py-2.5 px-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-bold uppercase tracking-wider hover:bg-emerald-500/25 transition-all active:scale-[0.97]"
                    >
                        GPX ↓
                    </button>
                    <button
                        onClick={onDismiss}
                        className="py-2.5 px-3 rounded-xl bg-white/5 border border-white/10 text-gray-400 text-xs font-bold hover:bg-white/10 transition-all active:scale-[0.97]"
                    >
                        ✕
                    </button>
                </div>
            </div>
        </div>
    </div>
);

// ── Main Badge Component ──

export const FollowRouteBadge: React.FC = () => {
    const {
        isFollowing,
        voyagePlan,
        routeChanged,
        changeDescription,
        isRefreshing,
        lastRefresh: _lastRefresh,
        stopFollowing,
        acceptRouteChange,
        dismissRouteChange,
        refreshRoute,
        routeCoords,
    } = useFollowRoute();

    const [showChangePanel, setShowChangePanel] = useState(false);
    const [showStopDialog, setShowStopDialog] = useState(false);

    // Auto-show change panel when route changes
    React.useEffect(() => {
        if (routeChanged) setShowChangePanel(true);
    }, [routeChanged]);

    const handleDownloadGPX = useCallback(async () => {
        if (!routeCoords.length || !voyagePlan) return;
        try {
            // Build GPX from current route coords
            const gpxWaypoints = routeCoords.map((c, i) => ({
                lat: c.lat,
                lon: c.lon,
                name: i === 0 ? 'DEP' : i === routeCoords.length - 1 ? 'ARR' : `WP${i}`,
            }));

            const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Thalassa Marine Weather">
  <trk>
    <name>${voyagePlan.origin} → ${voyagePlan.destination}</name>
    <trkseg>
${gpxWaypoints.map((wp) => `      <trkpt lat="${wp.lat}" lon="${wp.lon}"><name>${wp.name}</name></trkpt>`).join('\n')}
    </trkseg>
  </trk>
</gpx>`;

            // Try native share, fallback to clipboard
            if (navigator.share) {
                const file = new File([gpx], `follow_route.gpx`, { type: 'application/gpx+xml' });
                await navigator.share({ files: [file], title: 'Updated Route GPX' });
            } else {
                await navigator.clipboard.writeText(gpx);
                // toast would go here
            }
        } catch (e) {
            log.warn('GPX export failed', e);
        }
    }, [routeCoords, voyagePlan]);

    if (!isFollowing || !voyagePlan) return null;

    const origin = voyagePlan.origin?.split(',')[0] || 'Origin';
    const destination = voyagePlan.destination?.split(',')[0] || 'Destination';

    return (
        <>
            <div className="relative z-[900]">
                <div
                    className={`mx-4 rounded-2xl border backdrop-blur-md transition-all duration-500 ${
                        routeChanged
                            ? 'bg-amber-500/10 border-amber-500/30 shadow-[0_0_20px_rgba(245,158,11,0.15)]'
                            : 'bg-sky-500/8 border-sky-500/20 shadow-lg'
                    }`}
                >
                    <div className="flex items-center gap-3 px-4 py-2.5">
                        {/* Route icon + pulse */}
                        <div className="relative shrink-0">
                            <div className={`p-1.5 rounded-lg ${routeChanged ? 'bg-amber-500/15' : 'bg-sky-500/15'}`}>
                                <RouteIcon className={`w-4 h-4 ${routeChanged ? 'text-amber-400' : 'text-sky-400'}`} />
                            </div>
                            {routeChanged && (
                                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-amber-400 rounded-full animate-ping" />
                            )}
                        </div>

                        {/* Route info */}
                        <button
                            onClick={() => routeChanged && setShowChangePanel(!showChangePanel)}
                            className="flex-1 min-w-0 text-left"
                        >
                            <div className="flex items-center gap-1.5">
                                <span
                                    className={`text-[11px] font-bold uppercase tracking-widest ${routeChanged ? 'text-amber-400' : 'text-sky-400'}`}
                                >
                                    {routeChanged
                                        ? '⚠ Route Updated'
                                        : isRefreshing
                                          ? '↻ Refreshing...'
                                          : '🧭 Following'}
                                </span>
                            </div>
                            <div className="text-xs text-white/80 font-medium truncate mt-0.5">
                                {origin} → {destination}
                            </div>
                        </button>

                        {/* Refresh button */}
                        <button
                            onClick={refreshRoute}
                            disabled={isRefreshing}
                            className="p-2 rounded-lg bg-white/5 border border-white/10 text-gray-400 hover:text-white hover:bg-white/10 transition-all active:scale-[0.95] shrink-0"
                            title="Refresh weather routing"
                        >
                            <svg
                                className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182"
                                />
                            </svg>
                        </button>

                        {/* Stop button */}
                        <button
                            onClick={() => setShowStopDialog(true)}
                            className="p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 transition-all active:scale-[0.95] shrink-0"
                            title="Stop following route"
                        >
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                </div>

                {/* Route change panel */}
                {showChangePanel && routeChanged && (
                    <RouteChangePanel
                        description={changeDescription}
                        onAccept={() => {
                            acceptRouteChange();
                            setShowChangePanel(false);
                        }}
                        onDismiss={() => {
                            dismissRouteChange();
                            setShowChangePanel(false);
                        }}
                        onDownloadGPX={handleDownloadGPX}
                    />
                )}
            </div>

            {/* Stop Following Confirmation Dialog */}
            {showStopDialog && (
                <StopFollowingDialog
                    origin={voyagePlan.origin}
                    destination={voyagePlan.destination}
                    onConfirm={() => {
                        stopFollowing();
                        setShowStopDialog(false);
                    }}
                    onCancel={() => setShowStopDialog(false)}
                />
            )}
        </>
    );
};
