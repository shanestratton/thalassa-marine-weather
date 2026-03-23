/**
 * VoyageLogTable — Comprehensive waypoint telemetry table
 * showing departure, all waypoints, and arrival with conditions.
 */

import React from 'react';
import type { VoyagePlan, VesselProfile } from '../../types';
import { fmtLat, fmtLon, fmtCoord } from '../../utils/coords';
import { calculateDistance } from '../../utils/math';
import { WindIcon, WaveIcon } from '../Icons';

interface VoyageLogTableProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    isRouteAnalyzed: boolean;
    displayWave: (ftVal: number | undefined) => string;
    waveLabel: string;
}

export const VoyageLogTable: React.FC<VoyageLogTableProps> = React.memo(
    ({ voyagePlan, vessel: _vessel, isRouteAnalyzed, displayWave, waveLabel }) => (
        <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-left border-collapse">
                <thead>
                    <tr className="text-[11px] text-gray-400 uppercase tracking-widest border-b border-white/10">
                        <th className="pb-3 pl-2 font-bold">Waypoint / ETA</th>
                        <th className="pb-3 font-bold">Position</th>
                        <th className="pb-3 font-bold">Depth</th>
                        <th className="pb-3 font-bold">Wind</th>
                        <th className="pb-3 font-bold">Sea State</th>
                        <th className="pb-3 font-bold">Notes</th>
                    </tr>
                </thead>
                <tbody className="text-xs md:text-sm font-mono text-gray-300">
                    {/* Origin Row */}
                    <tr className="border-b border-white/5 group hover:bg-white/5 transition-colors">
                        <td className="py-3.5 pl-2">
                            <div className="font-bold text-white">DEPARTURE</div>
                            <div className="text-[11px] text-gray-400">T+00:00</div>
                        </td>
                        <td className="py-3.5">
                            <div className="text-white">
                                {voyagePlan.origin && typeof voyagePlan.origin === 'string'
                                    ? voyagePlan.origin.split(',')[0]
                                    : 'Origin'}
                            </div>
                            <div className="text-[11px] text-gray-400 opacity-60">
                                {fmtCoord(voyagePlan.originCoordinates?.lat, voyagePlan.originCoordinates?.lon)}
                            </div>
                        </td>
                        <td className="py-3.5 text-gray-400 italic">--</td>
                        <td className="py-3.5 text-gray-400 italic">--</td>
                        <td className="py-3.5 text-gray-400 italic">--</td>
                        <td className="py-3.5 text-gray-400 max-w-[200px] truncate">
                            Departure: {voyagePlan.departureDate}
                        </td>
                    </tr>

                    {/* Waypoints */}
                    {voyagePlan.waypoints.map((wp, i) => {
                        const prevLat =
                            i === 0
                                ? voyagePlan.originCoordinates?.lat || 0
                                : voyagePlan.waypoints[i - 1].coordinates?.lat || 0;
                        const prevLon =
                            i === 0
                                ? voyagePlan.originCoordinates?.lon || 0
                                : voyagePlan.waypoints[i - 1].coordinates?.lon || 0;
                        const distKm =
                            wp.coordinates && prevLat
                                ? calculateDistance(prevLat, prevLon, wp.coordinates.lat, wp.coordinates.lon)
                                : 0;
                        const _distNm = distKm * 0.539957;

                        return (
                            <tr key={i} className="border-b border-white/5 group hover:bg-white/5 transition-colors">
                                <td className="py-3.5 pl-2">
                                    <div className="font-bold text-sky-400">WP-{String(i + 1).padStart(2, '0')}</div>
                                    <div className="text-[11px] text-gray-400">{wp.name}</div>
                                </td>
                                <td className="py-3.5">
                                    {wp.coordinates ? (
                                        <>
                                            <div>{fmtLat(wp.coordinates.lat)}</div>
                                            <div className="opacity-60">{fmtLon(wp.coordinates.lon)}</div>
                                        </>
                                    ) : (
                                        '--'
                                    )}
                                </td>
                                <td className="py-3.5">
                                    {wp.depth_m !== undefined ? (
                                        <div
                                            className={`flex items-center gap-1 font-mono text-xs ${wp.depth_m < 10 ? 'text-red-400' : wp.depth_m < 30 ? 'text-amber-400' : 'text-sky-400'}`}
                                        >
                                            ⚓ {wp.depth_m}m
                                        </div>
                                    ) : (
                                        <span className="text-gray-400 italic">--</span>
                                    )}
                                </td>
                                <td className="py-3.5">
                                    <div className="flex items-center gap-1.5 text-sky-300">
                                        <WindIcon className="w-3.5 h-3.5" /> {wp.windSpeed ?? '--'}kt
                                    </div>
                                </td>
                                <td className="py-3.5">
                                    <div className="flex items-center gap-1.5 text-sky-300">
                                        <WaveIcon className="w-3.5 h-3.5" /> {displayWave(wp.waveHeight)}
                                        {waveLabel}
                                    </div>
                                </td>
                                <td className="py-3.5">
                                    <div className="flex flex-col gap-1">
                                        {(wp.windSpeed || 0) > 20 && (
                                            <span className="text-[11px] font-bold text-amber-400 px-1.5 py-0.5 bg-amber-500/10 rounded w-fit border border-amber-500/20">
                                                HIGH WIND
                                            </span>
                                        )}
                                        {(wp.waveHeight || 0) > (waveLabel === 'm' ? 1.2 : 4) && (
                                            <span className="text-[11px] font-bold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded w-fit border border-sky-500/20">
                                                ROUGH SEAS
                                            </span>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        );
                    })}

                    {/* Destination Row */}
                    <tr className="group hover:bg-white/5 transition-colors">
                        <td className="py-3.5 pl-2">
                            <div className="font-bold text-white">ARRIVAL</div>
                            <div className="text-[11px] text-gray-400">
                                {isRouteAnalyzed ? `Est. ${voyagePlan.durationApprox}` : 'Duration pending...'}
                            </div>
                        </td>
                        <td className="py-3.5">
                            <div className="text-white">
                                {voyagePlan.destination && typeof voyagePlan.destination === 'string'
                                    ? voyagePlan.destination.split(',')[0]
                                    : 'Destination'}
                            </div>
                            <div className="text-[11px] text-gray-400 opacity-60">
                                {fmtCoord(
                                    voyagePlan.destinationCoordinates?.lat,
                                    voyagePlan.destinationCoordinates?.lon,
                                )}
                            </div>
                        </td>
                        <td className="py-3.5 text-gray-400 italic">--</td>
                        <td className="py-3.5 text-gray-400 italic">--</td>
                        <td className="py-3.5 text-gray-400 italic">--</td>
                        <td className="py-3.5 text-emerald-400 font-bold text-xs uppercase tracking-wider">
                            Destination Reach
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    ),
);
