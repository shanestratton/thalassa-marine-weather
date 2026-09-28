import React, { useMemo, useState, useCallback, useEffect, useId, useRef } from 'react';
import SunCalc from 'suncalc';
import { triggerHaptic } from '../../utils/system';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useWeatherStore } from '../../stores/weatherStore';
import { OverlayPortal } from '../ui/OverlayPortal';
import { Button } from '../ui/Button';
import { XIcon } from '../Icons';
import { ChevronRightIcon } from '../icons/GlassGlyphs';
import { analyzeRain, getIntensityLabel, RAIN_THRESHOLD, type RainAnalysis } from './rainAnalysis';

interface MinutelyRain {
    time: string;
    intensity: number; // mm/hr
}

interface RainForecastCardProps {
    data: MinutelyRain[];
    className?: string;
    timeZone?: string;
    rainSummary?: string; // Apple's native summary (e.g. "Rain starting in 15 min")
    /** Which API delivered `data` — shown as a tiny provenance tag. */
    source?: 'rainbow' | 'weatherkit' | 'synthetic' | 'unknown';
    /**
     * Whether the minutely fetch has resolved, and how.
     *
     * Without this the card cannot tell "the forecast says it will stay dry"
     * from "we have no forecast", and an empty array rendered as the
     * confident headline NO RAIN EXPECTED. Offline that was permanent:
     * Dashboard's offline path sets minutelyRain to [] and status 'error',
     * so a skipper out of coverage got a dry verdict that never changed.
     */
    status?: 'loading' | 'loaded' | 'error';
    /**
     * False while the Glass shows another day or hour. The strip is always a
     * nowcast from this minute, and on a page ten days out 'No rain expected
     * next 3½ hours' read as that day's forecast (UX scorecard run 7), so
     * there it says 'Right now:' first. Defaults to true.
     */
    isLive?: boolean;
    /** The Glass report's position, for the detail's day or night scene.
     *  Falls back to the report in the weather store. */
    coordinates?: { lat: number; lon: number };
}

/** Most bars the detail chart draws. A 240-frame Rainbow feed is bucketed so
 *  every bar fits the dialog and lines up with the time axis. */
const MAX_CHART_BARS = 60;
/** The chart's lowest full-scale value, mm/hr: bars are drawn against the
 *  larger of this and the peak, so a 0.4 mm/hr drizzle is a low bar rather
 *  than a full-height wall. 2.5 is where 'Moderate' starts. */
const CHART_AXIS_FLOOR = 2.5;
/** The strip's mini chart draws any real rain at least this tall (per cent
 *  of its 22 px), so a light hour is a bar and not a dotted rule. */
const MINI_BAR_MIN_PCT = 30;
/** The detail's rain-on-glass layer: at 40 % at the very top edge, easing
 *  to 12 % by 14 px, above the title row, and held at 12 % everywhere under
 *  the dialog's title, X, text, chart, stats, credit and Close. Whole in the
 *  side gutters, beads sat on the axis ticks, the stats and the Close button,
 *  and on a moving boat shapes behind the numbers make them harder to read
 *  (UX scorecard run 10). A 40 % band 24-72 px deep still put a bead inside
 *  the X's box and beside the title (review, batch 12). */
const DROP_LAYER_MASK = 'linear-gradient(180deg, rgba(0,0,0,0.4) 0, rgba(0,0,0,0.12) 14px, rgba(0,0,0,0.12) 100%)';
/** Intensity bands the detail draws as faint reference lines under a
 *  drizzle-only window, so the empty box above 10 pt bars reads as the scale
 *  it is ('well short of Light') rather than dead space (UX scorecard run 10). */
const LIGHT_RAIN_FROM = 0.5;
/** The chart box: 120 px when there is rain to fill it, 96 px when the whole
 *  window is drizzle under the Light line. */
const CHART_BOX_TALL = 'h-[120px]';
const CHART_BOX_DRIZZLE = 'h-24';
const DRIZZLE_BOX_PX = 96;
/** The Peak word's width, 12 px bold tracked capitals. */
const PEAK_MARKER_PX = 40;
/** The width the axis assumes when it decides two ticks would touch: a
 *  375 pt phone's chart, the narrowest the dialog is drawn at. */
const AXIS_ASSUMED_PX = 300;
/** Rough width of a 12 px bold tick label, per character. */
const AXIS_CHAR_PX = 7;

/** A trace frame under the rain threshold: drawn faint, so a chart that
 *  starts at 'Now' in the rain colour no longer says it is already raining
 *  under 'Rain in 47 min' (UX scorecard run 10). */
const TRACE_BAR_COLOR = 'rgba(148, 163, 184, 0.3)';

/**
 * How far ahead the remaining frames reach, in the words rainAnalysis uses
 * for the dry headline ('58 min', '3½ hours'): the end of the last one-minute
 * frame, floored to the half hour from 100 min. The chart summary and the
 * axis's far tick repeat it, so the dialog names one horizon rather than
 * '3½ hours' over '4 hours ahead' (UX scorecard runs 7, 9).
 */
function liveWindowLabel(frames: MinutelyRain[], now: number): string {
    return liveWindow(frames, now)?.words ?? '';
}

/**
 * The same horizon three ways: `minutes` it vouches for (floored to the half
 * hour from 100 min, as the words are), the `words` ('3½ hours', '58 min')
 * and the time axis's `tick` ('3½ h', '1 h', '58 min').
 */
function liveWindow(frames: MinutelyRain[], now: number): { minutes: number; words: string; tick: string } | null {
    if (frames.length === 0) return null;
    const spanMin = Math.max(
        1,
        Math.round((new Date(frames[frames.length - 1].time).getTime() + 60_000 - now) / 60_000),
    );
    if (spanMin >= 100) {
        const h = Math.floor(spanMin / 60);
        const halves = spanMin - h * 60 >= 30;
        const amount = `${h}${halves ? '\u00bd' : ''}`;
        return {
            minutes: h * 60 + (halves ? 30 : 0),
            words: `${amount} hour${h === 1 && !halves ? '' : 's'}`,
            tick: `${amount} h`,
        };
    }
    return {
        minutes: spanMin,
        words: `${spanMin} min`,
        tick: spanMin % 60 === 0 ? `${spanMin / 60} h` : `${spanMin} min`,
    };
}

/**
 * The analysis's verdicts in sentence case. Its fallbacks are title-cased
 * ('Rain Data Out Of Date') for the tracked capitals the card once set every
 * verdict in; a sentence reads as one (UX scorecard run 9).
 */
function sentenceCase(text: string): string {
    return text.replace(/(\s)([A-Z])(?=[a-z])/g, (_m, space: string, letter: string) => space + letter.toLowerCase());
}

/** 'in 1 h 44 min', 'in 25 min', 'Now': when the peak comes, in the time
 *  axis's own units. */
