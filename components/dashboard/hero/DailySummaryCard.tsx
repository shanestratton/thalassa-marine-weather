/**
 * DailySummaryCard — the day-overview landing card for FORECAST days on the
 * Glass page. Replaces the old "lands on midnight" behaviour: when you swipe up
 * to a future day you see this overview first, and the hourly cards (00:00,
 * 01:00, …) are one swipe left from here.
 *
 * Self-contained on purpose — it does NOT reuse the hourly card's tide-graph /
 * map chrome, so it can't destabilise the (fragile) hourly render path.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
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

/**
 * How much of the day card fits its slot. The slot is the Glass carousel's,
 * and its HEIGHT is set by the phone: 109 px on a 375x667 phone, where the
 * full card (188 px) was cut off (Shane's screenshot, 2026-10-02).
 *   full    — everything: condition, big High/Low, readings, tide.
 *   compact — the condition line goes, High/Low shrink onto one line.
 *   tight   — the High/Low and wave-period lines go too. The readings row and the
 *             tide times stay: the hero header right above already shows
 *             the day's high and low, and on a marine app the tide line is
 *             the one worth the room (2026-10-02).
 * Anything hidden stays in the spoken text, so VoiceOver loses nothing.
 *
 * The card measures itself rather than trusting fixed thresholds: what a
 * density needs depends on the width (the readings' wraps) and the data (a
 * wave period, a tide line). It draws the largest density whose measured height
 * fits; a density not yet measured at this width is assumed to need its
 * estimate below (measured in the app, Chromium, 2026-10-02: full 188-198,
 * compact 122 px with a wave period and a tide line; tight is the floor).
 */
export type DayCardDensity = 'full' | 'compact' | 'tight';
export const DAY_CARD_DENSITY_ESTIMATE_PX: Readonly<Record<DayCardDensity, number>> = Object.freeze({
    full: 200,
    compact: 126,
    tight: 0,
});
const DENSITIES: readonly DayCardDensity[] = ['full', 'compact', 'tight'];

export function chooseDayCardDensity(
    slotHeight: number | null | undefined,
    needed: Partial<Record<DayCardDensity, number>> = {},
): DayCardDensity {
    // Unmeasured (first paint, jsdom, a hidden slide): never shrink on a zero.
    if (!slotHeight || slotHeight <= 0) return 'full';
    for (const density of DENSITIES) {
        if ((needed[density] ?? DAY_CARD_DENSITY_ESTIMATE_PX[density]) <= slotHeight) return density;
    }
    return 'tight';
}

/**
 * The density that fits the card's slot, live. The root is h-full, so its
 * height is the slot's whatever is drawn in it; the content wrapper has its
 * natural height, which is what the drawn density needs. Measurements are
 * kept per width, and a density only ever steps up to one that has not been
 * measured too tall, so it cannot oscillate.
 */
