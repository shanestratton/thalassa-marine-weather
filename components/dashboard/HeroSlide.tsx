/**
 * @filesize-justified Single React.memo component — monolithic render with no natural sub-component boundaries.
 */
import React, { useState, useEffect, useId, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { TideGraph } from './TideAndVessel';
// MapHub removed from essential mode — uses static image to prevent GPU heating
import { DropletIcon, EyeIcon, SunIcon, ThermometerIcon, GaugeIcon, CompassIcon, CloudIcon, WaveIcon } from '../Icons';
import {
    UnitPreferences,
    WeatherMetrics,
    VesselProfile,
    Tide,
    TidePoint,
    HourlyForecast,
    UserSettings,
    SourcedWeatherMetrics,
    ForecastDay,
} from '../../types';
import { TideGUIDetails } from '../../services/weather/api/tides';
import { cardinalToDegrees, convertMetersTo } from '../../utils';

import { MetricGridPanel } from './hero/MetricGridPanel';
import { useWeather } from '../../context/WeatherContext';
import { MinutelyRain } from '../../services/weather/api/weatherkit';

import { isGoldenHour } from '../../utils/goldenHour';
import { EssentialMapSlide } from './hero/EssentialMapSlide';
import { EssentialAnchorView } from './hero/EssentialAnchorView';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import {
    computeSunPhase,
    computeCardDisplayValues,
    buildSlides,
    forecastDayHasWeather,
    heroRowDayName,
    horizonCaption,
    setSlideInert,
} from './hero/heroSlideHelpers';
import type { GlassForecastRange } from './hero/heroSlideHelpers';
import { DailySummaryCard } from './hero/DailySummaryCard';
import { WindVsTideView } from './tide/WindVsTideView';
import { useSettingsStore } from '../../stores/settingsStore';

// Stable fallback: `weatherData?.forecast || []` minted a fresh array on every
// render when forecast was absent, defeating the `slides` useMemo below.
const EMPTY_FORECAST: ForecastDay[] = [];

type TideDirection = 'rising' | 'falling' | 'steady';

/**
 * Tide height (metres) and direction at `tMs`, for the tide card's accessible
 * name. Between extremes it is the same cosine curve TideGraph draws; the
 * hourly sea-level series is the fallback. Null when neither brackets `tMs` —
 * the name then carries the hour alone rather than an invented height.
 */
function tideAtTime(
    extremes: { t: number; h: number }[],
    series: { t: number; h: number }[],
    tMs: number,
): { heightM: number; direction: TideDirection } | null {
    const dir = (from: number, to: number): TideDirection =>
        Math.abs(to - from) < 0.005 ? 'steady' : to > from ? 'rising' : 'falling';
    for (let i = 1; i < extremes.length; i++) {
        const a = extremes[i - 1];
        const b = extremes[i];
        if (tMs >= a.t && tMs <= b.t && b.t > a.t) {
            const phase = (Math.PI * (tMs - a.t)) / (b.t - a.t);
            return { heightM: (a.h + b.h) / 2 + ((a.h - b.h) / 2) * Math.cos(phase), direction: dir(a.h, b.h) };
        }
    }
    for (let i = 1; i < series.length; i++) {
        const a = series[i - 1];
        const b = series[i];
        if (tMs >= a.t && tMs <= b.t && b.t > a.t) {
            return { heightM: a.h + ((b.h - a.h) * (tMs - a.t)) / (b.t - a.t), direction: dir(a.h, b.h) };
        }
    }
    return null;
}

const byTime = <T extends { time: string; height: number }>(points: T[] | undefined) =>
    (points ?? [])
        .map((p) => ({ t: new Date(p.time).getTime(), h: p.height }))
        .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.h))
        .sort((a, b) => a.t - b.t);

/**
 * Opens the Glass footer's own model picker, by pressing its model pill:
 * one way into the picker, not a second picker with its own copy of the
 * coverage and refresh wiring.
 */
const openGlassModelPicker = () => {
    document
        .querySelector<HTMLButtonElement>('[data-testid="glass-status-strip"] button[aria-haspopup="dialog"]')
        ?.click();
};

/**
 * A forecast day past the pinned model's reach: not one weather number in
 * the day or its hours, and no wave or tide to show instead. It used to
 * render the overview's grid of bare dashes — the same picture as a broken
 * feed — so it says what it is instead.
 */
const ForecastHorizonCard: React.FC<{
    dateLabel: string;
    caption: string;
    showDateHeading: boolean;
    /** Set when the caption names a model: 'try another model' gets the
     *  control that does it (UX scorecard run 8). */
    onChooseModel?: () => void;
}> = ({ dateLabel, caption, showDateHeading, onChooseModel }) => (
    <div
        data-testid="forecast-horizon"
        role="group"
        aria-label={`Forecast for ${dateLabel}`}
        // Centred in its frame: pinned to the top it left ~120 pt of empty
        // card under one line (UX scorecard run 7).
        className="w-full h-full min-h-0 overflow-hidden flex flex-col items-center justify-center gap-2 px-5 text-center"
    >
        {showDateHeading ? <span className="text-base font-bold tracking-wide text-white/90">{dateLabel}</span> : null}
        <p className="glass-forecast-caption text-sm font-medium">{caption}</p>
        {onChooseModel ? (
            <button
                type="button"
                onClick={(event) => {
                    event.stopPropagation();
                    onChooseModel();
                }}
                aria-haspopup="dialog"
                className="mt-1 min-h-11 rounded-xl border border-sky-400/40 bg-sky-500/10 px-4 text-sm font-semibold text-sky-300 active:bg-sky-500/25"
            >
                Choose model
            </button>
        ) : null}
    </div>
);

// --- HERO SLIDE COMPONENT (Individual Day Card) ---
/** Module-level so the memoised radar card sees one stable onMapTap identity. */
const navigateToMap = () => {
    window.dispatchEvent(new CustomEvent('thalassa:navigate', { detail: { tab: 'map' } }));
};

