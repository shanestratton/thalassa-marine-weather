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
    onActiveDataChange,
    isEssentialMode,
    minutelyRain,
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
    onActiveDataChange?: (data: WeatherMetrics) => void;
    isEssentialMode?: boolean;
    minutelyRain?: MinutelyRain[];
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
        const rows: { data: WeatherMetrics; hourly: HourlyForecast[]; customTime: number | undefined }[] = [];

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

        // Build today's hourly: filter to today's date
        let todayHourly: HourlyForecast[] = [];
        if (hourly && Array.isArray(hourly)) {
            todayHourly = hourly.filter((h) => {
                if (!h || !h.time) return false;
                const localDateStr = new Date(h.time).toLocaleDateString('en-CA', { timeZone: timeZone });
                return localDateStr === todayISO;
            });
        }

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
                let dayHourly: HourlyForecast[] = [];
                if (targetDate && hourly && Array.isArray(hourly)) {
                    dayHourly = hourly.filter((h) => {
                        const localDateStr = new Date(h.time).toLocaleDateString('en-CA', { timeZone: timeZone });
                        return localDateStr === targetDate;
                    });
                }

                // merge of WeatherMetrics + ForecastDay
                const metrics: Record<string, unknown> = {
                    ...current,
                    ...f,
                    condition: f.condition,
                };
                rows.push({
                    data: metrics as unknown as WeatherMetrics,
                    hourly: dayHourly,
                    customTime: undefined,
                });
            });
        }
        // Cap at 10 rows total (Today + up to 9 future days). WeatherKit's
        // daily forecast returns 10 days; Open-Meteo returns up to 16. Either
        // way, 10 is the carousel's design ceiling.
        return rows.slice(0, 10);
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
                }
            }
        },
        [onDayChange, onHourChange],
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

    // FIX: Listen for global reset specifically for Vertical Scroll (Back to Today)
    useEffect(() => {
        const handleReset = () => {
            if (scrollRef.current) {
                scrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
            }
            if (onTimeSelect) onTimeSelect(undefined);
        };
        window.addEventListener('hero-reset-scroll', handleReset);
        return () => window.removeEventListener('hero-reset-scroll', handleReset);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
                className={`w-full h-full ${isEssentialMode ? 'overflow-hidden' : 'overflow-y-auto snap-y snap-mandatory'} no-scrollbar flex flex-col gap-0 focus:outline-none`}
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
                                onHourChange={onHourChange}
                                isVisible={activeIndex === rIdx}
                                utcOffset={utcOffset}
                                tideHourly={tideHourly}
                                onActiveDataChange={onActiveDataChange}
                                isEssentialMode={isEssentialMode}
                                minutelyRain={minutelyRain}
                            />
                        </div>
                    ))
                )}
            </div>

            {/* Pagination Dots (Vertical) — hidden in essential mode */}
            {!isEssentialMode && dayRows.length > 1 && (
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex flex-col gap-1.5 z-30 pointer-events-none pr-1">
                    {dayRows.map((_, i) => (
                        <div
                            key={i}
                            className={`w-1 h-1 md:w-1.5 md:h-1.5 rounded-full transition-all duration-300 ${i === activeIndex ? 'bg-sky-400' : 'bg-white/20'} `}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};
