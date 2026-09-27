import React, { useCallback, useState } from 'react';
import { ArrowUpIcon, ArrowDownIcon } from '../Icons';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertTemp } from '../../utils';
import { useSettingsStore } from '../../stores/settingsStore';
import { MetricPinSheet } from './MetricPinSheet';
import { getPinnedMetricDisplay } from './metricDisplayHelpers';
import { CoachMark } from '../ui/CoachMark';
import { triggerHaptic } from '../../utils/system';
import { useDroppable } from '@dnd-kit/core';

/**
 * ConditionText — simple text sizing based on string length.
 * No JavaScript DOM measurement = no flash on render.
 * Same size for live + forecast so carousel swipes don't jank.
 */
const ConditionText: React.FC<{ text: string; live?: boolean }> = ({ text, live }) => {
    // No condition reported: a muted, regular-weight placeholder, never bold
    // ivory bars that read as a glitch (same rule as the temperature '--').
    if (text === '--') {
        return <span className="text-lg text-white/40 font-mono font-normal leading-none">--</span>;
    }
    const sizeClass =
        text.length <= 8
            ? live
                ? 'text-xl'
                : 'text-lg' // "Clear", "Cloudy", "Sunny"
            : text.length <= 14
              ? live
                  ? 'text-lg'
                  : 'text-base' // "Mostly Clear", "Partly Cloudy"
              : 'text-sm'; // "Thunderstorms"

    // Inter, not mono: mono is kept for numbers, and the weather word is a
    // word (UX scorecard run 9).
    return <span className={`${sizeClass} text-ivory font-sans font-bold tracking-tight leading-none`}>{text}</span>;
};

/** Chevron-down SVG icon */
const ChevronIcon: React.FC<{ className?: string }> = ({ className }) => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
    >
        <polyline points="6 9 12 15 18 9" />
    </svg>
);

interface HeroHeaderProps {
    data: WeatherMetrics;
    units: UnitPreferences;
    isLive: boolean;
    isDay: boolean;
    dateLabel: string;
    timeLabel: string;
    timeZone?: string;
    sources?: Record<
        string,
        { source: string; sourceColor?: 'emerald' | 'amber' | 'sky' | 'white'; sourceName?: string }
    >;
    isExpanded?: boolean;
    onToggleExpand?: () => void;
    /** Passed through to MetricPinSheet so the picker hides marine-only
     *  metrics on inland users. */
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland';
    /** Set while a later day is shown: the date gains a "Today" control. */
    onReturnToToday?: () => void;
    /** Why a later day is all dashes ("Beyond ICON's range (ends Sun 4 Oct) —
     *  try another model"). Its first clause stands under the date in place
     *  of the '--' condition: the full caption sat ~300 pt below the wall of
     *  dashes it explains (UX scorecard run 9). */
    rangeNote?: string | null;
}

