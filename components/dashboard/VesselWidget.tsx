/**
 * VesselWidget + VesselStatusWidget — Vessel hydrostatics display.
 *
 * Shows hull speed, displacement, motion comfort ratio, capsize screening,
 * and D/L ratio for the configured vessel. VesselStatusWidget adds tidal
 * and celestial context for the full dashboard marine/inland view.
 */
import React from 'react';
import { Card } from './shared/Card';
import {
    PowerBoatIcon,
    SailBoatIcon,
    SearchIcon,
    SunIcon,
    MoonIcon,
    EyeIcon,
    GaugeIcon,
    TideCurveIcon,
} from '../Icons';
import { Tide, UnitPreferences, VesselProfile, WeatherMetrics, HourlyForecast, TidePoint } from '../../types';
import { TideGUIDetails as _TideGUIDetails } from '../../services/weather/api/tides';
import { calculateMCR, calculateCSF, calculateDLR, calculateHullSpeed, convertDistance } from '../../utils';
import { MoonVisual, SolarArc } from './tide/CelestialComponents';
import { TideGraph } from './tide/TideGraph';

export interface VesselStatus {
    status?: 'safe' | 'unsafe';
}

export type VesselStatusStyles = Record<string, string>;

const VesselWidgetComponent = ({ vessel, vesselStatus }: { vessel: VesselProfile; vesselStatus: VesselStatus }) => {
    const hullSpeed = vessel && vessel.type !== 'observer' ? calculateHullSpeed(vessel.length) : null;
    const mcr = vessel && vessel.type === 'sail' ? calculateMCR(vessel.displacement, vessel.length, vessel.beam) : null;
    const csf = vessel && vessel.type === 'sail' ? calculateCSF(vessel.displacement, vessel.beam) : null;

    if (!vessel || vessel.type === 'observer') {
        return (
            <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-center items-center h-full text-center min-h-[220px]">
                <SearchIcon className="w-12 h-12 text-gray-400 mb-3" />
                <h3 className="text-lg font-medium text-white mb-1">Crew Member Mode</h3>
                <p className="text-xs text-gray-400 max-w-[200px]">Configure a vessel profile to see hydrostatics.</p>
            </Card>
        );
    }

    return (
        <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[220px]">
            <div className="flex justify-between items-start mb-2">
                <div className="flex items-center gap-2 text-amber-300">
                    {vessel.type === 'power' ? (
                        <PowerBoatIcon className="w-5 h-5" />
                    ) : (
                        <SailBoatIcon className="w-5 h-5" />
                    )}
                    <span className="text-sm font-bold uppercase tracking-widest truncate max-w-[150px]">
                        {vessel.name}
                    </span>
                </div>
                <div
                    className={`px-2 py-1 rounded border text-[11px] font-bold uppercase ${vesselStatus?.status === 'unsafe' ? 'bg-red-500/20 border-red-500/50 text-red-300' : 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'}`}
                >
                    {vesselStatus?.status === 'unsafe' ? 'Limits Exceeded' : 'Within Limits'}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mt-2">
                <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                    <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1">Hull Speed</span>
                    <span className="text-xl font-mono font-bold text-white">
                        {hullSpeed?.toFixed(1)} <span className="text-xs text-gray-400">kts</span>
                    </span>
                </div>
                <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                    <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1">Displacement</span>
                    <span className="text-xl font-mono font-bold text-white">
                        {(vessel.displacement / 2204.62).toFixed(1)} <span className="text-xs text-gray-400">t</span>
                    </span>
                </div>
                {vessel.type === 'sail' && (
                    <>
                        {mcr && (
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1">
                                    Comfort
                                </span>
                                <span
                                    className={`text-xl font-mono font-bold ${mcr > 30 ? 'text-emerald-300' : mcr > 20 ? 'text-yellow-300' : 'text-amber-300'}`}
                                >
                                    {Math.round(mcr)}
                                </span>
                            </div>
                        )}
                        {csf && (
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1">
                                    Capsize
                                </span>
                                <span
                                    className={`text-xl font-mono font-bold ${csf < 2 ? 'text-emerald-300' : 'text-red-300'}`}
                                >
                                    {csf.toFixed(1)}
                                </span>
                            </div>
                        )}
                    </>
                )}
            </div>
        </Card>
    );
};
export const VesselWidget = React.memo(VesselWidgetComponent);

