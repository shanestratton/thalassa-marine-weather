/**
 * PassageDataPanel — Tablet-only data panel for passage planning (Helm mode).
 *
 * Displays route analysis, waypoint table, and weather conditions
 * in a 30%-width sidebar alongside the map.
 */

import React from 'react';
import type { RouteAnalysis } from '../../services/WeatherRoutingService';
import type { TurnWaypoint } from '../../services/IsochroneRouter';

interface PassageDataPanelProps {
    routeAnalysis: RouteAnalysis | null;
    departure: { lat: number; lon: number; name: string } | null;
    arrival: { lat: number; lon: number; name: string } | null;
    turnWaypoints: TurnWaypoint[];
    departureTime: string;
}

export const PassageDataPanel: React.FC<PassageDataPanelProps> = ({
    routeAnalysis,
    departure,
    arrival,
    turnWaypoints,
    departureTime,
}) => {
    const depTime = departureTime ? new Date(departureTime) : new Date();

    return (
        <div className="h-full w-full overflow-y-auto bg-slate-950/95 border-l border-white/[0.06]">
            {/* Header */}
            <div className="px-4 pt-4 pb-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2 mb-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    <h2 className="text-[11px] font-black text-white uppercase tracking-widest">Passage Plan</h2>
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                    {departure?.name || '—'} → {arrival?.name || '—'}
                </p>
            </div>

            {/* Route Summary */}
            {routeAnalysis && (
                <div className="px-4 py-3 border-b border-white/[0.06]">
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">
                                Distance
                            </span>
                            <p className="text-lg font-black text-white tabular-nums">
                                {routeAnalysis.totalDistance.toFixed(0)}
                                <span className="text-[11px] text-gray-500 ml-1">NM</span>
                            </p>
                        </div>
                        <div>
                            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">
                                Duration
                            </span>
                            <p className="text-lg font-black text-white tabular-nums">
                                {routeAnalysis.estimatedDuration < 24
                                    ? `${routeAnalysis.estimatedDuration.toFixed(1)}h`
                                    : `${Math.floor(routeAnalysis.estimatedDuration / 24)}d ${Math.round(routeAnalysis.estimatedDuration % 24)}h`}
                            </p>
                        </div>
                        <div>
                            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">
                                Departure
                            </span>
                            <p className="text-sm font-bold text-sky-400 tabular-nums">
                                {depTime.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })}
                                <span className="text-gray-500 ml-1">
                                    {depTime.toLocaleTimeString('en-AU', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        hour12: false,
                                    })}
                                </span>
                            </p>
                        </div>
                        <div>
                            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-widest">ETA</span>
                            <p className="text-sm font-bold text-amber-400 tabular-nums">
                                {new Date(
                                    depTime.getTime() + routeAnalysis.estimatedDuration * 3600000,
                                ).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })}
                                <span className="text-gray-500 ml-1">
                                    {new Date(
                                        depTime.getTime() + routeAnalysis.estimatedDuration * 3600000,
                                    ).toLocaleTimeString('en-AU', {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        hour12: false,
                                    })}
                                </span>
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Waypoint Table */}
            {turnWaypoints.length > 0 && (
                <div className="px-4 py-3">
                    <h3 className="text-[11px] font-black text-gray-400 uppercase tracking-widest mb-2">Waypoints</h3>
                    <div className="space-y-1">
                        {turnWaypoints.map((wp, i) => {
                            const etaDate = wp.eta ? new Date(wp.eta) : null;
                            const isFirst = wp.id === 'DEP';
                            const isLast = wp.id === 'ARR';
                            return (
                                <div
                                    key={wp.id}
                                    className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border transition-colors ${
                                        isFirst
                                            ? 'bg-emerald-500/5 border-emerald-500/15'
                                            : isLast
                                              ? 'bg-red-500/5 border-red-500/15'
                                              : 'bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.04]'
                                    }`}
                                >
                                    {/* Number badge */}
                                    <div
                                        className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-black shrink-0 ${
                                            isFirst
                                                ? 'bg-emerald-500/20 text-emerald-400'
                                                : isLast
                                                  ? 'bg-red-500/20 text-red-400'
                                                  : 'bg-amber-500/20 text-amber-400'
                                        }`}
                                    >
                                        {isFirst ? 'D' : isLast ? 'A' : i}
                                    </div>

                                    {/* Details */}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[11px] font-bold text-white truncate">{wp.id}</p>
                                        <p className="text-[11px] text-gray-500 tabular-nums">
                                            {wp.lat.toFixed(2)}° {wp.lon.toFixed(2)}°
                                            {wp.distanceNM > 0 && (
                                                <span className="ml-1.5">• {wp.distanceNM.toFixed(0)} NM</span>
                                            )}
                                        </p>
                                    </div>

                                    {/* Bearing + Wind */}
                                    <div className="text-right shrink-0">
                                        {wp.bearing > 0 && (
                                            <p className="text-[11px] font-bold text-white tabular-nums">
                                                {Math.round(wp.bearing)}°
                                            </p>
                                        )}
                                        {wp.tws > 0 && (
                                            <p className="text-[11px] text-gray-500 tabular-nums">
                                                {wp.tws.toFixed(0)} kts
                                            </p>
                                        )}
                                    </div>

                                    {/* ETA */}
                                    <div className="text-right shrink-0 min-w-[40px]">
                                        {etaDate && (
                                            <p className="text-[11px] font-bold text-sky-400/80 tabular-nums">
                                                {etaDate.toLocaleTimeString('en-AU', {
                                                    hour: '2-digit',
                                                    minute: '2-digit',
                                                    hour12: false,
                                                })}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Empty state */}
            {!routeAnalysis && (
                <div className="px-4 py-8 text-center">
                    <div className="text-2xl mb-2">🧭</div>
                    <p className="text-[11px] text-gray-500">Tap the map to set departure and arrival points</p>
                </div>
            )}
        </div>
    );
};
