
import React from 'react';
import { t } from '../../theme';
import { Card } from './shared/Card';
import { Metric } from './shared/Metric';
import { AlertTriangleIcon, CheckIcon, WindIcon, CompassIcon, ThermometerIcon } from '../Icons';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { CardDisplayValues } from './hero/types';

import { useUI } from '../../context/UIContext';

export const AlertsBanner = ({ alerts }: { alerts?: string[] }) => {
    const { setPage } = useUI();

    if (!alerts || alerts.length === 0) {
        return (
            <div className="w-full bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 flex items-center gap-3 backdrop-blur-md mb-2">
                <div className="p-1.5 bg-emerald-500/20 rounded-full">
                    <CheckIcon className="w-4 h-4 text-emerald-400" />
                </div>
                <div className="flex flex-col">
                    <span className="text-emerald-100 font-bold text-sm uppercase tracking-wider">No Warnings</span>
                    <span className="text-emerald-500/60 text-sm uppercase tracking-widest font-medium">Conditions Stable</span>
                </div>
            </div>
        );
    }

    return (
        <button
            onClick={() => setPage('warnings')}
            className="w-full bg-red-500 hover:bg-red-600 transition-colors border border-red-400/50 rounded-xl p-3 flex items-center justify-between shadow-lg animate-in fade-in slide-in-from-top-2 cursor-pointer mb-2 group"
        >
            <div className="flex items-center gap-2.5">
                <AlertTriangleIcon className="w-5 h-5 text-white animate-pulse" />
                <span className="text-white font-bold uppercase tracking-wider text-sm">
                    Warnings Active
                </span>
            </div>
            <div className="bg-white text-red-600 font-black text-sm w-6 h-6 flex items-center justify-center rounded-full shadow-md group-hover:scale-110 transition-transform">
                {alerts.length}
            </div>
        </button>
    );
};

export const MetricsWidget = ({ current, units, displayValues }: { current: WeatherMetrics, units: UnitPreferences, displayValues: CardDisplayValues }) => {
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
                <Metric icon={<CompassIcon rotation={current.windDegree ?? 0} className="w-6 h-6" />} label="Direction" value={current.windDirection} subValue={`${current.windDegree || '--'}°`} isEstimated={current.isEstimated} />
            </Card>
            <Card className={`col-span-1 border transition-colors ${isSensorLocked ? 'border-emerald-500/30' : 'border-white/10'}`}>
                <Metric
                    icon={<ThermometerIcon className="w-6 h-6" />}
                    label="Water Temp"
                    value={(current.waterTemperature !== null && current.waterTemperature !== undefined) ? `${displayValues.waterTemperature}°` : "N/A"}
                    subValue={<span className="opacity-60 text-sm uppercase">{(current.waterTemperature !== null && current.waterTemperature !== undefined) ? (isSensorLocked ? 'Verified Buoy' : 'Sea Surface Temp') : 'No Data'}</span>}
                    isEstimated={current.isEstimated}
                />
            </Card>
        </div>
    );
};
