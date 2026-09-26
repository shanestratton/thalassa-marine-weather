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
import { degreesToCardinal } from '../../../utils/format';
import { TideCurveIcon } from '../../Icons';

interface DailySummaryCardProps {
    daily: DailySummary;
    units: UnitPreferences;
    isLandlocked?: boolean;
    /** Day-of-week + date label (e.g. "Sat 25 Jun") — passed from HeroSlide's
     *  timezone-aware rowDateLabel so it can't drift off-by-one. */
    dateLabel?: string;
    /** Draw the date as the card's own heading. HeroSlide turns this off
     *  when its day label row above the carousel already names the day. */
    showDateHeading?: boolean;
    /** Replaces the empty weather rows with a sentence — used when the day is
     *  past the pinned model's range but waves or tides still have data. */
    note?: string;
}

/**
 * Missing data: '--' on screen, but VoiceOver used to read the dashes out
 * ("Sat 3 Oct -- -- Wind -- Dir") — so the glyphs are hidden and the words
 * are spoken instead (UX scorecard run 6).
 */
const Missing: React.FC = () => (
    <>
        <span aria-hidden="true">--</span>
        <span className="sr-only">no data</span>
    </>
);

const Metric: React.FC<{ label: string; value: string | null; sub?: string }> = ({ label, value, sub }) => (
    <div className="flex flex-col items-center text-center px-2">
        <span className="glass-forecast-caption text-xs font-semibold uppercase tracking-wider text-white/45">
            {label}
        </span>
        <span className="text-xl font-bold text-white tabular-nums">{value ?? <Missing />}</span>
        {sub ? <span className="glass-forecast-caption text-xs text-white/55">{sub}</span> : null}
    </div>
);

/** Compass arrow — points the way the wind BLOWS (downwind). windDegree is the
 *  bearing the wind comes from, so rotate +180 to point where it's heading,
 *  matching the app's map / current-conditions arrows. */
const WindArrow: React.FC<{ deg: number }> = ({ deg }) => (
    <svg
        width={22}
        height={22}
        viewBox="0 0 24 24"
        className="shrink-0"
        aria-hidden="true"
        style={{ transform: `rotate(${deg + 180}deg)` }}
    >
        <path d="M12 3L8 14h8L12 3Z" fill="var(--day-ui-accent, rgba(125,211,252,0.95))" />
        <path d="M12 21L8 14h8L12 21Z" fill="rgba(148,163,184,0.3)" />
    </svg>
);

/** Wind-direction cell: arrow with the cardinal underneath. */
const DirCell: React.FC<{ deg: number }> = ({ deg }) => (
    <div className="flex flex-col items-center text-center px-2">
        <span className="glass-forecast-caption text-xs font-semibold uppercase tracking-wider text-white/45">Dir</span>
        <WindArrow deg={deg} />
        <span className="text-xs font-semibold text-white/80">{degreesToCardinal(deg)}</span>
    </div>
);

export const DailySummaryCard: React.FC<DailySummaryCardProps> = ({
    daily,
    units,
    isLandlocked,
    dateLabel,
    showDateHeading = true,
    note,
}) => {
    const tempUnit = units.temp === 'F' ? '°F' : '°C';
    // convertTemp returns a string ('--' when missing, else a rounded number string)
    const high = convertTemp(daily.highTemp, units.temp);
    const low = convertTemp(daily.lowTemp, units.temp);

    const wind = convertSpeed(daily.windSpeed, units.speed);
    // Real gusts only. This used to estimate sustained×1.3 when the provider
    // omitted the daily gust, "so the summary never reads blank" — but ECMWF
    // AIFS and JMA GSM publish no gust field at all, so that convention
    // presented an invented number as forecast. Blank is the honest answer.
    const gust = daily.windGust != null ? convertSpeed(daily.windGust, units.speed) : null;

    const hasWave = !isLandlocked && daily.waveHeight !== null && daily.waveHeight !== undefined;
    const wave = hasWave ? convertLength(daily.waveHeight as number, units.length) : null;
    const rain =
        daily.precipChance !== undefined && daily.precipChance !== null ? `${Math.round(daily.precipChance)}%` : null;

    return (
        <div
            role="group"
            aria-label={dateLabel ? `Forecast for ${dateLabel}` : 'Day forecast'}
            className="w-full h-full min-h-0 overflow-hidden flex flex-col items-center justify-start pt-3 gap-2.5 px-5 text-white"
        >
            {/* Day of week + date — anchored to the top so it's never clipped */}
            {dateLabel && showDateHeading ? (
                <span className="text-base font-bold tracking-wide text-white/90">{dateLabel}</span>
            ) : null}

            {note ? (
                <p className="glass-forecast-caption text-sm font-medium text-center">{note}</p>
            ) : (
                /* Condition + high / low, each temperature captioned so the
                   pair is not two unlabelled numbers (UX scorecard run 6). */
                <div className="flex flex-col items-center gap-0.5">
                    {daily.condition ? (
                        <span className="text-base font-semibold text-white/90 text-center">{daily.condition}</span>
                    ) : null}
                    <div className="flex items-baseline gap-4">
                        <span className="flex items-baseline gap-1.5">
                            <span className="glass-forecast-caption text-xs font-semibold uppercase tracking-wider text-white/45">
                                High
                            </span>
                            <span className="text-4xl font-black tabular-nums">
                                {high !== '--' ? `${high}${tempUnit}` : <Missing />}
                            </span>
                        </span>
                        <span className="flex items-baseline gap-1.5">
                            <span className="glass-forecast-caption text-xs font-semibold uppercase tracking-wider text-white/45">
                                Low
                            </span>
                            <span className="glass-forecast-caption text-xl font-semibold text-white/45 tabular-nums">
                                {low !== '--' ? `${low}${tempUnit}` : <Missing />}
                            </span>
                        </span>
                    </div>
                </div>
            )}

            {/* Marine + wind row. Past the model's range only the wave (a
                separate marine model) can still have a number. */}
            <div className="flex items-start justify-center gap-4 flex-wrap">
                {!note ? <Metric label="Wind" value={wind !== null ? `${wind} ${units.speed}` : null} /> : null}
                {!note && daily.windDegree !== undefined && daily.windDegree !== null ? (
                    <DirCell deg={daily.windDegree} />
                ) : null}
                {!note ? <Metric label="Gust" value={gust !== null ? `${gust} ${units.speed}` : null} /> : null}
                {!isLandlocked && (!note || hasWave) ? (
                    <Metric
                        label="Wave"
                        value={wave !== null ? `${wave} ${units.length}` : null}
                        sub={daily.swellPeriod ? `${Math.round(daily.swellPeriod)}s swell` : undefined}
                    />
                ) : null}
                {!note ? <Metric label="Rain" value={rain} /> : null}
            </div>

            {/* Tide row */}
            {daily.tideSummary ? (
                <div className="flex items-center gap-2 text-sm text-white/75 text-center max-w-xs">
                    <TideCurveIcon className="w-4 h-4 shrink-0 text-sky-300" />
                    <span>{daily.tideSummary}</span>
                </div>
            ) : null}
        </div>
    );
};

DailySummaryCard.displayName = 'DailySummaryCard';
