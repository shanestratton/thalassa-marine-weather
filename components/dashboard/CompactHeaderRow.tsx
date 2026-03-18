import React, { useState } from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('CompactHeaderRow');
import { t } from '../../theme';
import { CheckIcon, AlertTriangleIcon, SunriseIcon, SunsetIcon } from '../Icons';
import { useUI } from '../../context/UIContext';
import { isGoldenHour } from '../../utils/goldenHour';
import type { DashboardMode } from '../../types';

// Critical warnings that CANNOT be dismissed (must match AlertsBanner/WarningDetails)
const CRITICAL_PATTERNS = [
    'STORM WARNING',
    'GALE WARNING',
    'DANGEROUS SEAS',
    'FREEZING SPRAY',
    'FREEZE WARNING',
    'EXCESSIVE HEAT',
    'DENSE FOG',
    'STORM WATCH',
    'GALE WATCH',
];
const isCritical = (alert: string) => CRITICAL_PATTERNS.some((p) => alert.toUpperCase().includes(p));

export const CompactHeaderRow = ({
    alerts,
    sunrise,
    sunset,
    precipitation: _precipitation,
    moonPhase,
    dashboardMode: _dashboardMode,
    onToggleDashboardMode: _onToggleDashboardMode,
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

    // Read dismissed state from sessionStorage (shared with AlertsBanner + WarningDetails)
    const getDismissed = (): Set<string> => {
        try {
            const stored = sessionStorage.getItem('thalassa_dismissed_alerts');
            return stored ? new Set(JSON.parse(stored)) : new Set();
        } catch (e) {
            log.warn(e);
            return new Set();
        }
    };

    const dismissed = getDismissed();
    const activeAlerts = (alerts || []).filter((a) => isCritical(a) || !dismissed.has(a));
    const hasWarnings = activeAlerts.length > 0;

    return (
        <div className="w-full flex items-center gap-2" aria-live="polite" aria-atomic="true">
            {/* WARNINGS BUTTON - Expands to fill available space */}
            <button
                onClick={() => setPage('warnings')}
                aria-label={
                    hasWarnings ? `${activeAlerts.length} active weather warnings` : 'No active weather warnings'
                }
                className={`${
                    hasWarnings
                        ? 'bg-red-500 hover:bg-red-600 border-red-400/50'
                        : 'bg-emerald-500/10 border-emerald-500/20'
                } transition-colors border rounded-xl px-3 h-[40px] flex items-center gap-2 shadow-lg cursor-pointer group flex-1`}
            >
                {hasWarnings ? (
                    <>
                        <AlertTriangleIcon className="w-4 h-4 text-white animate-pulse" />
                        <span className="text-white font-bold uppercase tracking-wider text-sm">Warnings</span>
                        <div className="bg-white text-red-600 font-bold text-sm w-5 h-5 flex items-center justify-center rounded-full shadow-md group-hover:scale-110 transition-transform ml-auto">
                            {activeAlerts.length}
                        </div>
                    </>
                ) : (
                    <>
                        <CheckIcon className="w-4 h-4 text-emerald-400" />
                        <span className="text-emerald-100 font-bold text-sm uppercase tracking-wider">No Warnings</span>
                    </>
                )}
            </button>

            {/* CELESTIAL CARD - Sunrise, Sunset, Moon, Golden Hour */}
            <div
                className={`${sunrise && sunset && isGoldenHour(sunrise, sunset) ? 'bg-amber-500/15 border-amber-400/25' : `bg-slate-800/60 ${t.border.default}`} rounded-xl px-3 h-[40px] flex items-center gap-3 flex-shrink-0 transition-colors duration-500`}
                role="status"
                aria-label="Celestial data"
            >
                {/* Golden Hour Badge - replaces sunrise/sunset when active */}
                {sunrise && sunset && isGoldenHour(sunrise, sunset) ? (
                    <div className="flex items-center gap-1.5 animate-in fade-in duration-500">
                        <span className="text-sm">📸</span>
                        <span className="text-xs font-bold text-amber-300 uppercase tracking-wider">Golden Hour</span>
                    </div>
                ) : (
                    <>
                        {/* Sunrise */}
                        {sunrise && (
                            <div className="flex items-center gap-1.5">
                                <SunriseIcon className="w-3.5 h-3.5 text-amber-400" />
                                <span className="text-white font-bold text-sm font-mono tracking-tight">{sunrise}</span>
                            </div>
                        )}

                        {/* Sunset */}
                        {sunset && (
                            <div className="flex items-center gap-1.5">
                                <SunsetIcon className="w-3.5 h-3.5 text-purple-400" />
                                <span className="text-white font-bold text-sm font-mono tracking-tight">{sunset}</span>
                            </div>
                        )}
                    </>
                )}

                {/* Moon Phase - Just emoji */}
                {moonPhase && (
                    <span className="text-base leading-none" aria-label="Moon phase">
                        {moonPhase}
                    </span>
                )}
            </div>
        </div>
    );
};
