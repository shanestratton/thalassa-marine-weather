import React from 'react';
import type { WindHistorySummary } from '../../utils/windHistory';

function format(value: number | null | undefined): string {
    return value !== null && value !== undefined && Number.isFinite(value) ? value.toFixed(1) : '—';
}

/** Same three-card footprint; recording belongs to the feed, never this view. */
export function WindHistoryStats({
    apparentWind,
    history,
    onShowDetails,
}: {
    apparentWind: number | null;
    history: WindHistorySummary | null;
    onShowDetails: () => void;
}) {
    return (
        <div className="w-full grid grid-cols-3 gap-2 items-center">
            <div className="rounded-xl bg-white/3 border border-white/6 p-1.5 text-center">
                <p className="text-[9px] font-black uppercase tracking-wider whitespace-nowrap text-gray-400">AWS</p>
                <p className="text-xl font-black tabular-nums font-mono whitespace-nowrap text-sky-300">
                    {format(apparentWind)}
                    <span className="ml-0.5 text-[9px] font-bold text-gray-500">kts</span>
                </p>
            </div>
            <button
                type="button"
                className="rounded-xl bg-white/4 border border-white/8 p-1.5 text-center min-h-[44px]"
                onClick={onShowDetails}
                aria-label="Maximum recorded true wind in the last hour. Show history details"
            >
                <p className="text-[9px] font-black uppercase tracking-wider whitespace-nowrap text-gray-400">
                    Max · 1h
                </p>
                <p className="text-xl font-black tabular-nums font-mono whitespace-nowrap text-amber-400">
                    {format(history?.max1h?.kts)}
                    <span className="ml-0.5 text-[9px] font-bold text-gray-500">kts</span>
                </p>
            </button>
            <button
                type="button"
                className="rounded-xl bg-white/3 border border-white/6 p-1.5 text-center min-h-[44px]"
                onClick={onShowDetails}
                aria-label="Highest recorded true wind in the last ten minutes. Show history details"
            >
                <p className="text-[9px] font-black uppercase tracking-wider whitespace-nowrap text-gray-400">
                    Gust 10m
                </p>
                <p className="text-xl font-black tabular-nums font-mono whitespace-nowrap text-white">
                    {format(history?.gust10m?.kts)}
                    <span className="ml-0.5 text-[9px] font-bold text-gray-500">kts</span>
                </p>
            </button>
        </div>
    );
}
