/**
 * @filesize-justified Single React.memo component — monolithic render with no natural sub-component boundaries.
 */
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
import {
    convertTemp,
    convertSpeed,
    convertLength,
    convertDistance,
    degreesToCardinal,
    cardinalToDegrees,
} from '../../utils';

import { MetricGridPanel } from './hero/MetricGridPanel';
import { useWeather } from '../../context/WeatherContext';
import { MinutelyRain } from '../../services/weather/api/weatherkit';

import { isGoldenHour } from '../../utils/goldenHour';
import { EssentialMapSlide } from './hero/EssentialMapSlide';
import { EssentialAnchorView } from './hero/EssentialAnchorView';
import { AnchorWatchService, type AnchorWatchSnapshot } from '../../services/AnchorWatchService';
import { computeSunPhase, computeCardDisplayValues, buildSlides } from './hero/heroSlideHelpers';
import { DailySummaryCard } from './hero/DailySummaryCard';
import { WindVsTideView } from './tide/WindVsTideView';
import { useSettingsStore } from '../../stores/settingsStore';

// Stable fallback: `weatherData?.forecast || []` minted a fresh array on every
// render when forecast was absent, defeating the `slides` useMemo below.
const EMPTY_FORECAST: ForecastDay[] = [];

// --- HERO SLIDE COMPONENT (Individual Day Card) ---
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
}) => {
    const { weatherData } = useWeather();
    const forecast = weatherData?.forecast ?? EMPTY_FORECAST;

    // 1. STATE HOISTING (Zero-Latency Architecture)
    // We define the scroll state AT THE TOP so it drives the entire component synchronously.
    const [activeHIdx, setActiveHIdx] = useState(0);
    // Tide graph ↔ wind-vs-tide flip (single press on the tide card toggles).
    const [showWindVsTide, setShowWindVsTide] = useState(false);
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

    // Calculate display values for static widgets based on activeCardData
    // These values will update if dynamicHeaderMetrics is enabled
    const hasActiveWind = activeCardData?.windSpeed !== null && activeCardData?.windSpeed !== undefined;
    const rawActiveGust = activeCardData?.windGust || (activeCardData?.windSpeed || 0) * 1.3;
    const hasActiveWave = activeCardData?.waveHeight !== null && activeCardData?.waveHeight !== undefined;

    const _staticDisplayValues = {
        airTemp:
            activeCardData?.airTemperature !== null
                ? convertTemp(activeCardData?.airTemperature || 0, units.temp)
                : '--',
        windSpeed: hasActiveWind ? Math.round(convertSpeed(activeCardData.windSpeed!, units.speed)!) : '--',
        waveHeight: isLandlocked
            ? '0'
            : hasActiveWave
              ? String(convertLength(activeCardData.waveHeight, units.length))
              : '--',
        vis: activeCardData?.visibility ? convertDistance(activeCardData.visibility, units.visibility || 'nm') : '--',
        gusts: hasActiveWind ? Math.round(convertSpeed(rawActiveGust!, units.speed)!) : '--',
        pressure: activeCardData?.pressure ? Math.round(activeCardData.pressure) : '--',
        uv:
            activeCardData?.uvIndex !== undefined && activeCardData?.uvIndex !== null
                ? Math.round(activeCardData.uvIndex)
                : '--',
        humidity:
            activeCardData?.humidity !== undefined && activeCardData?.humidity !== null
                ? Math.round(activeCardData.humidity)
                : '--',
        waterTemperature:
            activeCardData?.waterTemperature !== undefined && activeCardData?.waterTemperature !== null
                ? convertTemp(activeCardData.waterTemperature, units.temp)
                : '--',
        currentSpeed:
            activeCardData?.currentSpeed !== undefined && activeCardData?.currentSpeed !== null
                ? Number(activeCardData.currentSpeed).toFixed(1)
                : '--',
        currentDirection: (() => {
            const val = activeCardData?.currentDirection;
            if (typeof val === 'number') return degreesToCardinal(val);
            if (typeof val === 'string') return val.replace(/[\d.°]+/g, '').trim() || val;
            return '--';
        })(),
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

    return (
        <div className="relative w-full h-full overflow-hidden">
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
                    className="absolute inset-y-0 right-0 z-50 w-16 flex items-center justify-end pr-3 pointer-events-none"
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

            {/* ========== SCROLLABLE HORIZONTAL CAROUSEL ========== */}
            <div className="absolute inset-0 overflow-y-auto overflow-x-hidden no-scrollbar">
                <div
                    ref={horizontalScrollRef}
                    onScroll={handleHorizontalScroll}
                    onKeyDown={handleHorizontalKeyDown}
                    tabIndex={0}
                    role="region"
                    aria-roledescription="carousel"
                    aria-label="Hourly forecast carousel — use left and right arrow keys to navigate between hours"
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
                            return (
                                <div
                                    key={slideIdx}
                                    // overflow-hidden + min-h-0: the daily card must NOT make the
                                    // parent's overflow-y-auto scrollable, or it captures the
                                    // up/down day-swipe and the snap "bounces" (regression fix).
                                    className="w-full h-full min-h-0 overflow-hidden snap-start snap-always shrink-0 relative pb-4 flex flex-col"
                                >
                                    <DailySummaryCard
                                        daily={slide.daily}
                                        units={units}
                                        isLandlocked={isLandlocked}
                                        dateLabel={rowDateLabel}
                                    />
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

                        return (
                            <div
                                key={slideIdx}
                                className="w-full h-full snap-start snap-always shrink-0 relative pb-4 flex flex-col"
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
                                            coordinates={coordinates}
                                            windSpeed={data.windSpeed}
                                            windDirection={
                                                typeof data.windDirection === 'number'
                                                    ? data.windDirection
                                                    : (cardinalToDegrees(data.windDirection) ?? null)
                                            }
                                            windGust={data.windGust}
                                            condition={data.condition}
                                            units={units}
                                            onMapTap={() => {
                                                window.dispatchEvent(
                                                    new CustomEvent('thalassa:navigate', {
                                                        detail: { tab: 'map' },
                                                    }),
                                                );
                                            }}
                                        />
                                    )
                                ) : showMapInstead ? (
                                    <EssentialMapSlide
                                        slideIdx={slideIdx}
                                        isGolden={isGolden}
                                        isCardDay={isCardDay}
                                        isForecastDay={index > 0}
                                        coordinates={coordinates}
                                        windSpeed={data.windSpeed}
                                        windDirection={
                                            typeof data.windDirection === 'number'
                                                ? data.windDirection
                                                : (cardinalToDegrees(data.windDirection) ?? null)
                                        }
                                        windGust={data.windGust}
                                        condition={data.condition}
                                        units={units}
                                        onMapTap={() => {
                                            window.dispatchEvent(
                                                new CustomEvent('thalassa:navigate', { detail: { tab: 'map' } }),
                                            );
                                        }}
                                    />
                                ) : showTideGraph ? (
                                    /* COASTAL LAYOUT — widgets above card, tide inside card */
                                    <div className="relative w-full h-full flex flex-col gap-2">
                                        {/* Tide Graph Card — 2/3 of space. A button only while the
                                            graph shows: the wind-vs-tide face carries its own controls,
                                            and a button may not contain buttons. */}
                                        <div
                                            onClick={() => setShowWindVsTide((v) => !v)}
                                            role={showWindVsTide ? undefined : 'button'}
                                            tabIndex={showWindVsTide ? undefined : 0}
                                            aria-label={showWindVsTide ? undefined : 'Show wind versus tide'}
                                            onKeyDown={(e) => {
                                                if (showWindVsTide) return;
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                    e.preventDefault();
                                                    setShowWindVsTide(true);
                                                }
                                            }}
                                            title="Tap for wind vs tide"
                                            className={`relative flex-2 min-h-0 w-full rounded-2xl overflow-hidden border bg-white/4 shadow-[0_0_30px_-5px_rgba(0,0,0,0.3)] cursor-pointer ${isGolden ? 'border-amber-400/15' : isCardDay ? 'border-white/8' : 'border-sky-300/8'}`}
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
                                                        hourly={hourly}
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
                                                        onClose={() => setShowWindVsTide(false)}
                                                    />
                                                ) : shouldRenderChart ? (
                                                    <TideGraph
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
                                            <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
                                                <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                                                    <span className="text-lg">🌊</span>
                                                </div>
                                                <p className="text-xs font-semibold text-amber-400/80 uppercase tracking-widest">
                                                    Tides Temporarily Unavailable
                                                </p>
                                                <p className="text-[11px] text-white/60 leading-relaxed max-w-[200px]">
                                                    Tide data source is currently unreachable. Data will restore
                                                    automatically on next refresh.
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
                                                        label: 'HPA',
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
