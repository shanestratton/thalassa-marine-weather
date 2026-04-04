/**
 * PassageBanner — Compact passage planner overlay for MapHub.
 *
 * Single card design: route stats + controls in a minimal floating banner.
 */
import React, { useState } from 'react';
import { createLogger } from '../../utils/createLogger';
import { triggerHaptic } from '../../utils/system';
import { exportPassageAsGPX, exportBasicPassageGPX } from '../../services/passageGpxExport';
import { shareGPXFile } from '../../services/gpxService';
import { Share } from '@capacitor/share';

const log = createLogger('PassageBanner');

interface PassageBannerProps {
    passage: {
        showPassage: boolean;
        departure: { lat: number; lon: number; name: string } | null;
        arrival: { lat: number; lon: number; name: string } | null;
        routeAnalysis: { totalDistance: number; estimatedDuration: number } | null;
        departureTime: string | null;
        setShowPassage: (v: boolean) => void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        isoResultRef: React.MutableRefObject<any>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        turnWaypointsRef: React.MutableRefObject<any[]>;
        speed: number;
    };
    isoProgress: {
        step: number;
        closestNM: number;
        totalDistNM?: number;
        elapsed?: number;
        frontSize?: number;
        phase?: string;
    } | null;
    embedded: boolean;
    isPinView: boolean;
    deviceMode: 'deck' | 'helm';
}

