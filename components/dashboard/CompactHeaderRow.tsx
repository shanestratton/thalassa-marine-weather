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

/**
 * The moon as a line glyph in the chip's icon style: an outlined disc with
 * its lit part filled. The phase emoji was the page's only colour emoji and,
 * a yellow disc beside GOLDEN HOUR, read as a second sun (UX scorecard run
 * 10). Drawn as the phase emoji draws it (lit on the right while waxing).
 */
const MoonPhaseGlyph: React.FC<{ phase?: string; className?: string }> = ({ phase = '', className }) => {
    const name = phase.toLowerCase();
    const waning = name.includes('waning') || name.includes('last');
    // The terminator's half-width, and which way it bows.
    const lit = name.startsWith('full')
        ? 'full'
        : name.startsWith('new')
          ? 'none'
          : name.includes('quarter')
            ? 'half'
            : name.includes('gibbous')
              ? 'gibbous'
              : 'crescent';
    // Limb arc from top to bottom down the lit side, back up the terminator.
    const limbSweep = waning ? 0 : 1;
    const d =
        lit === 'half'
            ? `M12 3 A9 9 0 0 ${limbSweep} 12 21 Z`
            : lit === 'crescent'
              ? `M12 3 A9 9 0 0 ${limbSweep} 12 21 A4.5 9 0 0 ${1 - limbSweep} 12 3 Z`
              : lit === 'gibbous'
                ? `M12 3 A9 9 0 0 ${limbSweep} 12 21 A4.5 9 0 0 ${limbSweep} 12 3 Z`
                : null;
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            className={className}
            aria-hidden="true"
            data-moon-phase={lit}
        >
            <circle cx="12" cy="12" r="9" />
            {lit === 'full' && <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity={0.55} />}
            {d && <path d={d} fill="currentColor" fillOpacity={0.55} strokeLinejoin="round" />}
        </svg>
    );
};

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

    // A time is known when it has a digit: '', '--' and '--:--' are pending.
    const riseKnown = !!sunrise && /\d/.test(sunrise);
    const setKnown = !!sunset && /\d/.test(sunset);
    const goldenHour = Boolean(riseKnown && setKnown && sunrise && sunset && isGoldenHour(sunrise, sunset));

    // What the chip says, one sr-only phrase per part with its comma at the
    // end. A comma in its own span, or leading the next part, was read with a
    // space before it ('Sunrise 05:41 , sunset 17:53 , full moon'), because
    // each sr-only span is a block in the name (UX scorecard run 9).
    const riseWords = riseKnown
        ? `Sunrise ${sunrise}`
        : setKnown
          ? 'Sunrise not yet known'
          : 'Sunrise and sunset not yet known';
    // When both are pending the sunset is said with the sunrise.
    const setWords = setKnown ? `sunset ${sunset}` : riseKnown ? 'sunset not yet known' : '';
    const withComma = (words: string, more: boolean) => (more ? `${words},` : words);

    return (
        <div className="w-full flex items-center gap-2">
            {/* WARNINGS BUTTON - Expands to fill available space. The live
                region wraps the warnings alone: around the whole row it
                re-read the sunrise and sunset on every day swipe.
                Not h-11: index.css floors .h-11 after the utilities, so it beat
                the trimmed-rhythm h-8 and the pill stood 44 pt tall beside a
                30 pt chip, overhanging the hero card (UX scorecard run 7). The
                pill is drawn 40 pt, the sun chip's height, where 44 beside 40
                read as two unrelated pills (run 10); the ::before of
                hit-target-44 keeps the 44 pt hit area. */}
            <div className="flex-1 min-w-0 flex" aria-live="polite" aria-atomic="true">
                <button
                    onClick={() => {
                        void triggerHaptic('light');
                        setPage('warnings');
                    }}
                    aria-label={hasWarnings ? `${activeAlerts.length} active weather warnings` : 'No forecast alerts'}
                    className={`${
                        hasWarnings
                            ? 'glass-warning-status bg-red-700 hover:bg-red-800 border-red-400/50'
                            : 'bg-emerald-500/10 border-emerald-500/20'
                    } transition-all active:scale-[0.97] border rounded-xl px-2.5 h-[40px] in-data-[glass-rhythm]:h-8 hit-target-44 flex items-center gap-1.5 shadow-lg cursor-pointer group flex-1 min-w-0`}
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
                            {/* It opens Forecast alerts, which checks forecast
                                thresholds only. 'NO WARNINGS' read as 'no
                                official warnings' (UX scorecard run 9). The
                                pill's padding and gap, and the sun chip's gap,
                                are trimmed so the words stay on one line at
                                375 pt. */}
                            <span className="glass-clear-status text-emerald-100 font-bold text-xs leading-4 text-balance">
                                No forecast alerts
                            </span>
                        </>
                    )}
                </button>
            </div>

            {/* CELESTIAL CARD - Sunrise, Sunset, Moon, Golden Hour.
                The times and the moon glyph said nothing to a screen reader
                ('05:42 17:53 🌕'), so each carries its words. */}
            <div
                className={`${goldenHour ? 'bg-amber-500/15 border-amber-400/25' : `bg-slate-800/60 ${t.border.default}`} rounded-xl px-3 h-[40px] in-data-[glass-rhythm]:h-8 flex items-center gap-2.5 shrink-0 transition-colors duration-500`}
                role="group"
                aria-label="Sun and moon"
            >
                {/* Golden Hour Badge - replaces sunrise/sunset when active */}
                {goldenHour ? (
                    <div className="flex items-center gap-1.5 animate-in fade-in duration-500">
                        <SunIcon className="w-3.5 h-3.5 text-amber-400" />
                        {/* Sentence case, as the alerts pill beside it (UX
                            scorecard run 10: tracked caps against a sentence). */}
                        <span aria-hidden="true" className="text-xs leading-4 font-bold text-amber-300">
                            Golden hour
                        </span>
                        <span className="sr-only">{withComma('Golden hour', !!moonPhase)}</span>
                    </div>
                ) : (
                    <>
                        {/* Sunrise and sunset keep their slots while they load:
                            the chip used to drop both and show the moon alone,
                            with no sign anything was pending (UX scorecard run 8).
                            '--:--' is the muted placeholder, read as words. */}
                        <div className="flex items-center gap-1.5">
                            <SunriseIcon className="w-3.5 h-3.5 text-amber-400" />
                            <span
                                className={`font-bold text-sm font-mono tracking-tight ${riseKnown ? 'text-white' : 'text-slate-500'}`}
                            >
                                <span aria-hidden="true">{riseKnown ? sunrise : '--:--'}</span>
                                <span className="sr-only">{withComma(riseWords, !!setWords || !!moonPhase)}</span>
                            </span>
                        </div>

                        <div className="flex items-center gap-1.5">
                            <SunsetIcon className="w-3.5 h-3.5 text-purple-400" />
                            <span
                                className={`font-bold text-sm font-mono tracking-tight ${setKnown ? 'text-white' : 'text-slate-500'}`}
                            >
                                <span aria-hidden="true">{setKnown ? sunset : '--:--'}</span>
                                {setWords && <span className="sr-only">{withComma(setWords, !!moonPhase)}</span>}
                            </span>
                        </div>
                    </>
                )}

                {/* Moon phase: the glyph is the picture, the words are what is
                    read. The part before it carries the comma. */}
                {moonPhase && (
                    <span className="inline-flex items-center leading-none">
                        <MoonPhaseGlyph phase={moonPhaseName} className="w-4 h-4 text-white/80" />
                        <span className="sr-only">
                            {moonPhaseName ? `${moonPhaseName.toLowerCase()} moon` : 'moon phase'}
                        </span>
                    </span>
                )}
            </div>
        </div>
    );
};
