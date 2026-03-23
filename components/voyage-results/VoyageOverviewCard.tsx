/**
 * VoyageOverviewCard — Hero card showing origin/destination, distance, duration,
 * conditions, and viability status.
 */

import React from 'react';
import type { VoyagePlan, VesselProfile } from '../../types';
import { fmtCoord } from '../../utils/coords';
import {
    SailBoatIcon,
    PowerBoatIcon,
    RouteIcon,
    ClockIcon,
    WindIcon,
    WaveIcon as _WaveIcon,
    DiamondIcon,
} from '../Icons';

const getStatusClasses = (status?: string) => {
    switch (status) {
        case 'SAFE':
            return 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400';
        case 'CAUTION':
            return 'bg-amber-500/10 border-amber-500/30 text-amber-400';
        case 'UNSAFE':
            return 'bg-red-500/10 border-red-500/30 text-red-400';
        default:
            return 'bg-slate-800 border-white/10 text-gray-400';
    }
};

interface VoyageOverviewCardProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    isRouteAnalyzed: boolean;
    displayWave: (ftVal: number | undefined) => string;
    waveLabel: string;
}

export const VoyageOverviewCard: React.FC<VoyageOverviewCardProps> = React.memo(
    ({ voyagePlan, vessel, isRouteAnalyzed, displayWave, waveLabel }) => (
        <div className="w-full bg-slate-900 border border-white/10 rounded-2xl p-0 relative overflow-hidden shadow-2xl flex flex-col">
            {/* Background Decorations */}
            <div className="absolute top-0 right-0 w-96 h-96 bg-sky-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none"></div>

            {/* Header: Route — Departing → Arriving */}
            <div className="p-6 md:p-8 pb-0 flex items-center gap-4 relative z-10">
                {/* Origin */}
                <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-[11px] text-gray-400 font-bold uppercase tracking-widest mb-1">
                        Departing
                    </span>
                    <span className="text-xl md:text-3xl font-bold text-white tracking-tight truncate">
                        {voyagePlan.origin && typeof voyagePlan.origin === 'string'
                            ? voyagePlan.origin.split(',')[0]
                            : 'Unknown'}
                    </span>
                    <span className="text-[11px] text-gray-400 font-mono mt-1">
                        {fmtCoord(voyagePlan.originCoordinates?.lat, voyagePlan.originCoordinates?.lon, 2)}
                    </span>
                </div>

                {/* Route Connector */}
                <div className="flex flex-col items-center justify-center shrink-0 gap-0.5 py-2 min-w-[80px] md:min-w-[140px]">
                    <div className="w-full flex items-center gap-0">
                        <div className="h-px flex-1 bg-gradient-to-r from-transparent via-sky-500/40 to-sky-500/60" />
                        <div className="p-1.5 bg-sky-500/10 border border-sky-500/30 rounded-full shadow-[0_0_8px_rgba(56,189,248,0.15)]">
                            {vessel?.type === 'power' ? (
                                <PowerBoatIcon className="w-3.5 h-3.5 text-sky-400" />
                            ) : (
                                <SailBoatIcon className="w-3.5 h-3.5 text-sky-400" />
                            )}
                        </div>
                        <div className="h-px flex-1 bg-gradient-to-r from-sky-500/60 via-sky-500/40 to-transparent" />
                    </div>
                    <span className="text-[11px] text-sky-400/70 font-bold uppercase tracking-[0.15em] mt-0.5">
                        {voyagePlan.departureDate}
                    </span>
                </div>

                {/* Destination */}
                <div className="flex flex-col text-right items-end min-w-0 flex-1">
                    <span className="text-[11px] text-gray-400 font-bold uppercase tracking-widest mb-1">Arriving</span>
                    <span className="text-xl md:text-3xl font-bold text-white tracking-tight truncate">
                        {voyagePlan.destination && typeof voyagePlan.destination === 'string'
                            ? voyagePlan.destination.split(',')[0]
                            : 'Unknown'}
                    </span>
                    <span className="text-[11px] text-gray-400 font-mono mt-1">
                        {fmtCoord(voyagePlan.destinationCoordinates?.lat, voyagePlan.destinationCoordinates?.lon, 2)}
                    </span>
                </div>
            </div>

            {/* Stats Stack */}
            <div className="px-6 md:px-8 pb-6 flex flex-col gap-2.5 relative z-10">
                {/* Distance */}
                <div className="bg-white/5 rounded-xl px-4 py-3 border border-white/5 flex items-center justify-between group hover:bg-white/10 transition-colors">
                    <div className="flex items-center gap-3 text-gray-400 group-hover:text-sky-300 transition-colors">
                        <div className="p-1.5 bg-sky-500/10 rounded-lg">
                            <RouteIcon className="w-4 h-4 text-sky-400" />
                        </div>
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-300">Distance</span>
                    </div>
                    <div className="text-right">
                        {isRouteAnalyzed ? (
                            <>
                                <span className="text-lg font-bold text-white">{voyagePlan.distanceApprox}</span>
                                <span className="text-[11px] text-gray-400 block">Nautical Miles</span>
                            </>
                        ) : (
                            <>
                                <span className="text-lg font-bold text-amber-300/80 animate-pulse">Routing...</span>
                                <span className="text-[11px] text-gray-400 block">Awaiting route analysis</span>
                            </>
                        )}
                    </div>
                </div>

                {/* Duration */}
                <div className="bg-white/5 rounded-xl px-4 py-3 border border-white/5 flex items-center justify-between group hover:bg-white/10 transition-colors">
                    <div className="flex items-center gap-3 text-gray-400 group-hover:text-sky-300 transition-colors">
                        <div className="p-1.5 bg-sky-500/10 rounded-lg">
                            <ClockIcon className="w-4 h-4 text-sky-400" />
                        </div>
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-300">Duration</span>
                    </div>
                    <div className="text-right">
                        {isRouteAnalyzed ? (
                            <>
                                <span className="text-lg font-bold text-white">{voyagePlan.durationApprox}</span>
                                <span className="text-[11px] text-gray-400 block">Estimated Time</span>
                            </>
                        ) : (
                            <>
                                <span className="text-lg font-bold text-amber-300/80 animate-pulse">Routing...</span>
                                <span className="text-[11px] text-gray-400 block">Awaiting route analysis</span>
                            </>
                        )}
                    </div>
                </div>

                {/* Max Conditions */}
                <div className="bg-white/5 rounded-xl px-4 py-3 border border-white/5 flex items-center justify-between group hover:bg-white/10 transition-colors">
                    <div className="flex items-center gap-3 text-gray-400 group-hover:text-amber-300 transition-colors">
                        <div className="p-1.5 bg-amber-500/10 rounded-lg">
                            <WindIcon className="w-4 h-4 text-amber-400" />
                        </div>
                        <span className="text-xs font-bold uppercase tracking-widest text-gray-300">
                            Max Conditions
                        </span>
                    </div>
                    <div className="text-right flex items-baseline gap-3">
                        <div>
                            <span className="text-lg font-bold text-white">
                                {voyagePlan.suitability?.maxWindEncountered ?? '--'}
                            </span>
                            <span className="text-[11px] text-gray-400 ml-0.5">kts</span>
                        </div>
                        <div className="text-[11px] text-sky-300 font-medium border-l border-white/10 pl-3">
                            {displayWave(voyagePlan.suitability?.maxWaveEncountered)} {waveLabel} seas
                        </div>
                    </div>
                </div>

                {/* Viability Status */}
                <div
                    className={`rounded-xl px-4 py-3 border flex items-center justify-between ${getStatusClasses(voyagePlan.suitability?.status)}`}
                >
                    <div className="flex items-center gap-3 opacity-90">
                        <div className="p-1.5 bg-current/10 rounded-lg opacity-60">
                            <DiamondIcon className="w-4 h-4" />
                        </div>
                        <div>
                            <span className="text-lg font-black uppercase tracking-wide">
                                {voyagePlan.suitability?.status}
                            </span>
                            <span className="text-[11px] opacity-70 block leading-tight">
                                {voyagePlan.suitability?.reasoning || 'Route analyzed.'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    ),
);
