
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
    const [dismissed, setDismissed] = React.useState<Set<string>>(() => {
        // Restore dismissed alerts from sessionStorage (resets on app restart for safety)
        try {
            const stored = sessionStorage.getItem('thalassa_dismissed_alerts');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch (e) { console.warn('[WeatherGrid_exports]', e); return new Set(); }
    });

    // Critical warnings that CANNOT be dismissed (life/vessel safety)
    const CRITICAL_PATTERNS = [
        'STORM WARNING', 'GALE WARNING', 'DANGEROUS SEAS',
        'FREEZING SPRAY', 'FREEZE WARNING', 'EXCESSIVE HEAT',
        'DENSE FOG', 'STORM WATCH', 'GALE WATCH',
    ];
    const isCritical = (alert: string) =>
        CRITICAL_PATTERNS.some(p => alert.toUpperCase().includes(p));

    // Filter out dismissed non-critical alerts
    const activeAlerts = (alerts || []).filter(a =>
        isCritical(a) || !dismissed.has(a)
    );
    const dismissableCount = activeAlerts.filter(a => !isCritical(a)).length;

    const handleDismiss = (e: React.MouseEvent) => {
        e.stopPropagation();
        const toDismiss = (alerts || []).filter(a => !isCritical(a));
        const newDismissed = new Set([...dismissed, ...toDismiss]);
        setDismissed(newDismissed);
        try {
            sessionStorage.setItem('thalassa_dismissed_alerts',
                JSON.stringify([...newDismissed]));
        } catch (e) { console.warn('[WeatherGrid_exports] non-critical:', e); }
    };

    if (!activeAlerts || activeAlerts.length === 0) {
        return (
            <div className="w-full bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 flex items-center gap-3 mb-2">
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
        <div className="w-full bg-red-500 border border-red-400/50 rounded-xl p-3 flex items-center justify-between shadow-lg animate-in fade-in slide-in-from-top-2 mb-2 group relative">
            <button
                onClick={() => setPage('warnings')}
                className="flex items-center gap-2.5 flex-1 cursor-pointer"
            >
                <AlertTriangleIcon className="w-5 h-5 text-white animate-pulse" />
                <span className="text-white font-bold uppercase tracking-wider text-sm">
                    {activeAlerts.length === 1 ? activeAlerts[0] : `${activeAlerts.length} Warnings Active`}
                </span>
            </button>
            <div className="flex items-center gap-2">
                {dismissableCount > 0 && (
                    <button
                        onClick={handleDismiss}
                        className="bg-white/20 hover:bg-white/30 active:bg-white/40 text-white font-bold text-xs px-2.5 py-1.5 rounded-lg transition-colors uppercase tracking-wider"
                        title="Dismiss non-critical warnings"
                    >
                        OK
                    </button>
                )}
                <div className="bg-white text-red-600 font-bold text-sm w-6 h-6 flex items-center justify-center rounded-full shadow-md">
                    {activeAlerts.length}
                </div>
            </div>
        </div>
    );
};

export const MetricsWidget = ({ current, units, displayValues }: { current: WeatherMetrics, units: UnitPreferences, displayValues: CardDisplayValues }) => {
    const isSensorLocked = current.isEstimated === false;

    return (
        <div className="grid grid-cols-3 gap-4">
            <Card className={`col-span-1 border transition-colors ${isSensorLocked ? 'border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)]' : 'border-white/10'}`}>
                <div className="absolute top-2 right-2 flex gap-1">
                    {isSensorLocked && <span className="text-[7px] font-bold bg-emerald-500 text-white px-1 py-0.5 rounded leading-none uppercase tracking-tighter">Verified</span>}
                </div>
                <Metric icon={<WindIcon className="w-6 h-6" />} label={`Wind (${units.speed})`} value={`${displayValues.windSpeed}`} subValue={<span className="text-amber-300 font-medium">Gusting: {displayValues.gusts}</span>} isEstimated={current.isEstimated} />
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
