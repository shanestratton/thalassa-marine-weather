/**
 * DailySummaryCard — the day-overview landing card for FORECAST days on the
 * Glass page. Replaces the old "lands on midnight" behaviour: when you swipe up
 * to a future day you see this overview first, and the hourly cards (00:00,
 * 01:00, …) are one swipe left from here.
 *
 * Self-contained on purpose — it does NOT reuse the hourly card's tide-graph /
 * map chrome, so it can't destabilise the (fragile) hourly render path.
 */
import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import type { DailySummary, DaySky } from './heroSlideHelpers';
import type { UnitPreferences } from '../../../types';
import { convertTemp, convertSpeed, convertLength } from '../../../utils/units';
import { degreesToCardinal } from '../../../utils/format';
import { TideCurveIcon } from '../../Icons';
import { AGREEMENT_GLYPH, AGREEMENT_WORDS, type AgreementLevel } from '../../../services/weather/dayAgreement';

/** The models' wind verdict for the card's day (W1-09, services/weather/dayAgreement). */
export interface DayAgreementChip {
    /** null: fewer than two models reach the day, so there is nothing to compare. */
    level: AgreementLevel | null;
    /** Models with every hour of the day. */
    members: number;
    /** The most the comparison fields. */
    peak: number;
    /** Judged with fewer than min(5, peak) models: say "only". */
    thin: boolean;
}

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
    /** The models' wind agreement for this day (W1-09). 'pending': not known
     *  yet, so its line is held (no jump when it lands); null: none to show
     *  (offline, no answer), so no chip rather than a stale one. */
    agreement?: DayAgreementChip | 'pending' | null;
    /** Opens the ten-day comparison on this day. */
    onCompare?: () => void;
    /** First light, the sun, last light and the moon (W1-09): drawn when the
     *  slot has room for it (the roomy step), spoken at every other. */
    sky?: DaySky | null;
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
 *   roomy   — full plus the sun & moon row (W1-09). Only offered to a card
 *             that has one, and only drawn where it fits: at 390x844 and
 *             393x852 the row would push the full card down to compact.
 *   snug    — the full card with the agreement chip's glyph in the corner
 *             instead of on a line of its own (W1-09 review): at 375x812 the
 *             line (24 px) cost the card its condition line on every day.
 *             Only offered to a card that holds a chip line.
 * Anything hidden stays in the spoken text, so VoiceOver loses nothing.
 *
 * The card measures itself rather than trusting fixed thresholds: what a
 * density needs depends on the width (the readings' wraps) and the data (a
 * wave period, a tide line). It draws the largest density whose measured height
 * fits; a density not yet measured at this width is assumed to need its
 * estimate below (measured in the app, Chromium, 2026-10-02: full 188-198,
 * compact 122 px with a wave period and a tide line; tight is the floor).
 */
export type DayCardDensity = 'roomy' | 'full' | 'snug' | 'compact' | 'tight';
export const DAY_CARD_DENSITY_ESTIMATE_PX: Readonly<Record<DayCardDensity, number>> = Object.freeze({
    roomy: 240,
    full: 200,
    snug: 180,
    compact: 126,
    tight: 0,
});
const DENSITIES: readonly DayCardDensity[] = ['roomy', 'full', 'snug', 'compact', 'tight'];
/** The chip's line at its least (the chip's own height): what snug saves. */
const CHIP_LINE_PX = 20;

export function chooseDayCardDensity(
    slotHeight: number | null | undefined,
    needed: Partial<Record<DayCardDensity, number>> = {},
    /** The card has a sun & moon row to draw at the roomy step. */
    roomy = false,
    /** The card holds a chip line that snug can move to the corner. */
    snug = false,
): DayCardDensity {
    // Unmeasured (first paint, jsdom, a hidden slide): never shrink on a zero.
    if (!slotHeight || slotHeight <= 0) return 'full';
    for (const density of DENSITIES) {
        if ((density === 'roomy' && !roomy) || (density === 'snug' && !snug)) continue;
        // Unmeasured, snug is the measured full card less the chip's line.
        const estimate =
            density === 'snug' && needed.full != null
                ? needed.full - CHIP_LINE_PX
                : DAY_CARD_DENSITY_ESTIMATE_PX[density];
        if ((needed[density] ?? estimate) <= slotHeight) return density;
    }
    return 'tight';
}

/** A drawn layout's measurement key. Snug is the full layout without the
 *  chip's line, so a card measured snug while its chip loaded knows its full
 *  height once the chip comes to nothing, and is not left a step down. */
const layoutKey = (density: DayCardDensity, lineDrawn: boolean) =>
    density === 'snug' ? 'full:0' : `${density}:${lineDrawn ? 1 : 0}`;

/**
 * The density that fits the card's slot, live. The root is h-full, so its
 * height is the slot's whatever is drawn in it; the content wrapper has its
 * natural height, which is what the drawn density needs. Measurements are
 * kept per width, and a density only ever steps up to one that has not been
 * measured too tall, so it cannot oscillate.
 */
