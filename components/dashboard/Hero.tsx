import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';

// PERF: Refs used to keep handler closures stable while accessing latest callbacks

import { HeroSlide } from './HeroSlide';
import { HeroSlideSkeleton } from './Skeletons';
import {
    UnitPreferences,
    WeatherMetrics,
    ForecastDay,
    VesselProfile,
    Tide,
    TidePoint,
    HourlyForecast,
} from '../../types';
import { MinutelyRain } from '../../services/weather/api/weatherkit';
import { TideGUIDetails } from '../../services/weather/api/tides';
import { useSettings } from '../../context/SettingsContext';
import { forecastDayHasWeather, heroRowDayName, horizonCaption, setSlideInert } from './hero/heroSlideHelpers';
import type { GlassForecastRange } from './hero/heroSlideHelpers';

/** What the page around the carousel needs to know about the day on screen. */
export interface ShownGlassDay {
    /** The day has hours to swipe through (today always does). */
    hasHours: boolean;
    /** Why this day's numbers are missing, or null when it has a forecast. */
    rangeNote: string | null;
}

export const HeroSection = ({
    current,
    forecasts,
    units,
    generatedAt,
    vessel,
    modelUsed,
    groundingSource,
    isLandlocked,
    locationName,
    tides,
    tideHourly,
    timeZone,
    hourly,
    className,
    lat,
    coordinates,
    guiDetails,
    locationType,
    onTimeSelect,
    customTime,
    utcOffset,
    onDayChange,
    onHourChange,
    onSlideIndexChange,
    onActiveDataChange,
    isEssentialMode,
    minutelyRain,
    forecastModelLabel = null,
    compact = false,
    onShownDayChange,
}: {
    current: WeatherMetrics;
    forecasts: ForecastDay[];
    units: UnitPreferences;
    generatedAt: string;
    vessel?: VesselProfile;
    modelUsed?: string;
    groundingSource?: string;
    isLandlocked?: boolean;
    locationName?: string;
    tides?: Tide[];
    tideHourly?: TidePoint[];
    timeZone?: string;
    hourly?: HourlyForecast[];
    className?: string;
    lat?: number;
    guiDetails?: TideGUIDetails;
    coordinates?: { lat: number; lon: number };
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland';
    onTimeSelect?: (time: number | undefined) => void;
    customTime?: number;
    utcOffset?: number;
    onDayChange?: (day: number) => void;
    onHourChange?: (hour: number) => void;
    /** Raw carousel index of the focused slide — see HeroSlide's prop docs. */
    onSlideIndexChange?: (idx: number) => void;
    onActiveDataChange?: (data: WeatherMetrics) => void;
    isEssentialMode?: boolean;
    minutelyRain?: MinutelyRain[];
    /** The pinned model's pill label ("ICON"); null for Auto. Names the model
     *  whose range a far day is past. */
    forecastModelLabel?: string | null;
    /** Short viewport: the slides drop their day label row. */
    compact?: boolean;
    /** Reports the shown day to the chrome outside the carousel: whether it
     *  has any hours to page through, and — past the pinned model's range —
     *  the caption that explains its empty grid. */
    onShownDayChange?: (day: ShownGlassDay) => void;
}) => {
    const { settings, updateSettings } = useSettings();
    const [activeIndex, setActiveIndex] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const activeIndexRef = useRef(0);

    // PERF FIX: Store callback refs so handler closures are stable across renders
    const onTimeSelectRef = useRef(onTimeSelect);
    const onHourChangeRef = useRef(onHourChange);
    onTimeSelectRef.current = onTimeSelect;
    onHourChangeRef.current = onHourChange;

    // Construct rows: TODAY (live card) + future forecast days
    const dayRows = useMemo(() => {
        const rows: {
            data: WeatherMetrics;
            hourly: HourlyForecast[];
            customTime: number | undefined;
            /** The day carries at least one real weather number. */
            hasWeather: boolean;
        }[] = [];

        // Compute today's ISO date in the location's timezone (handles UTC offset edge cases)
        const tz = timeZone || undefined;
        const now = new Date();
        const todayISO = now.toLocaleDateString('en-CA', { timeZone: tz });
        // WeatherKit cached data may have yesterday's UTC date for today's local date
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayISO = yesterday.toLocaleDateString('en-CA', { timeZone: tz });

        // ROW 0: TODAY (Live Card) — uses current conditions + today's hourly data
        // Find today's daily forecast to merge high/low/sunrise/sunset
        let todayForecast: ForecastDay | undefined = undefined;
        if (forecasts && forecasts.length > 0) {
            todayForecast = forecasts.find((f, fIdx) => {
                const fDate = f.isoDate || f.date;
                if (fDate && fDate === todayISO) return true;
                // UTC offset match: first entry with yesterday's UTC date = today local
                if (fDate && fDate === yesterdayISO && fIdx === 0) return true;
                return false;
            });
        }

        // Bucket the hourly array by local calendar day ONCE.
        //
        // Every row used to re-filter the whole array, constructing a fresh
        // Intl.DateTimeFormat per hour per row (toLocaleDateString does that
        // internally) — 11 rows x ~240 hours on a 10-day forecast. One pass
        // with one reused formatter gives byte-identical buckets: filter
        // preserves order, and Intl.DateTimeFormat('en-CA', { timeZone })
        // .format(d) yields the same YYYY-MM-DD string toLocaleDateString does.
        const hourlyByDay = new Map<string, HourlyForecast[]>();
        if (hourly && Array.isArray(hourly) && hourly.length > 0) {
            const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone });
            for (const h of hourly) {
                if (!h || !h.time) continue;
                const when = new Date(h.time);
                if (Number.isNaN(when.getTime())) continue;
                const key = dayKey.format(when);
                const bucket = hourlyByDay.get(key);
                if (bucket) bucket.push(h);
                else hourlyByDay.set(key, [h]);
            }
        }

        // Build today's hourly
        const todayHourly: HourlyForecast[] = hourlyByDay.get(todayISO) ?? [];

        // merge of WeatherMetrics + ForecastDay with null/undefined mismatch
        const todayMetrics: Record<string, unknown> = {
            ...(todayForecast || {}), // Daily forecast base (high/low/sunrise/sunset)
            ...current, // Real-time observation data WINS over forecast nulls
            // Explicitly pull daily-only fields from the forecast
            highTemp: todayForecast?.highTemp ?? current.highTemp,
            lowTemp: todayForecast?.lowTemp ?? current.lowTemp,
            sunrise: todayForecast?.sunrise ?? (current as WeatherMetrics & { sunrise?: string }).sunrise,
            sunset: todayForecast?.sunset ?? (current as WeatherMetrics & { sunset?: string }).sunset,
            // Lock row 0's identity: the "TODAY" label in HeroSlide reads
            // `displayData.isoDate`, so anchor it to the real local date.
            // Without this, row 0 can inherit yesterday's isoDate via the
            // todayForecast spread (when WK assigns yesterday's UTC date to
            // the "today-local" entry) and we end up with two rows whose
            // isoDate equals the same calendar day.
            isoDate: todayISO,
            date: todayISO,
        };
        rows.push({
            data: todayMetrics as unknown as WeatherMetrics,
            hourly: todayHourly,
            customTime: undefined, // Live — uses new Date() for "now" line
            hasWeather: true, // Live conditions — never "past the range"
        });

        // ROWS 1+: Future forecast days (skip today, de-dupe, cap at 10 total)
        //
        // Previously we compared each `f.isoDate` against `todayISO`/`yesterdayISO`
        // string-equality. That held up when every provider agreed on the
        // location-tz isoDate format, but the StormGlass transformer generates
        // isoDate from the device-local tz (`new Date(h.time).toLocaleDateString('en-CA')`
        // with no timeZone option), while Hero computes todayISO in the
        // *location* tz. On a boat near a tz boundary — or any user whose
        // device tz differs from the location tz — the two strings disagreed
        // for the exact same calendar day and today slipped through the filter,
        // producing a second "today" row labelled with the date (e.g. "Fri, 24 Apr").
        //
        // New approach: dedupe by isoDate using a Set that's pre-seeded with
        // todayISO and yesterdayISO. Any entry whose isoDate collides with a
        // previously-added row is skipped. This is robust against cross-tz
        // drift, duplicate forecast entries, and providers that front-load
        // today into the array.
        if (forecasts && forecasts.length > 0) {
            const seenIsoDates = new Set<string>([todayISO, yesterdayISO]);
            // Sort chronologically by isoDate so the carousel always reads
            // left-to-right from nearest to furthest, regardless of provider
            // ordering quirks.
            const sortedForecasts = [...forecasts]
                .filter((f) => !!(f.isoDate || f.date))
                .sort((a, b) => {
                    const aDate = String(a.isoDate || a.date);
                    const bDate = String(b.isoDate || b.date);
                    return aDate.localeCompare(bDate);
                });
            sortedForecasts.forEach((f) => {
                const fDate = f.isoDate || f.date;
                if (!fDate) return;
                if (seenIsoDates.has(fDate)) return; // skip today + already-emitted
                seenIsoDates.add(fDate);

                const targetDate = f.isoDate;
                const dayHourly: HourlyForecast[] = targetDate ? (hourlyByDay.get(targetDate) ?? []) : [];

                // merge of WeatherMetrics + ForecastDay
                // Observation-only fields start as null so a forecast day never
                // wears today's pressure, humidity, visibility or sea state; the
                // day's own values (spread after) win where the forecast has them.
                const metrics: Record<string, unknown> = {
                    ...current,
                    pressure: null,
                    humidity: null,
                    visibility: null,
                    cloudCover: null,
                    dewPoint: null,
                    uvIndex: null,
                    precipitation: null,
                    swellPeriod: null,
                    swellDirection: undefined,
                    waterTemperature: null,
                    currentSpeed: null,
                    currentDirection: undefined,
                    ...f,
                    condition: f.condition,
                };
                rows.push({
                    data: metrics as unknown as WeatherMetrics,
                    hourly: dayHourly,
                    customTime: undefined,
                    // From the forecast day itself, not `metrics`: that spreads
                    // today's live wind underneath, which would pass for a number.
                    hasWeather: forecastDayHasWeather(f, dayHourly),
                });
            });
        }
        // Cap at 11 rows total (Today + up to 10 future days). WeatherKit's
        // daily forecast returns 10 days; the weather service extends the tail
        // with Open-Meteo (up to 16) so a full 10 days in advance are available.
        return rows.slice(0, 11);
    }, [current, forecasts, hourly, timeZone]);

    const handleScroll = useCallback(
        (e: React.UIEvent<HTMLDivElement>) => {
            const y = e.currentTarget.scrollTop;
            const h = e.currentTarget.clientHeight;
            if (h > 0) {
                const idx = Math.round(y / h);
                if (idx !== activeIndexRef.current) {
                    activeIndexRef.current = idx;
                    setActiveIndex(idx);
                    if (onDayChange) onDayChange(idx);
                    if (onHourChange) onHourChange(0); // Reset to first hour of new day
                    // A new day lands on ITS slide 0 — the overview for a forecast
                    // day, the live card for today. Mirrors the onHourChange reset.
                    if (onSlideIndexChange) onSlideIndexChange(0);
                }
            }
        },
        [onDayChange, onHourChange, onSlideIndexChange],
    );

    // Keyboard navigation for vertical day carousel
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!scrollRef.current) return;
        const h = scrollRef.current.clientHeight;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            scrollRef.current.scrollBy({ top: h, behavior: 'smooth' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            scrollRef.current.scrollBy({ top: -h, behavior: 'smooth' });
        }
    }, []);

    /*
     * Vertical carousel reset — INSTANT, never smooth.
     *
     * Every day row is `h-full` inside this scroller, so a row-aligned
     * position is exactly k × clientHeight in raw pixels. Collapsing to
     * essential mode makes each row 81 px TALLER (glassLayout: the hero
     * container's collapsed `top` sits 163 − 82 px higher) while scrollTop is
     * left untouched — so a row-aligned offset instantly becomes fractional,
     * and the page paints the bottom of one day above the top of the next.
     *
     * That is exactly what Shane photographed on 2026-08-28: the lower chrome
     * of one radar card (wind chip, scrubber, RainViewer) stacked above the
     * upper chrome of the next (LIVE pill, 300 nm ring, condition). One card
     * cannot draw both ends and nothing between.
     *
     * The old reset was `scrollTo({ behavior: 'smooth' })`, and it is fired
     * 10 ms into the container's 300 ms `transition-[top]`, on a box that the
     * same render has just switched to overflow-hidden and stripped of
     * scroll-snap. An animated scroll racing an animating height is not a
     * thing to reason about — it is a thing to not do. WebKit has no scroll
     * anchoring, so nothing re-snaps afterwards, and overflow-hidden means
     * the skipper cannot drag it straight either.
     */
    const resetVertical = useCallback(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        activeIndexRef.current = 0;
        setActiveIndex(0);
        if (onDayChange) onDayChange(0);
        if (onHourChange) onHourChange(0);
        if (onSlideIndexChange) onSlideIndexChange(0);
        if (onTimeSelect) onTimeSelect(undefined);
    }, [onDayChange, onHourChange, onSlideIndexChange, onTimeSelect]);

    useEffect(() => {
        window.addEventListener('hero-reset-scroll', resetVertical);
        return () => window.removeEventListener('hero-reset-scroll', resetVertical);
    }, [resetVertical]);

    /*
     * The vertical mirror of HeroSlide's own essential-mode realign. Hero owns
     * this rather than trusting the `hero-reset-scroll` event, because not
     * every route into essential mode dispatches one: `isExpanded` is also
     * derived from locationType, so a refresh that reclassifies the location
     * flips the mode with no event at all.
     *
     * Re-asserted once after the 300 ms transition has settled, because the
     * rows are still growing underneath the first call.
     */
    useEffect(() => {
        if (!isEssentialMode) return;
        resetVertical();
        const t = setTimeout(resetVertical, 320);
        return () => clearTimeout(t);
    }, [isEssentialMode, resetVertical]);

    // The last day the pinned model reaches, so a day past it can say
    // "Beyond ICON's range (ends Sat 3 Oct)" instead of drawing dashes that
    // read as a broken feed (UX scorecard run 6). One stable object for memo.
    const lastWeatherRow = useMemo(() => {
        for (let i = dayRows.length - 1; i >= 0; i--) if (dayRows[i].hasWeather) return i;
        return -1;
    }, [dayRows]);
    const forecastRange = useMemo<GlassForecastRange>(
        () => ({
            modelLabel: forecastModelLabel,
            lastDayLabel: lastWeatherRow < 0 ? null : lastWeatherRow === 0 ? 'today' : heroRowDayName(lastWeatherRow),
        }),
        [forecastModelLabel, lastWeatherRow],
    );

    // PERF FIX: Pre-compute a stable array of per-slide onTimeSelect handlers.
    // Old approach: `createTimeSelectHandler(rIdx)` returned a NEW closure every render,
    // completely defeating React.memo on HeroSlide. Now each handler is created once
    // and survives re-renders because callbacks are accessed via refs.
    const timeSelectHandlers = useMemo(() => {
        return dayRows.map((_, _rIdx) => (time: number | undefined) => {
            // Forward to Dashboard (via ref — always latest)
            onTimeSelectRef.current?.(time);

            // Calculate hour index for Dashboard's activeHour state
            if (onHourChangeRef.current && time) {
                const selectedDate = new Date(time);
                const hour = selectedDate.getHours();
                // All rows are forecast days — hour is simply hour of day (0-23)
                onHourChangeRef.current(hour);
            } else if (onHourChangeRef.current && !time) {
                onHourChangeRef.current(0);
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dayRows.length]);

    // Clamped so a stale index past a shortened forecast never hides every day.
    const shownIndex = Math.min(activeIndex, Math.max(0, dayRows.length - 1));

    // A day past the model's range has no hours worth paging (its frames, if
    // any, are all empty), so the hour dots go; and its caption is handed up
    // so the grid can say why it is empty before ten 'no reading' cells.
    const shownRow = dayRows[shownIndex];
    const shownRangeNote = shownRow && !shownRow.hasWeather ? horizonCaption(forecastRange) : null;
    const shownHasHours = shownIndex === 0 || (!!shownRow && shownRow.hasWeather && shownRow.hourly.length > 0);
    useEffect(() => {
        onShownDayChange?.({ hasHours: shownHasHours, rangeNote: shownRangeNote });
    }, [onShownDayChange, shownHasHours, shownRangeNote]);

    return (
        <div
            className={`w-full h-full relative flex flex-col items-center justify-start overflow-hidden ${className || ''}`}
        >
            {/* VERTICAL SCROLL SNAP CONTAINER */}
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                onKeyDown={handleKeyDown}
                tabIndex={0}
                role="region"
                aria-roledescription="carousel"
                aria-label="Daily forecast carousel — use up and down arrow keys to navigate between days"
                /* Snap stays on in BOTH modes and only the overflow changes.
                   Mandatory snap then re-resolves row alignment for free on any
                   future height change — rotation, or the rain card growing
                   when minutely data lands — while overflow-hidden still
                   suppresses the swipe that essential mode is there to hide. */
                className={`w-full h-full ${isEssentialMode ? 'overflow-hidden' : 'overflow-y-auto'} snap-y snap-mandatory no-scrollbar flex flex-col gap-0 focus:outline-hidden`}
                style={{ overscrollBehavior: 'none' }}
            >
                {/* Show skeleton while data is loading */}
                {dayRows.length === 0 ? (
                    <div
                        className="relative w-full h-full snap-start snap-always shrink-0 flex flex-col overflow-hidden"
                        style={{ backfaceVisibility: 'hidden' }}
                    >
                        <HeroSlideSkeleton />
                    </div>
                ) : (
                    dayRows.map((row, rIdx) => (
                        // Each day: relative positioning creates context for HeroSlide's absolute headers
                        // overflow-hidden prevents headers from escaping during vertical scroll
                        <div
                            key={rIdx}
                            // Days off screen leave the reading order. All eleven were
                            // exposed at once: ~250 tide buttons under ten identical
                            // region names (UX scorecard run 6).
                            ref={(el) => setSlideInert(el, rIdx !== shownIndex, scrollRef.current)}
                            aria-hidden={rIdx !== shownIndex || undefined}
                            className="relative w-full h-full snap-start snap-always shrink-0 flex flex-col overflow-hidden"
                        >
                            <HeroSlide
                                index={rIdx}
                                data={row.data}
                                units={units}
                                tides={tides}
                                settings={settings}
                                updateSettings={updateSettings}
                                addDebugLog={undefined} // Stable undefined instead of new function
                                timeZone={timeZone}
                                locationName={locationName}
                                isLandlocked={isLandlocked}
                                locationType={locationType}
                                displaySource={groundingSource || modelUsed || ''}
                                vessel={vessel}
                                // CRITICAL FIX: If this slide is active, allow the Dashboard's selected time (from horiz scroll) to override.
                                // Otherwise, fall back to row defaults (Live for Today, Noon for Future).
                                customTime={activeIndex === rIdx && customTime ? customTime : row.customTime}
                                hourly={row.hourly}
                                fullHourly={hourly}
                                lat={lat}
                                guiDetails={guiDetails}
                                coordinates={coordinates}
                                generatedAt={generatedAt}
                                onTimeSelect={timeSelectHandlers[rIdx]}
                                onSlideIndexChange={onSlideIndexChange}
                                onHourChange={onHourChange}
                                isVisible={activeIndex === rIdx}
                                utcOffset={utcOffset}
                                tideHourly={tideHourly}
                                onActiveDataChange={onActiveDataChange}
                                isEssentialMode={isEssentialMode}
                                minutelyRain={minutelyRain}
                                forecastRange={forecastRange}
                                compact={compact}
                            />
                        </div>
                    ))
                )}
            </div>

            {/* Pagination Dots (Vertical) — hidden in essential mode.
                6 px and at least 3:1, just inside the card's right edge rather
                than in the screen gutter, where 4 px grey dots at ~2.3:1 read
                as stray pixels (UX scorecard run 6). The rail sits 2–8 px in
                from the card's edge; the tide card keeps its captions 24 px in
                and its curve 16 px in (TideGraph reserveRightPx), so no dot
                lands on the header or the curve (run 7). The box spans the
                card — below the day label row, above the hour-dot band — and
                centres the rail. On a short phone the ~94 pt card is shorter
                than the 96 px rail, so it steps to 5 px dots on a 1 px gap
                (65 px for 11 days), inset 16 px from the top so the first dot
                clears the card's corner radius and the last clears the
                more-hours chevron (UX scorecard run 9). */}
            {!isEssentialMode && dayRows.length > 1 && (
                <div
                    className={`absolute right-[18px] ${compact ? 'top-4 bottom-5 gap-px' : 'top-5 bottom-4 gap-[3px]'} z-30 flex flex-col justify-center pointer-events-none`}
                    aria-hidden="true"
                >
                    {dayRows.map((_, i) => (
                        <div
                            key={i}
                            // Inactive: white/45 by night (~3.8:1 on the card), slate-500
                            // by day (4.8:1 on the white card; slate-400 was 2.6:1). The
                            // active dot steps to sky-600 by day so it still out-weighs
                            // the inactive ones.
                            className={`${compact ? 'w-[5px] h-[5px]' : 'w-1.5 h-1.5'} shrink-0 rounded-full transition-colors duration-300 ${i === shownIndex ? 'bg-sky-400 [.display-light_&]:bg-sky-600' : 'bg-white/45 [.display-light_&]:bg-slate-500'}`}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};