export const PassageBanner: React.FC<PassageBannerProps> = ({
    passage,
    isoProgress,
    embedded,
    isPinView,
    deviceMode: _deviceMode,
}) => {
    const [passageToast, setPassageToast] = useState<string | null>(null);

    if (!passage.showPassage || embedded || isPinView) return null;

    // ── GPX Export ──
    const handleExportGPX = async () => {
        try {
            let gpx: string;
            if (passage.isoResultRef.current && passage.turnWaypointsRef.current.length) {
                gpx = exportPassageAsGPX(
                    passage.isoResultRef.current,
                    passage.turnWaypointsRef.current,
                    passage.departure!.name,
                    passage.arrival!.name,
                    passage.departureTime || new Date().toISOString(),
                );
            } else {
                gpx = exportBasicPassageGPX(
                    passage.departure!,
                    passage.arrival!,
                    passage.departureTime || new Date().toISOString(),
                    passage.routeAnalysis?.totalDistance,
                    passage.routeAnalysis?.estimatedDuration,
                );
            }
            await shareGPXFile(gpx, `passage_${passage.departure!.name}_to_${passage.arrival!.name}.gpx`);
        } catch (err) {
            log.error('GPX Export failed:', err);
            setPassageToast('Export failed');
            setTimeout(() => setPassageToast(null), 2000);
        }
    };

    // ── Save to Logbook ──
    const handleSaveToLog = async () => {
        try {
            const { ShipLogService } = await import('../../services/ShipLogService');
            const dep = passage.departure!;
            const arr = passage.arrival!;
            const isoResult = passage.isoResultRef.current;
            const turnWPs = passage.turnWaypointsRef.current;
            const totalNM = isoResult?.totalDistanceNM ?? passage.routeAnalysis?.totalDistance ?? 0;
            const totalHrs = isoResult?.totalDurationHours ?? passage.routeAnalysis?.estimatedDuration ?? 0;

            const hasIsoWPs = isoResult && turnWPs.length >= 2;
            const firstWP = hasIsoWPs ? turnWPs[0] : null;
            const lastWP = hasIsoWPs ? turnWPs[turnWPs.length - 1] : null;

            const plan: Record<string, unknown> = {
                origin: dep.name || `${dep.lat.toFixed(2)}, ${dep.lon.toFixed(2)}`,
                destination: arr.name || `${arr.lat.toFixed(2)}, ${arr.lon.toFixed(2)}`,
                originCoordinates: firstWP ? { lat: firstWP.lat, lon: firstWP.lon } : { lat: dep.lat, lon: dep.lon },
                destinationCoordinates: lastWP ? { lat: lastWP.lat, lon: lastWP.lon } : { lat: arr.lat, lon: arr.lon },
                waypoints:
                    hasIsoWPs && turnWPs.length > 2
                        ? turnWPs
                              .slice(1, -1)
                              .map((wp: { lat: number; lon: number; name?: string; id?: string; tws?: number }) => ({
                                  name: wp.id ?? wp.name,
                                  coordinates: { lat: wp.lat, lon: wp.lon },
                                  windSpeed: wp.tws,
                                  depth_m: undefined,
                              }))
                        : [],
                distanceApprox: `${totalNM.toFixed(0)} NM`,
                durationApprox: `${totalHrs.toFixed(0)} hours`,
                departureDate: passage.departureTime || new Date().toISOString(),
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const voyageId = await ShipLogService.savePassagePlanToLogbook(plan as any);
            if (voyageId) {
                setPassageToast('Route saved to logbook ✓');
            } else {
                setPassageToast('Save failed ✗');
            }
            setTimeout(() => setPassageToast(null), 2000);
        } catch (err) {
            log.error('Failed to save planned route:', err);
            setPassageToast('Save failed ✗');
            setTimeout(() => setPassageToast(null), 2000);
        }
    };

    // ── Share Passage Brief ──
    const handleShareBrief = async () => {
        try {
            triggerHaptic('light');
            const { generatePassageBrief } = await import('../../services/PassageBriefService');
            const dep = passage.departure!;
            const arr = passage.arrival!;
            const isoResult = passage.isoResultRef.current;
            const turnWPs = passage.turnWaypointsRef.current;

            const brief = generatePassageBrief({
                routeName: `${dep.name} to ${arr.name}`,
                origin: dep,
                destination: arr,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                viaWaypoints: (passage as any).viaWaypoints || [],
                departureTime: passage.departureTime || new Date().toISOString(),
                totalDistanceNM: isoResult?.totalDistanceNM ?? passage.routeAnalysis?.totalDistance ?? 0,
                estimatedDuration: isoResult?.totalDurationHours ?? passage.routeAnalysis?.estimatedDuration ?? 0,
                speed: passage.speed,
                turnWaypoints:
                    turnWPs.length > 0
                        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          turnWPs.map((wp: any) => ({
                              name: wp.id ?? wp.name ?? 'WP',
                              lat: wp.lat,
                              lon: wp.lon,
                              tws: wp.tws,
                              bng: wp.bng,
                          }))
                        : undefined,
            });

            await Share.share({
                title: `Passage Brief: ${brief.title}`,
                text: brief.textVersion,
                dialogTitle: 'Share Passage Brief',
            });
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : '';
            if (errMsg?.includes('cancel') || errMsg?.includes('dismissed')) return;
            log.error('Share brief failed:', err);
            setPassageToast('Share failed');
            setTimeout(() => setPassageToast(null), 2000);
        }
    };

    // ── Format duration ──
    const formatDuration = (hours: number) => {
        if (hours < 24) return `${hours.toFixed(1)}h`;
        return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
    };

    // ── Progress label ──
    const progressLabel = isoProgress
        ? isoProgress.phase === 'loading-wind'
            ? 'Loading wind data…'
            : isoProgress.phase === 'loading-bathy'
              ? 'Loading depth data…'
              : `Routing… ${isoProgress.closestNM} NM`
        : null;

    return (
        <div className="absolute top-14 left-3 right-3 z-[502] animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="bg-slate-950/95 backdrop-blur-md border border-white/[0.08] rounded-xl shadow-2xl shadow-black/50 overflow-hidden">
                {/* ── Top row: Route + Close ── */}
                <div className="flex items-center gap-2 px-3 py-2">
                    {/* Route tags */}
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {passage.departure && (
                            <span className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/15 rounded text-emerald-400/90 text-[11px] font-bold truncate max-w-[120px]">
                                {passage.departure.name}
                            </span>
                        )}
                        {passage.departure && passage.arrival && (
                            <svg
                                className="w-3 h-3 text-gray-500 shrink-0"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                        )}
                        {/* Via waypoints from GPX import */}
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        {(passage as any).viaWaypoints?.length > 0 && (
                            <>
                                <span className="px-1.5 py-0.5 bg-amber-500/10 border border-amber-500/15 rounded text-amber-400/80 text-[11px] font-bold">
                                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}+
                                    {(passage as any).viaWaypoints.length} via
                                </span>
                                <svg
                                    className="w-3 h-3 text-gray-500 shrink-0"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    strokeWidth={2}
                                >
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                                </svg>
                            </>
                        )}
                        {passage.arrival && (
                            <span className="px-1.5 py-0.5 bg-red-500/10 border border-red-500/15 rounded text-red-400/90 text-[11px] font-bold truncate max-w-[120px]">
                                {passage.arrival.name}
                            </span>
                        )}
                    </div>

                    {/* Stats pills */}
                    {passage.routeAnalysis && (
                        <div className="flex items-center gap-1.5 shrink-0">
                            <span className="px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-300 text-[11px] font-black tabular-nums border border-sky-500/10">
                                {passage.routeAnalysis.totalDistance.toFixed(0)} NM
                            </span>
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 text-[11px] font-black tabular-nums border border-amber-500/10">
                                {formatDuration(passage.routeAnalysis.estimatedDuration)}
                            </span>
                        </div>
                    )}

                    {/* Close button */}
                    <button
                        onClick={() => {
                            passage.setShowPassage(false);
                            window.dispatchEvent(new CustomEvent('thalassa:passage-clear'));
                            triggerHaptic('light');
                        }}
                        className="w-7 h-7 flex items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] hover:bg-white/10 transition-colors shrink-0 active:scale-95"
                        aria-label="Close passage planner"
                    >
                        <svg
                            className="w-3 h-3 text-gray-400"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2.5}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* ── Progress indicator ── */}
                {isoProgress && (
                    <div className="px-3 pb-1.5 flex items-center gap-1.5 text-[11px] text-amber-400/70">
                        <div className="w-2 h-2 border border-amber-400/60 border-t-transparent rounded-full animate-spin" />
                        {progressLabel}
                    </div>
                )}

                {/* ── Action buttons row ── */}
                {passage.routeAnalysis && passage.departure && passage.arrival && !isoProgress && (
                    <div className="flex border-t border-white/[0.06]">
                        <button
                            aria-label="Export GPX"
                            onClick={handleExportGPX}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2 text-sky-400 text-[11px] font-bold uppercase tracking-wider hover:bg-sky-500/5 active:bg-sky-500/10 transition-colors"
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
                                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                />
                            </svg>
                            GPX
                        </button>
                        <div className="w-px bg-white/[0.06]" />
                        <button
                            aria-label="Share Brief"
                            onClick={handleShareBrief}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2 text-amber-400 text-[11px] font-bold uppercase tracking-wider hover:bg-amber-500/5 active:bg-amber-500/10 transition-colors"
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
                                    d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z"
                                />
                            </svg>
                            Brief
                        </button>
                        <div className="w-px bg-white/[0.06]" />
                        <button
                            aria-label="Save to Log"
                            onClick={handleSaveToLog}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2 text-emerald-400 text-[11px] font-bold uppercase tracking-wider hover:bg-emerald-500/5 active:bg-emerald-500/10 transition-colors"
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
                                    d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
                                />
                            </svg>
                            Save
                        </button>
                    </div>
                )}

                {/* Toast */}
                {passageToast && (
                    <div className="px-3 py-1.5 text-center text-[11px] font-bold text-emerald-400 border-t border-white/[0.06] animate-in fade-in duration-200">
                        {passageToast}
                    </div>
                )}
            </div>
        </div>
    );
};
