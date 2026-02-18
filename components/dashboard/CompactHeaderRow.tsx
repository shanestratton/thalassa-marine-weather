import React from 'react';
import { t } from '../../theme';
import { CheckIcon, AlertTriangleIcon, SunriseIcon, SunsetIcon, RainIcon, MoonIcon } from '../Icons';
import { useUI } from '../../context/UIContext';
import type { DashboardMode } from '../../types';

export const CompactHeaderRow = ({
    alerts,
    sunrise,
    sunset,
    precipitation,
    moonPhase,
    dashboardMode,
    onToggleDashboardMode
}: {
    alerts?: string[];
    sunrise?: string;
    sunset?: string;
    precipitation?: number | null;
    moonPhase?: string;
    dashboardMode?: DashboardMode;
    onToggleDashboardMode?: () => void;
}) => {
    const { setPage } = useUI();
    const hasWarnings = alerts && alerts.length > 0;

    return (
        <div className="w-full flex items-center gap-2" aria-live="polite" aria-atomic="true">
            {/* WARNINGS BUTTON - Expands to fill available space */}
            <button
                onClick={() => setPage('warnings')}
                className={`${hasWarnings
                    ? 'bg-red-500 hover:bg-red-600 border-red-400/50'
                    : 'bg-emerald-500/10 border-emerald-500/20'
                    } transition-colors border rounded-xl px-3 h-[40px] flex items-center gap-2 backdrop-blur-md shadow-lg cursor-pointer group flex-1`}
            >
                {hasWarnings ? (
                    <>
                        <AlertTriangleIcon className="w-4 h-4 text-white animate-pulse" />
                        <span className="text-white font-bold uppercase tracking-wider text-sm">
                            Warnings
                        </span>
                        <div className="bg-white text-red-600 font-bold text-sm w-5 h-5 flex items-center justify-center rounded-full shadow-md group-hover:scale-110 transition-transform ml-auto">
                            {alerts.length}
                        </div>
                    </>
                ) : (
                    <>
                        <CheckIcon className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-100 font-bold text-sm uppercase tracking-wider">
                            No Warnings
                        </span>
                    </>
                )}
            </button>


            {/* CELESTIAL CARD - Sunrise, Sunset, Moon */}
            <div className={`bg-slate-800/60 ${t.border.default} rounded-xl px-3 h-[40px] flex items-center gap-3 backdrop-blur-md flex-shrink-0`}>
                {/* Sunrise */}
                {sunrise && (
                    <div className="flex items-center gap-1.5">
                        <SunriseIcon className="w-3.5 h-3.5 text-orange-400" />
                        <span className="text-white font-bold text-sm font-mono tracking-tight">
                            {sunrise}
                        </span>
                    </div>
                )}

                {/* Sunset */}
                {sunset && (
                    <div className="flex items-center gap-1.5">
                        <SunsetIcon className="w-3.5 h-3.5 text-purple-400" />
                        <span className="text-white font-bold text-sm font-mono tracking-tight">
                            {sunset}
                        </span>
                    </div>
                )}

                {/* Moon Phase - Just emoji */}
                {moonPhase && (
                    <span className="text-base leading-none">
                        {moonPhase}
                    </span>
                )}
            </div>
        </div>
    );
};
