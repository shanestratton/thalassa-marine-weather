/**
 * Route Intelligence Panel
 * Per-waypoint weather forecasts with tide-aware ETAs and night crossing analysis
 */

import React from 'react';
import { t } from '../../theme';
import { VoyagePlan, VesselProfile, Waypoint } from '../../types';
import {
    WindIcon, WaveIcon, ClockIcon, SunIcon, MoonIcon,
    AlertTriangleIcon, MapPinIcon, ArrowRightIcon
} from '../Icons';

interface RouteIntelligenceProps {
    voyagePlan: VoyagePlan;
    vessel: VesselProfile;
    departureTime?: string; // ISO datetime
}

interface WaypointForecast {
    waypoint: Waypoint;
    index: number;
    etaHours: number;
    etaTime: Date;
    isNightArrival: boolean;
    conditions: {
        wind: number;
        waves: number;
        tidePhase?: 'rising' | 'falling' | 'slack';
    };
    legDistance: number;
    cumulativeDistance: number;
    alerts: string[];
}

/**
 * Calculate ETA and conditions for each waypoint
 */
function calculateWaypointForecasts(
    voyagePlan: VoyagePlan,
    vessel: VesselProfile,
    departureTime: Date
): WaypointForecast[] {
    if (!voyagePlan.waypoints || voyagePlan.waypoints.length === 0) {
        return [];
    }

    const forecasts: WaypointForecast[] = [];
    const cruiseSpeed = vessel.cruisingSpeed || 6;
    let cumulativeHours = 0;
    let cumulativeDistance = 0;

    // Calculate leg distances using haversine
    const calcDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
        const R = 3440.065; // Earth radius in nm
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    let prevLat = voyagePlan.originCoordinates?.lat || 0;
    let prevLon = voyagePlan.originCoordinates?.lon || 0;

    voyagePlan.waypoints.forEach((wp, i) => {
        if (!wp.coordinates) return;

        const legDistance = calcDistance(prevLat, prevLon, wp.coordinates.lat, wp.coordinates.lon);
        const legHours = legDistance / cruiseSpeed;
        cumulativeHours += legHours;
        cumulativeDistance += legDistance;

        const etaTime = new Date(departureTime.getTime() + cumulativeHours * 3600 * 1000);
        const etaHour = etaTime.getHours();
        const isNightArrival = etaHour < 6 || etaHour > 20;

        const alerts: string[] = [];
        if (isNightArrival) alerts.push('Night arrival');
        if ((wp.windSpeed || 0) > 20) alerts.push('High winds');
        if ((wp.waveHeight || 0) > 2) alerts.push('Rough seas');

        // Estimate tide phase based on hour (simplified)
        const tidePhase: 'rising' | 'falling' | 'slack' =
            etaHour % 6 < 2 ? 'slack' : etaHour % 12 < 6 ? 'rising' : 'falling';

        forecasts.push({
            waypoint: wp,
            index: i,
            etaHours: cumulativeHours,
            etaTime,
            isNightArrival,
            conditions: {
                wind: wp.windSpeed || 0,
                waves: wp.waveHeight || 0,
                tidePhase
            },
            legDistance,
            cumulativeDistance,
            alerts
        });

        prevLat = wp.coordinates.lat;
        prevLon = wp.coordinates.lon;
    });

    return forecasts;
}

