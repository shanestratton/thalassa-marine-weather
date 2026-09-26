import React from 'react';
import type { WindHistorySummary } from '../../utils/windHistory';

/** '--' is the Instrument Panel's one no-data glyph (never '—' beside it). */
function format(value: number | null | undefined): string {
    return value !== null && value !== undefined && Number.isFinite(value) ? value.toFixed(1) : '--';
}

/** What a screen reader hears for one reading: the number and its unit, or that there is none. */
function spoken(value: string): string {
    return value === '--' ? 'no data' : `${value} knots`;
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
    const aws = format(apparentWind);
    const max1h = format(history?.max1h?.kts);
    const gust10m = format(history?.gust10m?.kts);
    return (
        <div className="w-full grid grid-cols-3 gap-2 items-center">
            <div className="rounded-xl bg-white/3 border border-white/6 p-1.5 text-center">
                {/* One spoken reading instead of "AWS", "12.0", "kts" as three stops. */}
                <span className="sr-only">{`Apparent wind speed, ${spoken(aws)}`}</span>
                <p
                    aria-hidden="true"
                    className="text-[9px] font-black uppercase tracking-wider whitespace-nowrap text-gray-400"
                >
                    AWS
                </p>
                <p
                    aria-hidden="true"
                    className="text-xl font-black tabular-nums font-mono whitespace-nowrap text-sky-300"
                >
                    {aws}
                    <span className="ml-1 text-[9px] font-bold text-gray-400">kts</span>
                </p>
            </div>
            <button
                type="button"
                className="rounded-xl bg-white/4 border border-white/8 p-1.5 text-center min-h-[44px]"
                onClick={onShowDetails}
                aria-label={`Maximum recorded true wind in the last hour, ${spoken(max1h)}. Show history details`}
            >
                <p className="text-[9px] font-black uppercase tracking-wider whitespace-nowrap text-gray-400">
                    Max · 1h
                </p>
                <p className="text-xl font-black tabular-nums font-mono whitespace-nowrap text-amber-400">
                    {max1h}
                    <span className="ml-1 text-[9px] font-bold text-gray-400">kts</span>
                </p>
            </button>
            <button
                type="button"
                className="rounded-xl bg-white/3 border border-white/6 p-1.5 text-center min-h-[44px]"
                onClick={onShowDetails}
                aria-label={`Highest recorded true wind in the last ten minutes, ${spoken(gust10m)}. Show history details`}
            >
                <p className="text-[9px] font-black uppercase tracking-wider whitespace-nowrap text-gray-400">
                    Gust 10m
                </p>
                <p className="text-xl font-black tabular-nums font-mono whitespace-nowrap text-white">
                    {gust10m}
                    <span className="ml-1 text-[9px] font-bold text-gray-400">kts</span>
                </p>
            </button>
        </div>
    );
}
