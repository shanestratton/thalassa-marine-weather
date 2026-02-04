import React from 'react';
import { CheckIcon, AlertTriangleIcon, SunriseIcon, SunsetIcon, RainIcon, MoonIcon } from '../Icons';
import { useUI } from '../../context/UIContext';

export const CompactHeaderRow = ({
    alerts,
    sunrise,
    sunset,
    precipitation,
    moonPhase
}: {
    alerts?: string[];
    sunrise?: string;
    sunset?: string;
    precipitation?: number | null;
    moonPhase?: string;
}) => {
    const { setPage } = useUI();
    const hasWarnings = alerts && alerts.length > 0;

    return (
        <div className="w-full flex items-center gap-2">
            {/* WARNINGS BUTTON - Expands to fill available space */}
            <button
                onClick={() => setPage('warnings')}
                className={`${hasWarnings
                    ? 'bg-red-500 hover:bg-red-600 border-red-400/50'
                    : 'bg-emerald-500/10 border-emerald-500/20'
                    } transition-colors border rounded-xl px-3 py-2.5 flex items-center gap-2 backdrop-blur-md shadow-lg cursor-pointer group flex-1`}
            >
                {hasWarnings ? (
                    <>
                        <AlertTriangleIcon className="w-4 h-4 text-white animate-pulse" />
                        <span className="text-white font-bold uppercase tracking-wider text-[10px]">
                            Warnings
                        </span>
                        <div className="bg-white text-red-600 font-black text-[10px] w-5 h-5 flex items-center justify-center rounded-full shadow-md group-hover:scale-110 transition-transform ml-auto">
                            {alerts.length}
                        </div>
                    </>
                ) : (
                    <>
                        <CheckIcon className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-100 font-bold text-[10px] uppercase tracking-wider">
                            No Warnings
                        </span>
                    </>
                )}
            </button>

            {/* CONSOLIDATED CELESTIAL CARD - Sunrise, Sunset, Moon in one card */}
            <div className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-2.5 flex items-center gap-3 backdrop-blur-md flex-shrink-0">
                {/* Sunrise */}
                {sunrise && (
                    <div className="flex items-center gap-1.5">
                        <SunriseIcon className="w-3.5 h-3.5 text-orange-400" />
                        <span className="text-white font-bold text-[11px] tracking-tight">
                            {sunrise}
                        </span>
                    </div>
                )}

                {/* Sunset */}
                {sunset && (
                    <div className="flex items-center gap-1.5">
                        <SunsetIcon className="w-3.5 h-3.5 text-purple-400" />
                        <span className="text-white font-bold text-[11px] tracking-tight">
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
