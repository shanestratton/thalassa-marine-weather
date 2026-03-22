/**
 * PassageBanner — Passage planner overlay for MapHub.
 *
 * Renders the route data bar (distance/time/ETA) and the passage mode
 * control banner (departure/arrival tags, GPX export, Save to Log).
 */
import React, { useState } from 'react';
import { createLogger } from '../../utils/createLogger';
import { triggerHaptic } from '../../utils/system';
import { exportPassageAsGPX, exportBasicPassageGPX } from '../../services/passageGpxExport';
import { shareGPXFile } from '../../services/gpxService';

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
    deviceMode,
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

    // ── Progress label helper ──
    const progressLabel = isoProgress
        ? isoProgress.phase === 'loading-wind'
            ? '⏳ Loading wind data…'
            : isoProgress.phase === 'loading-bathy'
              ? '⏳ Loading depth data…'
              : `⏳ Routing… ${isoProgress.closestNM} NM to go${isoProgress.totalDistNM ? ` / ${isoProgress.totalDistNM} NM` : ''} • ${((isoProgress.elapsed ?? 0) / 1000).toFixed(0)}s`
        : null;

    return (
        <>
            {/* ═══ PRO DATA BAR (Phone / Deck mode during passage) ═══ */}
            {deviceMode === 'deck' && passage.routeAnalysis && (
                <div className="absolute top-14 left-3 right-3 z-[502] animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="bg-slate-950 border border-white/[0.12] rounded-2xl px-3 py-2.5 flex items-center justify-between shadow-2xl shadow-black/50">
                        <div className="text-center flex-1">
                            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Distance</p>
                            <p className="text-base font-black text-white tabular-nums leading-tight">
                                {passage.routeAnalysis.totalDistance.toFixed(0)}
                                <span className="text-[11px] text-gray-400"> NM</span>
                            </p>
                        </div>
                        <div className="w-px h-6 bg-white/10" />
                        <div className="text-center flex-1">
                            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">Time</p>
                            <p className="text-base font-black text-white tabular-nums leading-tight">
                                {passage.routeAnalysis.estimatedDuration < 24
                                    ? `${passage.routeAnalysis.estimatedDuration.toFixed(1)}h`
                                    : `${Math.floor(passage.routeAnalysis.estimatedDuration / 24)}d ${Math.round(passage.routeAnalysis.estimatedDuration % 24)}h`}
                            </p>
                        </div>
                        <div className="w-px h-6 bg-white/10" />
                        <div className="text-center flex-1">
                            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-widest">ETA</p>
                            <p className="text-base font-black text-amber-400 tabular-nums leading-tight">
                                {new Date(
                                    (passage.departureTime ? new Date(passage.departureTime) : new Date()).getTime() +
                                        passage.routeAnalysis.estimatedDuration * 3600000,
                                ).toLocaleTimeString('en-AU', {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false,
                                })}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══ PASSAGE MODE BANNER ═══ */}
            <div className="absolute top-24 left-4 right-4 z-[501] animate-in fade-in slide-in-from-top-2 duration-300">
                <div className="bg-slate-950 border border-white/[0.12] rounded-2xl px-4 py-3 shadow-2xl shadow-black/50">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                            <div className="min-w-0">
                                <p className="text-[11px] font-black text-white uppercase tracking-widest">
                                    Passage Planner
                                </p>
                                <p className="text-[11px] text-gray-400 truncate">
                                    {!passage.departure
                                        ? 'Tap map to set Departure'
                                        : !passage.arrival
                                          ? 'Tap map to set Arrival'
                                          : progressLabel
                                            ? progressLabel
                                            : passage.routeAnalysis
                                              ? `${passage.routeAnalysis.totalDistance.toFixed(0)} NM • ${passage.routeAnalysis.estimatedDuration.toFixed(0)}h`
                                              : 'Computing route…'}
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={() => {
                                passage.setShowPassage(false);
                                triggerHaptic('light');
                            }}
                            className="w-8 h-8 flex items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] hover:bg-white/10 transition-colors shrink-0 active:scale-95"
                            aria-label="Close passage planner"
                        >
                            <svg
                                className="w-3.5 h-3.5 text-gray-400"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2.5}
                            >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    {passage.departure && (
                        <div className="mt-1.5 pt-1.5 border-t border-white/5 flex gap-1.5 text-[11px]">
                            <span className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/15 rounded text-emerald-400/80 font-bold truncate">
                                ⬤ {passage.departure.name}
                            </span>
                            {passage.arrival && (
                                <span className="px-1.5 py-0.5 bg-red-500/10 border border-red-500/15 rounded text-red-400/80 font-bold truncate">
                                    ◉ {passage.arrival.name}
                                </span>
                            )}
                        </div>
                    )}
                    {/* Action buttons (GPX export + Save) */}
                    {passage.routeAnalysis && passage.departure && passage.arrival && (
                        <div className="mt-1.5 pt-1.5 border-t border-white/5">
                            {isoProgress && (
                                <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-amber-400/70">
                                    <div className="w-2 h-2 border border-amber-400/60 border-t-transparent rounded-full animate-spin" />
                                    {isoProgress.phase === 'loading-wind'
                                        ? 'Loading wind data…'
                                        : isoProgress.phase === 'loading-bathy'
                                          ? 'Loading depth data…'
                                          : `Routing… ${isoProgress.closestNM} NM to go${isoProgress.totalDistNM ? ` / ${isoProgress.totalDistNM} NM` : ''} • ${((isoProgress.elapsed ?? 0) / 1000).toFixed(0)}s`}
                                </div>
                            )}
                            <div className="flex gap-2">
                                <button
                                    aria-label="Export"
                                    onClick={handleExportGPX}
                                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-sky-500/15 border border-sky-500/25 text-sky-400 text-[11px] font-black uppercase tracking-wider active:scale-95 transition-transform"
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
                                <button
                                    aria-label="Use"
                                    onClick={handleSaveToLog}
                                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 text-[11px] font-black uppercase tracking-wider active:scale-95 transition-transform"
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
                                    Save to Log
                                </button>
                            </div>
                            {passageToast && (
                                <div className="mt-1.5 text-center text-[11px] font-bold text-emerald-400 animate-in fade-in duration-200">
                                    {passageToast}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
};