function useDayCardDensity(): [React.RefObject<HTMLDivElement>, React.RefObject<HTMLDivElement>, DayCardDensity] {
    const rootRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [density, setDensity] = useState<DayCardDensity>('full');
    const densityRef = useRef<DayCardDensity>('full');
    const neededRef = useRef<{ width: number; heights: Partial<Record<DayCardDensity, number>> }>({
        width: -1,
        heights: {},
    });
    useLayoutEffect(() => {
        const root = rootRef.current;
        const content = contentRef.current;
        if (!root || !content) return;
        const measure = () => {
            const slot = root.clientHeight;
            const width = root.clientWidth;
            if (!slot || !width) return;
            if (neededRef.current.width !== width) neededRef.current = { width, heights: {} };
            // Keyed by what is DRAWN (the wrapper's data-density), not by what
            // was last asked for: a resize can land before React re-renders.
            const drawn = (content.dataset.density as DayCardDensity | undefined) ?? 'full';
            const natural = content.offsetHeight;
            if (natural > 0) neededRef.current.heights[drawn] = natural;
            const next = chooseDayCardDensity(slot, neededRef.current.heights);
            if (next !== densityRef.current) {
                densityRef.current = next;
                setDensity(next);
            }
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(root);
        observer.observe(content);
        return () => observer.disconnect();
    }, []);
    return [rootRef, contentRef, density];
}

/** One reading in the day row. The unit sits on its own small line under the
 *  number so five readings fit one row on a 320 pt phone; '12.5 kts' inline
 *  wrapped the row onto a second line that the card's fixed slot clipped
 *  (Shane's screenshot, 2026-10-02: WAVE and RAIN cut in half). */
const Metric: React.FC<{
    label: string;
    value: string | null;
    unit?: string;
    sub?: string;
    /** Words for `sub` where its few characters say too little aloud. */
    subSpoken?: string;
    density?: DayCardDensity;
}> = ({ label, value, unit, sub, subSpoken, density = 'full' }) => (
    <div className="flex min-w-0 flex-col items-center text-center" data-testid="day-metric">
        <span
            className={`glass-forecast-caption text-xs font-semibold uppercase tracking-wider text-white/45 ${density === 'full' ? '' : 'leading-tight'}`}
        >
            {label}
        </span>
        <span
            className={`whitespace-nowrap font-bold text-white tabular-nums ${density === 'full' ? 'text-xl leading-tight' : 'text-lg leading-tight'}`}
        >
            {value ?? <Missing />}
        </span>
        {value !== null && unit ? (
            <span
                className={`glass-forecast-caption whitespace-nowrap text-xs text-white/55 ${density === 'full' ? '' : 'leading-tight'}`}
            >
                {unit}
            </span>
        ) : null}
        {sub ? (
            <span
                className={
                    density === 'tight'
                        ? 'sr-only'
                        : `glass-forecast-caption whitespace-nowrap text-xs text-white/55 ${density === 'full' ? '' : 'leading-tight'}`
                }
                aria-hidden={subSpoken ? true : undefined}
            >
                {sub}
            </span>
        ) : null}
        {/* Beside the caption, not in it: the caption's measured width stays its own. */}
        {sub && subSpoken ? <span className="sr-only">{subSpoken}</span> : null}
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
const DirCell: React.FC<{ deg: number; density?: DayCardDensity }> = ({ deg, density = 'full' }) => (
    <div className="flex min-w-0 flex-col items-center text-center" data-testid="day-metric">
        <span
            className={`glass-forecast-caption text-xs font-semibold uppercase tracking-wider text-white/45 ${density === 'full' ? '' : 'leading-tight'}`}
        >
            Dir
        </span>
        <WindArrow deg={deg} />
        <span className={`text-xs font-semibold text-white/80 ${density === 'full' ? '' : 'leading-tight'}`}>
            {degreesToCardinal(deg)}
        </span>
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
    // The Seas setting, as the top row, SWELL 2 and the deep-dive read it;
    // this converted and labelled with Lengths (W1-07).
    const waveUnit = units.waveHeight || 'm';
    const wave = hasWave ? convertLength(daily.waveHeight as number, waveUnit) : null;
    const rain =
        daily.precipChance !== undefined && daily.precipChance !== null ? `${Math.round(daily.precipChance)}` : null;

    const showWindRow = !note;
    const showDir = !note && daily.windDegree !== undefined && daily.windDegree !== null;
    const showWave = !isLandlocked && (!note || hasWave);
    const metricCount = Math.max(1, (showWindRow ? 3 : 0) + (showDir ? 1 : 0) + (showWave ? 1 : 0));

    const [rootRef, contentRef, density] = useDayCardDensity();
    const full = density === 'full';

    return (
        <div
            ref={rootRef}
            role="group"
            aria-label={dateLabel ? `Forecast for ${dateLabel}` : 'Day forecast'}
            data-density={density}
            className="w-full h-full min-h-0 overflow-hidden text-white"
        >
            <div
                ref={contentRef}
                data-testid="day-card-content"
                data-density={density}
                className={`flex flex-col items-center justify-start px-5 ${full ? 'pt-3 gap-2.5' : 'pt-1.5 gap-1'}`}
            >
                {/* Day of week + date — anchored to the top so it's never clipped.
                Not on a short slot: the day label row above already names it. */}
                {dateLabel && showDateHeading ? (
                    <span className={full ? 'text-base font-bold tracking-wide text-white/90' : 'sr-only'}>
                        {dateLabel}
                    </span>
                ) : null}

                {note ? (
                    <p className={`glass-forecast-caption font-medium text-center ${full ? 'text-sm' : 'text-xs'}`}>
                        {note}
                    </p>
                ) : (
                    /* Condition + high / low, each temperature captioned so the
                   pair is not two unlabelled numbers (UX scorecard run 6). On a
                   short slot the condition is spoken only and the pair shrinks
                   onto one small line; on the tightest both are spoken only
                   (the hero header shows the day's high and low). */
                    <div
                        className={
                            density === 'tight' ? 'sr-only' : `flex flex-col items-center ${full ? 'gap-0.5' : ''}`
                        }
                    >
                        {daily.condition ? (
                            <span className={full ? 'text-base font-semibold text-white/90 text-center' : 'sr-only'}>
                                {daily.condition}
                            </span>
                        ) : null}
                        <div className={`flex items-baseline ${full ? 'gap-4' : 'gap-3'}`} data-testid="day-high-low">
                            <span className="flex items-baseline gap-1.5">
                                <span className="glass-forecast-caption text-xs font-semibold uppercase tracking-wider text-white/45">
                                    High
                                </span>
                                <span
                                    className={`font-black tabular-nums ${full ? 'text-4xl' : 'text-2xl leading-tight'}`}
                                >
                                    {high !== '--' ? `${high}${tempUnit}` : <Missing />}
                                </span>
                            </span>
                            <span className="flex items-baseline gap-1.5">
                                <span className="glass-forecast-caption text-xs font-semibold uppercase tracking-wider text-white/45">
                                    Low
                                </span>
                                <span
                                    className={`glass-forecast-caption font-semibold text-white/45 tabular-nums ${full ? 'text-xl' : 'text-base leading-tight'}`}
                                >
                                    {low !== '--' ? `${low}${tempUnit}` : <Missing />}
                                </span>
                            </span>
                        </div>
                    </div>
                )}

                {/* Marine + wind row. Past the model's range only the wave (a
                separate marine model) can still have a number. One row of
                equal columns that never wraps: the card has a fixed slot, and a
                wrapped second row was clipped (2026-10-02). */}
                <div
                    className="grid w-full max-w-sm items-start gap-x-1"
                    style={{ gridTemplateColumns: `repeat(${metricCount}, minmax(0, 1fr))` }}
                    data-testid="day-metrics-row"
                >
                    {showWindRow ? (
                        <Metric
                            label="Wind"
                            value={wind !== null ? String(wind) : null}
                            unit={units.speed}
                            density={density}
                        />
                    ) : null}
                    {showDir ? <DirCell deg={daily.windDegree as number} density={density} /> : null}
                    {showWindRow ? (
                        <Metric
                            label="Gust"
                            value={gust !== null ? String(gust) : null}
                            unit={units.speed}
                            density={density}
                        />
                    ) : null}
                    {showWave ? (
                        <Metric
                            label="Wave"
                            value={wave !== null ? String(wave) : null}
                            unit={waveUnit}
                            // The total sea's mean period, not a swell's: it read
                            // '8s swell' (W1-07). Just the seconds on screen: a
                            // fifth of a 320 pt row holds '14s' in wide fonts,
                            // where '14s swell' already ran 4 px over its edge.
                            sub={daily.swellPeriod ? `${Math.round(daily.swellPeriod)}s` : undefined}
                            subSpoken={
                                daily.swellPeriod ? `waves ${Math.round(daily.swellPeriod)} seconds apart` : undefined
                            }
                            density={density}
                        />
                    ) : null}
                    {showWindRow ? <Metric label="Rain" value={rain} unit="%" density={density} /> : null}
                </div>

                {/* Tide row — kept on every slot: the day's tide times */}
                {daily.tideSummary ? (
                    <div
                        className={`flex items-center gap-2 text-white/75 text-center max-w-xs ${full ? 'text-sm' : 'text-xs leading-tight'}`}
                    >
                        <TideCurveIcon className={`${full ? 'w-4 h-4' : 'w-3.5 h-3.5'} shrink-0 text-sky-300`} />
                        <span>{daily.tideSummary}</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
};

DailySummaryCard.displayName = 'DailySummaryCard';
