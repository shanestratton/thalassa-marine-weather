import React, { useMemo, useCallback, useState } from 'react';
import { ArrowUpIcon, ArrowDownIcon } from '../Icons';
import { WeatherMetrics, UnitPreferences } from '../../types';
import { convertTemp } from '../../utils';
import { useSettingsStore } from '../../stores/settingsStore';
import { MetricPinSheet } from './MetricPinSheet';
import { getPinnedMetricDisplay } from './metricDisplayHelpers';
import { CoachMark } from '../ui/CoachMark';
import { triggerHaptic } from '../../utils/system';
import { useDroppable } from '@dnd-kit/core';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * ConditionText — simple text sizing based on string length.
 * No JavaScript DOM measurement = no flash on render.
 * Same size for live + forecast so carousel swipes don't jank.
 */
const ConditionText: React.FC<{ text: string; live?: boolean }> = ({ text, live }) => {
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

    return <span className={`${sizeClass} text-ivory font-mono font-bold tracking-tight leading-none`}>{text}</span>;
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
}

const HeroHeaderComponent: React.FC<HeroHeaderProps> = ({
    data,
    units,
    isLive,
    isDay,
    dateLabel,
    timeLabel,
    timeZone: _timeZone,
    sources,
    locationType,
    isExpanded = true,
    onToggleExpand,
}) => {
    // PERF: Memoize helper to get source text color for temperature
    const getTempColor = useCallback((): string => {
        if (!isLive) return 'text-white';
        if (!sources || !sources['airTemperature']) return 'text-white';
        const sourceColor = sources['airTemperature']?.sourceColor;
        switch (sourceColor) {
            case 'emerald':
                return 'text-emerald-400';
            case 'amber':
                return 'text-amber-400';
            default:
                return 'text-white';
        }
    }, [isLive, sources]);

    // The previous getConditionIcon emoji-mapping helper + its
    // conditionCategory memo were removed during the 2026-05 visual
    // uplift — neither was rendered (the condition string itself is
    // shown as text, no icon overlay). Kept the text-only display.
    const displayCondition = data.condition || 'Cloudy';

    // ── PINNED METRIC STATE ──────────────────────────────────────────
    // When `heroMetric` !== 'temp', the LEFT partition renders the pinned
    // metric (e.g. "GUST 22 kts") instead of the big temperature number.
    // The temperature moves into the grid cell the pinned metric vacated
    // — that swap is handled in HeroWidgets.tsx, not here.
    const heroMetric = useSettingsStore((s) => s.settings.heroMetric) || 'temp';
    const updateSettings = useSettingsStore((s) => s.updateSettings);
    const [pinSheetOpen, setPinSheetOpen] = useState(false);
    const pinnedDisplay = heroMetric !== 'temp' ? getPinnedMetricDisplay(heroMetric, data, units) : null;
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
        <div className="relative w-full rounded-2xl overflow-hidden border bg-white/[0.08] shadow-[0_0_30px_-5px_rgba(0,0,0,0.3)] border-white/[0.15]">
            {/* Keyframes moved to index.css */}

            <div className="flex flex-row w-full items-center min-h-[70px]">
                {/* LEFT: Pinned metric (temperature by default).
                    Tap → open MetricPinSheet to pick a different metric.
                    Double-tap → reset to temperature.
                    The whole partition is the hit area — keeps the tap
                    target generous on iOS. */}
                <div
                    ref={setDroppableRef}
                    className={`flex-[1] px-3 py-2 flex flex-col justify-center items-start min-w-0 cursor-pointer touch-manipulation select-none relative group transition-all duration-150 ${
                        isOver ? 'bg-sky-500/20 ring-2 ring-sky-400/60 ring-inset rounded-lg' : ''
                    }`}
                    onClick={handleHeroLeftTap}
                    role="button"
                    aria-label={
                        pinnedDisplay
                            ? `Pinned metric ${pinnedDisplay.label}. Tap to change, double-tap to reset. Drop a grid metric here to pin it.`
                            : 'Temperature. Tap to pin a different metric to the top, or drop one from the grid below.'
                    }
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                    {/* Animated swap — AnimatePresence drives a crossfade +
                        subtle scale between whichever metric is currently
                        pinned. `mode="wait"` ensures the old content fully
                        exits before the new content enters, avoiding a
                        double-layered flash. The motion.div is keyed by
                        heroMetric so every swap triggers a fresh enter/exit
                        cycle. */}
                    <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                            key={heroMetric}
                            initial={{ opacity: 0, scale: 0.92, y: 6 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.92, y: -6 }}
                            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                            className="flex flex-col items-start w-full"
                        >
                            {pinnedDisplay ? (
                                <>
                                    {/* Pinned-metric mode: small label + value + unit.
                                        Uses typography proportional to the temp slot so
                                        the header doesn't jump height on pin/unpin. */}
                                    <span className="text-[10px] font-bold uppercase tracking-widest text-sky-300/80 leading-none mb-0.5">
                                        {pinnedDisplay.label}
                                    </span>
                                    <div className="flex items-baseline gap-1 leading-none">
                                        <span
                                            className={`${typeof pinnedDisplay.value === 'string' && pinnedDisplay.value.length > 3 ? 'text-4xl' : 'text-[44px]'} font-mono font-bold tracking-tighter text-ivory drop-shadow`}
                                        >
                                            {pinnedDisplay.value}
                                        </span>
                                        {pinnedDisplay.unit && (
                                            <span className="text-base font-bold text-white/60">
                                                {pinnedDisplay.unit}
                                            </span>
                                        )}
                                    </div>
                                </>
                            ) : (
                                (() => {
                                    const tempStr = (
                                        data.airTemperature !== null
                                            ? convertTemp(data.airTemperature, units.temp)
                                            : '--'
                                    ).toString();
                                    const len = tempStr.length;
                                    const sizeClass = len > 3 ? 'text-4xl' : len > 2 ? 'text-[44px]' : 'text-[54px]';
                                    return (
                                        <div className="flex items-stretch">
                                            <span
                                                className={`${sizeClass} font-mono font-bold tracking-tighter ${getTempColor()} leading-none`}
                                                aria-label={`Temperature ${tempStr} degrees ${units.temp}`}
                                            >
                                                {tempStr}
                                            </span>
                                            {/* ° ring pinned to the top, unit letter dropped to the
                                                numeral's baseline directly beneath it. The column
                                                stretches the full temp height and justify-between
                                                splits ring/letter top-to-bottom; letter matches the
                                                numeral's colour so the pair reads as one unit. */}
                                            <div
                                                className="flex flex-col items-center justify-between self-stretch"
                                                aria-hidden="true"
                                            >
                                                <span
                                                    className={`${sizeClass} font-mono font-bold tracking-tighter ${getTempColor()} leading-none h-[0.42em]`}
                                                >
                                                    °
                                                </span>
                                                <span
                                                    className={`text-xl font-bold leading-none ${getTempColor()} -translate-y-[7px]`}
                                                >
                                                    {units.temp}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })()
                            )}
                        </motion.div>
                    </AnimatePresence>
                    {/* Tiny "edit" affordance in the top-right — only appears
                        on hover on desktop or remains subtly visible on mobile
                        so new users have a visual cue that this area is
                        interactive. */}
                    <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-white/[0.06] flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity pointer-events-none">
                        <svg
                            width="8"
                            height="8"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="text-white/70"
                            aria-hidden="true"
                        >
                            <circle cx="5" cy="12" r="1" />
                            <circle cx="12" cy="12" r="1" />
                            <circle cx="19" cy="12" r="1" />
                        </svg>
                    </span>

                    {/* First-use coach mark — only fires while the user is
                        still on the default temp view AND only on the LIVE
                        card (live temp reads are the honest moment to teach
                        the feature, not a forecast day). Disappears after
                        one viewing, controlled by localStorage. */}
                    {isLive && (
                        <CoachMark
                            seenKey="thalassa_hero_pin_coach_v1"
                            visibleWhen={heroMetric === 'temp'}
                            anchor="top-right"
                            arrow="up"
                            message="Tap to pin any metric here"
                            initialDelayMs={1500}
                            ttlMs={6000}
                            className="-translate-y-8"
                        />
                    )}
                </div>

                {/* CENTER: Status dot + icon + condition */}
                {/* key ensures React swaps the whole block atomically — no two-step size→text jank */}
                <div
                    key={`${isLive ? 'live' : dateLabel}-${displayCondition}`}
                    className="flex-[2] flex items-center justify-center min-w-0 py-2 px-1"
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
                            <span
                                className="text-sky-400 font-extrabold text-[11px] tracking-[0.2em] uppercase leading-none mb-1"
                                style={{ paddingLeft: '0.2em' }}
                            >
                                {dateLabel}
                            </span>
                            <div className="flex items-center justify-center gap-2 max-w-full">
                                <ConditionText text={displayCondition} />
                            </div>
                            {timeLabel && (
                                <span className="text-sky-400/70 text-[11px] font-bold font-mono leading-none mt-1">
                                    {timeLabel}
                                </span>
                            )}
                        </div>
                    )}
                </div>

                {/* RIGHT: Hi/Lo + Chevron */}
                <div
                    onClick={onToggleExpand}
                    className={`flex-[1] flex items-center justify-end gap-2 pr-3 touch-none select-none ${onToggleExpand ? 'cursor-pointer' : ''}`}
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                    role={onToggleExpand ? 'button' : undefined}
                    aria-label={
                        onToggleExpand
                            ? isExpanded
                                ? 'Collapse instrument grid'
                                : 'Expand instrument grid'
                            : undefined
                    }
                >
                    {/* Hi/Lo temps stacked */}
                    <div className="flex flex-col items-end gap-0.5">
                        <div className="flex items-center gap-0.5">
                            <ArrowUpIcon className="w-2.5 h-2.5 text-amber-400 opacity-70" />
                            <span className="text-xs font-mono font-bold text-white/80">
                                {data.highTemp !== undefined ? convertTemp(data.highTemp, units.temp) : '--'}°
                            </span>
                        </div>
                        <div className="flex items-center gap-0.5">
                            <ArrowDownIcon className="w-2.5 h-2.5 text-sky-400 opacity-70" />
                            <span className="text-xs font-mono font-bold text-white/80">
                                {data.lowTemp !== undefined ? convertTemp(data.lowTemp, units.temp) : '--'}°
                            </span>
                        </div>
                    </div>
                    {/* Ghostly chevron — hidden for inland (no expand available) */}
                    {onToggleExpand && (
                        <div className="w-9 h-9 rounded-full bg-white/[0.05] flex items-center justify-center">
                            <ChevronIcon
                                className={`w-[18px] h-[18px] text-white/60 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}
                            />
                        </div>
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