const HeroSlideComponent = ({
    data,
    index,
    units,
    tides,
    updateSettings: _updateSettings,
    addDebugLog: _addDebugLog,
    timeZone,
    locationName: _locationName,
    isLandlocked,
    displaySource: _displaySource,
    customTime,
    hourly,
    guiDetails,
    coordinates,
    locationType,
    generatedAt: _generatedAt,
    onTimeSelect,
    onHourChange,
    onSlideIndexChange,
    onActiveDataChange,
    isVisible = false,
    tideHourly,
    isEssentialMode = false,
    forecastRange,
    compact = false,
}: {
    data: SourcedWeatherMetrics;
    index: number;
    units: UnitPreferences;
    tides?: Tide[];
    settings: UserSettings;
    updateSettings: (newSettings: Partial<UserSettings>) => void;
    addDebugLog: ((msg: string) => void) | undefined;
    timeZone?: string;
    locationName?: string;
    isLandlocked?: boolean;
    displaySource: string;
    vessel?: VesselProfile;
    customTime?: number;
    hourly?: HourlyForecast[];
    fullHourly?: HourlyForecast[];
    lat?: number;
    guiDetails?: TideGUIDetails;
    coordinates?: { lat: number; lon: number };
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland';
    generatedAt?: string;
    onTimeSelect?: (time: number | undefined) => void;
    onHourChange?: (hour: number) => void;
    /** RAW carousel index, unlike onHourChange which maps it to an hour. A
     *  forecast day's slide 0 is the day OVERVIEW and slide 1 is 00:00, and
     *  both map to hour 0 — so the hour alone cannot tell them apart and
     *  anything upstream that must (the header's time range) needs this. */
    onSlideIndexChange?: (idx: number) => void;
    onActiveDataChange?: (data: SourcedWeatherMetrics) => void;
    isVisible?: boolean;
    utcOffset?: number;
    tideHourly?: TidePoint[];
    isEssentialMode?: boolean;
    minutelyRain?: MinutelyRain[];
    /** The pinned model and the last day it reaches — captions days past it. */
    forecastRange?: GlassForecastRange;
    /** Short viewport: no room for the day label row above the hours. */
    compact?: boolean;
}) => {
    const { weatherData } = useWeather();
    const forecast = weatherData?.forecast ?? EMPTY_FORECAST;

    // 1. STATE HOISTING (Zero-Latency Architecture)
    // We define the scroll state AT THE TOP so it drives the entire component synchronously.
    const [activeHIdx, setActiveHIdx] = useState(0);
    // Press the tide graph to open wind-vs-tide; its back control closes it.
    const [showWindVsTide, setShowWindVsTide] = useState(false);
    const windTideFocusTargetRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        // One face opens in every hourly slide, but only the keyboard-used
        // card may take focus. Pointer/touch flips leave focus alone.
        const card = windTideFocusTargetRef.current;
        windTideFocusTargetRef.current = null;
        if (!card?.isConnected) return;
        const target = showWindVsTide
            ? card.querySelector<HTMLElement>('[role="region"][aria-label="Wind versus tide details"]')
            : card;
        target?.focus({ preventScroll: true });
    }, [showWindVsTide]);
    const floodDirection = useSettingsStore((s) => s.settings.tideFloodDirection);
    const updateSettings = useSettingsStore((s) => s.updateSettings);

    // PERF: Refs for scroll optimization - prevent layout thrashing
    const scrollRafRef = useRef<number | null>(null);
    const lastScrollIdxRef = useRef(0);

    // 2. HOISTED DATA PREPARATION
    // Filter out the first hourly item (current hour) to avoid duplication with 'Now' card
    const hourlyToRender = React.useMemo(() => {
        try {
            if (!hourly || !Array.isArray(hourly) || hourly.length === 0) return [];

            if (index === 0) {
                // TODAY: Start from Next Hour, Finish at Midnight (Location Time)
                const now = new Date(); // Absolute Now

                // Get Current Location Date String (YYYY-MM-DD)
                // Fallback to 'UTC' if timeZone is missing (Ocean) to avoid crash, or use local.
                let safeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;

                // Validate timezone
                try {
                    Intl.DateTimeFormat(undefined, { timeZone: safeZone });
                } catch (e) {
                    safeZone = 'UTC';
                }

                const nowLocDateStr = now.toLocaleDateString('en-CA', { timeZone: safeZone }); // YYYY-MM-DD

                // Filter: Time > Now (Absolute) AND Date == Today (Local)
                const futureHourly = hourly
                    .filter((h) => {
                        if (!h || !h.time) return false;
                        const t = new Date(h.time);

                        // 1. Must be FUTURE hour (hour start > Now)
                        // If Now is 20:29, we already show 20:00 in the NOW card.
                        // So we only want hours starting from 21:00 onwards.
                        if (t.getTime() <= now.getTime()) return false;

                        // 2. Must be TODAY (Local Time)
                        // This prevents scrolling past midnight into tomorrow's data
                        const hDateStr = t.toLocaleDateString('en-CA', { timeZone: safeZone });
                        return hDateStr === nowLocDateStr;
                    })
                    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

                return futureHourly;
            } else {
                // FORECAST: 00:00 to 23:00 (Already filtered by day in Hero.tsx, just return all)
                return hourly.slice().sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
            }
        } catch (err) {
            return [];
        }
    }, [hourly, index, timeZone]);

    // FIX: Offshore should show 3x3 Grid, not Tide Graph (unless Coastal)
    const showTideGraph =
        (locationType === 'coastal' || locationType === 'inshore') && !isLandlocked && tides && tides.length > 0;
    // Detect when tides SHOULD be available but aren't (API failure / key issue)
    const tidesExpectedButMissing =
        (locationType === 'coastal' || locationType === 'inshore') && !isLandlocked && (!tides || tides.length === 0);
    // In essential mode, show map for any coastal/inshore location — independent of tide availability
    const showMapInstead =
        isEssentialMode &&
        (locationType === 'coastal' || locationType === 'inshore' || locationType === 'inland' || isLandlocked);

    // Anchor-watch snapshot — when the user has deployed the anchor, the
    // essential-mode slot swaps from EssentialMapSlide to EssentialAnchorView
    // (swing circle + radar + nearby AIS). Subscribe once at the HeroSlide
    // level so every slide in the carousel sees the same state.
    //
    // CRITICAL: lazy-initialise from `AnchorWatchService.getSnapshot()` — NOT
    // from `null`. The previous implementation defaulted to null on first
    // render, then the useEffect subscribed and the listener immediately fired
    // with the real state, causing a re-render. Visible result: when the
    // anchor was already deployed at app startup, the EssentialMapSlide
    // rendered for one frame before being replaced by EssentialAnchorView,
    // creating a visible "jump" in the Glass page on cold start. Lazy-init
    // means the FIRST render already has the correct snapshot, so the right
    // view (map vs anchor) is chosen from frame 1. No flash, no jump.
    const [anchorSnapshot, setAnchorSnapshot] = useState<AnchorWatchSnapshot | null>(() =>
        AnchorWatchService.getSnapshot(),
    );
    useEffect(() => {
        const unsub = AnchorWatchService.subscribe(setAnchorSnapshot);
        return unsub;
    }, []);
    // Swap trigger: anchor is actively watching (deployed + GPS running) or
    // has triggered the drag alarm. Idle / setting / paused still show the
    // map — the user hasn't committed to being on the hook.
    const showAnchorView = anchorSnapshot?.state === 'watching' || anchorSnapshot?.state === 'alarm';

    // Ticker for Live Countdown — the re-render itself is the point (it
    // refreshes `Date.now()` reads in the JSX), so the counter is unnamed.
    const [, setTick] = useState(0);
    useEffect(() => {
        if (index !== 0) return; // Optimization: Only tick for Live card
        const timer = setInterval(() => {
            if (!document.hidden) setTick((t) => t + 1);
        }, 30000); // 30s check
        return () => clearInterval(timer);
    }, [index]);

    // First-use swipe affordance: a pulsing chevron on the right edge of the
    // live card tells the user "there's more content horizontally". Solves
    // the discoverability gap where first-time users don't realise hours live
    // sideways on the today slide. Shows for 2.5s, then never again (flag
    // lives in localStorage so it survives app restarts).
    //
    // Only fires on day 0, hour 0 (the live card) — the carousel is most
    // discoverable here because it's where the user naturally starts.
    const SWIPE_HINT_SEEN_KEY = 'thalassa_swipe_hint_seen_v1';
    const [showSwipeHint, setShowSwipeHint] = useState(false);
    useEffect(() => {
        if (index !== 0 || activeHIdx !== 0) return;
        try {
            if (localStorage.getItem(SWIPE_HINT_SEEN_KEY) === '1') return;
        } catch {
            // localStorage unavailable — skip hint
            return;
        }
        // Small delay so the hint appears AFTER the card's initial mount
        // animation completes (feels like a deliberate coach-mark, not a
        // glitch).
        const showT = setTimeout(() => setShowSwipeHint(true), 600);
        const hideT = setTimeout(() => {
            setShowSwipeHint(false);
            try {
                localStorage.setItem(SWIPE_HINT_SEEN_KEY, '1');
            } catch {
                /* ignore — user will just see hint again next boot */
            }
        }, 3100); // 600ms delay + 2.5s visible
        return () => {
            clearTimeout(showT);
            clearTimeout(hideT);
        };
    }, [index, activeHIdx]);

    // Dismiss the hint the moment the user scrolls horizontally — no need to
    // keep nagging them once they've discovered it.
    useEffect(() => {
        if (activeHIdx > 0 && showSwipeHint) {
            setShowSwipeHint(false);
            try {
                localStorage.setItem(SWIPE_HINT_SEEN_KEY, '1');
            } catch {
                /* ignore */
            }
        }
    }, [activeHIdx, showSwipeHint]);

    // Vertical Scroll Reset Logic
    // Horizontal Scroll Reset Logic (Inner Axis is now Horizontal)
    const horizontalScrollRef = useRef<HTMLDivElement>(null);

    // FIX V6: DERIVE THE DATE LABEL FROM THE ROW INDEX, NOT THE DATA
    //
    // Every upstream provider (WK, OM, SG) produces isoDate strings that are
    // supposed to represent the same calendar day — but the string formatting
    // differs subtly between device-tz vs location-tz vs UTC-derived paths,
    // and any one of those drifts produced a silent off-by-one on the label.
    // User reported "Fri 24 should be Sat 25 and so on" — every forecast card
    // was showing yesterday's day name.
    //
    // Since Hero.tsx guarantees rows are ordered chronologically starting from
    // today (row 0), the label can be derived purely from `index`: row 0 is
    // TODAY, row 1 is today + 1 day, row N is today + N days. Immune to any
    // isoDate/date-string bugs further up the pipeline.
    const rowDateLabel = useMemo(() => {
        if (index === 0) return 'TODAY';
        const d = new Date();
        d.setDate(d.getDate() + index);
        return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    }, [index]);
    // The same day as spoken and captioned: "Today" rather than "TODAY".
    const dayName = useMemo(() => heroRowDayName(index), [index]);
    const hoursHintId = useId();

    // Auto-scroll to slide 0 when entering essential mode (map only renders on slide 0)
    useEffect(() => {
        if (isEssentialMode && horizontalScrollRef.current) {
            horizontalScrollRef.current.scrollTo({ left: 0 });
            lastScrollIdxRef.current = 0;
            setActiveHIdx(0);
            // Force Mapbox WebGL canvas to resize after scroll settles
            // Fixes "half and half" rendering when switching from full-screen carousel
            const t1 = setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
            const t2 = setTimeout(() => window.dispatchEvent(new Event('resize')), 400);
            return () => {
                clearTimeout(t1);
                clearTimeout(t2);
            };
        }
    }, [isEssentialMode]);

    useEffect(() => {
        const handleReset = () => {
            // Reset to Start (Left)
            if (horizontalScrollRef.current) {
                horizontalScrollRef.current.scrollTo({ left: 0 });
            }
            // Sync ref and state with reset
            lastScrollIdxRef.current = 0;
            setActiveHIdx(0);
            // Also propagate the live data immediately
            if (onTimeSelect) {
                onTimeSelect(undefined); // undefined = live/now
            }
            if (onSlideIndexChange) onSlideIndexChange(0);
        };
        window.addEventListener('hero-reset-scroll', handleReset);
        return () => {
            window.removeEventListener('hero-reset-scroll', handleReset);
            // Clean up any pending rAF on unmount
            if (scrollRafRef.current) {
                // eslint-disable-next-line react-hooks/exhaustive-deps
                cancelAnimationFrame(scrollRafRef.current);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // --- RENDER LOOP PREPARATION ---
    // CRITICAL FIX: Do NOT early-return before hooks — it violates React's Rules of Hooks.
    // Instead, guard inside each hook and move the fallback UI to just before the final JSX return.

    const slides = useMemo(
        () => buildSlides(data, index, hourlyToRender, forecast, timeZone),
        [index, data, hourlyToRender, forecast, timeZone],
    );

    // Phase 2 Optimization: Pre-compute display values for all slides
    // This avoids recalculating on every scroll/render
    const slideDisplayData = useMemo(
        () =>
            slides.map((slide) => {
                const cardData = slide.data as SourcedWeatherMetrics;
                const cardTime = slide.type === 'current' ? undefined : slide.time || customTime;
                const isHourly = slide.type === 'hourly';

                const sunPhase = computeSunPhase(cardData, cardTime);
                const cardDisplayValues = computeCardDisplayValues(cardData, units, index, isHourly, isLandlocked);

                const isCardDay = !isHourly && index > 0 ? true : sunPhase.isDay;
                const cardIsLive = !isHourly && index === 0;
                const isGolden =
                    isCardDay && cardData.sunrise && cardData.sunset
                        ? isGoldenHour(cardData.sunrise, cardData.sunset)
                        : false;

                return { sunPhase, cardDisplayValues, isCardDay, cardIsLive, isHourly, cardData, cardTime, isGolden };
            }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [slides, units, isLandlocked, index],
    );
    // Always track the actively scrolled card for header updates
    const activeSlide = slides[activeHIdx] || slides[0];
    const activeCardData = activeSlide?.data as SourcedWeatherMetrics;
    const activeCardTime = activeSlide?.time || customTime;
    const activeIsLive = index === 0 && activeHIdx === 0;

    // Calculate sunPhase for the active card for the static header's background
    const activeSunPhase = computeSunPhase(activeCardData, activeCardTime);
    const _activeIsCardDay = !activeIsLive && index > 0 ? true : activeSunPhase.isDay;

    // (The static-header display values that used to be computed here were
    // dead code, and carried an invented gust — sustained × 1.3 — that must
    // not be revived. The header renders at Dashboard level from real data.)

    // Tide cards: every hourly slide is its own button, so each name carries
    // its hour and height ("08:00, 3.8 m rising — show wind versus tide")
    // instead of ~240 identical "Show wind versus tide" buttons.
    const tideExtremes = useMemo(() => byTime(tides), [tides]);
    const tideSeriesPts = useMemo(() => byTime(tideHourly), [tideHourly]);
    const tideHourFmt = useMemo(() => {
        const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false };
        try {
            return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone });
        } catch {
            return new Intl.DateTimeFormat('en-GB', opts);
        }
    }, [timeZone]);
    const tideCardLabel = (isLive: boolean, tMs: number | undefined): string => {
        const at = tMs ?? Date.now();
        // The day is part of the name: every day row has an 08:00 card.
        const when = isLive || tMs === undefined ? 'Now' : `${dayName} ${tideHourFmt.format(new Date(at))}`;
        const tide = tideAtTime(tideExtremes, tideSeriesPts, at);
        const unit = units.tideHeight || 'm';
        const height = tide ? convertMetersTo(tide.heightM, unit) : null;
        const where = tide && height !== null ? `, ${height.toFixed(1)} ${unit} ${tide.direction}` : '';
        return `${when}${where} — show wind versus tide`;
    };

    // Get source colors for static header metrics
    // Shows amber (StormGlass), emerald (Buoy), or white (forecast)
    const _getActiveSourceColor = (metricKey: keyof WeatherMetrics): string => {
        // When showing forecast data (not live), always use white
        if (!activeIsLive) {
            return 'text-white';
        }
        // Live data - check if source info is available
        const liveSources = activeCardData?.sources;
        if (!liveSources || !liveSources[metricKey]) return 'text-white';

        const sourceColor = liveSources[metricKey]?.sourceColor;
        switch (sourceColor) {
            case 'emerald':
                return 'text-emerald-400'; // Buoy
            case 'amber':
                return 'text-amber-400'; // StormGlass
            default:
                return 'text-white';
        }
    };

    // Propagate active card data changes to parent
    // CRITICAL FIX: Only the VISIBLE slide should update the parent
    // Otherwise, all day slides fire onActiveDataChange and the last one (forecast day with UV=0) wins
    useEffect(() => {
        if (onActiveDataChange && activeCardData && isVisible) {
            onActiveDataChange(activeCardData);
        }
    }, [activeCardData, onActiveDataChange, isVisible]);

    // Scroll handler to update active index - INSTANT (no throttling)
    // Performance optimization: Direct state updates for zero-latency scroll response
    const handleHorizontalScroll = useCallback(
        (e: React.UIEvent<HTMLDivElement>) => {
            const container = e.currentTarget;
            const scrollLeft = container.scrollLeft;
            const cardWidth = container.clientWidth;
            const newIdx = Math.round(scrollLeft / cardWidth);

            // Only update state if the index actually changed
            if (newIdx !== lastScrollIdxRef.current && newIdx >= 0 && newIdx < slides.length) {
                lastScrollIdxRef.current = newIdx;
                setActiveHIdx(newIdx);
                // Update hour index directly — avoids triggering Dashboard state via onTimeSelect.
                // Forecast days have the day-overview summary at slide 0, so the real hour
                // is one less than the slide index (summary + 00:00 both map to hour 0).
                if (onHourChange) {
                    onHourChange(index > 0 ? Math.max(0, newIdx - 1) : newIdx);
                }
                // RAW index too — the mapping above is lossy (see the comment).
                if (onSlideIndexChange) onSlideIndexChange(newIdx);
                // INSTANT UPDATE: Propagate active card data immediately without waiting for useEffect
                // This eliminates one render cycle delay for temp/description updates
                if (onActiveDataChange && isVisible) {
                    const newActiveData = slides[newIdx]?.data as WeatherMetrics;
                    if (newActiveData) {
                        onActiveDataChange(newActiveData);
                    }
                }
            }
        },
        [slides, onHourChange, onSlideIndexChange, onActiveDataChange, isVisible, index],
    );

    // Keyboard navigation for horizontal hour carousel
    const handleHorizontalKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!horizontalScrollRef.current) return;
        const w = horizontalScrollRef.current.clientWidth;
        if (e.key === 'ArrowRight') {
            e.preventDefault();
            horizontalScrollRef.current.scrollBy({ left: w, behavior: 'smooth' });
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            horizontalScrollRef.current.scrollBy({ left: -w, behavior: 'smooth' });
        }
    }, []);

    // Safety fallback: if data is missing, show loading state
    // This MUST be after all hooks to respect React's Rules of Hooks
    if (!data || slides.length === 0) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-gray-400">Loading weather data...</div>
            </div>
        );
    }

    // Day label above the hours: nothing else said that today's live card IS
    // today, or that a vertical swipe changes the day (UX scorecard run 6).
    // The day overview is an average over the day, so it carries no time.
    const showDayLabel = !isEssentialMode && !compact;
    // Clamped: hours drop off today's row as the clock runs, and a stale
    // index past the end must not take every slide out of the reading order.
    const shownHIdx = Math.min(activeHIdx, slides.length - 1);
    const labelSlide = slides[shownHIdx];
    const labelTimeMs =
        labelSlide?.type === 'current' ? Date.now() : labelSlide?.type === 'hourly' ? labelSlide.time : undefined;
    const dayLabelText = labelTimeMs ? `${dayName} · ${tideHourFmt.format(new Date(labelTimeMs))}` : dayName;
    // A day past the model's range still carries its hours, every value null:
    // nothing worth paging to, so no more-hours cue (Hero drops its dots too).
    const overview = slides[0]?.type === 'daily' ? slides[0].daily : undefined;
    const dayBeyondRange =
        index > 0 && !!overview && !overview.condition && !forecastDayHasWeather(overview, hourlyToRender);
    const showMoreHoursCue = !isEssentialMode && !showSwipeHint && !dayBeyondRange && shownHIdx < slides.length - 1;

    return (
        <div className="relative w-full h-full overflow-hidden">
            {showDayLabel && (
                // Hidden from VoiceOver: the carousel's name carries the day and
                // every tide card its own hour. The carousel starts below it.
                <div className="absolute top-0 inset-x-0 h-5 flex items-center pl-1 pr-8" aria-hidden="true">
                    <span className="glass-tide-caption text-xs leading-4 font-bold uppercase tracking-widest text-sky-300/80 whitespace-nowrap">
                        {dayLabelText}
                    </span>
                </div>
            )}
            {/* ========== HEADERS MOVED TO DASHBOARD LEVEL ========== */}
            {/* Header and widgets now rendered at Dashboard level for true fixed positioning */}

            {/* ========== FIRST-USE SWIPE AFFORDANCE ========== */}
            {/* Pulsing chevron on right edge of the live card teaches the
                horizontal hour carousel. Auto-dismisses after 2.5s or the
                moment the user swipes. localStorage flag ensures it only
                fires on the very first session. Pointer-events disabled so
                it never interferes with the user's own swipe. */}
            {showSwipeHint && (
                <div
                    className={`absolute ${showDayLabel ? 'top-5' : 'top-0'} bottom-0 right-0 z-50 w-16 flex items-center justify-end pr-3 pointer-events-none`}
                    style={{
                        background:
                            'linear-gradient(to right, transparent 0%, rgba(56, 189, 248, 0.08) 60%, rgba(56, 189, 248, 0.18) 100%)',
                        animation: 'swipe-hint-pulse 1.1s ease-in-out infinite',
                    }}
                    aria-hidden="true"
                >
                    <svg
                        className="w-6 h-6 text-sky-300 drop-shadow-[0_0_6px_rgba(56,189,248,0.55)]"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <polyline points="9 6 15 12 9 18" />
                    </svg>
                </div>
            )}

            {/* ========== MORE HOURS CUE ==========
                Quiet and persistent while later hours lie to the right: the
                first-run chevron above goes after one viewing, and the 24-dot
                hour row that also said so went in batch 10, so nothing did (UX
                scorecard run 9). In the card's bottom-right corner, under the
                day rail and past the tide curve's 16 pt inset. */}
            {showMoreHoursCue && (
                <div
                    data-testid="glass-more-hours"
                    className="absolute right-1 bottom-1 z-40 flex h-4 w-4 items-center justify-center pointer-events-none text-sky-300 drop-shadow-[0_0_3px_rgba(0,0,0,0.6)]"
                    aria-hidden="true"
                >
                    <svg
                        className="h-3.5 w-3.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <polyline points="9 6 15 12 9 18" />
                    </svg>
                </div>
            )}

            <span id={hoursHintId} hidden>
                Swipe left or right, or use the left and right arrow keys, to change the hour.
            </span>
            {/* ========== SCROLLABLE HORIZONTAL CAROUSEL ========== */}
            <div
                className={`absolute inset-x-0 ${showDayLabel ? 'top-5' : 'top-0'} bottom-0 overflow-y-auto overflow-x-hidden no-scrollbar`}
            >
                <div
                    ref={horizontalScrollRef}
                    onScroll={handleHorizontalScroll}
                    onKeyDown={handleHorizontalKeyDown}
                    tabIndex={0}
                    role="region"
                    aria-roledescription="carousel"
                    // 'Today, by hour': named for what it holds, with the gestures
                    // as its description. The arrow-key instruction was the name,
                    // which an iPhone VoiceOver user cannot act on (UX scorecard run 10).
                    aria-label={`${dayName}, by hour`}
                    aria-describedby={hoursHintId}
                    className={`w-full h-full ${isEssentialMode ? 'overflow-hidden' : 'overflow-x-auto snap-x snap-mandatory'} no-scrollbar flex flex-row focus:outline-hidden`}
                    style={{ willChange: 'scroll-position' }}
                >
                    {slides.map((slide, slideIdx) => {
                        // Use pre-computed display data from memoized array
                        const precomputed = slideDisplayData[slideIdx];
                        // Guard against undefined precomputed data (race condition safety)
                        if (!precomputed) return null;

                        // Day-overview landing card for forecast days (self-contained —
                        // does not touch the hourly card chrome below).
                        //
                        // NOT in essential mode. Essential collapses the whole
                        // carousel to its first slide, so on a forecast day
                        // this overview WAS that slide and the radar card the
                        // mode exists to show could never be reached — the
                        // second half of Shane's 2026-08-28 report. Falling
                        // through hands the slide to the showMapInstead branch
                        // below, which is the essential slot proper.
                        if (slide.type === 'daily' && slide.daily && !showMapInstead) {
                            const d = slide.daily;
                            // Past the pinned model's range the provider still sends the
                            // day and its hours, every value null — so "no hourly frames"
                            // missed it and the card was a grid of dashes (run 6).
                            const beyondRange = index > 0 && !d.condition && !forecastDayHasWeather(d, hourlyToRender);
                            const hasWave = !isLandlocked && d.waveHeight !== null && d.waveHeight !== undefined;
                            const caption = horizonCaption(forecastRange);
                            return (
                                <div
                                    key={slideIdx}
                                    ref={(el) => setSlideInert(el, slideIdx !== shownHIdx, horizontalScrollRef.current)}
                                    aria-hidden={slideIdx !== shownHIdx || undefined}
                                    // overflow-hidden + min-h-0: the daily card must NOT make the
                                    // parent's overflow-y-auto scrollable, or it captures the
                                    // up/down day-swipe and the snap "bounces" (regression fix).
                                    // No bottom padding: the 16 pt it kept was the band of the
                                    // hour dots (gone since batch 10), a 20 pt gap under the card
                                    // where daylight drew a square shadow slab (UX scorecard
                                    // run 9). Dashboard's hero bottom now carries the 8 pt gap.
                                    className="w-full h-full min-h-0 overflow-hidden snap-start snap-always shrink-0 relative flex flex-col"
                                >
                                    {/* Framed like every other Glass slide: it used to float
                                        unframed on black (UX scorecard run 6). No outer
                                        shadow: the carousel clips it square, so by day it
                                        drew grey corners outside the rounded card (run 9). */}
                                    <div className="relative flex-1 min-h-0 w-full rounded-2xl overflow-hidden border border-white/8 bg-white/4">
                                        {beyondRange && !hasWave && !d.tideSummary ? (
                                            <ForecastHorizonCard
                                                dateLabel={rowDateLabel}
                                                caption={caption}
                                                // Not on a 667 pt phone: the hero above already
                                                // names the day, and in the ~95 pt card the
                                                // heading and button were cut (run 9). The reason
                                                // is said here only (run 10).
                                                showDateHeading={!showDayLabel && !compact}
                                                onChooseModel={
                                                    forecastRange?.modelLabel ? openGlassModelPicker : undefined
                                                }
                                            />
                                        ) : (
                                            <DailySummaryCard
                                                daily={slide.daily}
                                                units={units}
                                                isLandlocked={isLandlocked}
                                                dateLabel={rowDateLabel}
                                                showDateHeading={!showDayLabel}
                                                note={beyondRange ? caption : undefined}
                                            />
                                        )}
                                    </div>
                                </div>
                            );
                        }

                        const {
                            sunPhase: _sunPhase,
                            cardDisplayValues,
                            isCardDay,
                            cardIsLive,
                            isHourly: _isHourly,
                            cardData,
                            cardTime,
                            isGolden,
                        } = precomputed;
                        // Gate chart rendering: only render Recharts for the visible day slide
                        // Off-screen day slides don't render charts (prevents width(-1) warnings)
                        // NOTE: Do NOT gate on horizontal card proximity (activeHIdx) — that causes
                        // TideGraph to unmount/remount on every scroll frame, producing flicker.
                        const shouldRenderChart = isVisible;
                        const _forceLabel = rowDateLabel;

                        // Helper to get source color for card metrics (kept inline as it's lightweight)
                        const cardSources = cardData.sources;
                        const _getCardSourceColor = (metricKey: keyof WeatherMetrics): string => {
                            // Only show source colors on the live/current card (index 0)
                            // All forecast cards should be white since they're all from StormGlass
                            if (!cardIsLive) return 'text-white';
                            if (!cardSources || !cardSources[metricKey]) return 'text-white';
                            const sourceColor = cardSources[metricKey]?.sourceColor;
                            switch (sourceColor) {
                                case 'emerald':
                                    return 'text-emerald-400'; // Buoy
                                case 'amber':
                                    return 'text-amber-400'; // StormGlass
                                default:
                                    return 'text-white'; // Fallback
                            }
                        };

                        // Determine Widgets to Show (Hourly might have different needs, but keeping same for now)
                        // Mega Sub Card Logic:
                        // If showTideGraph is true, we show the Grid + Tide Graph
                        // If false, we show the 3-column simple grid

                        // Once per slide, not once per radar-card call site.
                        const windDirDeg =
                            typeof data.windDirection === 'number'
                                ? data.windDirection
                                : (cardinalToDegrees(data.windDirection) ?? null);

                        return (
                            <div
                                key={slideIdx}
                                // Off-screen hours leave the reading order: ~250 tide
                                // buttons and 200 copies of the tides notice used to be
                                // exposed at once (UX scorecard run 6).
                                ref={(el) => setSlideInert(el, slideIdx !== shownHIdx, horizontalScrollRef.current)}
                                aria-hidden={slideIdx !== shownHIdx || undefined}
                                // No bottom padding (see the day overview above).
                                className="w-full h-full snap-start snap-always shrink-0 relative flex flex-col"
                            >
                                {showMapInstead && showAnchorView ? (
                                    // Anchor deployed → radar-style anchor watch view
                                    // replaces the map in the essential slot. Only
                                    // renders on the live (today, slideIdx 0) card
                                    // so forecast days still show the map — the
                                    // anchor view is "right now", not "tomorrow at
                                    // 1400".
                                    //
                                    // `slideIdx === 0` alone did not say that:
                                    // every day row has a slide 0, so with the
                                    // anchor down Thursday's card claimed to be
                                    // an anchor watch. Both indices, or neither.
                                    index === 0 && slideIdx === 0 ? (
                                        <EssentialAnchorView
                                            windSpeed={data.windSpeed}
                                            windDirection={data.windDirection}
                                            windGust={data.windGust}
                                            speedUnit={units.speed || 'kts'}
                                            hourlyForecast={hourly}
                                        />
                                    ) : (
                                        <EssentialMapSlide
                                            slideIdx={slideIdx}
                                            isGolden={isGolden}
                                            isCardDay={isCardDay}
                                            isForecastDay={index > 0}
                                            forecastDayLabel={rowDateLabel}
                                            coordinates={coordinates}
                                            windSpeed={data.windSpeed}
                                            windDirection={windDirDeg}
                                            windGust={data.windGust}
                                            condition={data.condition}
                                            units={units}
                                            onMapTap={navigateToMap}
                                        />
                                    )
                                ) : showMapInstead ? (
                                    <EssentialMapSlide
                                        slideIdx={slideIdx}
                                        isGolden={isGolden}
                                        isCardDay={isCardDay}
                                        isForecastDay={index > 0}
                                        forecastDayLabel={rowDateLabel}
                                        coordinates={coordinates}
                                        windSpeed={data.windSpeed}
                                        windDirection={windDirDeg}
                                        windGust={data.windGust}
                                        condition={data.condition}
                                        units={units}
                                        onMapTap={navigateToMap}
                                    />
                                ) : showTideGraph ? (
                                    /* COASTAL LAYOUT — widgets above card, tide inside card */
                                    <div className="relative w-full h-full flex flex-col gap-2">
                                        {/* Tide Graph Card — 2/3 of space. A button only while the
                                            graph shows: the wind-vs-tide face carries its own controls,
                                            and a button may not contain buttons. */}
                                        <div
                                            data-wind-tide-card
                                            onClick={
                                                showWindVsTide
                                                    ? undefined
                                                    : () => {
                                                          windTideFocusTargetRef.current = null;
                                                          setShowWindVsTide(true);
                                                      }
                                            }
                                            role={showWindVsTide ? undefined : 'button'}
                                            tabIndex={showWindVsTide ? undefined : 0}
                                            aria-label={
                                                showWindVsTide ? undefined : tideCardLabel(cardIsLive, cardTime)
                                            }
                                            onKeyDown={(e) => {
                                                if (showWindVsTide) return;
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    windTideFocusTargetRef.current = e.currentTarget;
                                                    setShowWindVsTide(true);
                                                }
                                            }}
                                            title={showWindVsTide ? undefined : 'Tap for wind vs tide'}
                                            // No outer shadow, as the day overview: clipped square
                                            // by the carousel, it was the daylight slab (run 9).
                                            className={`relative flex-2 min-h-0 w-full rounded-2xl overflow-hidden border bg-white/4 ${showWindVsTide ? '' : 'cursor-pointer'} ${isGolden ? 'border-amber-400/15' : isCardDay ? 'border-white/8' : 'border-sky-300/8'}`}
                                        >
                                            {/* BG Gradient — golden hour amber tinge */}
                                            <div className="absolute inset-0 z-0 pointer-events-none">
                                                <div
                                                    className={`absolute inset-0 bg-linear-to-br ${isGolden ? 'from-amber-500/10 via-amber-300/4 to-amber-500/6' : isCardDay ? 'from-sky-500/6 via-transparent to-sky-500/4' : 'from-sky-500/8 via-transparent to-purple-500/4'}`}
                                                />
                                            </div>
                                            <div className="relative w-full h-full">
                                                {showWindVsTide ? (
                                                    <WindVsTideView
                                                        tideSeries={tideHourly}
                                                        now={{
                                                            windDeg: cardData.windDegree,
                                                            windKts: cardData.windSpeed,
                                                            currentDir: cardData.currentDirection,
                                                            currentKts: cardData.currentSpeed,
                                                        }}
                                                        nowMs={cardTime || Date.now()}
                                                        floodDirection={floodDirection}
                                                        onSetFloodDirection={(deg) => {
                                                            void updateSettings({ tideFloodDirection: deg });
                                                        }}
                                                        units={units}
                                                        onClose={(event) => {
                                                            windTideFocusTargetRef.current =
                                                                event.detail === 0
                                                                    ? event.currentTarget.closest<HTMLDivElement>(
                                                                          '[data-wind-tide-card]',
                                                                      )
                                                                    : null;
                                                            setShowWindVsTide(false);
                                                        }}
                                                    />
                                                ) : shouldRenderChart ? (
                                                    <TideGraph
                                                        // Keeps captions and curve clear of Hero's day
                                                        // pager rail, drawn over this card's right edge.
                                                        reserveRightPx={16}
                                                        tides={tides || []}
                                                        unit={units.tideHeight || 'm'}
                                                        timeZone={timeZone}
                                                        hourlyTides={[]}
                                                        tideSeries={tideHourly}
                                                        modelUsed="WorldTides"
                                                        unitPref={units}
                                                        customTime={cardTime}
                                                        showAllDayEvents={index > 0 && !cardTime}
                                                        stationName={guiDetails?.stationName || 'Local Station'}
                                                        secondaryStationName={guiDetails?.stationName}
                                                        guiDetails={guiDetails}
                                                        stationPosition="bottom"
                                                        className="h-full w-full"
                                                        style={{ height: '100%', width: '100%' }}
                                                    />
                                                ) : (
                                                    <div className="h-full w-full" />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ) : tidesExpectedButMissing && !showMapInstead ? (
                                    /* COASTAL BUT TIDES UNAVAILABLE — graceful degradation */
                                    <div className="relative w-full h-full flex flex-col gap-2">
                                        <div
                                            className={`relative flex-2 min-h-0 w-full rounded-2xl overflow-hidden border bg-white/3 ${isGolden ? 'border-amber-400/12' : isCardDay ? 'border-white/6' : 'border-sky-300/6'}`}
                                        >
                                            {/* On a short phone the card is ~84 pt: the badge
                                                goes and the gaps close, or the message spilled
                                                out of both ends of the card (UX scorecard run 7). */}
                                            <div
                                                className={`flex flex-col items-center justify-center h-full ${compact ? 'gap-1' : 'gap-3'} px-6 text-center`}
                                            >
                                                {!compact && (
                                                    <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                                                        <WaveIcon className="w-5 h-5 text-amber-400" />
                                                    </div>
                                                )}
                                                {/* A sentence, so sentence case, not tracked
                                                    capitals (UX scorecard run 9). */}
                                                <p className="text-sm font-semibold text-amber-400/90">
                                                    Tides temporarily unavailable
                                                </p>
                                                <p className="text-xs text-white/60 leading-snug max-w-[260px]">
                                                    The tide service isn’t answering. Tides come back on the next
                                                    refresh.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    /* INLAND / OFFSHORE LAYOUT — 3×2 instrument panel matching HeroWidgets */
                                    <div className="relative w-full h-full flex flex-col gap-2">
                                        <div className="relative flex-2 min-h-0 w-full rounded-xl overflow-hidden bg-white/8 border border-white/15 shadow-2xl flex flex-col">
                                            {(() => {
                                                const OFFSHORE_WIDGETS = [
                                                    {
                                                        id: 'waterTemperature',
                                                        label: 'WATER',
                                                        icon: <ThermometerIcon className="w-3 h-3" />,
                                                        headingColor: 'text-sky-400',
                                                        labelColor: 'text-sky-300',
                                                    },
                                                    {
                                                        id: 'currentSpeed',
                                                        label: 'DRIFT',
                                                        icon: <GaugeIcon className="w-3 h-3" />,
                                                        headingColor: 'text-purple-400',
                                                        labelColor: 'text-purple-300',
                                                    },
                                                    {
                                                        id: 'currentDirection',
                                                        label: 'SET',
                                                        icon: <CompassIcon rotation={0} className="w-3 h-3" />,
                                                        headingColor: 'text-purple-400',
                                                        labelColor: 'text-purple-300',
                                                    },
                                                    {
                                                        id: 'cape',
                                                        label: 'CAPE',
                                                        icon: <CloudIcon className="w-3 h-3" />,
                                                        headingColor: 'text-amber-400',
                                                        labelColor: 'text-amber-300',
                                                    },
                                                    {
                                                        id: 'secondarySwellHeight',
                                                        label: 'SWELL 2',
                                                        icon: <WaveIcon className="w-3 h-3" />,
                                                        headingColor: 'text-cyan-400',
                                                        labelColor: 'text-cyan-300',
                                                        dirDeg: cardData.swellDirection
                                                            ? cardinalToDegrees(cardData.swellDirection)
                                                            : null,
                                                    },
                                                    {
                                                        id: 'secondarySwellPeriod',
                                                        label: 'PER. 2',
                                                        icon: <GaugeIcon className="w-3 h-3" />,
                                                        headingColor: 'text-cyan-400',
                                                        labelColor: 'text-cyan-300',
                                                        dirDeg: cardData.swellDirection
                                                            ? cardinalToDegrees(cardData.swellDirection)
                                                            : null,
                                                    },
                                                ];
                                                const INLAND_WIDGETS = [
                                                    {
                                                        id: 'humidity',
                                                        label: 'HUM',
                                                        icon: <DropletIcon className="w-3 h-3" />,
                                                        headingColor: 'text-sky-400',
                                                        labelColor: 'text-sky-300',
                                                    },
                                                    {
                                                        id: 'uv',
                                                        label: 'UV',
                                                        icon: <SunIcon className="w-3 h-3" />,
                                                        headingColor: 'text-amber-400',
                                                        labelColor: 'text-amber-300',
                                                    },
                                                    {
                                                        id: 'precip',
                                                        label: 'RAIN',
                                                        icon: <DropletIcon className="w-3 h-3" />,
                                                        headingColor: 'text-sky-400',
                                                        labelColor: 'text-sky-300',
                                                    },
                                                    {
                                                        id: 'pressure',
                                                        label: 'BARO',
                                                        icon: <GaugeIcon className="w-3 h-3" />,
                                                        headingColor: 'text-emerald-400',
                                                        labelColor: 'text-emerald-300',
                                                    },
                                                    {
                                                        id: 'visibility',
                                                        label: 'VIS',
                                                        icon: <EyeIcon className="w-3 h-3" />,
                                                        headingColor: 'text-emerald-400',
                                                        labelColor: 'text-emerald-300',
                                                    },
                                                    {
                                                        id: 'dew',
                                                        label: 'DEW',
                                                        icon: <ThermometerIcon className="w-3 h-3" />,
                                                        headingColor: 'text-emerald-400',
                                                        labelColor: 'text-emerald-300',
                                                    },
                                                ];
                                                const hasMarineMetrics =
                                                    cardData &&
                                                    cardData.waterTemperature !== null &&
                                                    cardData.waterTemperature !== undefined;
                                                // Offshore: ALWAYS show marine widgets (show '--' for missing data rather than switching widget sets)
                                                const widgets =
                                                    locationType === 'inland' || isLandlocked
                                                        ? INLAND_WIDGETS
                                                        : locationType === 'offshore'
                                                          ? OFFSHORE_WIDGETS
                                                          : (locationType === 'coastal' ||
                                                                  locationType === 'inshore') &&
                                                              !hasMarineMetrics
                                                            ? INLAND_WIDGETS
                                                            : OFFSHORE_WIDGETS;

                                                const getVal = (id: string): string | number => {
                                                    switch (id) {
                                                        case 'humidity':
                                                            return cardDisplayValues.humidity;
                                                        case 'uv':
                                                            return cardDisplayValues.uv;
                                                        case 'precip':
                                                            return cardDisplayValues.precip;
                                                        case 'pressure':
                                                            return cardDisplayValues.pressure;
                                                        case 'visibility':
                                                            return cardDisplayValues.vis;
                                                        case 'dew':
                                                            return cardDisplayValues.dewPoint;
                                                        case 'waterTemperature':
                                                            return cardDisplayValues.waterTemperature;
                                                        case 'currentSpeed':
                                                            return cardDisplayValues.currentSpeed;
                                                        case 'currentDirection':
                                                            return cardDisplayValues.currentDirection;
                                                        case 'cape':
                                                            return cardDisplayValues.cape;
                                                        case 'secondarySwellHeight':
                                                            return cardDisplayValues.secondarySwellHeight;
                                                        case 'secondarySwellPeriod':
                                                            return cardDisplayValues.secondarySwellPeriod;
                                                        default:
                                                            return '--';
                                                    }
                                                };
                                                const getUnit = (id: string): string => {
                                                    switch (id) {
                                                        case 'humidity':
                                                            return '%';
                                                        case 'precip':
                                                            return cardDisplayValues.precipUnit || '%';
                                                        case 'visibility':
                                                            return units.visibility || 'nm';
                                                        case 'dew':
                                                            return `°${units.temp || 'C'}`;
                                                        case 'waterTemperature':
                                                            return `°${units.temp || 'C'}`;
                                                        case 'currentSpeed':
                                                            return 'kts';
                                                        case 'secondarySwellHeight':
                                                            return 'ft';
                                                        case 'secondarySwellPeriod':
                                                            return 's';
                                                        default:
                                                            return '';
                                                    }
                                                };

                                                return (
                                                    <MetricGridPanel
                                                        widgets={widgets}
                                                        getValue={getVal}
                                                        getUnit={getUnit}
                                                    />
                                                );
                                            })()}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

// Wrap with React.memo for performance - prevents re-renders when props haven't changed
export const HeroSlide = React.memo(HeroSlideComponent);
