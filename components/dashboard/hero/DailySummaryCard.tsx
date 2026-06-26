/**
 * DailySummaryCard — the day-overview landing card for FORECAST days on the
 * Glass page. Replaces the old "lands on midnight" behaviour: when you swipe up
 * to a future day you see this overview first, and the hourly cards (00:00,
 * 01:00, …) are one swipe left from here.
 *
 * Self-contained on purpose — it does NOT reuse the hourly card's tide-graph /
 * map chrome, so it can't destabilise the (fragile) hourly render path.
 */
import React from 'react';
import type { DailySummary } from './heroSlideHelpers';
import type { UnitPreferences } from '../../../types';
import { convertTemp, convertSpeed, convertLength } from '../../../utils/units';

interface DailySummaryCardProps {
    daily: DailySummary;
    units: UnitPreferences;
    isLandlocked?: boolean;
}

/** Pull an HH:MM out of an ISO string / Date string / already-formatted time. */
function formatTime(v?: string): string | null {
    if (!v) return null;
    const m = v.match(/(\d{1,2}):(\d{2})/);
    if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return null;
}

const Metric: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
    <div className="flex flex-col items-center text-center px-2">
        <span className="text-[11px] uppercase tracking-wider text-white/45">{label}</span>
        <span className="text-xl font-bold text-white tabular-nums">{value}</span>
        {sub ? <span className="text-[11px] text-white/55">{sub}</span> : null}
    </div>
);

export const DailySummaryCard: React.FC<DailySummaryCardProps> = ({ daily, units, isLandlocked }) => {
    const tempUnit = units.temp === 'F' ? '°F' : '°C';
    // convertTemp returns a string ('--' when missing, else a rounded number string)
    const high = convertTemp(daily.highTemp, units.temp);
    const low = convertTemp(daily.lowTemp, units.temp);

    const wind = convertSpeed(daily.windSpeed, units.speed);
    const gust = convertSpeed(daily.windGust, units.speed);

    const hasWave = !isLandlocked && daily.waveHeight !== null && daily.waveHeight !== undefined;
    const wave = hasWave ? convertLength(daily.waveHeight as number, units.length) : null;

    const sunrise = formatTime(daily.sunrise);
    const sunset = formatTime(daily.sunset);

    return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-5 px-6 text-white">
            {/* Day-overview tag */}
            <span className="text-[11px] uppercase tracking-[0.2em] text-white/40">Day overview</span>

            {/* Condition + high / low */}
            <div className="flex flex-col items-center gap-1">
                {daily.condition ? (
                    <span className="text-lg font-semibold text-white/90 text-center">{daily.condition}</span>
                ) : null}
                <div className="flex items-baseline gap-3">
                    <span className="text-5xl font-black tabular-nums">
                        {high !== '--' ? `${high}${tempUnit}` : '--'}
                    </span>
                    <span className="text-2xl font-semibold text-white/45 tabular-nums">
                        {low !== '--' ? `${low}${tempUnit}` : '--'}
                    </span>
                </div>
                <span className="text-[11px] uppercase tracking-wider text-white/40">High · Low</span>
            </div>

            {/* Marine + wind row */}
            <div className="flex items-start justify-center gap-6 flex-wrap">
                <Metric
                    label="Wind"
                    value={wind !== null ? `${wind} ${units.speed}` : '--'}
                    sub={gust !== null ? `gust ${gust}` : undefined}
                />
                {!isLandlocked ? (
                    <Metric
                        label="Wave"
                        value={wave !== null ? `${wave} ${units.length}` : '--'}
                        sub={daily.swellPeriod ? `${Math.round(daily.swellPeriod)}s swell` : undefined}
                    />
                ) : null}
                <Metric
                    label="Rain"
                    value={
                        daily.precipChance !== undefined && daily.precipChance !== null
                            ? `${Math.round(daily.precipChance)}%`
                            : '--'
                    }
                />
            </div>

            {/* Tide + sun row */}
            <div className="flex flex-col items-center gap-2 w-full max-w-xs">
                {daily.tideSummary ? (
                    <div className="flex items-center gap-2 text-sm text-white/75 text-center">
                        <span aria-hidden="true">🌊</span>
                        <span>{daily.tideSummary}</span>
                    </div>
                ) : null}
                {(sunrise || sunset) && (
                    <div className="flex items-center justify-center gap-5 text-sm text-white/70">
                        {sunrise ? (
                            <span>
                                <span aria-hidden="true">☀️</span> {sunrise}
                            </span>
                        ) : null}
                        {sunset ? (
                            <span>
                                <span aria-hidden="true">🌙</span> {sunset}
                            </span>
                        ) : null}
                    </div>
                )}
            </div>

            {/* Swipe affordance toward the hourly cards */}
            <span className="text-[11px] text-white/35 tracking-wide">Swipe ← for hourly</span>
        </div>
    );
};

DailySummaryCard.displayName = 'DailySummaryCard';
