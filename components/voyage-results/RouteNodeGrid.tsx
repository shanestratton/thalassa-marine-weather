/**
 * RouteNodeGrid — Suggested route plan waypoint cards.
 */

import React from 'react';
import type { VoyagePlan } from '../../types';
import { fmtCoord } from '../../utils/coords';
import { RouteIcon, WindIcon, WaveIcon } from '../Icons';

interface RouteNodeGridProps {
    voyagePlan: VoyagePlan;
    isRouteAnalyzed: boolean;
    setIsMapOpen: (open: boolean) => void;
    displayWave: (ftVal: number | undefined) => string;
    waveLabel: string;
}

export const RouteNodeGrid: React.FC<RouteNodeGridProps> = React.memo(
    ({ voyagePlan, isRouteAnalyzed, setIsMapOpen, displayWave, waveLabel }) => {
        if (!isRouteAnalyzed) {
            return (
                <div className="flex flex-col items-center justify-center py-10 opacity-70 border-2 border-dashed border-amber-500/20 rounded-xl bg-amber-500/5">
                    <div className="animate-pulse flex flex-col items-center gap-3">
                        <RouteIcon className="w-10 h-10 text-amber-400/60" />
                        <span className="text-sm font-bold text-amber-300/80 uppercase tracking-widest">
                            Computing Route...
                        </span>
                        <span className="text-xs text-gray-400 max-w-xs text-center">
                            Waypoints will appear once weather routing analysis completes
                        </span>
                    </div>
                </div>
            );
        }

        if (!voyagePlan.waypoints || voyagePlan.waypoints.length === 0) {
            return (
                <div className="flex flex-col items-center justify-center py-10 opacity-50 border-2 border-dashed border-white/10 rounded-xl bg-white/5">
                    <RouteIcon className="w-10 h-10 text-gray-400 mb-3" />
                    <span className="text-sm font-bold text-gray-400 uppercase tracking-widest">Direct Route</span>
                    <span className="text-xs text-gray-400 mt-1">No intermediate stops required</span>
                </div>
            );
        }

        return (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {voyagePlan.waypoints.map((wp, i) => (
                    <div
                        key={i}
                        className="flex gap-3 relative group cursor-pointer select-none bg-white/5 hover:bg-white/10 border border-white/5 hover:border-sky-500/30 rounded-xl p-4 transition-all"
                        onClick={() => setIsMapOpen(true)}
                    >
                        {/* Node Number Badge */}
                        <div className="absolute -top-2 -right-2 w-6 h-6 bg-slate-800 border border-white/10 rounded-full flex items-center justify-center text-[11px] font-mono text-gray-400 shadow-lg group-hover:border-sky-500/50 group-hover:text-sky-400 transition-colors">
                            {i + 1}
                        </div>

                        {/* Serial Icon */}
                        <div className="mt-1">
                            <div className="w-8 h-8 rounded-full bg-slate-900 border-2 border-sky-500/30 flex items-center justify-center shrink-0 shadow-lg shadow-sky-900/10 group-hover:scale-110 transition-transform">
                                <div className="w-2.5 h-2.5 bg-sky-500 rounded-full"></div>
                            </div>
                        </div>

                        <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-bold text-white tracking-wide truncate mb-1 pr-4">{wp.name}</h4>
                            <span className="text-[11px] font-mono text-gray-400 block mb-2">
                                {fmtCoord(wp.coordinates?.lat, wp.coordinates?.lon)}
                            </span>

                            {/* Conditions Mini-Grid */}
                            <div className="grid grid-cols-2 gap-2">
                                {wp.windSpeed !== undefined && (
                                    <div className="bg-black/20 rounded px-2 py-1 flex items-center gap-1.5">
                                        <WindIcon className="w-3 h-3 text-sky-400" />
                                        <span className="text-[11px] text-gray-300 font-medium">{wp.windSpeed}kt</span>
                                    </div>
                                )}
                                {wp.waveHeight !== undefined && (
                                    <div className="bg-black/20 rounded px-2 py-1 flex items-center gap-1.5">
                                        <WaveIcon className="w-3 h-3 text-sky-400" />
                                        <span className="text-[11px] text-gray-300 font-medium">
                                            {displayWave(wp.waveHeight)}
                                            {waveLabel}
                                        </span>
                                    </div>
                                )}
                                {wp.depth_m !== undefined && (
                                    <div className="bg-black/20 rounded px-2 py-1 flex items-center gap-1.5">
                                        <span
                                            className={`text-[11px] font-mono font-bold ${wp.depth_m < 10 ? 'text-red-400' : wp.depth_m < 30 ? 'text-amber-400' : 'text-sky-400'}`}
                                        >
                                            ⚓ {wp.depth_m}m
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        );
    },
);