export const RouteIntelligence: React.FC<RouteIntelligenceProps> = ({
    voyagePlan,
    vessel,
    departureTime
}) => {
    const departure = departureTime ? new Date(departureTime) : new Date();
    const forecasts = calculateWaypointForecasts(voyagePlan, vessel, departure);

    if (forecasts.length === 0) {
        return (
            <div className={`bg-slate-800/50 rounded-xl p-4 ${t.border.default} text-center`}>
                <span className="text-sm text-slate-400">No waypoints defined for route analysis</span>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <MapPinIcon className="w-4 h-4 text-sky-400" />
                    Route Intelligence
                </h3>
                <span className="text-sm text-slate-500">
                    {forecasts.length} waypoints analyzed
                </span>
            </div>

            {/* Waypoint Timeline */}
            <div className="space-y-3">
                {forecasts.map((fc, i) => (
                    <div
                        key={fc.index}
                        className={`
                            relative rounded-xl p-4 border transition-all
                            ${fc.alerts.length > 0
                                ? 'bg-amber-500/5 border-amber-500/20 hover:border-amber-500/40'
                                : 'bg-slate-800/50 border-white/10 hover:border-white/20'}
                        `}
                    >
                        {/* Connection Line */}
                        {i < forecasts.length - 1 && (
                            <div className="absolute left-7 bottom-0 w-0.5 h-3 bg-gradient-to-b from-sky-500/50 to-transparent" />
                        )}

                        {/* Header Row */}
                        <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-3">
                                {/* Waypoint Number */}
                                <div className="w-8 h-8 rounded-full bg-sky-500/20 border border-sky-500/40 flex items-center justify-center shrink-0">
                                    <span className="text-sm font-bold text-sky-300">{fc.index + 1}</span>
                                </div>
                                <div>
                                    <h4 className="text-sm font-bold text-white">{fc.waypoint.name}</h4>
                                    <div className="text-sm text-slate-400 font-mono">
                                        {fc.waypoint.coordinates?.lat.toFixed(3)}°N, {Math.abs(fc.waypoint.coordinates?.lon || 0).toFixed(3)}°W
                                    </div>
                                </div>
                            </div>

                            {/* ETA Badge */}
                            <div className={`
                                flex items-center gap-2 px-2 py-1 rounded-lg
                                ${fc.isNightArrival
                                    ? 'bg-indigo-500/20 border border-indigo-500/30'
                                    : 'bg-emerald-500/10 border border-emerald-500/20'}
                            `}>
                                {fc.isNightArrival
                                    ? <MoonIcon className="w-3 h-3 text-indigo-300" />
                                    : <SunIcon className="w-3 h-3 text-emerald-300" />
                                }
                                <span className="text-sm font-bold text-white">
                                    {fc.etaTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                </span>
                            </div>
                        </div>

                        {/* Conditions Grid */}
                        <div className="grid grid-cols-4 gap-2 text-center mb-2">
                            {/* Distance */}
                            <div className="bg-black/20 rounded-lg p-2">
                                <div className="text-sm text-slate-500 uppercase mb-0.5">Leg</div>
                                <div className="text-sm font-bold text-white">{fc.legDistance.toFixed(1)} nm</div>
                            </div>

                            {/* ETA Hours */}
                            <div className="bg-black/20 rounded-lg p-2">
                                <div className="text-sm text-slate-500 uppercase mb-0.5">ETA</div>
                                <div className="text-sm font-bold text-white">T+{fc.etaHours.toFixed(1)}h</div>
                            </div>

                            {/* Wind */}
                            <div className={`rounded-lg p-2 ${fc.conditions.wind > 20 ? 'bg-orange-500/20' : 'bg-black/20'}`}>
                                <div className="text-sm text-slate-500 uppercase mb-0.5 flex items-center justify-center gap-1">
                                    <WindIcon className="w-2.5 h-2.5" /> Wind
                                </div>
                                <div className={`text-sm font-bold ${fc.conditions.wind > 20 ? 'text-orange-300' : 'text-white'}`}>
                                    {fc.conditions.wind} kt
                                </div>
                            </div>

                            {/* Waves */}
                            <div className={`rounded-lg p-2 ${fc.conditions.waves > 2 ? 'bg-blue-500/20' : 'bg-black/20'}`}>
                                <div className="text-sm text-slate-500 uppercase mb-0.5 flex items-center justify-center gap-1">
                                    <WaveIcon className="w-2.5 h-2.5" /> Seas
                                </div>
                                <div className={`text-sm font-bold ${fc.conditions.waves > 2 ? 'text-blue-300' : 'text-white'}`}>
                                    {fc.conditions.waves} ft
                                </div>
                            </div>
                        </div>

                        {/* Alerts */}
                        {fc.alerts.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                                {fc.alerts.map((alert, ai) => (
                                    <span
                                        key={ai}
                                        className="text-sm font-bold uppercase px-1.5 py-0.5 bg-amber-500/20 text-amber-300 rounded border border-amber-500/30"
                                    >
                                        {alert}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {/* Summary Bar */}
            <div className={`bg-slate-800/50 rounded-xl p-3 ${t.border.default} flex items-center justify-between`}>
                <div className="flex items-center gap-4 text-sm text-slate-400">
                    <span>
                        <span className="text-white font-bold">{forecasts[forecasts.length - 1]?.cumulativeDistance.toFixed(1)}</span> nm total
                    </span>
                    <span>
                        <span className="text-white font-bold">{forecasts[forecasts.length - 1]?.etaHours.toFixed(1)}</span>h duration
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    {forecasts.some(f => f.isNightArrival) && (
                        <span className="text-sm font-bold text-indigo-300 bg-indigo-500/20 px-1.5 py-0.5 rounded border border-indigo-500/30">
                            NIGHT CROSSING
                        </span>
                    )}
                    {forecasts.some(f => f.alerts.length > 0) && (
                        <span className="text-sm font-bold text-amber-300 bg-amber-500/20 px-1.5 py-0.5 rounded border border-amber-500/30">
                            {forecasts.filter(f => f.alerts.length > 0).length} ALERTS
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
};
