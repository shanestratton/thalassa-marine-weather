import React, { useState, useEffect, useMemo, useRef } from 'react';
import { TideGraph } from './TideAndVessel';
import { WindIcon, WaveIcon, RadioTowerIcon, CompassIcon, DropletIcon, GaugeIcon, ArrowUpIcon, ArrowDownIcon, MinusIcon, CloudIcon, MapIcon, RainIcon, SunIcon, EyeIcon, ClockIcon, GripIcon, TideCurveIcon, StarIcon, MoonIcon, SunriseIcon, SunsetIcon, ThermometerIcon } from '../Icons';
import { UnitPreferences, WeatherMetrics, ForecastDay, VesselProfile, Tide, TidePoint, HourlyForecast } from '../../types';
import { convertTemp, convertSpeed, convertLength, convertPrecip, calculateApparentTemp, convertDistance, getTideStatus, calculateDailyScore, getSailingScoreColor, getSailingConditionText, degreesToCardinal, convertMetersTo, formatCoordinate } from '../../utils';
import { ALL_STATIONS } from '../../services/TideService';
import { useSettings } from '../../context/SettingsContext';
import { useUI } from '../../context/UIContext';
// DnD imports removed
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { ALL_HERO_WIDGETS } from '../WidgetDefinitions';
import { StatusBadges } from './StatusBadges';
import { TimerBadge } from './TimerBadge';
import { Countdown } from './Countdown';
import { LocationClock } from './LocationClock';
import { useWeather } from '../../context/WeatherContext';

// --- STYLES ---
// WIDGET_CARD_CLASS removed
// --- STYLES ---
// WIDGET_CARD_CLASS removed
const STATIC_WIDGET_CLASS = "flex-1 min-w-[32%] md:min-w-[30%] bg-black/10 border border-white/5 rounded-xl p-2 md:p-4 relative flex flex-col justify-center min-h-[90px] md:min-h-[100px] shrink-0 opacity-80";

// --- WIDGET RENDERER (Pure Function) ---
const renderHeroWidget = (
    id: string,
    data: WeatherMetrics,
    values: any,
    units: UnitPreferences,
    isLive: boolean,
    trends?: Record<string, 'rising' | 'falling' | 'steady' | undefined>
) => {
    const hasWind = data.windSpeed !== null && data.windSpeed !== undefined;
    const trend = trends ? trends[id] : undefined;

    // Helper to render trend arrow
    const renderTrend = (t?: string, inverse = false) => {
        if (!t || t === 'steady' || t === 'neutral') return null;
        const isUp = t === 'rising';

        // Color Logic:
        // Standard (Pressure, Temp): Up = Green (or neutral white/teal), Down = Red (or neutral) regarding "Good/Bad"?
        // Actually, user wants "Rising/Falling". 
        // Let's use neutral/subtle colors (e.g. data color or white) but Arrow Direction is key.
        // Or: 
        // - Wind Rising = Bad (Red/Orange)
        // - Pressure Rising = Good (Teal/Green)
        // - Pressure Falling = Bad (Red/Orange)
        // Let's stick to subtle arrows first to be "Professional".

        return (
            <div className={`flex items-center ml-1.5 opacity-80 ${isUp ? '-mt-1' : '-mt-1'}`}>
                {isUp
                    ? <ArrowUpIcon className="w-2.5 h-2.5" />
                    : <ArrowDownIcon className="w-2.5 h-2.5" />}
            </div>
        );
    };

    switch (id) {
        case 'wind':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <WindIcon className={`w-3 h-3 ${isLive ? 'text-sky-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-sky-200' : 'text-slate-300'} `}>Wind</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.windSpeed}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">{units.speed}</span>
                        {renderTrend(trend, true)}
                    </div>
                    <div className="flex items-center gap-1 mt-auto pt-1">
                        <div className="flex items-center gap-1 bg-white/5 px-1 py-0.5 rounded text-[8px] md:text-[10px] font-mono text-sky-300 border border-white/5">
                            <CompassIcon rotation={data.windDegree || 0} className="w-2.5 h-2.5 md:w-3 md:h-3" />
                            {data.windDirection || 'VAR'}
                        </div>
                        {hasWind && isLive && (
                            <span className="text-[8px] md:text-[10px] text-orange-300 font-bold ml-auto hidden md:inline">G {values.gusts}</span>
                        )}
                    </div>
                </div>
            );
        case 'gust':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <WindIcon className={`w-3 h-3 ${isLive ? 'text-orange-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-orange-200' : 'text-slate-300'} `}>Gusts</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.gusts}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">{units.speed}</span>
                        {renderTrend(trend, true)}
                    </div>
                    <div className="flex items-center gap-1 mt-auto pt-1">
                        <span className="text-[8px] md:text-[10px] font-bold text-orange-300 opacity-80">Max</span>
                    </div>
                </div>
            );
        case 'wave':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <WaveIcon className={`w-3 h-3 ${isLive ? 'text-blue-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-blue-200' : 'text-slate-300'} `}>Seas</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.waveHeight}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">{units.length}</span>
                        {renderTrend(trend, true)}
                    </div>
                    <div className="flex items-center gap-1 mt-auto pt-1">
                        <div className="flex items-center gap-1 bg-white/5 px-1 py-0.5 rounded text-[8px] md:text-[10px] font-mono text-blue-300 border border-white/5">
                            <ClockIcon className="w-2.5 h-2.5" />
                            {data.swellPeriod ? `${Math.round(data.swellPeriod)} s` : '--'}
                        </div>
                    </div>
                </div>
            );
        case 'pressure':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <GaugeIcon className={`w-3 h-3 ${isLive ? 'text-teal-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-teal-200' : 'text-slate-300'} `}>Barometer</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.pressure}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">hPa</span>
                        {renderTrend(trend, false)}
                    </div>
                    <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-teal-300 font-bold opacity-70">
                        MSL
                    </div>
                </div>
            );
        case 'visibility':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <EyeIcon className={`w-3 h-3 ${isLive ? 'text-emerald-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-emerald-200' : 'text-slate-300'} `}>Visibility</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.vis}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">{units.visibility}</span>
                        {renderTrend(trend, false)}
                    </div>
                    <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-emerald-300 font-bold opacity-70">
                        --
                    </div>
                </div>
            );
        case 'humidity':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <DropletIcon className={`w-3 h-3 ${isLive ? 'text-cyan-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-cyan-200' : 'text-slate-300'} `}>Humidity</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.humidity}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">%</span>
                        {renderTrend(trend, true)}
                    </div>
                    <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-cyan-300 font-bold opacity-70">
                        --
                    </div>
                </div>
            );
        case 'feels':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <ThermometerIcon className={`w-3 h-3 ${isLive ? 'text-amber-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-amber-200' : 'text-slate-300'} `}>Feels Like</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.feelsLike}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">°{units.temp}</span>
                        {renderTrend(trend, true)}
                    </div>
                </div>
            );
        case 'clouds':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <CloudIcon className={`w-3 h-3 ${isLive ? 'text-gray-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-gray-200' : 'text-slate-300'} `}>Cover</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.cloudCover}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">%</span>
                        {renderTrend(trend, true)}
                    </div>
                </div>
            );
        case 'precip':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <RainIcon className={`w-3 h-3 ${isLive ? 'text-blue-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-blue-200' : 'text-slate-300'} `}>Precip</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.precip}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">{units.length === 'm' ? 'mm' : 'in'}</span>
                        {renderTrend(trend, true)}
                    </div>
                </div>
            );
        case 'dew':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <DropletIcon className={`w-3 h-3 ${isLive ? 'text-indigo-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-indigo-200' : 'text-slate-300'} `}>Dew Pt</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.dewPoint}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">°{units.temp}</span>
                        {renderTrend(trend, true)}
                    </div>
                </div>
            );
        case 'waterTemp':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <ThermometerIcon className={`w-3 h-3 ${isLive ? 'text-cyan-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-cyan-200' : 'text-slate-300'} `}>Sea Temp</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.waterTemperature}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">°{units.temp}</span>
                        {renderTrend(trend, true)}
                    </div>
                    <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-cyan-300 font-bold opacity-70">
                        Surface
                    </div>
                </div>
            );
        case 'currentSpeed':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <WaveIcon className={`w-3 h-3 ${isLive ? 'text-emerald-400' : 'text-slate-400'} `} />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-emerald-200' : 'text-slate-300'} `}>Drift</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.currentSpeed}</span>
                        <span className="text-[10px] md:text-sm font-medium text-gray-400">kts</span>
                        {renderTrend(trend, true)}
                    </div>
                    <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-emerald-300 font-bold opacity-70">
                        --
                    </div>
                </div>
            );
        case 'currentDirection':
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        {/* Fix: CompassIcon requires 'rotation' prop */}
                        <CompassIcon
                            className={`w-3 h-3 ${isLive ? 'text-teal-400' : 'text-slate-400'} `}
                            rotation={typeof data.currentDirection === 'number' ? data.currentDirection : 0}
                        />
                        <span className={`text-[9px] md: text-[10px] font-bold uppercase tracking-widest ${isLive ? 'text-teal-200' : 'text-slate-300'} `}>Set</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        {/* We want just the cardinal direction here, e.g. "NE" */}
                        <span className="text-2xl md:text-5xl font-black tracking-tighter text-white">{values.currentDirection}</span>
                    </div>
                    <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-teal-300 font-bold opacity-70">
                        {/* Fix: Ensure currentDirection is a number before Math.round, handle string case */}
                        {typeof data.currentDirection === 'number' ? Math.round(data.currentDirection) + '°' : '--'} True
                    </div>
                </div>
            );
        default:
            return null;
    }
};

