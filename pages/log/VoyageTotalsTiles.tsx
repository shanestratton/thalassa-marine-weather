/**
 * VoyageTotalsTiles — the three hero gauge tiles (Distance / Sea Time /
 * Voyages) at the top of the Ship's Log, extracted verbatim from
 * pages/LogPage.tsx.
 */
import React from 'react';

export const VoyageTotalsTiles: React.FC<{
    voyageStats: { totalNm: number; totalMs: number; voyageCount: number };
}> = ({ voyageStats }) => {
    // Aggregated server-side from voyage SUMMARIES (accurate
    // across the whole history, no points loaded). voyageStats
    // already excludes suggested/planned routes.
    const totalNmRaw = voyageStats.totalNm;
    const totalMs = voyageStats.totalMs;
    const totalHrs = Math.round((totalMs / (1000 * 60 * 60)) * 10) / 10;
    const atSeaDays = Math.round(totalHrs / 24);
    const atSeaValue = totalHrs < 24 ? totalHrs.toString() : atSeaDays.toString();
    // Singular where it is singular: "1 days" read as a typo on the skipper's own log.
    const atSeaUnit = totalHrs < 24 ? (totalHrs === 1 ? 'hr' : 'hrs') : atSeaDays === 1 ? 'day' : 'days';
    return (
        <div className="shrink-0 px-4 pb-3">
            <div className="grid grid-cols-3 gap-2.5">
                {/* ── NM Sailed ── */}
                <div className="relative rounded-2xl overflow-hidden border border-sky-500/15 bg-linear-to-br from-sky-500/10 via-sky-500/4 to-transparent p-3.5 shadow-[0_2px_12px_-4px_rgba(56,189,248,0.15)]">
                    {/* Soft top-edge highlight */}
                    <div className="absolute top-0 left-0 right-0 h-px bg-linear-to-r from-transparent via-sky-400/40 to-transparent" />
                    {/* Compass-needle icon, top-right */}
                    <svg
                        className="absolute top-2.5 right-2.5 w-4 h-4 text-sky-400/40"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        aria-hidden="true"
                    >
                        <circle cx="12" cy="12" r="9" />
                        <path d="M14.5 9.5L11 13l-1.5-1.5L13 8z" fill="currentColor" stroke="none" />
                        <path d="M9.5 14.5L13 11l1.5 1.5L11 16z" fill="currentColor" stroke="none" opacity="0.4" />
                    </svg>
                    <div className="text-[10px] font-bold text-sky-300/70 uppercase tracking-widest mb-2">Distance</div>
                    <div className="flex items-baseline gap-1">
                        <span className="text-2xl font-black text-white tabular-nums leading-none">
                            {totalNmRaw.toFixed(1)}
                        </span>
                        <span className="text-[11px] font-bold text-sky-300/60 uppercase tracking-wider">nm</span>
                    </div>
                </div>
                {/* ── At Sea ── */}
                <div className="relative rounded-2xl overflow-hidden border border-emerald-500/15 bg-linear-to-br from-emerald-500/10 via-emerald-500/4 to-transparent p-3.5 shadow-[0_2px_12px_-4px_rgba(16,185,129,0.15)]">
                    <div className="absolute top-0 left-0 right-0 h-px bg-linear-to-r from-transparent via-emerald-400/40 to-transparent" />
                    {/* Clock-like circle-with-tick icon */}
                    <svg
                        className="absolute top-2.5 right-2.5 w-4 h-4 text-emerald-400/40"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        aria-hidden="true"
                    >
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" strokeLinecap="round" />
                    </svg>
                    {/* "Sea Time", not "Time at Sea" — the longer label ran
                                            into the clock icon (Shane 2026-08-13). */}
                    <div className="text-[10px] font-bold text-emerald-300/70 uppercase tracking-widest mb-2">
                        Sea Time
                    </div>
                    <div className="flex items-baseline gap-1">
                        <span className="text-2xl font-black text-white tabular-nums leading-none">{atSeaValue}</span>
                        <span className="text-[11px] font-bold text-emerald-300/60 uppercase tracking-wider">
                            {atSeaUnit}
                        </span>
                    </div>
                </div>
                {/* ── Voyages ── */}
                <div className="relative rounded-2xl overflow-hidden border border-amber-500/15 bg-linear-to-br from-amber-500/10 via-amber-500/4 to-transparent p-3.5 shadow-[0_2px_12px_-4px_rgba(245,158,11,0.15)]">
                    <div className="absolute top-0 left-0 right-0 h-px bg-linear-to-r from-transparent via-amber-400/40 to-transparent" />
                    {/* Anchor icon */}
                    <svg
                        className="absolute top-2.5 right-2.5 w-4 h-4 text-amber-400/40"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        aria-hidden="true"
                    >
                        <circle cx="12" cy="5" r="2" />
                        <path d="M12 7v13" strokeLinecap="round" />
                        <path d="M8 11h8" strokeLinecap="round" />
                        <path d="M5 15a7 7 0 0014 0" strokeLinecap="round" />
                    </svg>
                    <div className="text-[10px] font-bold text-amber-300/70 uppercase tracking-widest mb-2">
                        Voyages
                    </div>
                    <div className="flex items-baseline gap-1">
                        <span className="text-2xl font-black text-white tabular-nums leading-none">
                            {voyageStats.voyageCount}
                        </span>
                        <span className="text-[11px] font-bold text-amber-300/60 uppercase tracking-wider">
                            {voyageStats.voyageCount === 1 ? 'log' : 'logs'}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
};
