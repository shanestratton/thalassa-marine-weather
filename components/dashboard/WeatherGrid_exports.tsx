
import React from 'react';
import { Card } from './shared/Card';
import { Metric } from './shared/Metric';
import { AlertTriangleIcon, CheckIcon, WindIcon, CompassIcon, ThermometerIcon } from '../Icons';
import { WeatherMetrics, UnitPreferences } from '../../types';

export const AlertsBanner = ({ alerts }: { alerts?: string[] }) => {
    if (!alerts || alerts.length === 0) {
        return (
            <div className="w-full bg-blue-500/10 border border-blue-500/20 rounded-2xl p-4 flex items-center gap-4 animate-in fade-in slide-in-from-top-4 backdrop-blur-md mb-2">
                <div className="p-2 bg-blue-500/20 rounded-full text-blue-400 shrink-0 shadow-[0_0_15px_rgba(59,130,246,0.3)]">
                    <CheckIcon className="w-5 h-5" />
                </div>
                <div>
                    <h3 className="text-blue-200 font-bold uppercase tracking-wider text-xs mb-0.5">
                        No Active Warnings
                    </h3>
                    <p className="text-blue-100/70 text-xs font-medium">Conditions are currently stable.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="w-full bg-red-500/10 border border-red-500/20 rounded-2xl p-4 flex items-start gap-4 animate-in fade-in slide-in-from-top-4 backdrop-blur-md mb-2">
            <div className="p-2 bg-red-500/20 rounded-full text-red-400 shrink-0 shadow-[0_0_15px_rgba(239,68,68,0.3)]">
                <AlertTriangleIcon className="w-5 h-5" />
            </div>
            <div>
                <h3 className="text-red-200 font-bold uppercase tracking-wider text-xs mb-1 flex items-center gap-2">
                    Active Warnings <span className="bg-red-500 text-white text-[9px] px-1.5 py-0.5 rounded-full">{alerts.length}</span>
                </h3>
                <div className="space-y-1">
                    {alerts.map((alert, i) => (
                        <p key={i} className="text-red-100/90 text-sm font-medium leading-relaxed">{alert}</p>
                    ))}
                </div>
            </div>
        </div>
    );
};

export const MetricsWidget = ({ current, units, displayValues }: { current: WeatherMetrics, units: UnitPreferences, displayValues: any }) => {
    const isSensorLocked = current.isEstimated === false;
    
    return (
        <div className="grid grid-cols-3 gap-4">
            <Card className={`col-span-1 border transition-colors ${isSensorLocked ? 'border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)]' : 'border-white/10'}`}>
                <div className="absolute top-2 right-2 flex gap-1">
                    {isSensorLocked && <span className="text-[7px] font-black bg-emerald-500 text-white px-1 py-0.5 rounded leading-none uppercase tracking-tighter">Verified</span>}
                </div>
                <Metric icon={<WindIcon className="w-6 h-6" />} label={`Wind (${units.speed})`} value={`${displayValues.windSpeed}`} subValue={<span className="text-orange-300 font-medium">Gusting: {displayValues.gusts}</span>} isEstimated={current.isEstimated} />
            </Card>
            <Card className="col-span-1">
                <Metric icon={<CompassIcon rotation={current.windDegree} className="w-6 h-6" />} label="Direction" value={current.windDirection} subValue={`${current.windDegree || '--'}°`} isEstimated={current.isEstimated} />
            </Card>
            <Card className={`col-span-1 border transition-colors ${isSensorLocked ? 'border-emerald-500/30' : 'border-white/10'}`}>
                <Metric 
                    icon={<ThermometerIcon className="w-6 h-6" />} 
                    label="Water Temp" 
                    value={(current.waterTemperature !== null && current.waterTemperature !== undefined) ? `${displayValues.waterTemp}°` : "N/A"} 
                    subValue={<span className="opacity-60 text-[10px] uppercase">{(current.waterTemperature !== null && current.waterTemperature !== undefined) ? (isSensorLocked ? 'Verified Buoy' : 'Sea Surface Temp') : 'No Data'}</span>} 
                    isEstimated={current.isEstimated} 
                />
            </Card>
        </div>
    );
};