// --- HERO SLIDE COMPONENT (Individual Day Card) ---
export const HeroSlide = React.memo(({
    data,
    index,
    units,
    tides,
    settings,
    updateSettings,
    addDebugLog,
    timeZone,
    locationName,
    isLandlocked,
    displaySource,
    vessel,
    customTime,
    hourly,
    fullHourly,
    guiDetails,
    coordinates,
    locationType,
    generatedAt,
    onTimeSelect,
    isVisible = false // Default false to be safe
}: {
    data: WeatherMetrics,
    index: number,
    units: UnitPreferences,
    tides?: Tide[],
    settings: any,
    updateSettings: any,
    addDebugLog: any,
    timeZone?: string,
    locationName?: string,
    isLandlocked?: boolean,
    displaySource: string,
    vessel?: VesselProfile,
    customTime?: number,
    hourly?: HourlyForecast[],
    fullHourly?: HourlyForecast[],
    lat?: number,
    guiDetails?: any,
    coordinates?: { lat: number, lon: number },
    locationType?: 'coastal' | 'offshore' | 'inland',
    generatedAt?: string,
    onTimeSelect?: (time: number | undefined) => void,
    isVisible?: boolean
}) => {
    const { nextUpdate } = useWeather();

    // 1. STATE HOISTING (Zero-Latency Architecture)
    // We define the scroll state AT THE TOP so it drives the entire component synchronously.
    const [activeHIdx, setActiveHIdx] = useState(0);

    // 2. HOISTED DATA PREPARATION
    // Filter out the first hourly item (current hour) to avoid duplication with 'Now' card
    const hourlyToRender = React.useMemo(() => {
        if (!hourly || hourly.length === 0) return [];

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

            // Filter: Time > Now (Absolute) AND Time is Same Day (Location)
            return hourly.filter(h => {
                const t = new Date(h.time);

                // 1. Must be in the future (absolute)
                // Add a small buffer (5 mins) to ensure we don't show an hour that just started 1 min ago if "Now" covers it? 
                // We want strict future hour.
                const isFuture = t.getTime() > now.getTime();

                // 2. Must be "Today" in Location Time
                const itemLocDateStr = t.toLocaleDateString('en-CA', { timeZone: safeZone });
                const isSameDay = itemLocDateStr === nowLocDateStr;

                return isFuture && isSameDay;
            });
        } else {
            // FORECAST: 00:00 to 23:00 (Already filtered by day in Hero.tsx, just return all)
            return hourly;
        }
    }, [hourly, index, timeZone]);

    // 3. DERIVED VISUAL TIME (The "Fast" Time)
    // This updates instantly on scroll render, unlike 'customTime' prop which lags.
    const visualTime = useMemo(() => {
        if (index === 0) {
            // TODAY
            if (activeHIdx === 0) return undefined; // Live
            const hItem = hourlyToRender[activeHIdx - 1];
            return hItem ? new Date(hItem.time).getTime() : undefined;
        } else {
            // FORECAST
            const hItem = hourlyToRender[activeHIdx];
            return hItem ? new Date(hItem.time).getTime() : undefined;
        }
    }, [activeHIdx, index, hourlyToRender]);

    // Ticker for Live Countdown
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (index !== 0) return; // Optimization: Only tick for Live card
        const timer = setInterval(() => setTick(t => t + 1), 30000); // 30s check
        return () => clearInterval(timer);
    }, [index]);

    const isLive = index === 0 && !customTime;

    // FIX: Live Data Override using Hourly Array
    // This ensures that if the app is open for hours (or data fetched earlier), 
    // we show the forecast for the *current wall-clock hour* rather than the fetch-time snapshot.
    const effectiveData = useMemo(() => {
        // Use fullHourly if available (preferred for timezone safety), else fallback to filtered hourly
        const sourceHourly = fullHourly && fullHourly.length > 0 ? fullHourly : hourly;

        // FIX: If this is the "Live" card, we MUST rely on the 'data' prop (which has METAR overrides).
        // Trying to "find the current slot" from the hourly array (which is raw model data) causes
        // a race condition at the top of the hour where the UI flashes raw data before the refresh completes.
        if (isLive) return data;

        if (!sourceHourly || sourceHourly.length === 0) return data;

        // FIX: Respect Visual Time (Scroll). Fallback to Now if live.
        // We use 'visualTime' (local) instead of 'customTime' (prop) for zero latency.
        const now = visualTime || Date.now();
        const oneHour = 3600 * 1000;

        // Find the hourly slot that covers the current time
        const currentSlot = sourceHourly.find(h => {
            const t = new Date(h.time).getTime();
            return now >= t && now < t + oneHour;
        });

        if (currentSlot) {
            // CRITICAL FIX: Do NOT override "Current" data (which might be real METAR) with "Hourly" data (which is model forecast).
            // The 'data' prop comes from 'weather.current' which has 'Ground Truth' overrides.
            // ...
            return {
                ...data,
                // Only update time-sensitive fields
                uvIndex: currentSlot.uvIndex !== undefined ? currentSlot.uvIndex : data.uvIndex,
                precipitation: currentSlot.precipitation,
                feelsLike: currentSlot.feelsLike,
                currentSpeed: (currentSlot.currentSpeed !== undefined && currentSlot.currentSpeed !== null) ? currentSlot.currentSpeed : data.currentSpeed,
                currentDirection: (currentSlot.currentDirection !== undefined && currentSlot.currentDirection !== null) ? currentSlot.currentDirection : data.currentDirection,
                waterTemperature: (currentSlot.waterTemperature !== undefined && currentSlot.waterTemperature !== null) ? currentSlot.waterTemperature : data.waterTemperature
            };
        }
        return data;
    }, [data, hourly, isLive, fullHourly, tick, visualTime]); // Dependency: visualTime

    // Use effectiveData for all display logic used in the MAIN CARD
    const displayData = effectiveData;

    // Trend Calculation
    const trends = useMemo(() => {
        if (!fullHourly || fullHourly.length < 2) return undefined;

        // Find current index based on time
        // Use visualTime for instant trend updates
        const now = visualTime || Date.now();
        // Look for the slot that matches 'now'
        let currentIndex = fullHourly.findIndex(h => {
            const t = new Date(h.time).getTime();
            return now >= t && now < t + 3600000;
        });

        if (currentIndex === -1) {
            // Fallback: if we are "live" (index 0), try to compare with the previous hour in the array if available?
            // Or if we can't find exact, maybe we are at the start of the array?
            // If we can't find current, we can't compare.
            return undefined;
        }


        const current = effectiveData; // Use the effective (potentially live) data
        let baseItem = fullHourly[currentIndex - 1]; // Previous hour
        let isForecast = false;

        // Fallback: If no previous data (start of array), look ahead to show "Forecast Trend"
        if (!baseItem) {
            const nextItem = fullHourly[currentIndex + 1];
            if (nextItem) {
                baseItem = nextItem;
                isForecast = true;
            }
        }

        const prev = baseItem;

        const getTrend = (curr?: number | null, old?: number | null, threshold = 0): 'rising' | 'falling' | 'steady' => {
            if (curr === undefined || curr === null || old === undefined || old === null) return 'steady';
            let diff = curr - old;

            // If comparing to Future (Next Hour), invert logic:
            // e.g. Current(10) -> Next(15). Diff(10-15)=-5. But Trend is Rising (+5).
            if (isForecast) {
                diff = old - curr;
            }

            if (diff > threshold) return 'rising';
            if (diff < -threshold) return 'falling';
            return 'steady';
        };

        return {
            wind: getTrend(current.windSpeed, prev.windSpeed, 1),
            gust: getTrend(current.windGust, prev.windGust, 2),
            wave: getTrend(current.waveHeight, prev.waveHeight, 0.1),
            pressure: getTrend(current.pressure, prev.pressure, 0.5),
            waterTemp: getTrend(current.waterTemperature, prev.waterTemperature, 0.2),
            currentSpeed: getTrend(current.currentSpeed, prev.currentSpeed, 0.2),
            humidity: getTrend(current.humidity, prev.humidity, 3),
            visibility: getTrend(current.visibility, prev.visibility, 1),
            precip: getTrend(current.precipitation, prev.precipitation, 0.1),
            feels: getTrend(current.feelsLike, prev.feelsLike, 1),
            clouds: getTrend(current.cloudCover, prev.cloudCover, 5)
            // dew: getTrend(current.dewPoint, prev.dewPoint, 1) - Removed due to type mismatch
        };
    }, [effectiveData, fullHourly, visualTime]);

    // Debug Log for Trends
    console.log('[TRENDS DEBUG]', { index, hasFullHourly: !!fullHourly, len: fullHourly?.length, trends });

    // Vertical Scroll Reset Logic
    // Horizontal Scroll Reset Logic (Inner Axis is now Horizontal)
    const horizontalScrollRef = useRef<HTMLDivElement>(null);

    // FIX V5: PRE-CALCULATE THE DATE LABEL FROM THE PARENT ROW DATA
    const rowDateLabel = useMemo(() => {
        if (index === 0) return "TODAY";

        // Critical: Use displayData.isoDate if available to LOCK the date to the row's day
        if (displayData.isoDate) {
            const [y, m, day] = displayData.isoDate.split('-').map(Number);
            const d = new Date(y, m - 1, day, 12, 0, 0);
            return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        }

        // Fallback for generic date objects
        const d = displayData.date ? new Date(displayData.date) : new Date();
        return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    }, [index, displayData.isoDate, displayData.date]);

    useEffect(() => {
        const handleReset = () => {
            // Reset to Start (Left)
            if (horizontalScrollRef.current) {
                horizontalScrollRef.current.scrollTo({ left: 0, behavior: 'smooth' });
            }
        };
        window.addEventListener('hero-reset-scroll', handleReset);
        return () => window.removeEventListener('hero-reset-scroll', handleReset);
    }, []);

    const fullWidgetList = settings.heroWidgets && settings.heroWidgets.length > 0 ? settings.heroWidgets : ['wind', 'wave', 'pressure'];
    const displayWidgets = fullWidgetList.slice(0, 3);

    // Display Logic used for WIDGETS (Not the Card itself? Wait, Widgets use this too)
    const rawGust = displayData.windGust || ((displayData.windSpeed || 0) * 1.3);
    const hasWind = displayData.windSpeed !== null && displayData.windSpeed !== undefined;

    // Calculate Day/Night state
    const isCardDay = useMemo(() => {
        if (index > 0) return true;
        if (!displayData.sunrise || !displayData.sunset) return true;

        const now = visualTime || Date.now();
        const d = new Date(now);
        const [rH, rM] = displayData.sunrise.split(':').map(Number);
        const [sH, sM] = displayData.sunset.split(':').map(Number);

        const rise = new Date(d).setHours(rH, rM, 0, 0);
        const set = new Date(d).setHours(sH, sM, 0, 0);

        return d.getTime() >= rise && d.getTime() < set;
    }, [index, displayData.sunrise, displayData.sunset, visualTime, tick]); // Added tick

    const isHighGust = hasWind && (rawGust > ((displayData.windSpeed || 0) * 1.5));
    const hasWave = displayData.waveHeight !== null && displayData.waveHeight !== undefined;

    const displayValues = {
        airTemp: displayData.airTemperature !== null ? convertTemp(displayData.airTemperature, units.temp) : '--',
        highTemp: (displayData as any).highTemp !== undefined ? convertTemp((displayData as any).highTemp, units.temp) : '--',
        lowTemp: (displayData as any).lowTemp !== undefined ? convertTemp((displayData as any).lowTemp, units.temp) : '--',
        windSpeed: hasWind ? convertSpeed(displayData.windSpeed, units.speed) : '--',
        waveHeight: isLandlocked ? "0" : (hasWave ? convertLength(displayData.waveHeight, units.length) : '--'),
        vis: displayData.visibility ? convertDistance(displayData.visibility, units.visibility || 'nm') : '--',
        gusts: hasWind ? convertSpeed(rawGust, units.speed) : '--',
        precip: convertPrecip(displayData.precipitation, units.length),
        pressure: displayData.pressure ? Math.round(displayData.pressure) : '--',
        cloudCover: (displayData.cloudCover !== null && displayData.cloudCover !== undefined) ? Math.round(displayData.cloudCover) : '--',
        uv: (displayData.uvIndex !== undefined && displayData.uvIndex !== null) ? Math.round(displayData.uvIndex) : '--',
        sunrise: displayData.sunrise || '--:--',
        sunset: displayData.sunset || '--:--',
        currentSpeed: displayData.currentSpeed !== undefined && displayData.currentSpeed !== null ? Number(displayData.currentSpeed).toFixed(1) : '--',
        humidity: (displayData.humidity !== undefined && displayData.humidity !== null) ? Math.round(displayData.humidity) : '--',
        feelsLike: (displayData.feelsLike !== undefined && displayData.feelsLike !== null) ? convertTemp(displayData.feelsLike, units.temp) : '--',
        dewPoint: (displayData.dewPoint !== undefined && displayData.dewPoint !== null) ? convertTemp(displayData.dewPoint, units.temp) : '--',

        // Critical: Added missing Marine keys for Third Row widgets
        waterTemperature: displayData.waterTemperature !== undefined && displayData.waterTemperature !== null ? convertTemp(displayData.waterTemperature, units.temp) : '--',
        currentDirection: (() => {
            const val = displayData.currentDirection;
            if (typeof val === 'number') return degreesToCardinal(val);
            if (typeof val === 'string') return val.replace(/[\d.°]+/g, '').trim() || val;
            return '--';
        })()
    };

    // Score Calculation
    const score = calculateDailyScore(displayData.windSpeed || 0, displayData.waveHeight || 0, vessel);
    const scoreColor = getSailingScoreColor(score);
    const scoreText = getSailingConditionText(score);

    // WidgetMap removed (replaced by renderHeroWidget helper)

    // ... (Skipping to renderTideGraph)

    const renderTideGraph = (targetTime?: number, targetDateStr?: string) => {
        // 1. INLAND MODE
        if (locationType === 'inland' || isLandlocked) {
            return (
                <div className="mt-0.5 pt-1 border-t border-white/5 flex gap-2 px-4 md:px-6 h-44 items-center justify-between pb-4">
                    {/* Humidity */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <DropletIcon className="w-3 h-3 text-cyan-400" />
                            <span className="text-[10px] font-bold uppercase tracking-widest text-cyan-200">Humidity</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-3xl font-black text-white">{displayValues.humidity}</span>
                            <span className="text-xs text-gray-400 font-medium">%</span>
                        </div>
                    </div>

                    {/* Visibility */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <EyeIcon className="w-3 h-3 text-emerald-400" />
                            <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-200">Visibility</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-3xl font-black text-white">{displayValues.vis}</span>
                            <span className="text-xs text-gray-400 font-medium">{units.visibility}</span>
                        </div>
                    </div>

                    {/* UV/Pressure */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <SunIcon className="w-3 h-3 text-orange-400" />
                            <span className="text-[10px] font-bold uppercase tracking-widest text-orange-200">UV Index</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-3xl font-black text-white">{displayValues.uv}</span>
                        </div>
                    </div>
                </div>
            );
        }

        // 2. OFFSHORE MODE 
        if (locationType === 'offshore' || (!tides?.length && !isLandlocked)) {
            return (
                <div className="mt-0.5 pt-1 border-t border-white/5 flex gap-2 px-4 md:px-6 h-44 items-center justify-between pb-4">
                    {/* Water Temp */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <ThermometerIcon className="w-3 h-3 text-blue-400" />
                            <span className="text-[10px] font-bold uppercase tracking-widest text-blue-200">Water</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-3xl font-black text-white">
                                {data.waterTemperature ? convertTemp(data.waterTemperature, units.temp) : '--'}
                            </span>
                            <span className="text-xs text-gray-400 font-medium">°{units.temp}</span>
                        </div>
                    </div>

                    {/* Set (Current Speed) */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <GaugeIcon className="w-3 h-3 text-violet-400" />
                            <span className="text-[10px] font-bold uppercase tracking-widest text-violet-200">Drift</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-3xl font-black text-white">{displayValues.currentSpeed}</span>
                            <span className="text-xs text-gray-400 font-medium">kts</span>
                        </div>
                    </div>

                    {/* Drift (Current Direction) */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <CompassIcon rotation={0} className="w-3 h-3 text-violet-400" />
                            <span className="text-[10px] font-bold uppercase tracking-widest text-violet-200">Set</span>
                        </div>
                        <div className="flex flex-col justify-center">
                            <span className="text-3xl font-black text-white">
                                {(() => {
                                    const val = data.currentDirection;
                                    if (typeof val === 'number') return degreesToCardinal(val);
                                    if (typeof val === 'string') {
                                        return val.replace(/[\d.°]+/g, '').trim() || val;
                                    }
                                    return '--';
                                })()}
                            </span>
                        </div>
                        <div className="mt-auto pt-1 text-[8px] md:text-[10px] text-violet-300 font-bold opacity-80 text-center">
                            {(() => {
                                const val = data.currentDirection;
                                let degrees: number | null = null;
                                if (typeof val === 'number') degrees = val;
                                else if (typeof val === 'string') {
                                    const match = val.match(/(\d+)/);
                                    if (match) degrees = parseInt(match[1]);
                                }

                                if (degrees !== null && !isNaN(degrees)) {
                                    return `${Math.round(degrees)}° True`;
                                }
                                return 'True';
                            })()}
                        </div>
                    </div>
                </div>
            );
        }
        if (!tides || tides.length === 0) return null;

        return (
            <div className="w-full h-36 px-0 pb-0 relative mb-8">
                <TideGraph
                    tides={tides}
                    unit={units.tideHeight || 'm'}
                    timeZone={timeZone}
                    hourlyTides={[]}
                    tideSeries={undefined}
                    modelUsed="WorldTides"
                    unitPref={units}
                    customTime={targetTime || customTime}
                    showAllDayEvents={index > 0 && !targetTime}
                    /* Logic to resolve Primary vs Secondary */
                    stationName={(() => {
                        const sName = guiDetails?.stationName;
                        if (!sName) return "Local Station";
                        const sObj = ALL_STATIONS.find(s => s.name === sName);
                        if (sObj?.referenceStationId) {
                            const ref = ALL_STATIONS.find(r => r.id === sObj.referenceStationId);
                            return ref ? ref.name : sName;
                        }
                        return sName;
                    })()}
                    secondaryStationName={(() => {
                        const sName = guiDetails?.stationName;
                        if (!sName) return undefined;
                        const sObj = ALL_STATIONS.find(s => s.name === sName);
                        if (sObj?.referenceStationId) {
                            return sName; // The User's specific location is the Secondary
                        }
                        return undefined;
                    })()}
                    guiDetails={guiDetails}
                    stationPosition="bottom"
                />
            </div>
        );
    };

    const renderTopWidget = () => {
        const topWidgetId = settings.topHeroWidget || 'sunrise'; // Default

        if (topWidgetId === 'sunrise') {
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <SunIcon className="w-3 h-3 text-orange-400" />
                        <span className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-orange-200">Sun Phz</span>
                    </div>
                    <div className="flex flex-col justify-center">
                        <div className="flex items-center justify-between">
                            <span className="text-[9px] text-orange-300 font-bold uppercase mr-1">Rise</span>
                            <span className="text-base md:text-lg font-black tracking-tighter text-white">{displayValues.sunrise}</span>
                        </div>
                        <div className="w-full h-px bg-white/5 my-0.5"></div>
                        <div className="flex items-center justify-between">
                            <span className="text-[9px] text-purple-300 font-bold uppercase mr-1">Set</span>
                            <span className="text-base md:text-lg font-black tracking-tighter text-white">{displayValues.sunset}</span>
                        </div>
                    </div>
                    <LocationClock timeZone={timeZone} />
                </div>
            );
        }

        if (topWidgetId === 'score') {
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <StarIcon className="w-3 h-3 text-yellow-400" />
                        <span className="text-[9px] md:text-[10px] font-bold uppercase tracking-widest text-yellow-200">Boating</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-3xl md:text-5xl font-black tracking-tighter text-white">{score}</span>
                        <span className="text-[10px] md:text-xs font-medium text-gray-400">/100</span>
                    </div>
                    <div className={`mt-auto pt-1 text-[8px] md: text-[10px] font-bold px-1.5 py-0.5 rounded w-fit ${scoreColor} `}>
                        {scoreText}
                    </div>
                </div>
            );
        }

        // Use Common Renderer
        const customWidget = renderHeroWidget(topWidgetId, data, displayValues, units, isLive);
        if (customWidget) {
            return customWidget;
        }
        return null;
    };

    const renderCard = (cardData: WeatherMetrics, isHourly: boolean, hTime?: number, forceLabel?: string) => {
        // Recalculate display values for this specific card
        const cardDisplayValues = {
            airTemp: cardData.airTemperature !== null ? convertTemp(cardData.airTemperature, units.temp) : '--',
            highTemp: (cardData as any).highTemp !== undefined ? convertTemp((cardData as any).highTemp, units.temp) : '--',
            lowTemp: (cardData as any).lowTemp !== undefined ? convertTemp((cardData as any).lowTemp, units.temp) : '--',
            windSpeed: cardData.windSpeed !== null && cardData.windSpeed !== undefined ? convertSpeed(cardData.windSpeed, units.speed) : '--',
            waveHeight: isLandlocked ? "0" : (cardData.waveHeight !== null && cardData.waveHeight !== undefined ? convertLength(cardData.waveHeight, units.waveHeight) : '--'),
            vis: cardData.visibility ? convertDistance(cardData.visibility, units.visibility || 'nm') : '--',
            gusts: cardData.windSpeed !== null ? convertSpeed((cardData.windGust || (cardData.windSpeed * 1.3)), units.speed) : '--',
            precip: convertPrecip(cardData.precipitation, units.length),
            pressure: cardData.pressure ? Math.round(cardData.pressure) : '--',
            cloudCover: (cardData.cloudCover !== null && cardData.cloudCover !== undefined) ? Math.round(cardData.cloudCover) : '--',
            uv: cardData.uvIndex !== undefined ? Math.round(cardData.uvIndex) : '--',
            sunrise: (() => { const t = cardData.sunrise; if (!t) return '--:--'; try { return new Date('1/1/2000 ' + t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { return t; } })(),
            sunset: (() => { const t = cardData.sunset; if (!t) return '--:--'; try { return new Date('1/1/2000 ' + t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch (e) { return t; } })(),
            humidity: (cardData.humidity !== undefined && cardData.humidity !== null) ? Math.round(cardData.humidity) : '--',
            waterTemperature: (cardData.waterTemperature !== undefined && cardData.waterTemperature !== null) ? convertTemp(cardData.waterTemperature, units.temp) : '--',
            currentSpeed: (cardData.currentSpeed !== undefined && cardData.currentSpeed !== null) ? Number(cardData.currentSpeed).toFixed(1) : '--',
            currentDirection: (() => {
                const val = cardData.currentDirection;
                if (typeof val === 'number') return degreesToCardinal(val);
                if (typeof val === 'string') return val.replace(/[\d.°]+/g, '').trim() || val;
                return '--';
            })()
        };



        const cardIsLive = !isHourly && isLive;
        const cardTime = hTime || customTime;

        // Note: We reuse the parent's `renderTopWidget` and `tideGraph` logic for simplicity,
        // but arguably Hourly slides might need Tides recalculated for their specific hour.
        // For now, we'll hide Tides on hourly slides to avoid complexity or keep same graph.

        // DYNAMIC SUN PHASE LOGIC (Enhanced with defaults)
        const sunPhase = (() => {
            const currentTs = cardTime || Date.now();
            const sRise = cardData.sunrise;
            const sSet = cardData.sunset;

            // Fallback: 6am-6pm if NO data
            const fallbackCheck = () => {
                const h = new Date(currentTs).getHours();
                return { isDay: h >= 6 && h < 18, label: h >= 6 && h < 18 ? 'Sunset' : 'Sunrise', time: '--:--' };
            };

            if (!sRise || !sSet || sRise === '--:--' || sSet === '--:--') {
                return fallbackCheck();
            }

            try {
                // Heuristic parse "HH:MM"
                const [rH, rM] = sRise.replace(/[^0-9:]/g, '').split(':').map(Number);
                const [sH, sM] = sSet.replace(/[^0-9:]/g, '').split(':').map(Number);

                // If parse fails, fallback
                if (isNaN(rH) || isNaN(sH)) return fallbackCheck();

                const d = new Date(currentTs);
                const riseDt = new Date(d); riseDt.setHours(rH, rM, 0);
                const setDt = new Date(d); setDt.setHours(sH, sM, 0);

                // Check interval
                if (d < riseDt) return { isDay: false, label: 'Sunrise', time: sRise };
                if (d >= riseDt && d < setDt) return { isDay: true, label: 'Sunset', time: sSet };
                return { isDay: false, label: 'Sunrise', time: sRise }; // Night (Post-Sunset)
            } catch (e) {
                return fallbackCheck();
            }
        })();

        // DETERMINATE STYLING THEME
        // Future Dailies (Index > 0, !isHourly) -> Always Day/Glass
        // Hourly/Now -> Use sunPhase
        const isCardDay = (!isHourly && index > 0) ? true : sunPhase.isDay;

        return (
            <div
                className={`w-full h-auto snap-start shrink-0 relative px-0.5 pb-0 flex flex-col`}
            >
                <div className={`relative w-full h-auto rounded-3xl overflow-hidden backdrop-blur-md flex flex-col border border-white/10 bg-black/20 `}>
                    {/* BG */}
                    <div className="absolute inset-0 z-0">
                        <div className={`absolute inset-0 bg-gradient-to-br ${isCardDay ? 'from-blue-900/20 via-slate-900/40 to-black/60' : 'from-red-900/10 via-slate-900/40 to-black/60'} `} />
                    </div>

                    <div className="relative z-10 w-full h-auto flex flex-col p-0">
                        {/* Header Grid */}
                        <div className="flex flex-col gap-2 md:gap-3 mb-2 relative z-10 px-4 md:px-6 pt-4 md:pt-6 shrink-0">

                            {/* MERGED Header Card (Span 3-Full Width) - PREMIUM GLASS THEME */}
                            <div className={`col-span-3 rounded-2xl p-0 backdrop-blur-md flex flex-col relative overflow-hidden group h-[140px] border shadow-lg ${isCardDay
                                ? 'bg-gradient-to-br from-sky-900/20 via-slate-900/40 to-black/40 border-sky-400/20 shadow-sky-900/5'
                                : 'bg-gradient-to-br from-indigo-900/20 via-slate-900/40 to-black/40 border-indigo-400/20 shadow-indigo-900/5'
                                } `}>
                                {/* Gradient Orb (Shared) */}
                                <div className="absolute -top-10 -right-10 w-40 h-40 bg-gradient-to-br from-indigo-500/20 via-purple-500/10 to-transparent rounded-full blur-2xl pointer-events-none" />

                                {/* TOP SECTION (Split 58/42) */}
                                {/* TOP SECTION (Split 58/42) */}
                                {/* TOP SECTION (Split 58/42) */}
                                {/* TOP SECTION (3-Column Layout) */}
                                <div className="flex flex-row w-full flex-1 border-b border-white/5 h-[90px]">

                                    {/* COLUMN 1: Main Temp & Condition (33%) */}
                                    <div className="flex-1 border-r border-white/5 p-2 flex flex-col justify-between items-start min-w-0 bg-white/0">
                                        {/* Top: Main Temp */}
                                        <div className="flex items-start leading-none relative -translate-y-2">
                                            {(() => {
                                                const tempStr = cardDisplayValues.airTemp.toString();
                                                const len = tempStr.length;
                                                const sizeClass = len > 3 ? 'text-3xl md:text-4xl' : len > 2 ? 'text-4xl md:text-5xl' : 'text-5xl md:text-6xl';
                                                return (
                                                    <span className={`${sizeClass} font-black tracking-tighter text-white drop-shadow-2xl leading-none transition-all duration-300`}>
                                                        {cardDisplayValues.airTemp}°
                                                    </span>
                                                )
                                            })()}
                                        </div>

                                        {/* Bottom: Condition */}
                                        <span className={`text-[9px] md:text-[10px] font-bold uppercase tracking-widest opacity-90 w-full whitespace-nowrap overflow-hidden text-ellipsis ${cardData.condition?.includes('STORM') ? 'text-red-500 animate-pulse' :
                                            cardData.condition?.includes('POURING') ? 'text-orange-400' :
                                                cardData.condition?.includes('SHOWERS') ? 'text-cyan-400' :
                                                    'text-sky-300'
                                            } `}>
                                            {cardData.condition?.replace(/Thunderstorm/i, 'Thunder').replace(/Light Showers/i, 'Showers')}
                                        </span>
                                    </div>

                                    {/* COLUMN 2: Metrics Stack (33%) */}
                                    <div className="flex-1 border-r border-white/5 p-2 flex flex-col justify-between items-center min-w-0 bg-white/0">
                                        {/* 1. Hi/Low */}
                                        <div className="flex items-center gap-2 text-xs font-bold leading-none w-full justify-center">
                                            <div className="flex items-center gap-0.5 text-white">
                                                <ArrowUpIcon className="w-2.5 h-2.5 text-orange-400" />
                                                {cardDisplayValues.highTemp}°
                                            </div>
                                            <div className="w-px h-2.5 bg-white/20" />
                                            <div className="flex items-center gap-0.5 text-gray-300">
                                                <ArrowDownIcon className="w-2.5 h-2.5 text-emerald-400" />
                                                {cardDisplayValues.lowTemp}°
                                            </div>
                                        </div>

                                        {/* 2. Feels Like */}
                                        <div className={`flex items-center gap-1 justify-center w-full ${!(cardData.feelsLike !== undefined) ? 'opacity-0' : ''}`}>
                                            <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Feels</span>
                                            <span className="text-[10px] font-bold text-orange-200">
                                                {cardData.feelsLike !== undefined ? convertTemp(cardData.feelsLike, units.temp) : '--'}°
                                            </span>
                                        </div>

                                        {/* 3. Cloud */}
                                        <div className="flex items-center gap-1 justify-center w-full">
                                            <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">Cloud</span>
                                            <span className="text-[10px] font-bold text-gray-300">{Math.round(cardData.cloudCover || 0)}%</span>
                                        </div>

                                        {/* 4. Rain */}
                                        <div className="flex items-center gap-1 justify-center w-full">
                                            <RainIcon className="w-2.5 h-2.5 text-cyan-400" />
                                            {(() => {
                                                const p = displayData.precipitation || 0;
                                                let desc = "None";
                                                if (p > 0) {
                                                    if (p < 0.5) desc = "Trace";
                                                    else if (cardData.condition?.toLowerCase().includes("shower")) desc = "Showers";
                                                    else desc = "Rain";
                                                }
                                                return (
                                                    <>
                                                        <span className="text-[9px] font-bold text-gray-400 uppercase tracking-wider">{desc}</span>
                                                        <span className="text-[10px] font-bold text-cyan-300">{cardDisplayValues.precip}</span>
                                                    </>
                                                );
                                            })()}
                                        </div>

                                        {/* 5. Dew Point */}
                                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-indigo-300 justify-center w-full">
                                            <span className="text-[8px] uppercase tracking-wider text-indigo-300/50">Dew</span>
                                            {cardData.dewPoint !== undefined ? convertTemp(cardData.dewPoint, units.temp) : '--'}°
                                        </div>
                                    </div>

                                    {/* COLUMN 3: Context Header (33%) */}
                                    <div className="flex-1 p-2 flex flex-col justify-between items-end min-w-0 bg-white/0">
                                        <div className="w-full flex justify-start items-end flex-col -translate-y-1">
                                            {/* TOP LINE */}
                                            <span className={`${cardIsLive ? 'text-emerald-400' : 'text-blue-400'} font-extrabold text-[10px] md:text-xs tracking-[0.2em] leading-none mb-1 w-full text-right`}>
                                                {cardIsLive ? "TODAY" : "FORECAST"}
                                            </span>
                                            {/* MIDDLE LINE */}
                                            <span className={`${cardIsLive ? 'text-emerald-400' : 'text-blue-400'} ${(!cardIsLive && (forceLabel || "TODAY") !== "TODAY") ? 'text-lg md:text-xl' : 'text-xl md:text-2xl'} font-black tracking-tighter leading-none w-full text-right whitespace-nowrap mb-0.5`}>
                                                {cardIsLive ? "NOW" : (forceLabel || "TODAY")}
                                            </span>
                                        </div>

                                        {/* BOTTOM LINE: Hour Range */}
                                        {(cardIsLive || (isHourly && hTime)) ? (
                                            <span className={`text-xs md:text-sm font-bold ${cardIsLive ? 'text-emerald-400' : 'text-blue-400'} font-mono translate-y-1 text-right whitespace-nowrap`}>
                                                {cardIsLive ? (() => {
                                                    const startH = new Date().toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: timeZone }).split(':')[0];
                                                    const nextDate = new Date();
                                                    nextDate.setHours(nextDate.getHours() + 1);
                                                    const nextH = nextDate.toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: timeZone }).split(':')[0];
                                                    return `${startH}:00 - ${nextH}:00`;
                                                })() : (() => {
                                                    const start = new Date(hTime!);
                                                    const end = new Date(hTime!);
                                                    end.setHours(start.getHours() + 1);
                                                    const strictFmt = (d: Date) => {
                                                        const h = d.getHours();
                                                        const m = d.getMinutes().toString().padStart(2, '0');
                                                        return `${h.toString().padStart(2, '0')}:${m}`;
                                                    };
                                                    return `${strictFmt(start)} - ${strictFmt(end)}`;
                                                })()}
                                            </span>
                                        ) : <div className="mt-auto" />}
                                    </div>
                                </div>

                                {/* BOTTOM SECTION (Unified Stats Row) */}
                                <div className="flex flex-row items-center justify-between w-full relative z-10 px-4 py-2 bg-white/5 min-h-[40px] gap-2">
                                    {/* Humidity (Replaces Cloud) */}
                                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                                        <DropletIcon className="w-3.5 h-3.5 text-cyan-400 mb-0.5" />
                                        <span className="text-[10px] font-bold text-white leading-none">{cardData.humidity ? Math.round(cardData.humidity) : '--'}%</span>
                                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">Hum</span>
                                    </div>
                                    <div className="w-px h-4 bg-white/10 shrink-0" />
                                    {/* Visibility (Replaces Rain) */}
                                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                                        <EyeIcon className="w-3.5 h-3.5 text-emerald-400 mb-0.5" />
                                        <span className="text-[10px] font-bold text-white leading-none">{cardDisplayValues.vis}</span>
                                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">Vis NM</span>
                                    </div>
                                    <div className="w-px h-4 bg-white/10 shrink-0" />
                                    {/* Sunrise */}
                                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                                        <SunriseIcon className="w-3.5 h-3.5 text-orange-400 mb-0.5" />
                                        <span className="text-[10px] font-bold text-white leading-none">{cardDisplayValues.sunrise}</span>
                                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">Rise</span>
                                    </div>
                                    <div className="w-px h-4 bg-white/10 shrink-0" />
                                    {/* Sunset */}
                                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                                        <SunsetIcon className="w-3.5 h-3.5 text-indigo-300 mb-0.5" />
                                        <span className="text-[10px] font-bold text-white leading-none">{cardDisplayValues.sunset}</span>
                                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">Set</span>
                                    </div>
                                    <div className="w-px h-4 bg-white/10 shrink-0" />
                                    {/* UV Index */}
                                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                                        <SunIcon className="w-3.5 h-3.5 text-orange-400 mb-0.5" />
                                        <span className="text-[10px] font-bold text-white leading-none">{cardDisplayValues.uv !== '--' ? cardDisplayValues.uv : '0'}</span>
                                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">UV:{cardData.uvIndex}</span>
                                    </div>
                                    <div className="w-px h-4 bg-white/10 shrink-0" />
                                    {/* Pressure */}
                                    <div className="flex flex-col items-center flex-1 min-w-[30px]">
                                        <GaugeIcon className="w-3.5 h-3.5 text-teal-400 mb-0.5" />
                                        <span className="text-[10px] font-bold text-white leading-none">
                                            {cardDisplayValues.pressure && cardDisplayValues.pressure !== '--' ? Math.round(parseFloat(cardDisplayValues.pressure.toString())).toString() : '--'}
                                        </span>
                                        <span className="text-[8px] font-bold text-gray-500 uppercase tracking-wider mt-0.5">PRMSL</span>

                                    </div>
                                </div>
                            </div>

                            {/* WIDGET GRID CONTAINER - 3 Rows (or 1 Row + Tide) */}

                            {/* WIDGET GRID CONTAINER - 3 Rows (or 1 Row + Tide) */}
                            {/* WIDGET GRID CONTAINER - 3 Rows (or 1 Row + Tide) */}
                            {(() => {
                                // HOISTED LOGIC: Determine layout mode early to style Row 1
                                const showTideGraph = (locationType === 'coastal') || (tides && tides.length > 0 && !isLandlocked && locationType !== 'offshore');

                                // Conditional Height Configuration (REFINED STEP 1450):
                                // GOAL: Strict Uniformity & Height Parity.
                                //
                                // Constraint: Row 1 (Wind) naturally requires ~85px to fit content nicely.
                                // If we force it to 76px, it overflows/grows, making it taller than Row 3 (which fits in 76px).
                                // Result: Uneven rows.
                                //
                                // FIX: Set ALL rows to min-h-[85px].
                                //
                                // Offshore Mode:
                                // - 3 Rows @ 85px = 255px
                                // - 2 Gaps @ 6px = 12px
                                // - Total = 267px
                                //
                                // Conditional Height Configuration (FINAL REVERSION STEP 1539):
                                // GOAL: Large, Uniform Boxes (85px) & Total Height Parity.
                                //
                                // User Feedback: "Gone back to smaller boxes" -> Implies 74px was too small/uneven.
                                // Fix: Revert to 85px Uniformity.
                                //
                                // Math:
                                // Offshore: 3 * 85px = 255px + Gaps.
                                // Coastal: 85px (Row 1) + Tide Graph (176px / h-44) + Gaps.
                                // Total: ~267px.
                                //
                                // We accept that Offshore is slightly taller than the "Compressed" 240px version,
                                // but this prioritizes "Uniform Box Size" which seems to be the user's main visual cue.

                                const rowHeightClass = "h-[85px] overflow-hidden";

                                // FIX: Local Visual Time Calculation using Hoisted State
                                // visualTime is now calculated at the top level

                                return (
                                    <>
                                        {/* ROW 1: Wind, Gust, Seas (ALWAYS VISIBLE) */}
                                        <div className="px-0 shrink-0 mt-0.5">
                                            <div className="grid grid-cols-3 gap-1.5 md:gap-2 relative z-10 w-full pb-0">
                                                {['wind', 'gust', 'wave'].map((id: string, idx: number) => {
                                                    const justifyClass = idx === 0 ? 'items-start text-left' : idx === 1 ? 'items-center text-center' : 'items-end text-right';
                                                    const getTheme = (wid: string) => {
                                                        switch (wid) {
                                                            case 'wind': return 'bg-gradient-to-br from-sky-900/40 via-blue-900/20 to-slate-900/10 border-sky-400/20 shadow-sky-900/5';
                                                            case 'gust': return 'bg-gradient-to-br from-orange-900/40 via-amber-900/20 to-red-900/10 border-orange-400/20 shadow-orange-900/5';
                                                            case 'wave': return 'bg-gradient-to-br from-blue-900/40 via-indigo-900/20 to-slate-900/10 border-blue-400/20 shadow-blue-900/5';
                                                            default: return 'bg-black/10 border-white/5';
                                                        }
                                                    };
                                                    const themeClass = getTheme(id);
                                                    return (
                                                        <div key={id} className={`rounded-xl p-2 md:p-3 relative flex flex-col justify-center ${rowHeightClass} backdrop-blur-sm shadow-lg border ${themeClass} ${justifyClass}`}>
                                                            {renderHeroWidget(id, cardData, cardDisplayValues, units, cardIsLive, trends)}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>

                                        {/* CONDITIONAL CONTENT */}
                                        {showTideGraph ? (
                                            // COASTAL: Tide Graph (Height increased to h-44/176px for parity with 3x85px rows)
                                            <div className="w-full h-44 px-0 pb-0 relative mt-1.5 mb-4">
                                                <TideGraph
                                                    tides={tides || []}
                                                    unit={units.tideHeight || 'm'}
                                                    timeZone={timeZone}
                                                    hourlyTides={[]}
                                                    tideSeries={undefined}
                                                    modelUsed="WorldTides"
                                                    unitPref={units}
                                                    customTime={visualTime}
                                                    showAllDayEvents={index > 0 && !customTime}
                                                    stationName={guiDetails?.stationName || "Local Station"}
                                                    secondaryStationName={guiDetails?.stationName}
                                                    guiDetails={guiDetails}
                                                    stationPosition="bottom"
                                                />

                                            </div>
                                        ) : (
                                            // NON-COASTAL: Extra Rows (Uniform Compact Height)
                                            <>
                                                {/* ROW 2: Visibility, Humidity, Pressure */}
                                                <div className="px-0 shrink-0 mt-1.5">
                                                    <div className="flex flex-row gap-1.5 md:gap-2 relative z-10 w-full pb-0">
                                                        {['visibility', 'humidity', 'pressure'].map((id: string, idx: number) => {
                                                            const justifyClass = idx === 0 ? 'items-start text-left' : idx === 1 ? 'items-center text-center' : 'items-end text-right';
                                                            const getTheme = (wid: string) => {
                                                                switch (wid) {
                                                                    case 'visibility': return 'bg-gradient-to-br from-emerald-900/40 via-green-900/20 to-slate-900/10 border-emerald-400/20 shadow-emerald-900/5';
                                                                    case 'humidity': return 'bg-gradient-to-br from-cyan-900/40 via-sky-900/20 to-slate-900/10 border-cyan-400/20 shadow-cyan-900/5';
                                                                    case 'pressure': return 'bg-gradient-to-br from-teal-900/40 via-emerald-900/20 to-slate-900/10 border-teal-400/20 shadow-teal-900/5';
                                                                    default: return 'bg-black/10 border-white/5';
                                                                }
                                                            };
                                                            const themeClass = getTheme(id);
                                                            return (
                                                                <div key={id} className={`flex-1 min-w-[30%] rounded-xl p-2 md:p-3 relative flex flex-col justify-center ${rowHeightClass} shrink-0 backdrop-blur-sm shadow-lg border ${themeClass} ${justifyClass}`}>
                                                                    {renderHeroWidget(id, cardData, cardDisplayValues, units, cardIsLive, trends)}
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                </div>

                                                {/* ROW 3: Sea Temp, Drift, Set */}
                                                <div className="px-0 shrink-0 mt-1.5 mb-6">
                                                    <div className="flex flex-row gap-1.5 md:gap-2 relative z-10 w-full pb-0">
                                                        {['waterTemp', 'currentSpeed', 'currentDirection'].map((id: string, idx: number) => {
                                                            const justifyClass = idx === 0 ? 'items-start text-left' : idx === 1 ? 'items-center text-center' : 'items-end text-right';
                                                            const getTheme = (wid: string) => {
                                                                switch (wid) {
                                                                    case 'waterTemp': return 'bg-gradient-to-br from-blue-900/40 via-cyan-900/20 to-slate-900/10 border-blue-400/20 shadow-blue-900/5';
                                                                    case 'currentSpeed': return 'bg-gradient-to-br from-emerald-900/40 via-teal-900/20 to-slate-900/10 border-emerald-400/20 shadow-emerald-900/5';
                                                                    case 'currentDirection': return 'bg-gradient-to-br from-teal-900/40 via-cyan-900/20 to-slate-900/10 border-teal-400/20 shadow-teal-900/5';
                                                                    default: return 'bg-black/10 border-white/5';
                                                                }
                                                            };
                                                            const themeClass = getTheme(id);
                                                            return (
                                                                <div key={id} className={`flex-1 min-w-[30%] rounded-xl p-2 md:p-3 relative flex flex-col justify-center ${rowHeightClass} shrink-0 backdrop-blur-sm shadow-lg border ${themeClass} ${justifyClass}`}>
                                                                    {renderHeroWidget(id, cardData, cardDisplayValues, units, cardIsLive, trends)}
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                </div>
                                            </>
                                        )}
                                    </>
                                );
                            })()}

                            {/* LEGACY BLOCK REMOVED - Logic moved to Conditional Block above */}



                            {/* BADGES ROW (Tightened Spacing) */}
                            <StatusBadges
                                isLandlocked={isLandlocked || false}
                                locationName={locationName || ''}
                                displaySource={displaySource}
                                nextUpdate={nextUpdate}
                                fallbackInland={false}
                                stationId={effectiveData?.stationId}
                                locationType={locationType}
                            />

                            {/* Location Time (Restored Inside Card) */}
                            <div className="w-full flex justify-center pb-2 pt-2">
                                <LocationClock timeZone={timeZone} />
                            </div>
                        </div>
                    </div >
                </div >
            </div >
        );
    };

    // --- HOISTED TO TOP ---
    // hourlyToRender calculation moved to top for synchronous access





    // --- HORIZONTAL SCROLL MANAGEMENT ---
    // --- HORIZONTAL SCROLL MANAGEMENT ---
    // activeHIdx state moved to top


    // Reset Listener (WX Button)
    useEffect(() => {
        const handleReset = () => {
            if (horizontalScrollRef.current) {
                horizontalScrollRef.current.scrollTo({ left: 0, behavior: 'smooth' });
                setActiveHIdx(0);
            }
        };
        window.addEventListener('hero-reset-scroll', handleReset);
        return () => window.removeEventListener('hero-reset-scroll', handleReset);
    }, []);

    // Emit Time Selection on horizontal scroll
    // FIXED: Discrete "Snap" Logic (High Performance)
    // Instead of continuous updates (which felt sluggish due to React overhead),
    // we only update when the card explicitly snaps to a new index.
    const handleHScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const x = e.currentTarget.scrollLeft;
        const w = e.currentTarget.clientWidth;

        // Calculate new Snap Index
        const newIdx = Math.round(x / w);

        // Only update if index CHANGED (Discrete Step)
        if (newIdx !== activeHIdx) {
            setActiveHIdx(newIdx);

            if (!onTimeSelect || !isVisible) return;

            // Calculate Target Time based on Index
            let targetTime: number | undefined = undefined;

            if (index === 0) {
                // TODAY ROW
                if (newIdx === 0) {
                    // "Now" Card -> Live Time
                    targetTime = undefined;
                } else {
                    // Hourly Cards (Offset by 1 because of "Now" card)
                    const hItem = hourlyToRender[newIdx - 1];
                    if (hItem) targetTime = new Date(hItem.time).getTime();
                }
            } else {
                // FORECAST ROW
                // Direct mapping (No "Now" card)
                const hItem = hourlyToRender[newIdx];
                if (hItem) targetTime = new Date(hItem.time).getTime();
            }

            // INSTANT UPDATE (No Debounce)
            onTimeSelect(targetTime);
        }
    };

    // REMOVED: Effect-based time selection (replaced by scroll handler)
    /*
    useEffect(() => {
        if (!onTimeSelect || !isVisible) return;
        if (index === 0) {
            if (activeHIdx === 0) onTimeSelect(undefined);
            else {
                const hItem = hourlyToRender[activeHIdx - 1];
                if (hItem) onTimeSelect(new Date(hItem.time).getTime());
            }
        } else {
            const hItem = hourlyToRender[activeHIdx];
            if (hItem) onTimeSelect(new Date(hItem.time).getTime());
        }
    }, [activeHIdx, index, hourlyToRender, onTimeSelect, isVisible]);
    */

    const totalCards = 1 + hourlyToRender.length;

    return (
        <div className="w-full min-w-full h-auto relative flex flex-col justify-start">
            <div className="relative w-full h-auto rounded-3xl overflow-hidden backdrop-blur-md flex flex-col border-none bg-transparent shadow-2xl shrink-0">

                {/* HORIZONTAL CAROUSEL WRAPPER (Inner Axis) */}
                <div
                    ref={horizontalScrollRef}
                    onScroll={handleHScroll}
                    className="relative z-10 w-full h-auto shrink-0 overflow-x-auto scrollbar-hide flex flex-row pointer-events-auto snap-x snap-mandatory pb-0"
                >

                    {/* 1. MAIN DAY CARD (Only for Today/Index 0) */}
                    {/* FIX: Use displayData which has the LIVE HOUR override applied */}
                    {index === 0 && (
                        <div className="w-full h-full snap-start shrink-0">
                            {renderCard(displayData as WeatherMetrics, false, undefined, rowDateLabel)}
                        </div>
                    )}

                    {/* 2. HOURLY CARDS */}
                    {hourlyToRender.map((h, i) => {
                        const hMetrics: WeatherMetrics = {
                            ...displayData, // Inherit from effective data (e.g. sunset/sunrise/location)
                            airTemperature: h.temperature,
                            condition: h.condition,
                            precipitation: h.precipitation ?? 0,
                            cloudCover: h.cloudCover ?? 0,
                            uvIndex: h.uvIndex ?? 0,
                            pressure: h.pressure ?? 1013,
                            windSpeed: h.windSpeed ?? 0,
                            windGust: h.windGust ?? 0,
                            windDirection: h.windDirection || 'N',
                            windDegree: h.windDirection ? 0 : 0, // Simplified
                            waveHeight: h.waveHeight ?? 0,
                            swellPeriod: h.swellPeriod ?? 0,
                            feelsLike: h.feelsLike ?? h.temperature,
                            humidity: h.humidity ?? 80,
                            visibility: h.visibility ?? 10,
                            currentSpeed: h.currentSpeed ?? 0,
                            currentDirection: h.currentDirection ?? 0,
                            waterTemperature: h.waterTemperature ?? 0,
                        };
                        return <div key={i} className="w-full h-full snap-start shrink-0">{renderCard(hMetrics, true, new Date(h.time).getTime(), rowDateLabel)}</div>
                    })}

                    {/* Buffer for bounce */}
                    <div className="w-1 h-1 shrink-0 snap-align-none" />
                </div>

                {totalCards > 1 && (
                    <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1 z-20 pointer-events-none p-1 rounded-full bg-black/20 backdrop-blur-sm">
                        {Array.from({ length: totalCards }).map((_, i) => (
                            <div
                                key={i}
                                className={"rounded-full transition-all duration-300 " + (i === activeHIdx ? 'bg-sky-400 w-1.5 h-1.5' : 'bg-white/20 w-1 h-1')}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}); // END React.memo

// Display name for debugging
(HeroSlide as any).displayName = 'HeroSlide';


