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
    /** Day-of-week + date label (e.g. "Sat 25 Jun") — passed from HeroSlide's
     *  timezone-aware rowDateLabel so it can't drift off-by-one. */
    dateLabel?: string;
}

const Metric: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
    <div className="flex flex-col items-center text-center px-2">
        <span className="text-[11px] uppercase tracking-wider text-white/45">{label}</span>
        <span className="text-xl font-bold text-white tabular-nums">{value}</span>
        {sub ? <span className="text-[11px] text-white/55">{sub}</span> : null}
    </div>
);

export const DailySummaryCard: React.FC<DailySummaryCardProps> = ({ daily, units, isLandlocked, dateLabel }) => {
    const tempUnit = units.temp === 'F' ? '°F' : '°C';
    // convertTemp returns a string ('--' when missing, else a rounded number string)
    const high = convertTemp(daily.highTemp, units.temp);
    const low = convertTemp(daily.lowTemp, units.temp);

    const wind = convertSpeed(daily.windSpeed, units.speed);
    // Gust falls back to a sustained×1.3 estimate when the provider omits the
    // daily gust — matches the hourly cards' convention so the summary never
    // reads blank while the hourly slides show a value.
    const gustRaw = daily.windGust || (daily.windSpeed ? daily.windSpeed * 1.3 : null);
    const gust = convertSpeed(gustRaw, units.speed);

    const hasWave = !isLandlocked && daily.waveHeight !== null && daily.waveHeight !== undefined;
    const wave = hasWave ? convertLength(daily.waveHeight as number, units.length) : null;

    return (
        <div className="w-full h-full min-h-0 overflow-hidden flex flex-col items-center justify-start pt-3 gap-2.5 px-5 text-white">
            {/* Day of week + date — anchored to the top so it's never clipped */}
            {dateLabel ? <span className="text-base font-bold tracking-wide text-white/90">{dateLabel}</span> : null}

            {/* Condition + high / low */}
            <div className="flex flex-col items-center gap-0.5">
                {daily.condition ? (
                    <span className="text-base font-semibold text-white/90 text-center">{daily.condition}</span>
                ) : null}
                <div className="flex items-baseline gap-3">
                    <span className="text-4xl font-black tabular-nums">
                        {high !== '--' ? `${high}${tempUnit}` : '--'}
                    </span>
                    <span className="text-xl font-semibold text-white/45 tabular-nums">
                        {low !== '--' ? `${low}${tempUnit}` : '--'}
                    </span>
                </div>
            </div>

            {/* Marine + wind row */}
            <div className="flex items-start justify-center gap-4 flex-wrap">
                <Metric label="Wind" value={wind !== null ? `${wind} ${units.speed}` : '--'} />
                <Metric label="Gust" value={gust !== null ? `${gust} ${units.speed}` : '--'} />
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

            {/* Tide row */}
            {daily.tideSummary ? (
                <div className="flex items-center gap-2 text-sm text-white/75 text-center max-w-xs">
                    <span aria-hidden="true">🌊</span>
                    <span>{daily.tideSummary}</span>
                </div>
            ) : null}
        </div>
    );
};

DailySummaryCard.displayName = 'DailySummaryCard';