function useDayCardDensity(
    roomy: boolean,
    /** The card holds a line for the agreement chip (or its pending place). */
    line: boolean,
): [React.RefObject<HTMLDivElement>, React.RefObject<HTMLDivElement>, DayCardDensity] {
    const rootRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [density, setDensity] = useState<DayCardDensity>('full');
    const densityRef = useRef<DayCardDensity>('full');
    // Natural heights per drawn layout (layoutKey), at one width.
    const neededRef = useRef<{ width: number; heights: Record<string, number> }>({
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
            // Keyed by what is DRAWN (the wrapper's data-density and whether
            // the chip's line is), not by what was last asked for: a resize
            // can land before React re-renders.
            const drawn = (content.dataset.density as DayCardDensity | undefined) ?? 'full';
            const heights = neededRef.current.heights;
            const natural = content.offsetHeight;
            if (natural > 0) heights[layoutKey(drawn, content.dataset.chipLine === '1')] = natural;
            const needed: Partial<Record<DayCardDensity, number>> = {};
            for (const d of DENSITIES) {
                const h = heights[layoutKey(d, line && d !== 'tight')];
                if (h != null) needed[d] = h;
            }
            const next = chooseDayCardDensity(slot, needed, roomy, line);
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
    }, [roomy, line]);
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

const CHIP_TONE: Record<AgreementLevel | 'none', string> = {
    agree: 'border-emerald-400/35 bg-emerald-500/10 text-emerald-300',
    some: 'border-amber-400/35 bg-amber-500/10 text-amber-300',
    split: 'border-red-400/40 bg-red-500/10 text-red-300',
    none: 'border-white/15 bg-white/5 text-white/75',
};

/** What the chip says: its words on screen, its count, and its spoken name. */
export function agreementChipWords(chip: DayAgreementChip): { words: string; count: string; spoken: string } {
    if (!chip.level) {
        return {
            words: `${chip.members} model only`,
            count: '',
            spoken: `Wind: only ${chip.members} model reaches this day, nothing to compare`,
        };
    }
    const words = AGREEMENT_WORDS[chip.level];
    // Fewer than the comparison fields (runs end after day 7): say how many of
    // how many, as agreement among fewer can only look tighter; "only" when thin.
    const count = chip.members < chip.peak ? `${chip.members} of ${chip.peak} models` : `${chip.members} models`;
    return { words, count, spoken: `Wind: ${words.toLowerCase()}, ${chip.thin ? 'only ' : ''}${count}` };
}

/**
 * The models' wind verdict for the day: a glyph (never colour alone), the
 * words and the member count, a button into the comparison on this day. On
 * a line of its own under the readings it qualifies; at the snug and tight
 * steps, the glyph alone in the card's top-left corner, where it costs no
 * height, the words still its spoken name.
 */
const AgreementChip: React.FC<{
    chip: DayAgreementChip;
    corner: boolean;
    onCompare?: () => void;
    hintId: string;
}> = ({ chip, corner, onCompare, hintId }) => {
    const { words, count, spoken } = agreementChipWords(chip);
    const glyph = chip.level ? (
        <svg
            data-agreement={chip.level}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={corner ? 'w-3 h-3' : 'w-3.5 h-3.5 shrink-0'}
            aria-hidden="true"
        >
            <path d={AGREEMENT_GLYPH[chip.level]} />
        </svg>
    ) : null;
    const tone = CHIP_TONE[chip.level ?? 'none'];
    const className = corner
        ? `absolute left-1 top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border ${tone}`
        : `inline-flex h-5 max-w-full items-center gap-1 rounded-full border px-2 text-xs leading-4 font-semibold whitespace-nowrap ${tone}`;
    const body = corner ? (
        (glyph ?? <span aria-hidden="true" className="h-0.5 w-1.5 rounded-full bg-current" />)
    ) : (
        <>
            {glyph}
            <span aria-hidden="true">{words}</span>
            {count ? (
                <span aria-hidden="true" className="font-normal opacity-80">
                    · {count}
                </span>
            ) : null}
        </>
    );
    return onCompare ? (
        <button
            type="button"
            onClick={(event) => {
                event.stopPropagation();
                onCompare();
            }}
            aria-label={spoken}
            aria-haspopup="dialog"
            aria-describedby={hintId}
            data-placement={corner ? 'corner' : 'line'}
            className={`hit-target-44 ${className}`}
            // The passage stylesheet floors every button at 44 px, unlayered,
            // so no utility can undo it: a 44 px chip line cost 393 pt phones
            // their full card. hit-target-44 keeps the 44 px to the finger.
            style={{ minHeight: 0 }}
        >
            {body}
        </button>
    ) : (
        <span role="img" aria-label={spoken} data-placement={corner ? 'corner' : 'line'} className={className}>
            {body}
        </span>
    );
};

const lowerFirst = (phrase: string) => phrase.charAt(0).toLowerCase() + phrase.slice(1);
const isClock = (v: string | null) => !!v && /^\d{1,2}:\d{2}$/.test(v);

/** The sun & moon row's phrases, in time order: a pair that is one polar
 *  word ('Sun stays up', 'No true night') is said once. */
function skyPhrases(sky: DaySky): { sun: string[]; moon: string[] } {
    const pair = (a: string | null, b: string | null, aLabel: string, bLabel: string, none: string[]) => {
        if (a && a === b && !isClock(a)) return [[a], []];
        return [[a ? `${aLabel} ${a}` : none[0]], [b ? `${bLabel} ${b}` : none[1]]];
    };
    const [firstLight, lastLight] = pair(sky.firstLight, sky.lastLight, 'First light', 'Last light', ['', '']);
    const [sunrise, sunset] = pair(sky.sunrise, sky.sunset, 'Sunrise', 'Sunset', ['', '']);
    const [moonrise, moonset] = pair(sky.moonrise, sky.moonset, 'Moonrise', 'Moonset', ['No moonrise', 'No moonset']);
    // Deep polar night: no light and no sun are the same words, said once.
    const once = (phrases: string[]) => [...new Set(phrases.filter(Boolean))];
    return {
        sun: once([...firstLight, ...sunrise, ...sunset, ...lastLight]),
        moon: once([...moonrise, ...moonset, `${Math.round(sky.illumination * 100)}% lit`]),
    };
}

/** The sun & moon row (W1-09): drawn at the roomy step, spoken at every other. */
const SkyRow: React.FC<{ sky: DaySky; drawn: boolean }> = ({ sky, drawn }) => {
    const { sun, moon } = skyPhrases(sky);
    const spoken = `${sun.map((p, i) => (i ? lowerFirst(p) : p)).join(', ')}. ${moon
        .map((p, i) => (i ? lowerFirst(p) : p))
        .join(', ')
        .replace(/(\d+% lit)$/, 'moon $1')}.`;
    if (!drawn)
        return (
            <p data-testid="day-sky" className="sr-only">
                {spoken}
            </p>
        );
    const line = (phrases: string[]) => (
        <span aria-hidden="true" className="flex flex-wrap justify-center gap-x-2.5">
            {phrases.map((p) => {
                const m = /^(.*?)\s(\d{1,2}:\d{2})$/.exec(p);
                return (
                    <span key={p} className="whitespace-nowrap">
                        {m ? (
                            <>
                                <span className="text-white/55">{m[1]}</span>{' '}
                                <span className="font-semibold text-white/90 tabular-nums">{m[2]}</span>
                            </>
                        ) : (
                            p
                        )}
                    </span>
                );
            })}
        </span>
    );
    return (
        <p
            data-testid="day-sky"
            className="glass-forecast-caption flex w-full flex-col items-center gap-0.5 text-center text-xs leading-4 text-white/75"
        >
            {line(sun)}
            {line(moon)}
            <span className="sr-only">{spoken}</span>
        </p>
    );
};

export const DailySummaryCard: React.FC<DailySummaryCardProps> = ({
    daily,
    units,
    isLandlocked,
    dateLabel,
    showDateHeading = true,
    note,
    agreement,
    onCompare,
    sky,
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

    const hintId = useId();
    const chip = agreement && agreement !== 'pending' && agreement.members > 0 ? agreement : null;
    const [rootRef, contentRef, drawnDensity] = useDayCardDensity(!!sky, !!chip || agreement === 'pending');
    // The roomy step is the full card plus the sun & moon row; snug, the full
    // card with the chip in the corner.
    const density: Exclude<DayCardDensity, 'roomy' | 'snug'> =
        drawnDensity === 'roomy' || drawnDensity === 'snug' ? 'full' : drawnDensity;
    const full = density === 'full';
    const cornerChip = drawnDensity === 'tight' || drawnDensity === 'snug';
    const chipLine = !cornerChip && (!!chip || agreement === 'pending');

    return (
        <div
            ref={rootRef}
            role="group"
            aria-label={dateLabel ? `Forecast for ${dateLabel}` : 'Day forecast'}
            data-density={drawnDensity}
            className="relative w-full h-full min-h-0 overflow-hidden text-white"
        >
            <div
                ref={contentRef}
                data-testid="day-card-content"
                data-density={drawnDensity}
                data-chip-line={chipLine ? '1' : '0'}
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

                {/* The models' wind verdict, on its own line under the readings it
                    qualifies (W1-09); its line is held while it loads. At the
                    snug and tight steps it sits in the corner instead (below). */}
                {chip && !cornerChip ? (
                    <div className={`flex w-full justify-center ${full ? '-mt-1' : ''}`}>
                        <AgreementChip chip={chip} corner={false} onCompare={onCompare} hintId={hintId} />
                    </div>
                ) : agreement === 'pending' && !cornerChip ? (
                    <span
                        data-testid="day-agreement-pending"
                        aria-hidden="true"
                        className={`invisible block h-5 w-px ${full ? '-mt-1' : ''}`}
                    />
                ) : null}

                {sky ? <SkyRow sky={sky} drawn={drawnDensity === 'roomy'} /> : null}

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
            {chip && cornerChip ? <AgreementChip chip={chip} corner onCompare={onCompare} hintId={hintId} /> : null}
            {chip && onCompare ? (
                <span id={hintId} hidden>
                    Opens the model comparison on this day
                </span>
            ) : null}
        </div>
    );
};

DailySummaryCard.displayName = 'DailySummaryCard';