// --- LEGACY EXPORT FOR BACKWARD COMPAT ---
const VesselStatusWidgetComponent = ({
    vessel,
    current,
    vesselStatus,
    statusStyles: _statusStyles,
    tides,
    hourlyTides,
    tideHourly,
    units,
    timeZone,
    modelUsed,
    isLandlocked,
    lat,
}: {
    vessel: VesselProfile;
    current: WeatherMetrics;
    vesselStatus: VesselStatus;
    statusStyles: VesselStatusStyles;
    tides: Tide[];
    hourlyTides: HourlyForecast[];
    tideHourly?: TidePoint[];
    units: UnitPreferences;
    timeZone?: string;
    modelUsed?: string;
    isLandlocked?: boolean;
    lat?: number;
}) => {
    const hullSpeed = vessel && vessel.type !== 'observer' ? calculateHullSpeed(vessel.length) : null;
    const mcr = vessel && vessel.type === 'sail' ? calculateMCR(vessel.displacement, vessel.length, vessel.beam) : null;
    const csf = vessel && vessel.type === 'sail' ? calculateCSF(vessel.displacement, vessel.length) : null;
    const dlr = vessel && vessel.type === 'sail' ? calculateDLR(vessel.displacement, vessel.length) : null;

    if (isLandlocked) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-start relative overflow-hidden gap-4">
                    <div className="flex items-center gap-2 mb-2">
                        <SunIcon className="w-5 h-5 text-amber-400" />
                        <span className="text-sm font-bold text-amber-300 uppercase tracking-widest">Solar Cycle</span>
                    </div>
                    <div className="flex-1 flex flex-col justify-center items-center py-4">
                        <SolarArc
                            sunrise={current.sunrise || '06:00'}
                            sunset={current.sunset || '18:00'}
                            showTimes={true}
                            size="large"
                        />
                    </div>
                    <div className="bg-white/5 rounded-xl p-3 border border-white/5 mt-auto">
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-gray-400 font-bold uppercase tracking-wider">Daylight Remaining</span>
                            <span className="text-white font-mono">
                                {current.uvIndex > 0 ? 'High Visibility' : 'Night Mode'}
                            </span>
                        </div>
                    </div>
                </Card>

                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-start">
                    <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2 text-sky-300">
                            <MoonIcon className="w-5 h-5" />
                            <span className="text-sm font-bold uppercase tracking-widest">Lunar & Atmosphere</span>
                        </div>
                    </div>
                    <div className="flex flex-col gap-4 mt-2">
                        <div className="bg-white/5 rounded-xl p-4 border border-white/5 flex items-center justify-between">
                            <MoonVisual
                                cloudCover={current.cloudCover || 0}
                                apiPhase={current.moonPhase}
                                apiIllumination={current.moonIllumination}
                                apiPhaseValue={current.moonPhaseValue}
                                lat={lat}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
                                <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1 flex items-center gap-1">
                                    <EyeIcon className="w-3 h-3" /> Visibility
                                </span>
                                <span className="text-xl font-mono font-bold text-white">
                                    {current.visibility
                                        ? convertDistance(current.visibility, units.visibility || 'mi')
                                        : '--'}
                                    <span className="text-xs text-gray-400 ml-1">{units.visibility || 'mi'}</span>
                                </span>
                            </div>
                            <div className="bg-white/5 rounded-xl p-3 border border-white/5 flex flex-col justify-between">
                                <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1 flex items-center gap-1">
                                    <GaugeIcon className="w-3 h-3" /> Pressure
                                </span>
                                <span className="text-xl font-mono font-bold text-white">
                                    {current.pressure ? Math.round(current.pressure) : '--'}
                                    <span className="text-xs text-gray-400 ml-1">hPa</span>
                                </span>
                            </div>
                        </div>
                    </div>
                </Card>
            </div>
        );
    }

    // --- MARINE VIEW (Original) ---
    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[220px] relative overflow-hidden gap-4">
                <div className="flex justify-between items-start mb-2">
                    <div className="flex items-center gap-2">
                        <TideCurveIcon className="w-5 h-5 text-sky-400" />
                        <span className="text-sm font-bold text-sky-300 uppercase tracking-widest">Tidal Cycle</span>
                    </div>
                    <MoonVisual
                        cloudCover={current.cloudCover || 0}
                        apiPhase={current.moonPhase}
                        apiIllumination={current.moonIllumination}
                        apiPhaseValue={current.moonPhaseValue}
                    />
                </div>
                <div className="flex-1 w-full min-h-[160px] relative z-10">
                    <TideGraph
                        tides={tides}
                        unit={units.tideHeight || 'm'}
                        timeZone={timeZone}
                        hourlyTides={hourlyTides}
                        tideSeries={tideHourly}
                        modelUsed={modelUsed}
                        unitPref={units}
                    />
                </div>
                {current.sunrise && current.sunset && current.sunrise !== '--:--' && (
                    <div className="mt-1 pt-2 border-t border-white/5">
                        <SolarArc sunrise={current.sunrise} sunset={current.sunset} />
                    </div>
                )}
            </Card>

            {vessel && vessel.type !== 'observer' ? (
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-between min-h-[220px]">
                    <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2 text-amber-300">
                            {vessel.type === 'power' ? (
                                <PowerBoatIcon className="w-5 h-5" />
                            ) : (
                                <SailBoatIcon className="w-5 h-5" />
                            )}
                            <span className="text-sm font-bold uppercase tracking-widest truncate max-w-[150px]">
                                {vessel.name}
                            </span>
                        </div>
                        <div
                            className={`px-2 py-1 rounded border text-[11px] font-bold uppercase ${vesselStatus?.status === 'unsafe' ? 'bg-red-500/20 border-red-500/50 text-red-300' : 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'}`}
                        >
                            {vesselStatus?.status === 'unsafe' ? 'Limits Exceeded' : 'Within Limits'}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mt-2">
                        <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                            <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1">
                                Theoretical Hull Speed
                            </span>
                            <span className="text-xl font-mono font-bold text-white">
                                {hullSpeed?.toFixed(1)} <span className="text-xs text-gray-400">kts</span>
                            </span>
                        </div>
                        <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                            <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1">
                                Displacement
                            </span>
                            <span className="text-xl font-mono font-bold text-white">
                                {(vessel.displacement / 2204.62).toFixed(1)}{' '}
                                <span className="text-xs text-gray-400">t</span>
                            </span>
                        </div>
                        {vessel.type === 'sail' && (
                            <>
                                {mcr && (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                        <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1">
                                            Motion Comfort
                                        </span>
                                        <span
                                            className={`text-xl font-mono font-bold ${mcr > 30 ? 'text-emerald-300' : mcr > 20 ? 'text-yellow-300' : 'text-amber-300'}`}
                                        >
                                            {Math.round(mcr)}
                                        </span>
                                    </div>
                                )}
                                {csf && (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                        <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1">
                                            Capsize Risk
                                        </span>
                                        <span
                                            className={`text-xl font-mono font-bold ${csf < 2 ? 'text-emerald-300' : 'text-red-300'}`}
                                        >
                                            {csf.toFixed(1)}
                                        </span>
                                    </div>
                                )}
                                {dlr && (
                                    <div className="bg-white/5 rounded-xl p-3 border border-white/5">
                                        <span className="text-[11px] text-gray-400 uppercase font-bold block mb-1">
                                            D/L Ratio
                                        </span>
                                        <span className="text-xl font-mono font-bold text-white">
                                            {Math.round(dlr)}
                                        </span>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </Card>
            ) : (
                <Card className="bg-slate-900/60 border border-white/10 p-5 flex flex-col justify-center items-center h-full text-center min-h-[220px]">
                    <SearchIcon className="w-12 h-12 text-gray-400 mb-3" />
                    <h3 className="text-lg font-medium text-white mb-1">Crew Member Mode</h3>
                    <p className="text-xs text-gray-400 max-w-[200px]">
                        Configure a vessel profile to see hydrostatics.
                    </p>
                </Card>
            )}
        </div>
    );
};
export const VesselStatusWidget = React.memo(VesselStatusWidgetComponent);