function peakWhenLabel(minutes: number): string {
    if (minutes <= 1) return 'Now';
    if (minutes < 60) return `in ${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes - h * 60;
    return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
}

/**
 * Is the sun down at this position? The dry scene painted a blazing sun at
 * 18:56, an hour after the 17:53 sunset printed on the same screen (UX
 * scorecard run 7). Sunset is the disc's upper edge on the horizon, −0.833°
 * with refraction, the instant the Glass prints. Without a position the
 * location's clock decides, 06–18 counting as day.
 */
function isSunDown(now: number, coords: { lat: number; lon: number } | undefined, timeZone?: string): boolean {
    if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
        const altitude = SunCalc.getPosition(new Date(now), coords.lat, coords.lon).altitude;
        return altitude < (-0.833 * Math.PI) / 180;
    }
    let hour = new Date(now).getHours();
    try {
        hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
    } catch {
        // Unknown zone: the phone's own clock stands in.
    }
    return hour < 6 || hour >= 18;
}

/**
 * The frames as at most MAX_CHART_BARS bars, each the WETTEST minute of its
 * bucket so a short burst is never averaged away. `bucket` is the frames per
 * bar, for mapping the peak's frame index onto its bar.
 */
function chartBars(frames: MinutelyRain[]): { bars: number[]; bucket: number } {
    const bucket = Math.max(1, Math.ceil(frames.length / MAX_CHART_BARS));
    const bars: number[] = [];
    for (let i = 0; i < frames.length; i += bucket) {
        let peak = 0;
        for (let j = i; j < Math.min(i + bucket, frames.length); j++) peak = Math.max(peak, frames[j].intensity);
        bars.push(peak);
    }
    return { bars, bucket };
}

/**
 * RainForecastCard — Progressive Disclosure Rain Component
 *
 * Compact State: Small card with summary text. "Wakes up" with cyan glow when rain detected.
 * Expanded State: Full modal with Dark Sky-style 60-bar minute-by-minute precipitation chart.
 */
export const RainForecastCard: React.FC<RainForecastCardProps> = ({
    data,
    className = '',
    timeZone,
    rainSummary,
    source = 'unknown',
    status = 'loaded',
    isLive = true,
    coordinates,
}) => {
    const headlineId = useId();
    const sourceTagId = useId();
    // Label text for the provenance tag.
    //
    // The vendor names are gone (Shane 2026-08-28: "get rid of the Rainbow.AI
    // wording in the bottom right of the rain card"). Which API answered is a
    // developer's question, and the card is read at a glance from a cockpit —
    // it does not need to advertise a supplier.
    //
    // "Estimated" STAYS, and is not the same kind of label. It is not naming a
    // vendor, it is warning that these numbers are modelled rather than
    // observed, and a rain forecast that hides that is the one thing this card
    // must never be. Provenance for the curious lives in the modal.
    const sourceLabel = source === 'synthetic' ? 'Estimated' : '';
    // "Nowcast" is not a vendor either: it says what kind of number this is.
    // The grid's RAIN cell right above reads the forecast model's total for
    // the day, so '0 mm' over 'Rain in 88 min' read as the app contradicting
    // itself (UX scorecard run 8). Off the live card 'Right now:' says it.
    const nowcastLabel = !sourceLabel && isLive && (source === 'rainbow' || source === 'weatherkit') ? 'Nowcast' : '';
    const [isModalOpen, setIsModalOpen] = useState(false);

    // 60-second tick — forces re-evaluation of "Rain in X min" countdown
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 60_000);
        return () => clearInterval(id);
    }, []);

    const { analysis, analysedAt } = useMemo(
        () => {
            // One clock for the verdict and the detail, so the detail's
            // horizon phrase matches the headline to the minute.
            const at = Date.now();
            return { analysis: analyzeRain(data, { rainSummary, status, now: at }), analysedAt: at };
        },
        // `source` no longer feeds the analysis: the dry-verdict window is
        // computed from the live span of the remaining frames, not from the
        // provider's nominal horizon. `tick` re-evaluates every 60 s so
        // countdowns stay live and elapsed frames fall out.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [data, rainSummary, status, tick],
    );

    const openModal = useCallback(() => {
        if (analysis.frames.length > 0) {
            void triggerHaptic('light');
            setIsModalOpen(true);
        }
    }, [analysis.frames.length]);

    // If the feed expires while the modal is open (60-s tick empties frames),
    // close it rather than leave a sunny "Clear / 0.0 mm/hr" scene standing
    // on zero data.
    useEffect(() => {
        if (isModalOpen && analysis.frames.length === 0) setIsModalOpen(false);
    }, [isModalOpen, analysis.frames.length]);

    if (!analysis) return null;

    // --- COMPACT CARD (always visible) ---
    const isActive = analysis.hasRain;
    const hasDetail = analysis.frames.length > 0;
    const axisMax = Math.max(analysis.maxIntensity, CHART_AXIS_FLOOR);
    // The mini chart earns the strip's 76 pt only for moderate or heavier
    // rain. Below that its bars sat on the 2.5 mm/hr floor as a faint dotted
    // rule a third of the way across an otherwise empty card, nearly lost by
    // day (UX scorecard run 8), so the strip is the one 44 pt line it already
    // is on short portrait: headline, badge, any tag, and a chevron.
    const showChart = hasDetail && analysis.hasRain && analysis.maxIntensity >= CHART_AXIS_FLOOR;
    const oneLine = !showChart;
    const tag = hasDetail ? sourceLabel || nowcastLabel : '';
    // In the one-line row 'Nowcast' rides beside a short verdict only
    // ('Rain in 88 min' and its badge): beside 'No rain expected next 3½
    // hours' it would break the line on a 375 pt phone. The chart's own row
    // carries it whenever the chart is shown. 'Estimated' always shows.
    const inlineNowcast = hasDetail && !!nowcastLabel && analysis.headline.length <= 18;
    // The far tick names the feed's reach in the time axis's words: '4 h', '3½ h'.
    const horizonTick = showChart ? (liveWindow(analysis.frames, analysedAt)?.tick ?? '') : '';
    // Off the live card the strip says 'Right now:' first, and a dry verdict
    // takes the short form so the line no longer wraps and orphans 'hours'
    // on a 375 pt phone (UX scorecard run 9). A screen reader hears it whole.
    const reachNow = hasDetail ? liveWindow(analysis.frames, analysedAt) : null;
    const headlineText = sentenceCase(analysis.headline);
    const offLiveDry = !isLive && hasDetail && !analysis.hasRain && reachNow !== null;
    const stripShown = offLiveDry
        ? `Right now: dry for the next ${reachNow.tick}`
        : `${!isLive && hasDetail ? 'Right now: ' : ''}${headlineText}`;
    const stripSpoken = offLiveDry ? `Right now: dry for the next ${reachNow.words}` : stripShown;
    const inlineTagClass = `${oneLine ? '' : 'hidden in-data-[glass-rhythm=short]:inline-block'} shrink-0 text-[11px] font-semibold uppercase tracking-wider text-white/50 pointer-events-none select-none`;

    return (
        <>
            <button
                aria-label="Open rain forecast detail"
                // The label names the action; the verdict (and what kind of
                // number it is) is read as its description, so a screen reader
                // hears both.
                aria-describedby={tag ? `${headlineId} ${sourceTagId}` : headlineId}
                aria-disabled={hasDetail ? undefined : true}
                onClick={openModal}
                // By day the card takes the metric grid's white card surface and
                // border: the translucent slate was about 1.1:1 against the
                // daylight page (UX scorecard run 6). Important, because the
                // daylight remap of bg-slate-800/40 is unlayered and would win.
                // One line (oneLine, or short portrait's data-glass-rhythm="short"
                // on the Dashboard root): a single 44 pt centred row, with a
                // chevron standing in for 'Tap for detail' (UX scorecard run 7:
                // at 34 pt it was under the touch floor and had no cue).
                className={`w-full rounded-xl overflow-hidden relative text-left transition-all duration-500 ${
                    oneLine
                        ? 'min-h-[44px] flex items-center justify-center gap-1.5 px-6'
                        : 'min-h-[76px] in-data-[glass-rhythm=short]:min-h-[44px] in-data-[glass-rhythm=short]:flex in-data-[glass-rhythm=short]:items-center in-data-[glass-rhythm=short]:justify-center in-data-[glass-rhythm=short]:gap-1.5 in-data-[glass-rhythm=short]:px-6'
                } [.display-light_&]:bg-white! ${className} ${
                    isActive
                        ? 'bg-sky-900/40 border border-cyan-400/30 shadow-lg shadow-cyan-500/10 [.display-light_&]:border-sky-600/50!'
                        : 'bg-slate-800/40 border border-blue-400/10 [.display-light_&]:border-slate-900/20!'
                }`}
            >
                {/* Rain glow animation when active */}
                {isActive && (
                    <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl">
                        <div className="absolute -top-8 left-1/3 w-24 h-24 bg-sky-500/10 rounded-full blur-3xl" />
                        <div className="absolute -bottom-4 right-1/4 w-16 h-16 bg-sky-500/10 rounded-full blur-2xl" />
                    </div>
                )}

                {/* On one line the button pads both sides equally, so the
                    centred row stays clear of the chevron at the right edge. */}
                <div
                    className={
                        oneLine
                            ? 'relative z-10 min-w-0 px-1 flex flex-row items-center justify-center'
                            : 'relative z-10 px-3 py-1.5 h-full flex flex-col justify-between in-data-[glass-rhythm=short]:flex-row in-data-[glass-rhythm=short]:items-center in-data-[glass-rhythm=short]:justify-center in-data-[glass-rhythm=short]:py-0 in-data-[glass-rhythm=short]:px-1'
                    }
                >
                    {/* Header Row — gap-1.5, so the badge no longer butts
                        against the headline (UX scorecard run 8). */}
                    <div className="flex items-center justify-center gap-1.5">
                        <div className="flex items-center gap-1.5">
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                aria-hidden="true"
                                className={`shrink-0 ${isActive ? 'text-sky-400' : 'text-sky-400/60'}`}
                            >
                                <path
                                    d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"
                                    fill="currentColor"
                                    fillOpacity={isActive ? '0.5' : '0.3'}
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                            </svg>
                            {/* Sentence case: a sentence in tracked capitals shouted
                                (UX scorecard run 9). */}
                            <span
                                id={headlineId}
                                className={`text-sm font-semibold text-center ${isActive ? 'text-sky-300' : 'text-ivory'}`}
                            >
                                {stripShown === stripSpoken ? (
                                    stripShown
                                ) : (
                                    <>
                                        <span aria-hidden="true">{stripShown}</span>
                                        <span className="sr-only">{stripSpoken}</span>
                                    </>
                                )}
                            </span>
                        </div>

                        {isActive && (
                            <div
                                className={`shrink-0 px-1.5 py-0 rounded-full text-[11px] font-bold uppercase tracking-wide leading-tight ${analysis.category.badgeClass}`}
                            >
                                {analysis.category.label}
                            </div>
                        )}
                    </div>

                    {/* Mini Bar Chart (compact preview) — moderate or heavier rain
                        only. Real rain draws at least MINI_BAR_MIN_PCT tall, and
                        by day the bars take one solid sky ink: the pale night
                        blues vanished on the white card. Dropped on short
                        portrait: the one-line strip has no room. */}
                    {showChart && (
                        <div
                            aria-hidden="true"
                            className="flex items-end gap-px w-full mt-1 h-[22px] overflow-hidden in-data-[glass-rhythm=short]:hidden"
                        >
                            {chartBars(analysis.frames).bars.map((intensity, i) => {
                                const normalizedHeight = Math.max(
                                    (intensity / axisMax) * 100,
                                    intensity >= RAIN_THRESHOLD ? MINI_BAR_MIN_PCT : 0,
                                );
                                const barColor = getBarColor(intensity, axisMax, isActive);
                                const trace = intensity > 0 && intensity < RAIN_THRESHOLD;

                                return (
                                    <div key={i} className="flex-1 min-w-0 relative" style={{ height: '100%' }}>
                                        <div
                                            className={`absolute bottom-0 left-0 right-0 rounded-t-[1px] ${trace ? '[.display-light_&]:bg-slate-400/40!' : '[.display-light_&]:bg-sky-600/80!'}`}
                                            style={{
                                                height: `${normalizedHeight}%`,
                                                background: barColor,
                                                boxShadow: intensity > 0 ? `0 0 3px ${barColor}30` : 'none',
                                            }}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Time ends under the chart, and the tap hint between them
                        with what kind of numbers these are. On short portrait
                        the chevron says it. */}
                    {showChart && (
                        <div
                            aria-hidden="true"
                            className="flex items-center justify-between gap-2 mt-0.5 in-data-[glass-rhythm=short]:hidden"
                        >
                            <span className="shrink-0 text-[11px] font-bold text-white/60 tracking-wide">Now</span>
                            <span className="min-w-0 truncate text-xs font-semibold text-white/60">
                                {tag ? `${tag} · ` : ''}Tap for detail
                            </span>
                            <span className="shrink-0 text-[11px] font-bold text-white/60 tracking-wide">
                                {horizonTick}
                            </span>
                        </div>
                    )}
                </div>

                {hasDetail && (
                    <ChevronRightIcon
                        className={`${oneLine ? 'block' : 'hidden in-data-[glass-rhythm=short]:block'} absolute right-1.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/60 pointer-events-none`}
                    />
                )}

                {/* Honesty tag, in the one-line row: 'Estimated' whenever the
                    numbers are modelled rather than measured, 'Nowcast' beside
                    a short verdict. The full strip carries it in the row under
                    its chart instead. */}
                {sourceLabel ? (
                    <span className={inlineTagClass}>{sourceLabel}</span>
                ) : inlineNowcast ? (
                    <span className={inlineTagClass}>{nowcastLabel}</span>
                ) : null}
                {tag && (
                    <span id={sourceTagId} className="sr-only">
                        {tag === 'Estimated' ? 'Estimated from the hourly forecast' : 'Nowcast'}
                    </span>
                )}
            </button>

            {/* Expanded Modal */}
            {isModalOpen && (
                <RainModal
                    data={analysis.frames}
                    analysis={analysis}
                    source={source}
                    now={analysedAt}
                    timeZone={timeZone}
                    coordinates={coordinates}
                    onClose={() => setIsModalOpen(false)}
                />
            )}
        </>
    );
};

// --- EXPANDED MODAL ---

interface ModalProps {
    /** Future-only frames — the same array analysis.peakIdx indexes into. */
    data: MinutelyRain[];
    analysis: RainAnalysis;
    /** Which feed answered. Named here rather than on the card face. */
    source?: 'rainbow' | 'weatherkit' | 'synthetic' | 'unknown';
    /** The instant `analysis` was computed at. */
    now: number;
    timeZone?: string;
    coordinates?: { lat: number; lon: number };
    onClose: () => void;
}

const RainModal: React.FC<ModalProps> = ({
    data,
    analysis,
    source = 'unknown',
    now,
    timeZone,
    coordinates,
    onClose,
}) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useFocusTrap<HTMLDivElement>(true, {
        initialFocusRef: closeButtonRef,
        onEscape: onClose,
    });
    const reportCoords = useWeatherStore((s) => s.weatherData?.coordinates);
    const sunDown = isSunDown(now, coordinates ?? reportCoords, timeZone);

    // How far ahead the frames still reach, in the headline's own words: the
    // chart summary names the same horizon as the verdict.
    const horizon = liveWindowLabel(data, now);
    // The horizon is the headline's and the axis's far tick's to say: the
    // credit said it a third time (UX scorecard run 9).
    const feedProvenance = (() => {
        // '1 km grid': a bare '1 km' read as a distance (UX scorecard run 10).
        if (source === 'rainbow') return 'Rainbow.ai nowcast · 1 km grid';
        if (source === 'weatherkit') return 'Apple WeatherKit · minute-by-minute';
        if (source === 'synthetic') return 'Estimated from the hourly forecast — not a live rain feed';
        return null;
    })();

    // The chart as at most MAX_CHART_BARS bars on a fixed floor, and one
    // spoken summary in place of 60 unnamed bars and loose axis ticks.
    const { bars, bucket } = chartBars(data);
    const axisMax = Math.max(analysis.maxIntensity, CHART_AXIS_FLOOR);
    const peakBar = Math.floor(analysis.peakIdx / bucket);
    const peakPct = (peakBar + 0.5) / Math.max(bars.length, 1);
    // The peak bar's own height, as each bar draws it: the marker stands on
    // its bar rather than at the top of the 120 pt box, where over a 15 pt
    // drizzle bar it floated under the headline and read as 'RAIN IN 87 MIN
    // PEAK' (UX scorecard run 8).
    const barHeightPct = (intensity: number) => Math.max((intensity / axisMax) * 100, intensity > 0 ? 4 : 0);
    const peakBarPct = barHeightPct(bars[peakBar] ?? 0);
    const peakInMin = data[analysis.peakIdx]
        ? Math.max(0, Math.round((new Date(data[analysis.peakIdx].time).getTime() - now) / 60_000))
        : 0;
    const chartSummary = analysis.hasRain
        ? `Rain intensity, next ${horizon}: peak ${analysis.maxIntensity.toFixed(1)} mm/hr ${
              peakInMin <= 1 ? 'now' : `in ${peakInMin} min`
          }`
        : `Rain intensity, next ${horizon}: none`;

    // Prevent body scroll when modal is open
    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, []);

    // Time labels — derived from the ACTUAL data span, not hardcoded.
    //
    // Bug that led here: the axis was pinned at 0/15/30/45/60 minutes,
    // which only matches WeatherKit's 60-sample minutely feed. When
    // Skipper tier hits Rainbow.ai the feed is up to 240 samples over
    // 4 hours, and those pinned labels misread every bar position by
    // up to 4×. A peak visually sitting over "15M" was actually 60 min
    // away, which is exactly what the user noticed.
    //
    // Fix: read the first and last minutelyRain timestamps, compute the
    // offsets from "now" (in minutes), and place ticks at their true
    // position across that range. The ticks sit on round times — whole
    // hours on a long feed ('1 h' … '4 h'), half or quarter hours on a
    // short one — never at even fractions of the span, which printed
    // '1H59 / 2H59 / 3H58' (UX scorecard run 6). The far tick is the
    // horizon the headline states, so a feed reaching 3 h 58 ends at '3½ h'
    // where 3½ h falls, not at a '4 h' it cannot vouch for (run 9).
    //
    // When rain is still to come, its onset gets a tick of its own in the
    // headline's words ('47 min', in the rain colour) over a dashed line
    // through the chart, and the round ticks it would touch step aside: the
    // bars ran from 'Now' in the rain colour with nothing marking the onset,
    // so the chart said it was already raining under 'Rain in 47 min' (UX
    // scorecard run 10).
    const { timeLabels, onsetPct } = React.useMemo(() => {
        if (!data || data.length === 0) {
            return { timeLabels: [{ pct: 0, label: 'Now', onset: false }], onsetPct: null };
        }
        const firstMin = Math.max(0, Math.round((new Date(data[0].time).getTime() - now) / 60_000));
        const lastMin = Math.max(
            firstMin + 1,
            Math.round((new Date(data[data.length - 1].time).getTime() - now) / 60_000),
        );
        const span = lastMin - firstMin;
        const step = span >= 150 ? 60 : span > 75 ? 30 : 15;
        const formatMin = (m: number): string => (m % 60 === 0 ? `${m / 60} h` : `${m} min`);
        // The far tick is the horizon the headline states, at its own place:
        // an axis ending '4 h' under 'next 3½ hours' named a second horizon
        // (UX scorecard run 9). A fresh 4-hour feed still ends at '4 h'.
        const reach = liveWindow(data, now);
        const reachPct = reach ? Math.min(1, Math.max(0, (reach.minutes - firstMin) / span)) : 1;

        // The onset, in the minutes the headline counts ('Rain in 47 min').
        // Only while rain is still to come: once it is raining the chart
        // starts wet and the headline says so.
        const onsetFrame =
            analysis.hasRain && !analysis.isCurrentlyRaining && analysis.firstRainIdx > 0
                ? data[analysis.firstRainIdx]
                : undefined;
        const onsetMin = onsetFrame
            ? Math.max(1, Math.round((new Date(onsetFrame.time).getTime() - now) / 60_000))
            : null;
        const onsetAt = onsetMin !== null ? Math.min(1, Math.max(0, (onsetMin - firstMin) / span)) : null;
        const onsetText = onsetMin !== null ? `${onsetMin} min` : '';
        // Two centred ticks touch when their centres are closer than half of
        // each label plus a gap, on the narrowest chart the dialog draws.
        const clash = (aPct: number, aText: string, bPct: number, bText: string) =>
            Math.abs(aPct - bPct) * AXIS_ASSUMED_PX < ((aText.length + bText.length) * AXIS_CHAR_PX) / 2 + 8;
        const firstText = firstMin <= 2 ? 'Now' : formatMin(firstMin);
        // The onset's tick needs room past the flush-left first tick and
        // before the flush-right far one; the dashed line is drawn regardless.
        const onsetLabelled =
            onsetAt !== null &&
            onsetAt * AXIS_ASSUMED_PX - (onsetText.length * AXIS_CHAR_PX) / 2 > firstText.length * AXIS_CHAR_PX + 8 &&
            (reachPct - onsetAt) * AXIS_ASSUMED_PX - (onsetText.length * AXIS_CHAR_PX) / 2 >
                (reach?.tick.length ?? 0) * AXIS_CHAR_PX + 8;

        const labels = [{ pct: 0, label: firstText, onset: false }];
        for (let m = Math.ceil((firstMin + 1) / step) * step; m < (reach?.minutes ?? lastMin); m += step) {
            const pct = (m - firstMin) / span;
            // Too close to the first label, or to the far tick, to be read
            // beside it: '3 h' crowded a flush-right '3½ h' on a 375 pt phone.
            if (pct < 0.12 || reachPct - pct < 0.2) continue;
            if (onsetLabelled && onsetAt !== null && clash(pct, formatMin(m), onsetAt, onsetText)) continue;
            labels.push({ pct, label: formatMin(m), onset: false });
        }
        if (onsetLabelled && onsetAt !== null) labels.push({ pct: onsetAt, label: onsetText, onset: true });
        if (reach && reachPct >= 0.12) labels.push({ pct: reachPct, label: reach.tick, onset: false });
        return { timeLabels: labels, onsetPct: onsetAt };
    }, [data, now, analysis.hasRain, analysis.isCurrentlyRaining, analysis.firstRainIdx]);
    // A drizzle-only window: every bar under the Light line. The box steps
    // down to 96 px and carries faint Light / Moderate lines, so its empty
    // top reads as the scale rather than dead space (UX scorecard run 10).
    // The labels sit on the side away from the peak marker.
    const drizzleOnly = analysis.hasRain && analysis.maxIntensity < LIGHT_RAIN_FROM;
    const refSide = peakPct > 0.5 ? 'left-0' : 'right-0';
    // Where the Peak word sits across the chart, in per cent, as its
    // transform places it: flush left near the start, flush right near the
    // end, centred between.
    const peakMarkerSpan = (() => {
        const w = (PEAK_MARKER_PX / AXIS_ASSUMED_PX) * 100;
        const at = peakPct * 100;
        const [from, to] = peakPct < 0.1 ? [at, at + w] : peakPct > 0.9 ? [at - w, at] : [at - w / 2, at + w / 2];
        return [Math.max(0, from - 2), Math.min(100, to + 2)];
    })();

    return (
        // Centred and clear of the tab bar like the pin and model dialogs; the
        // body scrolls inside when a short or landscape phone cannot fit it.
        <OverlayPortal
            className="flex items-center justify-center p-4 pb-[calc(4rem+env(safe-area-inset-bottom)+1rem)] pt-[max(1rem,env(safe-area-inset-top))]"
            onClick={onClose}
            role="presentation"
        >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/80" />

            {/* Modal */}
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="rain-forecast-title"
                className="relative w-full max-w-md max-h-full flex flex-col rounded-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none"
                onClick={(e) => e.stopPropagation()}
                // Daylight gets the light day surface: the text inside already
                // inverts to navy by day, and on this navy gradient it went
                // dark-on-dark. Each var() keeps the night colour as fallback.
                style={{
                    background:
                        'var(--day-ui-surface, linear-gradient(180deg, rgb(6, 78, 115) 0%, rgb(15, 23, 42) 40%, rgb(8, 51, 96) 100%))',
                    border: '1px solid var(--day-ui-border, rgba(34, 211, 238, 0.2))',
                    boxShadow:
                        'var(--day-ui-shadow, 0 0 60px -10px rgba(34, 211, 238, 0.15), 0 25px 50px -12px rgba(0,0,0,0.5))',
                }}
            >
                {/* Weather-themed background scene.
                    Three moods: a clear day or a clear night when no rain is
                    expected, "rain on glass" when rain is coming. All pure
                    SVG + gradients — no image assets, no infinite
                    animations (battery), decorative (aria-hidden), and they
                    sit BEHIND a z-10 content layer so they never interfere
                    with readability. */}
                <div aria-hidden="true" className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
                    {!analysis.hasRain && sunDown ? (
                        /* Clear night — after sunset the dry scene is a
                            crescent moon and a few stars, not the sun (UX
                            scorecard run 7). On the daylight display the wash
                            steps back and the stars go, so the light surface
                            stays clean. */
                        <>
                            <div
                                className="absolute inset-0 [.display-light_&]:opacity-30"
                                style={{
                                    background:
                                        'linear-gradient(180deg, rgba(49, 46, 129, 0.32) 0%, rgba(30, 27, 75, 0.16) 45%, rgba(15, 23, 42, 0) 100%)',
                                }}
                            />
                            <svg
                                className="absolute top-0 left-0 w-full h-40 [.display-light_&]:hidden"
                                viewBox="0 0 300 160"
                                preserveAspectRatio="xMidYMin slice"
                            >
                                {[
                                    [28, 70, 1],
                                    [64, 112, 0.8],
                                    [118, 58, 0.9],
                                    [168, 96, 0.7],
                                    [196, 40, 1.1],
                                    [226, 132, 0.8],
                                    [250, 84, 0.9],
                                    [284, 124, 1],
                                    [90, 146, 0.7],
                                    [140, 128, 0.8],
                                ].map(([cx, cy, r]) => (
                                    <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill="rgba(226,232,240,0.75)" />
                                ))}
                            </svg>
                            <svg className="absolute top-16 right-4 w-14 h-14" viewBox="0 0 100 100">
                                <defs>
                                    <radialGradient id="rain-moon-disc" cx="40%" cy="40%" r="60%">
                                        <stop offset="0%" stopColor="rgba(254,249,195,0.95)" />
                                        <stop offset="100%" stopColor="rgba(253,224,71,0.7)" />
                                    </radialGradient>
                                    <mask id="rain-moon-cut">
                                        <rect width="100" height="100" fill="white" />
                                        <circle cx="64" cy="40" r="26" fill="black" />
                                    </mask>
                                </defs>
                                <circle
                                    cx="50"
                                    cy="50"
                                    r="30"
                                    fill="url(#rain-moon-disc)"
                                    stroke="rgba(202,138,4,0.45)"
                                    strokeWidth="1.5"
                                    mask="url(#rain-moon-cut)"
                                />
                            </svg>
                        </>
                    ) : !analysis.hasRain ? (
                        /* Clear day — warm sky gradient + prominent sun with
                            layered rays. Mood: optimistic, clear-weather
                            reassurance. The cloud puffs and second flare that
                            sat under the credit line like smudges are gone
                            (UX scorecard run 7). */
                        <>
                            {/* Sky wash — sky blue at top fading to warm amber at
                                bottom, so the whole panel has a "good day"
                                tint underneath the modal's base gradient. */}
                            <div
                                className="absolute inset-0"
                                style={{
                                    background:
                                        'linear-gradient(180deg, rgba(125, 211, 252, 0.22) 0%, rgba(186, 230, 253, 0.12) 35%, rgba(253, 230, 138, 0.08) 75%, rgba(254, 215, 170, 0.05) 100%)',
                                }}
                            />
                            {/* Lens-flare glow — soft radial bloom behind the sun,
                                gives the illusion of light bleeding through. */}
                            <div
                                className="absolute top-10 right-0 w-32 h-32 rounded-full blur-2xl opacity-60"
                                style={{
                                    background:
                                        'radial-gradient(circle, rgba(253,224,71,0.7) 0%, rgba(251,191,36,0.3) 40%, rgba(251,191,36,0) 75%)',
                                }}
                            />
                            {/* Sun disc + rays — the hero element, bold enough to
                                read as a real sun but tucked into the corner so
                                the modal's data stays primary. Starts BELOW the
                                header row: at top-6 it sat behind the close
                                button and crowded it. */}
                            <svg className="absolute top-16 right-3 w-16 h-16" viewBox="0 0 100 100">
                                <defs>
                                    <radialGradient id="sun-disc" cx="45%" cy="40%" r="55%">
                                        <stop offset="0%" stopColor="rgba(254,249,195,0.95)" />
                                        <stop offset="50%" stopColor="rgba(253,224,71,0.85)" />
                                        <stop offset="100%" stopColor="rgba(251,191,36,0.65)" />
                                    </radialGradient>
                                </defs>
                                {/* Long rays */}
                                {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
                                    <line
                                        key={`long-${angle}`}
                                        x1="50"
                                        y1="50"
                                        x2={50 + 42 * Math.cos((angle * Math.PI) / 180)}
                                        y2={50 + 42 * Math.sin((angle * Math.PI) / 180)}
                                        stroke="rgba(253,224,71,0.55)"
                                        strokeWidth="3"
                                        strokeLinecap="round"
                                    />
                                ))}
                                {/* Short rays offset 22.5° — fills the gaps, adds
                                    a gentle starburst feel */}
                                {[22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5].map((angle) => (
                                    <line
                                        key={`short-${angle}`}
                                        x1="50"
                                        y1="50"
                                        x2={50 + 32 * Math.cos((angle * Math.PI) / 180)}
                                        y2={50 + 32 * Math.sin((angle * Math.PI) / 180)}
                                        stroke="rgba(253,224,71,0.35)"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                    />
                                ))}
                                {/* Disc itself */}
                                <circle cx="50" cy="50" r="18" fill="url(#sun-disc)" />
                                {/* Inner highlight for 3D feel */}
                                <circle cx="44" cy="44" r="6" fill="rgba(254,249,195,0.7)" />
                            </svg>
                        </>
                    ) : (
                        <>
                            {/* Rain on glass — realistic droplets with
                                highlights, shadows, and trails. Scales with
                                intensity: light rain gets ~14 drops, heavy
                                rain gets ~26 with more streaks running down.
                                Seeded pseudo-random positions so the layout
                                stays stable between renders but feels natural,
                                not gridded. */}
                            {/* Cool gray-blue wash — mimics the view out a
                                rainy window, fades top-to-bottom. */}
                            <div
                                className="absolute inset-0"
                                style={{
                                    background:
                                        'linear-gradient(180deg, rgba(71, 85, 105, 0.25) 0%, rgba(51, 65, 85, 0.15) 60%, rgba(30, 41, 59, 0.2) 100%)',
                                }}
                            />
                            {/* Subtle soft-focus cloud band at the top */}
                            <svg
                                className="absolute top-0 left-0 w-full opacity-50"
                                viewBox="0 0 300 80"
                                preserveAspectRatio="xMidYMin slice"
                                aria-hidden="true"
                            >
                                <path
                                    d="M-10 80 Q40 30 90 50 Q130 20 170 45 Q210 15 250 40 Q280 25 310 55 L310 80Z"
                                    fill="rgba(148,163,184,0.18)"
                                />
                                <path
                                    d="M-10 80 Q30 20 80 40 Q120 10 160 35 Q200 5 240 30 Q270 15 310 50 L310 80Z"
                                    fill="rgba(100,116,139,0.15)"
                                />
                            </svg>
                            {/* Rain drops on glass — v3 (matched to user's
                                windshield reference photo).
                                Previous v2 pass was perfectly round with
                                specular highlight dots — read as "beads of
                                water on a tabletop", not "rain on a
                                windshield". Real windshield drops are:
                                  - IRREGULAR teardrop / kidney shapes,
                                    slightly rotated, lots of vertical stretch
                                    from gravity pulling the drop down
                                  - DARK crescent at the top + LIGHT interior
                                    at the bottom — because the drop is an
                                    upside-down lens: dark foreground (trees,
                                    ground) flips to the top of the bead, and
                                    bright sky flips to the bottom
                                  - Sharp near-black outline all around
                                  - Densely packed (60+ beads), mixed sizes
                                    1.5–9 units, small drops dominating
                                  - No prominent specular dot — the dark-top/
                                    bright-bottom gradient IS the water tell
                            */}
                            {/* By day the dark beads sit on the light day surface,
                                under navy text: drawn fainter so they stay a
                                mood, not a pattern the numbers must fight.
                                By night too, the beads and trails ran through
                                the text: one sat behind 'mm/hr' in the stats,
                                a trail cut the Z of DRIZZLE, and others sat
                                behind the '3 h' tick and Close (UX scorecard
                                run 8), and whole in the side gutters they still
                                crossed the axis, the stats and Close (run 10).
                                The mask keeps them at 40 % only in the top
                                edge's first few pixels, above the title and
                                X, and at 12 % under everything else. They
                                never move. */}
                            <svg
                                className="absolute inset-0 w-full h-full [.display-light_&]:opacity-25"
                                viewBox="0 0 200 400"
                                preserveAspectRatio="xMidYMid slice"
                                aria-hidden="true"
                                style={{ maskImage: DROP_LAYER_MASK, WebkitMaskImage: DROP_LAYER_MASK }}
                            >
                                <defs>
                                    {/* Lens gradient — dark crescent up top
                                        (inverted foreground), lighter below
                                        (inverted sky). Hard stop around 22 %
                                        gives the drop its signature "dark
                                        moon" crescent rather than a gentle
                                        fade. */}
                                    <linearGradient id="drop-lens-v3" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="rgba(8,12,22,0.95)" />
                                        <stop offset="22%" stopColor="rgba(20,28,42,0.88)" />
                                        <stop offset="40%" stopColor="rgba(71,85,105,0.55)" />
                                        <stop offset="70%" stopColor="rgba(148,163,184,0.35)" />
                                        <stop offset="100%" stopColor="rgba(226,232,240,0.55)" />
                                    </linearGradient>
                                </defs>
                                {(() => {
                                    // Dense packing — reference image has
                                    // 200+ drops visible, we'll dial to 55/90
                                    // depending on rain intensity. Past 100
                                    // we'd be rendering thousands of SVG
                                    // nodes and burning battery on low-end
                                    // phones, so this is the sweet spot.
                                    const isHeavy = analysis.maxIntensity >= 2.5;
                                    const dropCount = isHeavy ? 90 : 55;
                                    const drops: Array<{
                                        x: number;
                                        y: number;
                                        rx: number;
                                        ry: number;
                                        rot: number;
                                        hasTrail: boolean;
                                        trailLen: number;
                                    }> = [];
                                    let seed = isHeavy ? 17 : 91;
                                    const rand = () => {
                                        seed = (seed * 9301 + 49297) % 233280;
                                        return seed / 233280;
                                    };
                                    for (let i = 0; i < dropCount; i++) {
                                        // Weighted size distribution — most
                                        // drops small (1.5–3.5), some mid
                                        // (3–5.5), a few large (5–8.5). Feels
                                        // like real rain, not a grid of
                                        // identical pearls.
                                        const sizeRoll = rand();
                                        const base =
                                            sizeRoll < 0.55
                                                ? 1.5 + rand() * 2
                                                : sizeRoll < 0.88
                                                  ? 3 + rand() * 2.5
                                                  : 5 + rand() * 3.5;
                                        // Teardrop stretch — gravity pulls
                                        // drops vertically, so ry usually >
                                        // rx. Some variance to avoid uniform
                                        // stretch.
                                        const stretch = 0.85 + rand() * 0.8;
                                        drops.push({
                                            x: 4 + rand() * 192,
                                            y: 6 + rand() * 388,
                                            rx: base,
                                            ry: base * stretch,
                                            rot: (rand() - 0.5) * 40, // -20°…+20°
                                            hasTrail: base > 4.5 && rand() > 0.55,
                                            trailLen: 15 + rand() * 55,
                                        });
                                    }
                                    return drops.map((d, i) => (
                                        <g
                                            key={i}
                                            transform={`translate(${d.x.toFixed(1)} ${d.y.toFixed(1)}) rotate(${d.rot.toFixed(1)})`}
                                        >
                                            {/* Vertical trail — dark, narrow,
                                                below the bead's rotated frame.
                                                Reads as "water ran from here
                                                down the glass". */}
                                            {d.hasTrail && (
                                                <rect
                                                    x={-0.55}
                                                    y={0}
                                                    width={1.1}
                                                    height={d.trailLen}
                                                    fill="rgba(15,23,42,0.7)"
                                                    rx={0.55}
                                                />
                                            )}
                                            {/* Body — teardrop ellipse with
                                                the lens gradient. This alone
                                                does most of the heavy lifting
                                                for the "that is water" read. */}
                                            <ellipse cx={0} cy={0} rx={d.rx} ry={d.ry} fill="url(#drop-lens-v3)" />
                                            {/* Sharp dark outline — surface-
                                                tension edge. Reads clean
                                                against the panel background
                                                and locks the drop's silhouette. */}
                                            <ellipse
                                                cx={0}
                                                cy={0}
                                                rx={d.rx}
                                                ry={d.ry}
                                                fill="none"
                                                stroke="rgba(6,10,20,0.8)"
                                                strokeWidth="0.45"
                                            />
                                        </g>
                                    ));
                                })()}
                            </svg>
                        </>
                    )}
                </div>

                {/* Header — the one Glass dialog header: icon, sentence-case
                    title, top-right close (UX scorecard run 6). */}
                <div className="relative z-10 shrink-0 flex items-center justify-between px-5 pt-5 pb-3">
                    <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-sky-500/20 flex items-center justify-center">
                            <svg
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                className="text-sky-400"
                                aria-hidden="true"
                            >
                                <path
                                    d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"
                                    fill="currentColor"
                                    fillOpacity="0.4"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                />
                            </svg>
                        </div>
                        <h2 id="rain-forecast-title" className="text-base font-bold text-white tracking-tight">
                            Rain forecast
                        </h2>
                    </div>
                    <button
                        ref={closeButtonRef}
                        onClick={onClose}
                        className="hit-target-44 p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
                        aria-label="Close rain forecast detail"
                    >
                        <XIcon className="w-4 h-4" />
                    </button>
                </div>

                <div className="relative z-10 flex-1 min-h-0 overflow-y-auto px-5 pt-1 pb-4">
                    {/* Intensity Gauge — decoration; the words under it and the
                        chart summary carry the reading. */}
                    <div className="flex flex-col items-center mb-5">
                        <div className="relative w-36 h-20">
                            <svg viewBox="0 0 120 65" className="w-full h-full overflow-visible" aria-hidden="true">
                                {/* Background arc */}
                                <path
                                    d="M 10 60 A 50 50 0 0 1 110 60"
                                    fill="none"
                                    style={{ stroke: 'var(--day-ui-grid, rgba(255,255,255,0.08))' }}
                                    strokeWidth="8"
                                    strokeLinecap="round"
                                />
                                {/* Active arc — proportional to intensity */}
                                {analysis.hasRain && (
                                    <path
                                        d="M 10 60 A 50 50 0 0 1 110 60"
                                        fill="none"
                                        stroke="url(#rainGaugeGrad)"
                                        strokeWidth="8"
                                        strokeLinecap="round"
                                        strokeDasharray={`${Math.min(analysis.maxIntensity / 15, 1) * 157} 157`}
                                    />
                                )}
                                <defs>
                                    <linearGradient id="rainGaugeGrad" x1="0" y1="0" x2="1" y2="0">
                                        <stop offset="0%" stopColor="#22d3ee" />
                                        <stop offset="50%" stopColor="#3b82f6" />
                                        <stop offset="100%" stopColor="#818cf8" />
                                    </linearGradient>
                                </defs>
                                {/* Droplet icon — only with rain. At 0.0 it sat at
                                    the arc's apex and read as a needle at half
                                    scale. */}
                                {analysis.hasRain && (
                                    <path
                                        d="M 60 28 l3.5 3.5 a5 5 0 1 1 -7 0 L60 28z"
                                        fill="rgba(34, 211, 238, 0.7)"
                                        stroke="rgba(34, 211, 238, 0.9)"
                                        strokeWidth="0.5"
                                    />
                                )}
                            </svg>
                        </div>

                        {/* Intensity label. A dry window reads 'Dry': '0.0 mm/hr
                            peak' under 'Clear' was a number with nothing to
                            measure (UX scorecard run 7). */}
                        <div className="text-center -mt-2">
                            {analysis.hasRain ? (
                                <>
                                    {/* text-sky-400 steps to sky-800 by day (legibility.css),
                                        which holds on the light day surface below. */}
                                    <div className="text-[11px] font-bold uppercase tracking-widest mb-0.5 text-sky-400">
                                        {getIntensityLabel(analysis.maxIntensity)}
                                    </div>
                                    <div className="text-2xl font-black text-white tabular-nums">
                                        {analysis.maxIntensity.toFixed(1)}
                                    </div>
                                    {/* Units stay lower case: 'MM/HR' is not how the unit is written. */}
                                    <div className="text-[11px] text-white/60 tracking-wider">mm/hr peak</div>
                                </>
                            ) : (
                                <div className="text-2xl font-black text-white">Dry</div>
                            )}
                        </div>
                    </div>

                    {/* Summary Text */}
                    <div className="text-center mb-4">
                        <p className="text-base font-semibold text-white">{sentenceCase(analysis.headline)}</p>
                    </div>

                    {/* Rain chart — one image with a spoken summary; the bars
                        and axis ticks are not read one by one. */}
                    <div role="img" aria-label={chartSummary} className="relative">
                        {/* Chart frame: the box's own height, so the peak marker
                            can stand a bar's height up it. */}
                        <div className="relative">
                            {/* Peak intensity marker, 4 px above its bar and held
                                inside the chart's width at either end. At full
                                height it rises 16 px, into the headline's margin. */}
                            {analysis.hasRain && (
                                <div
                                    className="absolute text-[11px] leading-none text-sky-400 font-bold uppercase tracking-wider whitespace-nowrap"
                                    style={{
                                        left: `${peakPct * 100}%`,
                                        bottom: `calc(${peakBarPct.toFixed(1)}% + 4px)`,
                                        transform:
                                            peakPct < 0.1
                                                ? 'translateX(0)'
                                                : peakPct > 0.9
                                                  ? 'translateX(-100%)'
                                                  : 'translateX(-50%)',
                                    }}
                                >
                                    Peak
                                </div>
                            )}

                            {/* Dry window: the chart is only a 32 pt baseline over
                                the time axis, with no bars — trace below the rain
                                threshold, scaled to its own 0.1 mm/hr peak, drew a
                                full chart under 'No rain expected' (UX scorecard
                                run 7). With rain, bars are buckets of the feed (at
                                most MAX_CHART_BARS) against a fixed floor, clipped
                                to the padded box so they share one width with the
                                axis. */}
                            {/* Reference lines under a drizzle-only window: Light at
                                0.5 mm/hr, Moderate at the box's 2.5 mm/hr top. */}
                            {drizzleOnly &&
                                [
                                    { level: LIGHT_RAIN_FROM, label: 'Light' },
                                    { level: CHART_AXIS_FLOOR, label: 'Moderate' },
                                ].map(({ level, label }) => {
                                    const pct = (level / axisMax) * 100;
                                    const top = pct >= 99;
                                    // The line breaks under the Peak marker when it
                                    // would run through the word.
                                    const lineY = (pct / 100) * DRIZZLE_BOX_PX;
                                    const markerY = (peakBarPct / 100) * DRIZZLE_BOX_PX + 4;
                                    const crossesMarker = lineY >= markerY - 2 && lineY <= markerY + 14;
                                    const [gapFrom, gapTo] = crossesMarker ? peakMarkerSpan : [100, 100];
                                    const segments = [
                                        [0, gapFrom],
                                        [gapTo, 100],
                                    ].filter(([from, to]) => to - from > 0.5);
                                    return (
                                        <React.Fragment key={label}>
                                            {segments.map(([from, to]) => (
                                                <div
                                                    key={from}
                                                    className="absolute h-0 border-t border-dashed pointer-events-none"
                                                    style={{
                                                        bottom: `${pct.toFixed(1)}%`,
                                                        left: `${from.toFixed(1)}%`,
                                                        width: `${(to - from).toFixed(1)}%`,
                                                        borderColor: 'var(--day-ui-grid, rgba(255,255,255,0.16))',
                                                    }}
                                                />
                                            ))}
                                            <span
                                                className={`absolute ${refSide} text-[11px] leading-none font-semibold text-white/60 whitespace-nowrap pointer-events-none`}
                                                style={
                                                    top ? { top: '3px' } : { bottom: `calc(${pct.toFixed(1)}% + 3px)` }
                                                }
                                            >
                                                {label}
                                            </span>
                                        </React.Fragment>
                                    );
                                })}

                            <div
                                className={`relative flex items-end gap-px w-full overflow-hidden ${
                                    analysis.hasRain ? (drizzleOnly ? CHART_BOX_DRIZZLE : CHART_BOX_TALL) : 'h-8'
                                }`}
                            >
                                <div
                                    className="absolute inset-x-0 bottom-0 h-px pointer-events-none"
                                    style={{ background: 'var(--day-ui-border, rgba(255,255,255,0.25))' }}
                                />
                                {analysis.hasRain &&
                                    bars.map((intensity, i) => {
                                        const normalizedHeight = barHeightPct(intensity);
                                        const barColor = getBarColor(intensity, axisMax, true);
                                        const isPeak = i === peakBar;
                                        const trace = intensity < RAIN_THRESHOLD;

                                        return (
                                            <div key={i} className="flex-1 min-w-0 relative" style={{ height: '100%' }}>
                                                <div
                                                    className={`absolute bottom-0 left-0 right-0 rounded-t-sm transition-all duration-300 ${isPeak ? 'ring-1 ring-cyan-400/50' : ''}`}
                                                    style={{
                                                        height: `${normalizedHeight}%`,
                                                        background: barColor,
                                                        boxShadow:
                                                            intensity > 0 && !trace
                                                                ? `0 0 ${isPeak ? '8' : '3'}px ${barColor}50`
                                                                : 'none',
                                                    }}
                                                />
                                            </div>
                                        );
                                    })}
                            </div>
                            {/* The onset: a dashed rule from the axis up through the
                                bars, over its '47 min' tick below. */}
                            {onsetPct !== null && (
                                <div
                                    aria-hidden="true"
                                    className="absolute top-0 bottom-0 w-0 border-l border-dashed border-sky-300/70 pointer-events-none"
                                    style={{ left: `${(onsetPct * 100).toFixed(2)}%` }}
                                />
                            )}
                        </div>

                        {/* Time Axis — labels positioned by true pct across the
                            span of the minutelyRain feed, not by fixed index.
                            Keeps bars and labels aligned regardless of whether
                            the feed covers 60 min (WeatherKit) or 4h (Rainbow). */}
                        <div className="relative mt-2 h-4">
                            {timeLabels.map(({ pct, label, onset }, i) => (
                                <span
                                    key={`${i}-${label}`}
                                    className={`absolute text-[11px] font-bold tracking-wide whitespace-nowrap ${onset ? 'text-sky-300' : 'text-white/60'}`}
                                    style={{
                                        left: `${pct * 100}%`,
                                        // Shift the first label flush-left, the
                                        // last flush-right, the rest centered —
                                        // matches how bars align to their own
                                        // flex edges.
                                        transform:
                                            pct === 0
                                                ? 'translateX(0)'
                                                : pct > 0.95
                                                  ? 'translateX(-100%)'
                                                  : 'translateX(-50%)',
                                    }}
                                >
                                    {label}
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Stats Row. The peak's size is the gauge's job ('0.3 mm/hr
                        peak'); here it said it a second time, so the middle
                        stat says when the peak comes instead (UX scorecard
                        run 8), in the time axis's hours and minutes. Labelled
                        'Peak', so it reads 'Peak in 25 min' or 'Peak now'. */}
                    {analysis.hasRain && (
                        <div className="grid grid-cols-3 gap-3 mt-4 pt-3 border-t border-white/10">
                            <div className="text-center">
                                <div className="text-[11px] text-white/60 uppercase tracking-wider mb-0.5">Total</div>
                                <div className="text-sm font-bold text-white tabular-nums">
                                    {analysis.totalPrecip < 10
                                        ? analysis.totalPrecip.toFixed(1)
                                        : Math.round(analysis.totalPrecip)}{' '}
                                    mm
                                </div>
                            </div>
                            <div className="text-center">
                                <div className="text-[11px] text-white/60 uppercase tracking-wider mb-0.5">Peak</div>
                                <div className="text-sm font-bold text-sky-400 tabular-nums">
                                    {peakWhenLabel(peakInMin)}
                                </div>
                            </div>
                            <div className="text-center">
                                <div className="text-[11px] text-white/60 uppercase tracking-wider mb-0.5">Type</div>
                                <div className="text-sm font-bold text-white">{analysis.category.label}</div>
                            </div>
                        </div>
                    )}

                    {/* Which feed answered; how far ahead it sees is the
                        headline's and the axis's to say. Off the card face and
                        in here, where someone standing in rain the card called
                        dry comes looking for it. */}
                    {feedProvenance && (
                        <p className="mt-3 text-[12px] text-white/60 text-center leading-relaxed">{feedProvenance}</p>
                    )}
                </div>

                {/* Footer — the full-width Close the pin and model dialogs
                    have, in one-handed reach (UX scorecard run 7). */}
                <div className="relative z-10 shrink-0 px-4 py-3 border-t border-white/6">
                    <Button onClick={onClose} className="w-full text-slate-300">
                        Close
                    </Button>
                </div>
            </div>
        </OverlayPortal>
    );
};

// --- Helpers ---
// getIntensityLabel / getIntensityCategory live in rainAnalysis.ts with the
// rest of the card's claims; getBarColor is render-only and stays here.

function getBarColor(intensity: number, maxIntensity: number, active: boolean): string {
    if (intensity === 0) return 'transparent';
    if (intensity < RAIN_THRESHOLD) return TRACE_BAR_COLOR;

    const ratio = intensity / Math.max(maxIntensity, 0.1);

    if (active) {
        // Active: cyan → blue → indigo spectrum
        if (ratio > 0.8) return 'rgba(34, 211, 238, 0.95)'; // Cyan — peak
        if (ratio > 0.6) return 'rgba(56, 189, 248, 0.85)'; // Sky
        if (ratio > 0.4) return 'rgba(96, 165, 250, 0.80)'; // Blue
        if (ratio > 0.2) return 'rgba(129, 140, 248, 0.70)'; // Indigo
        return 'rgba(147, 197, 253, 0.55)'; // Light blue
    }

    // Quiet: muted blues
    if (ratio > 0.6) return 'rgba(96, 165, 250, 0.70)';
    if (ratio > 0.3) return 'rgba(96, 165, 250, 0.50)';
    return 'rgba(96, 165, 250, 0.35)';
}

export default RainForecastCard;
