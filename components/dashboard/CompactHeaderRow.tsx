import React from 'react';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('CompactHeaderRow');
import { t } from '../../theme';
import { CheckIcon, AlertTriangleIcon, SunIcon, SunriseIcon, SunsetIcon } from '../Icons';
import { useUI } from '../../context/UIContext';
import { triggerHaptic } from '../../utils/system';
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
    moonPhaseName,
    dashboardMode: _dashboardMode,
    onToggleDashboardMode: _onToggleDashboardMode,
}: {
    alerts?: string[];
    sunrise?: string;
    sunset?: string;
    precipitation?: number | null;
    moonPhase?: string;
    /** The phase in words ("Full", "Waxing Crescent"), spoken in place of the glyph. */
    moonPhaseName?: string;
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

    const goldenHour = Boolean(sunrise && sunset && isGoldenHour(sunrise, sunset));

    return (
        <div className="w-full flex items-center gap-2">
            {/* WARNINGS BUTTON - Expands to fill available space. The live
                region wraps the warnings alone: around the whole row it
                re-read the sunrise and sunset on every day swipe.
                Not h-11: index.css floors .h-11 after the utilities, so it beat
                the trimmed-rhythm h-8 and the pill stood 44 pt tall beside a
                30 pt chip, overhanging the hero card (UX scorecard run 7). The
                ::before of hit-target-44 keeps the 44 pt hit area. */}
            <div className="flex-1 min-w-0 flex" aria-live="polite" aria-atomic="true">
                <button
                    onClick={() => {
                        void triggerHaptic('light');
                        setPage('warnings');
                    }}
                    aria-label={
                        hasWarnings ? `${activeAlerts.length} active weather warnings` : 'No active weather warnings'
                    }
                    className={`${
                        hasWarnings
                            ? 'glass-warning-status bg-red-700 hover:bg-red-800 border-red-400/50'
                            : 'bg-emerald-500/10 border-emerald-500/20'
                    } transition-all active:scale-[0.97] border rounded-xl px-3 h-[max(44px,2.75rem)] -my-0.5 in-data-[glass-rhythm]:h-8 in-data-[glass-rhythm]:my-0 hit-target-44 flex items-center gap-2 shadow-lg cursor-pointer group flex-1 min-w-0`}
                >
                    {hasWarnings ? (
                        <>
                            <AlertTriangleIcon className="w-4 h-4 glass-warning-label animate-pulse" />
                            <span className="glass-warning-label font-bold uppercase tracking-wider text-sm">
                                Warnings
                            </span>
                            <div className="bg-white text-red-700 font-bold text-sm w-5 h-5 flex items-center justify-center rounded-full shadow-md group-hover:scale-110 transition-transform ml-auto">
                                {activeAlerts.length}
                            </div>
                        </>
                    ) : (
                        <>
                            <CheckIcon className="w-4 h-4 text-emerald-400" />
                            <span className="glass-clear-status text-emerald-100 font-bold text-sm uppercase tracking-wider">
                                No Warnings
                            </span>
                        </>
                    )}
                </button>
            </div>

            {/* CELESTIAL CARD - Sunrise, Sunset, Moon, Golden Hour.
                The times and the moon glyph said nothing to a screen reader
                ('05:42 17:53 🌕'), so each carries its words. */}
            <div
                className={`${goldenHour ? 'bg-amber-500/15 border-amber-400/25' : `bg-slate-800/60 ${t.border.default}`} rounded-xl px-3 h-[40px] in-data-[glass-rhythm]:h-8 flex items-center gap-3 shrink-0 transition-colors duration-500`}
                role="group"
                aria-label="Sun and moon"
            >
                {/* Golden Hour Badge - replaces sunrise/sunset when active */}
                {goldenHour ? (
                    <div className="flex items-center gap-1.5 animate-in fade-in duration-500">
                        <SunIcon className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-xs font-bold text-amber-300 uppercase tracking-wider">Golden Hour</span>
                    </div>
                ) : (
                    <>
                        {/* Sunrise */}
                        {sunrise && (
                            <div className="flex items-center gap-1.5">
                                <SunriseIcon className="w-3.5 h-3.5 text-amber-400" />
                                <span className="text-white font-bold text-sm font-mono tracking-tight">
                                    <span className="sr-only">Sunrise </span>
                                    {sunrise}
                                </span>
                            </div>
                        )}

                        {/* Sunset */}
                        {sunset && (
                            <div className="flex items-center gap-1.5">
                                <SunsetIcon className="w-3.5 h-3.5 text-purple-400" />
                                <span className="text-white font-bold text-sm font-mono tracking-tight">
                                    <span className="sr-only">, sunset </span>
                                    {sunset}
                                </span>
                            </div>
                        )}
                    </>
                )}

                {/* Moon phase: the glyph is the picture, the words are what is read. */}
                {moonPhase && (
                    <span className="text-base leading-none">
                        <span aria-hidden="true">{moonPhase}</span>
                        <span className="sr-only">
                            , {moonPhaseName ? `${moonPhaseName.toLowerCase()} moon` : 'moon phase'}
                        </span>
                    </span>
                )}
            </div>
        </div>
    );
};