const HeroHeaderComponent: React.FC<HeroHeaderProps> = ({
    data,
    units,
    isLive,
    dateLabel,
    timeLabel,
    timeZone: _timeZone,
    sources,
    locationType,
    isExpanded = true,
    onToggleExpand,
    onReturnToToday,
    rangeNote,
}) => {
    // PERF: Memoize helper to get source text color for temperature
    const getTempColor = useCallback((): string => {
        // Live hero temp reads green by default (brand look); amber is kept as
        // the one data-source caution signal. Non-live (forecast) cards stay
        // white so the live/forecast distinction survives.
        if (!isLive) return 'text-white';
        if (sources?.['airTemperature']?.sourceColor === 'amber') return 'text-amber-400';
        return 'text-emerald-400';
    }, [isLive, sources]);

    // The previous getConditionIcon emoji-mapping helper + its
    // conditionCategory memo were removed during the 2026-05 visual
    // uplift — neither was rendered (the condition string itself is
    // shown as text, no icon overlay). Kept the text-only display.
    // '' is the producers' sentinel for an unknown condition; never invent 'Cloudy'.
    const displayCondition = data.condition || '--';
    // The reason alone; the card below keeps the '— try another model' and its button.
    const rangeReason = !isLive && rangeNote ? rangeNote.split(' — ')[0] : null;

    // ── PINNED METRIC STATE ──────────────────────────────────────────
    // When `heroMetric` !== 'temp', the LEFT partition renders the pinned
    // metric (e.g. "GUST 22 kts") instead of the big temperature number.
    // The temperature moves into the grid cell the pinned metric vacated
    // — that swap is handled in HeroWidgets.tsx, not here.
    const heroMetric = useSettingsStore((s) => s.settings.heroMetric) || 'temp';
    const updateSettings = useSettingsStore((s) => s.updateSettings);
    const [pinSheetOpen, setPinSheetOpen] = useState(false);
    const pinnedDisplay = heroMetric !== 'temp' ? getPinnedMetricDisplay(heroMetric, data, units) : null;
    // convertTemp answers '--' for a missing reading. A placeholder is drawn
    // lighter, thinner and smaller than a live number: at hero size and weight
    // '--' read as two heavy white bars, like a rendering glitch.
    const tempStr = convertTemp(data.airTemperature, units.temp).toString();
    const tempMissing = tempStr === '--';
    const pinnedMissing = pinnedDisplay?.value === '--';
    const highStr = convertTemp(data.highTemp, units.temp).toString();
    const lowStr = convertTemp(data.lowTemp, units.temp).toString();
    // Tap on the LEFT partition opens the picker. Double-tap resets to
    // temperature. Single-tap tracking is done via a simple timer +
    // click-count ref so we don't block the double-tap with a 250ms delay
    // on every click.
    // DnD drop target — Phase 2 of metric-pin. Long-pressing and dragging
    // a grid cell here pins it to the hero slot. The tap handler below is
    // preserved intact; long-press activation (250ms/8px) in the Dashboard
    // DndContext means normal taps still pass through to the picker sheet.
    const { isOver, setNodeRef: setDroppableRef } = useDroppable({ id: 'hero-pin-slot' });

    const tapTrackRef = React.useRef<{ count: number; timer: number | null }>({ count: 0, timer: null });
    const handleHeroLeftTap = useCallback(() => {
        void triggerHaptic('light');
        tapTrackRef.current.count += 1;
        if (tapTrackRef.current.timer != null) {
            window.clearTimeout(tapTrackRef.current.timer);
        }
        tapTrackRef.current.timer = window.setTimeout(() => {
            const count = tapTrackRef.current.count;
            tapTrackRef.current.count = 0;
            if (count >= 2) {
                // Double-tap → reset to temperature
                updateSettings({ heroMetric: 'temp' });
            } else {
                // Single tap → open the picker sheet
                setPinSheetOpen(true);
            }
        }, 260);
    }, [updateSettings]);

    return (
        // Not overflow-hidden: the first-run coach mark reaches out of the pin
        // partition into the centre column. group/hero: while it shows (its
        // role=status is in the card only then) the condition steps aside.
        <div className="group/hero relative w-full rounded-2xl border bg-white/8 shadow-[0_0_30px_-5px_rgba(0,0,0,0.3)] border-white/15">
            {/* Keyframes moved to index.css */}

            <div className="flex flex-row w-full items-center min-h-[70px] in-data-[glass-rhythm]:min-h-[54px]">
                {/* LEFT: Pinned metric (temperature by default).
                    Tap → open MetricPinSheet to pick a different metric.
                    Double-tap → reset to temperature.
                    The whole partition is the hit area — keeps the tap
                    target generous on iOS. */}
                <div
                    ref={setDroppableRef}
                    // self-stretch + min-h-11: the whole row height is the pin
                    // target. Content-high, landscape's trimmed row left it
                    // 218 x 38 pt, under the 44 pt floor (UX scorecard run 8).
                    className={`flex-1 self-stretch min-h-11 px-3 py-2 in-data-[glass-rhythm]:py-1 flex flex-col justify-center items-start min-w-0 cursor-pointer touch-manipulation select-none relative group transition-all duration-150 ${
                        isOver ? 'bg-sky-500/20 ring-2 ring-sky-400/60 ring-inset rounded-l-[15px] rounded-r-lg' : ''
                    }`}
                    onClick={handleHeroLeftTap}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            handleHeroLeftTap();
                        }
                    }}
                    aria-label={
                        pinnedDisplay
                            ? `Pinned metric ${pinnedDisplay.label}${pinnedMissing ? ', no reading' : ''}. Tap to change, double-tap to reset. Drop a grid metric here to pin it.`
                            : `Temperature ${tempMissing ? 'no reading' : `${tempStr} degrees ${units.temp === 'F' ? 'Fahrenheit' : 'Celsius'}`}. Tap to pin a different metric to the top, or drop one from the grid below.`
                    }
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                    {/* Keying remounts this wrapper when the pinned metric
                        changes. A tiny CSS animation preserves the visual
                        hand-off without loading an animation runtime into the
                        app's initial bundle. */}
                    <div key={heroMetric} className="metric-swap-enter flex flex-col items-start w-full">
                        {pinnedDisplay ? (
                            <>
                                {/* Pinned-metric mode: small label + value + unit.
                                        Uses typography proportional to the temp slot so
                                        the header doesn't jump height on pin/unpin. */}
                                <span className="glass-tide-caption text-[10px] font-bold uppercase tracking-widest text-sky-300/80 leading-none mb-0.5">
                                    {pinnedDisplay.label}
                                </span>
                                <div className="flex items-baseline gap-1 leading-none">
                                    <span
                                        className={
                                            pinnedMissing
                                                ? 'text-4xl in-data-[glass-rhythm]:text-3xl font-mono font-normal tracking-tighter text-white/40'
                                                : `${typeof pinnedDisplay.value === 'string' && pinnedDisplay.value.length > 3 ? 'text-4xl in-data-[glass-rhythm]:text-3xl' : 'text-[44px] in-data-[glass-rhythm]:text-[36px]'} font-mono font-bold tracking-tighter text-ivory drop-shadow-sm`
                                        }
                                    >
                                        {pinnedDisplay.value}
                                    </span>
                                    {pinnedDisplay.unit && pinnedDisplay.value !== '--' && (
                                        <span className="text-base font-bold text-white/60">{pinnedDisplay.unit}</span>
                                    )}
                                </div>
                            </>
                        ) : (
                            (() => {
                                const len = tempStr.length;
                                // Trimmed rhythms (SHORT, LANDSCAPE) mark the Dashboard
                                // with data-glass-rhythm and give this row 56 px, not 72.
                                const sizeClass =
                                    tempMissing || len > 3
                                        ? 'text-4xl in-data-[glass-rhythm]:text-3xl'
                                        : len > 2
                                          ? 'text-[44px] in-data-[glass-rhythm]:text-[36px]'
                                          : 'text-[54px] in-data-[glass-rhythm]:text-[40px]';
                                // Placeholder: regular weight, muted ink (text-white/40
                                // has its own caption ink by night and by day).
                                const inkClass = tempMissing
                                    ? 'font-normal text-white/40'
                                    : `font-bold ${getTempColor()}`;
                                // The ° ring sits high inside its own em box — well
                                // above cap height — so pinning the column's BOX top
                                // to the digits' BOX top left the ring floating above
                                // the numerals (Shane 2026-07-18: "the degree symbol
                                // is too high, it needs to be in line with the top of
                                // the font for the temp"). Drop it by the digits'
                                // cap-height inset, which scales with the temp size —
                                // a fixed nudge would be right for one size class and
                                // wrong for the other two. Tune here if it reads low.
                                const ringDropPx = tempMissing || len > 3 ? 4 : len > 2 ? 5 : 6;
                                return (
                                    <div className="relative flex items-stretch">
                                        <span
                                            className={`${sizeClass} font-mono tracking-tighter ${inkClass} leading-none`}
                                        >
                                            {tempStr}
                                        </span>
                                        {/* ° ring (top) and unit letter (baseline) as a matched
                                                pair: SAME font + size + weight so they share one
                                                centre line and read as a stacked °C. The column
                                                stretches the full temp height, justify-between pins
                                                ring-to-top / letter-to-baseline, items-center keeps
                                                them collinear. Both mono 22px — no tracking (it
                                                shifts a single glyph off centre). Dropped with no
                                                reading, as the grid cells and the pinned metric
                                                drop their units: '--°C' is not a temperature. */}
                                        {!tempMissing && (
                                            <div
                                                className="flex flex-col items-center justify-between self-stretch"
                                                aria-hidden="true"
                                            >
                                                <span
                                                    className={`text-[22px] in-data-[glass-rhythm]:text-lg font-mono leading-none ${inkClass}`}
                                                    style={{ transform: `translateY(${ringDropPx}px)` }}
                                                >
                                                    °
                                                </span>
                                                <span
                                                    className={`text-[22px] in-data-[glass-rhythm]:text-lg font-mono leading-none ${inkClass} translate-y-[-7px]`}
                                                >
                                                    {units.temp}
                                                </span>
                                            </div>
                                        )}
                                        {/* First-use coach mark — only fires while the user is
                                            still on the default temp view AND only on the LIVE
                                            card (live temp reads are the honest moment to teach
                                            the feature, not a forecast day). Disappears after
                                            one viewing, controlled by localStorage.

                                            Never on the number (UX scorecard run 7: it hid the
                                            foot of '21', and all but the ° at 375 pt and in
                                            landscape), and never on the grid (run 8: hung below
                                            the card it covered the WIND label for its 6 s, and
                                            part of DIR at 375 pt). It sits inside the card,
                                            beside the digits and pointing back at them, in the
                                            centre column's place: the condition text steps
                                            aside while it shows (group-has on the card). */}
                                        {isLive && (
                                            <CoachMark
                                                seenKey="thalassa_hero_pin_coach_v1"
                                                visibleWhen={heroMetric === 'temp'}
                                                anchor="custom"
                                                arrow="left"
                                                message="Tap to pin"
                                                initialDelayMs={1500}
                                                ttlMs={6000}
                                                className="top-1/2 -translate-y-1/2 left-full ml-2 items-center whitespace-nowrap"
                                                // The bubble itself: its text-balance undid the
                                                // wrapper's nowrap, 'Tap / to / pin' (run 9).
                                                singleLine
                                            />
                                        )}
                                    </div>
                                );
                            })()
                        )}
                    </div>
                    {/* No corner 'edit' disc: at 16 px and 60 % it was too faint
                        to register, and a legible 20 px one lands on the °
                        ring at 375 pt. The first-run coach mark teaches the
                        tap, and the partition's name says it. */}
                </div>

                {/* CENTER: Status dot + icon + condition */}
                {/* key ensures React swaps the whole block atomically — no two-step size→text jank */}
                <div
                    key={`${isLive ? 'live' : dateLabel}-${displayCondition}`}
                    // py-0 in the trimmed rhythms: date, condition and hour stack to
                    // 52 px, and with py-2 they stretched a 56 px slot to 70.
                    // Invisible (space kept) while the first-run coach mark is
                    // standing in its place. Portrait only: in landscape the mark
                    // is ~250 pt away and the hero was left as '19°C' and a void
                    // for its 6 s (UX scorecard run 9).
                    className="flex-2 flex items-center justify-center min-w-0 py-2 in-data-[glass-rhythm]:py-0 px-1 portrait:group-has-[[role=status]]/hero:invisible"
                >
                    {isLive ? (
                        <div className="flex items-center justify-center gap-2 max-w-full -ml-2">
                            {/* Pulsing green live dot */}
                            <div
                                className="w-[7px] h-[7px] rounded-full bg-emerald-400 shrink-0"
                                style={{ animation: 'hh-pulse 2s ease-in-out infinite' }}
                            />
                            <ConditionText text={displayCondition} live />
                        </div>
                    ) : (
                        <div className="flex flex-col items-center">
                            <div className="flex items-center gap-1.5 mb-1">
                                <span
                                    // Tighter beside the Today pill, so 'WED 30 SEP' and the
                                    // pill share one line in the 375 pt centre column.
                                    className={`text-sky-400 font-extrabold text-xs ${onReturnToToday ? 'tracking-[0.12em]' : 'tracking-[0.2em]'} uppercase leading-none whitespace-nowrap`}
                                    style={{ paddingLeft: onReturnToToday ? '0.12em' : '0.2em' }}
                                >
                                    {dateLabel}
                                </span>
                                {/* A later day: one tap back to today's live card, not
                                    one swipe per day (UX scorecard run 7). The span
                                    gives the 14 px pill a 44 pt target that hangs
                                    down over the condition text, not up out of the
                                    card into the warnings row. A return arrow leads
                                    the word: a bare 'Today' beside 'WED 7 OCT' read
                                    as a tag saying that day was today (run 8), and
                                    'Back to today' does not fit the 375 pt column. */}
                                {onReturnToToday && (
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            onReturnToToday();
                                        }}
                                        // Starts with the visible word, for voice control.
                                        aria-label="Today, back to now"
                                        className="relative shrink-0 inline-flex items-center gap-0.5 rounded-full border border-sky-400/40 bg-sky-500/10 px-1.5 text-xs font-semibold leading-none text-sky-300 glass-tide-caption active:bg-sky-500/25"
                                    >
                                        <span
                                            className="absolute left-1/2 top-[-6px] h-11 w-full min-w-11 -translate-x-1/2"
                                            aria-hidden="true"
                                        />
                                        <svg
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2.5"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            className="w-2.5 h-2.5 shrink-0"
                                            aria-hidden="true"
                                        >
                                            <path d="M9 14 4 9l5-5" />
                                            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                                        </svg>
                                        Today
                                    </button>
                                )}
                            </div>
                            {rangeReason ? (
                                <p className="glass-forecast-caption max-w-full text-center text-xs font-medium leading-tight">
                                    {rangeReason}
                                </p>
                            ) : (
                                <div className="flex items-center justify-center gap-2 max-w-full">
                                    <ConditionText text={displayCondition} />
                                </div>
                            )}
                            {timeLabel && (
                                <span className="text-sky-300 text-sm font-bold font-mono leading-none mt-1">
                                    {timeLabel}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* RIGHT: Hi/Lo + Chevron. The hi/lo are their own element, not
                    part of the button's name; the whole column still toggles
                    the grid for a thumb, and the chevron is the one control a
                    screen reader or keyboard meets. */}
                <div
                    onClick={onToggleExpand}
                    className={`flex-1 flex min-h-11 items-center justify-end gap-2 pr-3 touch-none select-none ${onToggleExpand ? 'cursor-pointer' : ''}`}
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                    {/* Hi/Lo temps stacked */}
                    <div className="flex flex-col items-end gap-0.5">
                        <div className="flex items-center gap-0.5">
                            <ArrowUpIcon className="w-2.5 h-2.5 text-amber-400 opacity-70" />
                            <span className="text-xs font-mono font-bold text-white/80 whitespace-nowrap">
                                <span className="sr-only">High </span>
                                {highStr}
                                {highStr !== '--' && '°'}
                            </span>
                        </div>
                        <div className="flex items-center gap-0.5">
                            <ArrowDownIcon className="w-2.5 h-2.5 text-sky-400 opacity-70" />
                            <span className="text-xs font-mono font-bold text-white/80 whitespace-nowrap">
                                <span className="sr-only">Low </span>
                                {lowStr}
                                {lowStr !== '--' && '°'}
                            </span>
                        </div>
                    </div>
                    {/* Ghostly chevron — hidden for inland (no expand available).
                        44 pt button around the 36 px disc; -mx-1 keeps the disc
                        where it always sat. */}
                    {onToggleExpand && (
                        <button
                            type="button"
                            onClick={(event) => {
                                // The column's own onClick would toggle it back.
                                event.stopPropagation();
                                onToggleExpand?.();
                            }}
                            aria-label={isExpanded ? 'Collapse instrument grid' : 'Expand instrument grid'}
                            aria-expanded={isExpanded}
                            className="-mx-1 w-11 h-11 shrink-0 rounded-full flex items-center justify-center"
                        >
                            {/* A hairline edge: by day the white/5 disc is white on
                                a white card, and its boundary vanished (run 9). */}
                            <span
                                className="w-9 h-9 rounded-full bg-white/5 border border-white/8 flex items-center justify-center"
                                aria-hidden="true"
                            >
                                <ChevronIcon
                                    className={`w-[18px] h-[18px] text-white/60 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}
                                />
                            </span>
                        </button>
                    )}
                </div>
            </div>

            {/* Pin-a-metric picker sheet — mounts as a portal to document.body
                so its backdrop covers the full viewport regardless of the
                header's fixed-position stacking context. */}
            <MetricPinSheet
                visible={pinSheetOpen}
                currentMetric={heroMetric}
                locationType={locationType}
                onPick={(id) => {
                    void triggerHaptic('light');
                    updateSettings({ heroMetric: id });
                    setPinSheetOpen(false);
                }}
                onClose={() => setPinSheetOpen(false)}
            />
        </div>
    );
};

// PERF: Wrap with React.memo to prevent re-renders when props haven't changed
export const HeroHeader = React.memo(HeroHeaderComponent);
