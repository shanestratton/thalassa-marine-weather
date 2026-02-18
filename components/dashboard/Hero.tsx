import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { HeroSlide } from './HeroSlide';
import { HeroSlideSkeleton } from './Skeletons';
import { UnitPreferences, WeatherMetrics, ForecastDay, VesselProfile, Tide, TidePoint, HourlyForecast } from '../../types';
import { MinutelyRain } from '../../services/weather/api/tomorrowio';
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
    minutelyRain
}: {
    current: WeatherMetrics,
    forecasts: ForecastDay[],
    units: UnitPreferences,
    generatedAt: string,
    vessel?: VesselProfile,
    modelUsed?: string,
    groundingSource?: string,
    isLandlocked?: boolean,
    locationName?: string,
    tides?: Tide[],
    tideHourly?: TidePoint[],
    timeZone?: string,
    hourly?: HourlyForecast[],
    className?: string,
    lat?: number,
    guiDetails?: TideGUIDetails,
    coordinates?: { lat: number, lon: number },
    locationType?: 'coastal' | 'offshore' | 'inland',
    onTimeSelect?: (time: number | undefined) => void,
    customTime?: number,
    utcOffset?: number,
    onDayChange?: (day: number) => void,
    onHourChange?: (hour: number) => void,
    onActiveDataChange?: (data: WeatherMetrics) => void,
    isEssentialMode?: boolean,
    minutelyRain?: MinutelyRain[]
}) => {

    const { settings, updateSettings } = useSettings();
    const [activeIndex, setActiveIndex] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Construct rows: Index 0 is Current/Today. Index 1+ are Forecasts/Future.
    const dayRows = useMemo(() => {
        const rows = [];

        // Row 0: Current
        // Filter hourly for today?
        // Usually index 0 wants all available hourly or just remaining?
        // HeroSlide handles "Live" logic if index=0.
        rows.push({
            data: current,
            hourly: hourly || [],
            customTime: undefined // Current uses live time
        });

        // Forecast Rows - Filter out first day (Today) to avoid duplication
        if (forecasts && forecasts.length > 1) {
            forecasts.slice(1).forEach(f => {
                // Filter hourly for this specific day
                const targetDate = f.isoDate;
                // Fallback to f.date if isoDate missing (though type says isoDate optional?)
                // Assuming h.time follows ISO, we can match YYYY-MM-DD
                let dayHourly: HourlyForecast[] = [];
                if (targetDate && hourly && Array.isArray(hourly)) {
                    dayHourly = hourly.filter((h, debugIdx) => {
                        // FIX: Convert UTC timestamp to Local Date String using Location's Timezone
                        // This ensures that "00:00 Local" (which might be "14:00 Previous Day UTC") matches the target date.
                        const localDateStr = new Date(h.time).toLocaleDateString('en-CA', { timeZone: timeZone });

                        return localDateStr === targetDate;
                    });
                }

                // Construct metrics for the forecast day
                // We cast to any because WeatherMetrics and ForecastDay have overlaps but aren't identical
                const metrics: any = {
                    ...current, // Default fallback
                    ...f, // Override with forecast data (temp, wind, etc)
                    condition: f.condition,
                };
                rows.push({
                    data: metrics as WeatherMetrics,
                    hourly: dayHourly,
                    // Set customTime to Noon of that day to centre the graph
                    customTime: new Date(targetDate + 'T00:00:00').getTime()
                });
            });
        }
        return rows;
    }, [current, forecasts, hourly]);

    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const y = e.currentTarget.scrollTop;
        const h = e.currentTarget.clientHeight;
        if (h > 0) {
            const idx = Math.round(y / h);
            if (idx !== activeIndex) {
                setActiveIndex(idx);
                if (onDayChange) onDayChange(idx);
                if (onHourChange) onHourChange(0); // Reset to first hour of new day
            }
        }
    }, [activeIndex, onDayChange, onHourChange]);

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
    }, []);

    // Memoized time select handler for HeroSlide - avoids creating new function each render
    const createTimeSelectHandler = useCallback((rIdx: number) => (time: number | undefined) => {
        // Forward to Dashboard
        if (onTimeSelect) onTimeSelect(time);

        // Calculate hour index for Dashboard's activeHour state
        if (onHourChange && time) {
            const selectedDate = new Date(time);
            const hour = selectedDate.getHours();

            if (rIdx === 0) {
                // TODAY - calculate offset from current hour
                const now = new Date();
                const currentHour = now.getHours();
                const hourOffset = hour - currentHour;
                onHourChange(hourOffset);
            } else {
                // FORECAST - hour is just the hour of day (0-23)
                onHourChange(hour);
            }
        } else if (onHourChange && !time) {
            // NOW card selected
            onHourChange(0);
        }
    }, [onTimeSelect, onHourChange]);

    return (
        <div className={`w-full h-full relative flex flex-col items-center justify-start overflow-hidden ${className || ''}`}>

            {/* VERTICAL SCROLL SNAP CONTAINER */}
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                onKeyDown={handleKeyDown}
                tabIndex={0}
                role="region"
                aria-roledescription="carousel"
                aria-label="Daily forecast carousel — use up and down arrow keys to navigate between days"
                className="w-full h-full overflow-y-auto snap-y snap-mandatory no-scrollbar flex flex-col gap-0 focus:outline-none"
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
                                customTime={(activeIndex === rIdx && customTime) ? customTime : row.customTime}
                                hourly={row.hourly}
                                fullHourly={hourly}
                                lat={lat}
                                guiDetails={guiDetails}
                                coordinates={coordinates}
                                generatedAt={generatedAt}
                                onTimeSelect={createTimeSelectHandler(rIdx)}
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

            {/* Pagination Dots (Vertical) */}
            {dayRows.length > 1 && (
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex flex-col gap-1.5 z-30 pointer-events-none pr-1">
                    {dayRows.map((_, i) => (
                        <div key={i} className={`w-1 h-1 md:w-1.5 md:h-1.5 rounded-full transition-all duration-300 ${i === activeIndex ? 'bg-sky-400' : 'bg-white/20'} `} />
                    ))}
                </div>
            )}
        </div>
    );
};
