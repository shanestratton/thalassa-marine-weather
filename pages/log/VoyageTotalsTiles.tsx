/**
 * VoyageTotalsTiles — the three hero gauge tiles (Distance / Sea Time /
 * Voyages) at the top of the Ship's Log, extracted verbatim from
 * pages/LogPage.tsx.
 */
import React from 'react';
import { formatVoyageDuration } from '../../utils/voyageTiming';

// Full class strings per accent so Tailwind sees every one of them.
const ACCENTS = {
    sky: {
        tile: 'border-sky-500/15 from-sky-500/10 via-sky-500/4 shadow-[0_2px_12px_-4px_rgba(56,189,248,0.15)]',
        edge: 'via-sky-400/40',
        icon: 'text-sky-400/40',
        label: 'text-sky-300/70',
        unit: 'text-sky-300/60',
    },
    emerald: {
        tile: 'border-emerald-500/15 from-emerald-500/10 via-emerald-500/4 shadow-[0_2px_12px_-4px_rgba(16,185,129,0.15)]',
        edge: 'via-emerald-400/40',
        icon: 'text-emerald-400/40',
        label: 'text-emerald-300/70',
        unit: 'text-emerald-300/60',
    },
    amber: {
        tile: 'border-amber-500/15 from-amber-500/10 via-amber-500/4 shadow-[0_2px_12px_-4px_rgba(245,158,11,0.15)]',
        edge: 'via-amber-400/40',
        icon: 'text-amber-400/40',
        label: 'text-amber-300/70',
        unit: 'text-amber-300/60',
    },
} as const;

/**
 * One tile. The icon has its OWN row above the label: sharing the label row it
 * sat on "VOYAGES" and "DISTANCE" and wrapped "SEA TIME" onto two lines, which
 * dropped that value ~35 px below its neighbours (UX audit run 5). Labels are
 * one fixed-height line; every value is the same size with tabular digits.
 */
const TotalsTile: React.FC<{
    accent: keyof typeof ACCENTS;
    icon: React.ReactNode;
    label: string;
    value: string;
    unit?: string;
    unavailable: boolean;
}> = ({ accent, icon, label, value, unit, unavailable }) => {
    const a = ACCENTS[accent];
    return (
        <div
            className={`relative min-w-0 rounded-2xl overflow-hidden border bg-linear-to-br to-transparent px-3 py-3.5 ${a.tile}`}
        >
            {/* Soft top-edge highlight */}
            <div
                className={`absolute top-0 left-0 right-0 h-px bg-linear-to-r from-transparent to-transparent ${a.edge}`}
            />
            <svg
                className={`mb-1.5 block h-4 w-4 ${a.icon}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                aria-hidden="true"
            >
                {icon}
            </svg>
            <div className={`mb-1.5 h-4 truncate text-[10px] font-bold uppercase leading-4 tracking-wider ${a.label}`}>
                {label}
            </div>
            <div className="flex flex-wrap items-baseline gap-x-1">
                {unavailable ? (
                    // Lifetime history failed and nothing is loaded: an honest
                    // blank, not a hard 0.0 that reads as "never sailed".
                    <span className="text-xl font-black text-white tabular-nums leading-none">
                        <span aria-hidden="true">--</span>
                        <span className="sr-only">not available</span>
                    </span>
                ) : (
                    <>
                        <span className="text-xl font-black text-white tabular-nums leading-none">{value}</span>
                        {unit && (
                            <span className={`text-[11px] font-bold uppercase tracking-wider ${a.unit}`}>{unit}</span>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export const VoyageTotalsTiles: React.FC<{
    voyageStats: { totalNm: number; totalMs: number; voyageCount: number };
    /** Show '--' instead of the totals (the lifetime source failed and nothing is loaded). */
    unavailable?: boolean;
}> = ({ voyageStats, unavailable = false }) => {
    // Aggregated server-side from voyage SUMMARIES (accurate
    // across the whole history, no points loaded). voyageStats
    // already excludes suggested/planned routes.
    const totalNmRaw = voyageStats.totalNm;
    const totalMs = voyageStats.totalMs;
    const atSeaValue = formatVoyageDuration(totalMs);
    return (
        <div className="shrink-0 px-4 pb-3">
            <div className="grid grid-cols-3 gap-2.5">
                {/* ── NM Sailed — compass-needle icon ── */}
                <TotalsTile
                    accent="sky"
                    label="Distance"
                    value={totalNmRaw.toFixed(1)}
                    unit="nm"
                    unavailable={unavailable}
                    icon={
                        <>
                            <circle cx="12" cy="12" r="9" />
                            <path d="M14.5 9.5L11 13l-1.5-1.5L13 8z" fill="currentColor" stroke="none" />
                            <path d="M9.5 14.5L13 11l1.5 1.5L11 16z" fill="currentColor" stroke="none" opacity="0.4" />
                        </>
                    }
                />
                {/* ── At Sea — clock-like circle-with-tick icon ──
                    "Sea Time", not "Time at Sea" — the longer label ran
                    into the clock icon (Shane 2026-08-13). */}
                <TotalsTile
                    accent="emerald"
                    label="Sea Time"
                    value={atSeaValue}
                    unavailable={unavailable}
                    icon={
                        <>
                            <circle cx="12" cy="12" r="9" />
                            <path d="M12 7v5l3 2" strokeLinecap="round" />
                        </>
                    }
                />
                {/* ── Voyages — anchor icon ── */}
                <TotalsTile
                    accent="amber"
                    label="Voyages"
                    value={String(voyageStats.voyageCount)}
                    unit={voyageStats.voyageCount === 1 ? 'log' : 'logs'}
                    unavailable={unavailable}
                    icon={
                        <>
                            <circle cx="12" cy="5" r="2" />
                            <path d="M12 7v13" strokeLinecap="round" />
                            <path d="M8 11h8" strokeLinecap="round" />
                            <path d="M5 15a7 7 0 0014 0" strokeLinecap="round" />
                        </>
                    }
                />
            </div>
        </div>
    );
};
