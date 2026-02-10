import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { t } from '../../theme';
import { TideGraph } from './TideAndVessel';
import { MapIcon, StarIcon, DropletIcon, EyeIcon, SunIcon, ThermometerIcon, GaugeIcon, CompassIcon, WindIcon, CloudIcon, RainIcon, WaveIcon } from '../Icons';
import { UnitPreferences, WeatherMetrics, ForecastDay, VesselProfile, Tide, TidePoint, HourlyForecast, UserSettings, SourcedWeatherMetrics } from '../../types';
import { TideGUIDetails } from '../../services/weather/api/tides';
import { convertTemp, convertSpeed, convertLength, convertPrecip, calculateApparentTemp, convertDistance, getTideStatus, calculateDailyScore, getSailingScoreColor, getSailingConditionText, degreesToCardinal, convertMetersTo, formatCoordinate } from '../../utils';
import { ALL_STATIONS } from '../../services/TideService';
import { useSettings } from '../../context/SettingsContext';
import { useUI } from '../../context/UIContext';
import { useEnvironment } from '../../context/ThemeContext';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { ALL_HERO_WIDGETS } from '../WidgetDefinitions';
import { StatusBadges } from './StatusBadges';
import { TimerBadge } from './TimerBadge';
import { Countdown } from './Countdown';
import { LocationClock } from './LocationClock';
import { useWeather } from '../../context/WeatherContext';
import { generateWeatherNarrative, getMoonPhase } from './WeatherHelpers';
import { SourceLegend } from '../SourceLegend';
import { renderHeroWidget, formatTemp, formatCondition, renderHighLow, STATIC_WIDGET_CLASS, getSourceIndicatorColor } from './hero/HeroWidgets';

// --- HERO SLIDE COMPONENT (Individual Day Card) ---
const HeroSlideComponent = ({
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
    onHourChange,
    onActiveDataChange,
    isVisible = false,
    utcOffset,
    tideHourly,
    isEssentialMode = false
}: {
    data: SourcedWeatherMetrics,
    index: number,
    units: UnitPreferences,
    tides?: Tide[],
    settings: UserSettings,
    updateSettings: (newSettings: Partial<UserSettings>) => void,
    addDebugLog: ((msg: string) => void) | undefined,
    timeZone?: string,
    locationName?: string,
    isLandlocked?: boolean,
    displaySource: string,
    vessel?: VesselProfile,
    customTime?: number,
    hourly?: HourlyForecast[],
    fullHourly?: HourlyForecast[],
    lat?: number,
    guiDetails?: TideGUIDetails,
    coordinates?: { lat: number, lon: number },
    locationType?: 'coastal' | 'offshore' | 'inland',
    generatedAt?: string,
    onTimeSelect?: (time: number | undefined) => void,
    onHourChange?: (hour: number) => void,
    onActiveDataChange?: (data: SourcedWeatherMetrics) => void,
    isVisible?: boolean,
    utcOffset?: number,
    tideHourly?: TidePoint[],
    isEssentialMode?: boolean
}) => {
    const { nextUpdate, weatherData } = useWeather();
    const forecast = weatherData?.forecast || [];

    // 1. STATE HOISTING (Zero-Latency Architecture)
    // We define the scroll state AT THE TOP so it drives the entire component synchronously.
    const [activeHIdx, setActiveHIdx] = useState(0);

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
                const futureHourly = hourly.filter(h => {
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
                }).sort((a, b) => (new Date(a.time).getTime() - new Date(b.time).getTime()));

                return futureHourly;
            } else {
                // FORECAST: 00:00 to 23:00 (Already filtered by day in Hero.tsx, just return all)
                return hourly.slice().sort((a, b) => (new Date(a.time).getTime() - new Date(b.time).getTime()));
            }
        } catch (err) {
            return [];
        }
    }, [hourly, index, timeZone]);

    // --- RESTORED HELPERS ---
    const rowHeightClass = "min-h-[52px] sm:flex-1";

    // FIX: Offshore should show 3x3 Grid, not Tide Graph (unless Coastal)
    const showTideGraph = locationType === 'coastal' && !isLandlocked && tides && tides.length > 0;
    const showGrid = !showTideGraph; // Explicit switch
    const env = useEnvironment();
    const isCompact = env === 'onshore';


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

    const isLive = index === 0 && activeHIdx === 0;

    // FIX: Live Data Override using Hourly Array
    // This ensures that if the app is open for hours (or data fetched earlier), 
    // we show the forecast for the *current wall-clock hour* rather than the fetch-time snapshot.
    const effectiveData = useMemo(() => {
        // Use fullHourly if available (preferred for timezone safety), else fallback to filtered hourly
        // BUT: fullHourly doesn't have OpenMeteo UV injection, so ALWAYS use hourly for data lookups
        const sourceHourly = hourly;

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
            return {
                ...data, // Keep base data structure
                // STABILIZATION: Ensure WE NEVER RETURN UNDEFINED for these critical fields
                uvIndex: currentSlot.uvIndex ?? data.uvIndex ?? 0,
                precipitation: currentSlot.precipitation ?? 0,
                feelsLike: currentSlot.feelsLike ?? currentSlot.temperature ?? data.airTemperature,
                cloudCover: currentSlot.cloudCover ?? data.cloudCover ?? 0,
                humidity: currentSlot.humidity ?? data.humidity ?? 0,
                visibility: currentSlot.visibility ?? data.visibility ?? 10,

                // Wind/Marine overrides
                currentSpeed: currentSlot.currentSpeed ?? data.currentSpeed,
                currentDirection: currentSlot.currentDirection ?? data.currentDirection,
                waterTemperature: currentSlot.waterTemperature ?? data.waterTemperature,


                // Display Values
                windSpeed: currentSlot.windSpeed ?? data.windSpeed,
                windGust: currentSlot.windGust ?? data.windGust,
                windDirection: currentSlot.windDirection ?? data.windDirection, // Keep string if available
                waveHeight: currentSlot.waveHeight ?? data.waveHeight,
                pressure: currentSlot.pressure ?? data.pressure
            };
        }

        // Fallback: Try to find UV from the closest hourly slot when exact match fails
        const closestHour = sourceHourly.reduce((best, h) => {
            const t = new Date(h.time).getTime();
            const bestT = best ? new Date(best.time).getTime() : Infinity;
            return Math.abs(t - now) < Math.abs(bestT - now) ? h : best;
        }, null as typeof sourceHourly[0] | null);

        return {
            ...data,
            uvIndex: closestHour?.uvIndex ?? data.uvIndex ?? 0,
            waterTemperature: closestHour?.waterTemperature ?? data.waterTemperature
        };
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
            // STABILIZATION: If exact match fails (e.g. slight time drift), 
            // try to find the Closest slot instead of giving up.
            // This prevents "flickering" arrows during scroll transitions.
            let minDiff = Infinity;
            let bestIdx = -1;
            fullHourly.forEach((h, i) => {
                const t = new Date(h.time).getTime();
                const diff = Math.abs(t - now);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestIdx = i;
                }
            });

            // Allow if within 2 hours
            if (minDiff < 7200000 && bestIdx !== -1) {
                currentIndex = bestIdx;
            } else {
                return undefined;
            }
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

        // Final Safety
        if (!baseItem) return undefined;

        const prev = baseItem;

        const getTrend = (curr?: number | null, old?: number | null, threshold = 0): 'rising' | 'falling' | 'steady' => {
            // STABILIZATION: Treat 0 as a valid number, check for null/undefined strictly
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
        };
    }, [effectiveData, fullHourly, visualTime]);

    // Debug Log for Trends
    // console.log('[TRENDS DEBUG]', { index, hasFullHourly: !!fullHourly, len: fullHourly?.length, trends });

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
                horizontalScrollRef.current.scrollTo({ left: 0 });
            }
            // Sync ref and state with reset
            lastScrollIdxRef.current = 0;
            setActiveHIdx(0);
            // Also propagate the live data immediately
            if (onTimeSelect) {
                onTimeSelect(undefined); // undefined = live/now
            }
        };
        window.addEventListener('hero-reset-scroll', handleReset);
        return () => {
            window.removeEventListener('hero-reset-scroll', handleReset);
            // Clean up any pending rAF on unmount
            if (scrollRafRef.current) {
                cancelAnimationFrame(scrollRafRef.current);
            }
        };
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
        highTemp: displayData.highTemp !== undefined ? convertTemp(displayData.highTemp, units.temp) : '--',
        lowTemp: displayData.lowTemp !== undefined ? convertTemp(displayData.lowTemp, units.temp) : '--',
        windSpeed: hasWind ? Math.round(convertSpeed(displayData.windSpeed!, units.speed)!) : '--',
        waveHeight: isLandlocked ? "0" : (hasWave ? String(convertLength(displayData.waveHeight, units.length)).replace(/^0\./, '.') : '--'),
        vis: displayData.visibility ? convertDistance(displayData.visibility, units.visibility || 'nm') : '--',
        gusts: hasWind ? Math.round(convertSpeed(rawGust!, units.speed)!) : '--',
        precip: convertPrecip(displayData.precipitation, units.length) ?? '0',
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
                            <span className="text-sm font-bold uppercase tracking-widest text-cyan-200">Humidity</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-3xl font-black text-white">{displayValues.humidity}</span>
                            <span className="text-sm text-gray-400 font-medium">%</span>
                        </div>
                    </div>

                    {/* Visibility */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <EyeIcon className="w-3 h-3 text-emerald-400" />
                            <span className="text-sm font-bold uppercase tracking-widest text-emerald-200">Visibility</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-3xl font-black text-white">{displayValues.vis}</span>
                            <span className="text-sm text-gray-400 font-medium">{units.visibility}</span>
                        </div>
                    </div>

                    {/* UV/Pressure */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <SunIcon className="w-3 h-3 text-orange-400" />
                            <span className="text-sm font-bold uppercase tracking-widest text-orange-200">UV Index</span>
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
                            <span className="text-sm font-bold uppercase tracking-widest text-blue-200">Water</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-3xl font-black text-white">
                                {displayValues.waterTemperature}
                            </span>
                            <span className="text-sm text-gray-400 font-medium">°{units.temp}</span>
                        </div>
                    </div>

                    {/* Set (Current Speed) */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <GaugeIcon className="w-3 h-3 text-violet-400" />
                            <span className="text-sm font-bold uppercase tracking-widest text-violet-200">Drift</span>
                        </div>
                        <div className="flex items-baseline gap-0.5">
                            <span className="text-3xl font-black text-white">{displayValues.currentSpeed}</span>
                            <span className="text-sm text-gray-400 font-medium">kts</span>
                        </div>
                    </div>

                    {/* Drift (Current Direction) */}
                    <div className={STATIC_WIDGET_CLASS}>
                        <div className="flex items-center gap-1.5 mb-1 opacity-70">
                            <CompassIcon rotation={0} className="w-3 h-3 text-violet-400" />
                            <span className="text-sm font-bold uppercase tracking-widest text-violet-200">Set</span>
                        </div>
                        <div className="flex flex-col justify-center">
                            <span className="text-3xl font-black text-white">
                                {displayValues.currentDirection}
                            </span>
                        </div>
                        <div className="mt-auto pt-1 text-sm md:text-sm text-violet-300 font-bold opacity-80 text-center">
                            {(() => {
                                const val = displayValues.currentDirection;
                                // Extract degrees from cardinal direction if present
                                return 'True';
                            })()}
                        </div>
                    </div>
                </div>
            );
        }
        if (!tides || tides.length === 0) return null;

        return (
            <div className="w-full h-36 px-0 pb-0 relative mb-8 transition-all duration-300 ease-in-out">
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
                        <span className="text-sm md:text-sm font-bold uppercase tracking-widest text-orange-200">Sun Phz</span>
                    </div>
                    <div className="flex flex-col justify-center">
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-orange-300 font-bold uppercase mr-1">Rise</span>
                            <span className="text-base md:text-lg font-black tracking-tighter text-white">{displayValues.sunrise}</span>
                        </div>
                        <div className="w-full h-px bg-white/5 my-0.5"></div>
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-purple-300 font-bold uppercase mr-1">Set</span>
                            <span className="text-base md:text-lg font-black tracking-tighter text-white">{displayValues.sunset}</span>
                        </div>
                    </div>
                    <LocationClock timeZone={timeZone} utcOffset={utcOffset} />
                </div>
            );
        }

        if (topWidgetId === 'score') {
            return (
                <div className="flex flex-col h-full justify-between">
                    <div className="flex items-center gap-1.5 mb-0.5 opacity-70">
                        <StarIcon className="w-3 h-3 text-yellow-400" />
                        <span className="text-sm md:text-sm font-bold uppercase tracking-widest text-yellow-200">Boating</span>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                        <span className="text-3xl md:text-5xl font-black tracking-tighter text-white">{score}</span>
                        <span className="text-sm md:text-sm font-medium text-gray-400">/100</span>
                    </div>
                    <div className={`mt-auto pt-1 text-sm md: text-sm font-bold px-1.5 py-0.5 rounded w-fit ${scoreColor} `}>
                        {scoreText}
                    </div>
                </div>
            );
        }

        // Use Common Renderer
        const customWidget = renderHeroWidget(topWidgetId, data, displayValues, units, isLive, undefined, 'left', isLive ? (displayData as SourcedWeatherMetrics).sources : undefined, isCompact);
        if (customWidget) {
            return customWidget;
        }
        return null;
    };

    // --- RENDER LOOP PREPARATION ---
    // CRITICAL FIX: Do NOT early-return before hooks — it violates React's Rules of Hooks.
    // Instead, guard inside each hook and move the fallback UI to just before the final JSX return.

    const slides = useMemo(() => {
        if (!data) return [];
        return [
            // Only include "current" slide for TODAY (index 0)
            ...(index === 0 ? [{ type: 'current', data: data, time: undefined as number | undefined }] : []),
            ...(hourlyToRender || []).map(h => {
                // Find matching daily forecast for High/Low
                const hDate = new Date(h.time);
                const hDayStr = hDate.toLocaleDateString('en-CA'); // YYYY-MM-DD
                const matchDay = forecast.find(d => d.isoDate === hDayStr || d.date === hDayStr);

                return {
                    type: 'hourly',
                    data: {
                        ...h,
                        airTemperature: h.temperature, // Map for compatibility
                        feelsLike: h.feelsLike,
                        windSpeed: h.windSpeed,
                        waveHeight: h.waveHeight,
                        highTemp: matchDay?.highTemp, // Inject Daily High
                        lowTemp: matchDay?.lowTemp,    // Inject Daily Low
                        sunrise: matchDay?.sunrise || data.sunrise, // Inherit from daily or base data
                        sunset: matchDay?.sunset || data.sunset     // Inherit from daily or base data
                    } as unknown as SourcedWeatherMetrics,
                    time: hDate.getTime()
                };
            })
        ];
    }, [index, data, hourlyToRender, forecast]);

    // Phase 2 Optimization: Pre-compute display values for all slides
    // This avoids recalculating on every scroll/render
    const slideDisplayData = useMemo(() => slides.map((slide, slideIdx) => {
        const cardData = slide.data as SourcedWeatherMetrics;
        const cardTime = slide.type === 'current' ? undefined : (slide.time || customTime);
        const isHourly = slide.type === 'hourly';

        // Pre-compute sunPhase
        const sunPhase = (() => {
            if (!cardData) return { isDay: true, label: 'Sunset', time: '--:--' };
            const currentTs = cardTime || Date.now();
            const sRise = cardData.sunrise;
            const sSet = cardData.sunset;
            const fallbackCheck = () => {
                const h = new Date(currentTs).getHours();
                return { isDay: h >= 6 && h < 18, label: h >= 6 && h < 18 ? 'Sunset' : 'Sunrise', time: '--:--' };
            };
            if (!sRise || !sSet || sRise === '--:--' || sSet === '--:--') return fallbackCheck();
            try {
                const [rH, rM] = sRise.replace(/[^0-9:]/g, '').split(':').map(Number);
                const [sH, sM] = sSet.replace(/[^0-9:]/g, '').split(':').map(Number);
                if (isNaN(rH) || isNaN(sH)) return fallbackCheck();
                const d = new Date(currentTs);
                const riseDt = new Date(d); riseDt.setHours(rH, rM, 0);
                const setDt = new Date(d); setDt.setHours(sH, sM, 0);
                if (d < riseDt) return { isDay: false, label: 'Sunrise', time: sRise };
                if (d >= riseDt && d < setDt) return { isDay: true, label: 'Sunset', time: sSet };
                return { isDay: false, label: 'Sunrise', time: sRise };
            } catch (e) {
                return fallbackCheck();
            }
        })();

        // Pre-compute display values
        const cardDisplayValues = {
            airTemp: cardData.airTemperature !== null ? convertTemp(cardData.airTemperature, units.temp) : '--',
            highTemp: cardData.highTemp !== undefined ? convertTemp(cardData.highTemp, units.temp) : '--',
            lowTemp: cardData.lowTemp !== undefined ? convertTemp(cardData.lowTemp, units.temp) : '--',
            windSpeed: cardData.windSpeed !== null && cardData.windSpeed !== undefined ? Math.round(convertSpeed(cardData.windSpeed, units.speed)!) : '--',
            waveHeight: isLandlocked ? "0" : (cardData.waveHeight !== null && cardData.waveHeight !== undefined ? String(convertLength(cardData.waveHeight, units.waveHeight)).replace(/^0\./, '.') : '--'),
            vis: cardData.visibility ? convertDistance(cardData.visibility, units.visibility || 'nm') : '--',
            gusts: cardData.windSpeed !== null ? Math.round(convertSpeed((cardData.windGust ?? (cardData.windSpeed * 1.3)), units.speed)!) : '--',
            precip: convertPrecip(cardData.precipitation, units.length) ?? '0',
            pressure: cardData.pressure ? Math.round(cardData.pressure) : '--',
            cloudCover: (cardData.cloudCover !== null && cardData.cloudCover !== undefined) ? Math.round(cardData.cloudCover) : '--',
            uv: cardData.uvIndex !== undefined ? Math.round(cardData.uvIndex) : '--',
            sunrise: cardData.sunrise,
            sunset: cardData.sunset,
            humidity: (cardData.humidity !== undefined && cardData.humidity !== null) ? Math.round(cardData.humidity) : '--',
            dewPoint: (cardData.dewPoint !== undefined && cardData.dewPoint !== null) ? convertTemp(cardData.dewPoint, units.temp) : '--',
            waterTemperature: (() => {
                const val = cardData.waterTemperature;
                return (val !== undefined && val !== null) ? convertTemp(val, units.temp) : '--';
            })(),
            currentSpeed: (cardData.currentSpeed !== undefined && cardData.currentSpeed !== null) ? Number(cardData.currentSpeed).toFixed(1) : '--',
            currentDirection: (() => {
                const val = cardData.currentDirection;
                if (typeof val === 'number') return degreesToCardinal(val);
                if (typeof val === 'string') return val.replace(/[\d.°]+/g, '').trim() || val;
                return '--';
            })(),
            moon: cardData.moonPhase || 'Waxing'
        };

        const isCardDay = (!isHourly && index > 0) ? true : sunPhase.isDay;
        const cardIsLive = !isHourly && index === 0;

        return { sunPhase, cardDisplayValues, isCardDay, cardIsLive, isHourly, cardData, cardTime };
    }), [slides, units, isLandlocked, index]);    // Calculate active slide data for static displays
    // Always track the actively scrolled card for header updates
    const activeSlide = slides[activeHIdx] || slides[0];
    const activeCardData = activeSlide?.data as SourcedWeatherMetrics;
    const activeCardTime = activeSlide?.time || customTime;
    const activeIsLive = index === 0 && activeHIdx === 0;

    // Calculate sunPhase for the active card for the static header's background
    const activeSunPhase = (() => {
        if (!activeCardData) return { isDay: true, label: 'Sunset', time: '--:--' };

        const currentTs = activeCardTime || Date.now();
        const sRise = activeCardData.sunrise;
        const sSet = activeCardData.sunset;
        const fallbackCheck = () => {
            const h = new Date(currentTs).getHours();
            return { isDay: h >= 6 && h < 18, label: h >= 6 && h < 18 ? 'Sunset' : 'Sunrise', time: '--:--' };
        };
        if (!sRise || !sSet || sRise === '--:--' || sSet === '--:--') return fallbackCheck();

        try {
            const [rH, rM] = sRise.replace(/[^0-9:]/g, '').split(':').map(Number);
            const [sH, sM] = sSet.replace(/[^0-9:]/g, '').split(':').map(Number);
            if (isNaN(rH) || isNaN(sH)) return fallbackCheck();

            const d = new Date(currentTs);
            const riseDt = new Date(d); riseDt.setHours(rH, rM, 0);
            const setDt = new Date(d); setDt.setHours(sH, sM, 0);

            if (d < riseDt) return { isDay: false, label: 'Sunrise', time: sRise };
            if (d >= riseDt && d < setDt) return { isDay: true, label: 'Sunset', time: sSet };
            return { isDay: false, label: 'Sunrise', time: sRise };
        } catch (e) {
            return fallbackCheck();
        }
    })();
    const activeIsCardDay = (!activeIsLive && index > 0) ? true : activeSunPhase.isDay;

    // Calculate display values for static widgets based on activeCardData
    // These values will update if dynamicHeaderMetrics is enabled
    const hasActiveWind = activeCardData?.windSpeed !== null && activeCardData?.windSpeed !== undefined;
    const rawActiveGust = activeCardData?.windGust || ((activeCardData?.windSpeed || 0) * 1.3);
    const hasActiveWave = activeCardData?.waveHeight !== null && activeCardData?.waveHeight !== undefined;

    const staticDisplayValues = {
        airTemp: activeCardData?.airTemperature !== null ? convertTemp(activeCardData?.airTemperature || 0, units.temp) : '--',
        windSpeed: hasActiveWind ? Math.round(convertSpeed(activeCardData.windSpeed!, units.speed)!) : '--',
        waveHeight: isLandlocked ? "0" : (hasActiveWave ? String(convertLength(activeCardData.waveHeight, units.length)).replace(/^0\./, '.') : '--'),
        vis: activeCardData?.visibility ? convertDistance(activeCardData.visibility, units.visibility || 'nm') : '--',
        gusts: hasActiveWind ? Math.round(convertSpeed(rawActiveGust!, units.speed)!) : '--',
        pressure: activeCardData?.pressure ? Math.round(activeCardData.pressure) : '--',
        uv: (activeCardData?.uvIndex !== undefined && activeCardData?.uvIndex !== null) ? Math.round(activeCardData.uvIndex) : '--',
        humidity: (activeCardData?.humidity !== undefined && activeCardData?.humidity !== null) ? Math.round(activeCardData.humidity) : '--',
        waterTemperature: activeCardData?.waterTemperature !== undefined && activeCardData?.waterTemperature !== null ? convertTemp(activeCardData.waterTemperature, units.temp) : '--',
        currentSpeed: activeCardData?.currentSpeed !== undefined && activeCardData?.currentSpeed !== null ? Number(activeCardData.currentSpeed).toFixed(1) : '--',
        currentDirection: (() => {
            const val = activeCardData?.currentDirection;
            if (typeof val === 'number') return degreesToCardinal(val);
            if (typeof val === 'string') return val.replace(/[\d.°]+/g, '').trim() || val;
            return '--';
        })()
    };

    // Get source colors for static header metrics
    // Shows amber (StormGlass), emerald (Buoy), or white (forecast)
    const getActiveSourceColor = (metricKey: keyof WeatherMetrics): string => {
        // When showing forecast data (not live), always use white
        if (!activeIsLive) {
            return 'text-white';
        }
        // Live data - check if source info is available
        const liveSources = activeCardData?.sources;
        if (!liveSources || !liveSources[metricKey]) return 'text-white';

        const sourceColor = liveSources[metricKey]?.sourceColor;
        switch (sourceColor) {
            case 'emerald': return 'text-emerald-400';  // Buoy
            case 'amber': return 'text-amber-400';      // StormGlass
            default: return 'text-white';
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
    const handleHorizontalScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
        const container = e.currentTarget;
        const scrollLeft = container.scrollLeft;
        const cardWidth = container.clientWidth;
        const newIdx = Math.round(scrollLeft / cardWidth);

        // Only update state if the index actually changed
        if (newIdx !== lastScrollIdxRef.current && newIdx >= 0 && newIdx < slides.length) {
            lastScrollIdxRef.current = newIdx;
            setActiveHIdx(newIdx);
            // Update hour index directly — avoids triggering Dashboard state via onTimeSelect
            if (onHourChange) {
                onHourChange(newIdx);
            }
            // INSTANT UPDATE: Propagate active card data immediately without waiting for useEffect
            // This eliminates one render cycle delay for temp/description updates
            if (onActiveDataChange && isVisible) {
                const newActiveData = slides[newIdx]?.data as WeatherMetrics;
                if (newActiveData) {
                    onActiveDataChange(newActiveData);
                }
            }
        }
    }, [slides, onHourChange, onActiveDataChange, isVisible]);

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



            {/* ========== SCROLLABLE HORIZONTAL CAROUSEL ========== */}
            <div className="absolute inset-0 overflow-y-auto overflow-x-hidden no-scrollbar">
                <div
                    ref={horizontalScrollRef}
                    onScroll={handleHorizontalScroll}
                    className="w-full h-full overflow-x-auto snap-x snap-mandatory no-scrollbar flex flex-row"
                    style={{ willChange: 'scroll-position' }}
                >
                    {slides.map((slide, slideIdx) => {
                        // Use pre-computed display data from memoized array
                        const precomputed = slideDisplayData[slideIdx];
                        // Guard against undefined precomputed data (race condition safety)
                        if (!precomputed) return null;
                        const { sunPhase, cardDisplayValues, isCardDay, cardIsLive, isHourly, cardData, cardTime } = precomputed;
                        // Gate chart rendering: only render Recharts for the visible day slide
                        // Off-screen day slides don't render charts (prevents width(-1) warnings)
                        // NOTE: Do NOT gate on horizontal card proximity (activeHIdx) — that causes
                        // TideGraph to unmount/remount on every scroll frame, producing flicker.
                        const shouldRenderChart = isVisible;
                        const forceLabel = rowDateLabel;

                        // Helper to get source color for card metrics (kept inline as it's lightweight)
                        const cardSources = cardData.sources;
                        const getCardSourceColor = (metricKey: keyof WeatherMetrics): string => {
                            // Only show source colors on the live/current card (index 0)
                            // All forecast cards should be white since they're all from StormGlass
                            if (!cardIsLive) return 'text-white';
                            if (!cardSources || !cardSources[metricKey]) return 'text-white';
                            const sourceColor = cardSources[metricKey]?.sourceColor;
                            switch (sourceColor) {
                                case 'emerald': return 'text-emerald-400';  // Buoy
                                case 'amber': return 'text-amber-400';      // StormGlass
                                default: return 'text-white';               // Fallback
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
                                <div className={`relative w-full h-full rounded-2xl overflow-hidden flex flex-col gap-2 border bg-white/[0.04] backdrop-blur-xl shadow-[0_0_30px_-5px_rgba(0,0,0,0.3)] ${isCardDay ? 'border-white/[0.08]' : 'border-indigo-300/[0.08]'}`}>
                                    {/* BG Gradient */}
                                    <div className="absolute inset-0 z-0 pointer-events-none">
                                        <div className={`absolute inset-0 bg-gradient-to-br ${isCardDay ? 'from-sky-500/[0.06] via-transparent to-blue-500/[0.04]' : 'from-indigo-500/[0.08] via-transparent to-purple-500/[0.04]'}`} />
                                    </div>



                                    {/* 2. MAIN CONTENT */}
                                    <div className="relative w-full flex-1 min-h-0 overflow-hidden flex flex-col justify-start">
                                        {showTideGraph ? (
                                            <div className="flex flex-col w-full h-full">
                                                {/* Row 1: Small Widgets (hidden in Essential mode) */}
                                                {!isEssentialMode && (
                                                    <div className="px-0 shrink-0 mt-0.5 sm:flex sm:flex-col sm:justify-center">
                                                        <div className="grid grid-cols-3 gap-2 relative z-10 w-full pb-0">
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
                                                                    <div
                                                                        key={id}
                                                                        className={`rounded-xl p-2 sm:p-3 relative flex flex-col justify-center ${rowHeightClass} shadow-lg border ${themeClass} ${justifyClass}`}
                                                                    >
                                                                        {renderHeroWidget(id, cardData, cardDisplayValues, units, !isHourly, trends, idx === 0 ? 'left' : idx === 1 ? 'center' : 'right', isLive ? (displayData as SourcedWeatherMetrics).sources : undefined, isCompact)}
                                                                    </div>
                                                                )
                                                            })}
                                                        </div>
                                                    </div>
                                                )}

                                                {/* Tide Graph: Fills ALL Remaining Space */}
                                                {/* Only show Tide Graph on Main Card (idx 0) or if we want it everywhere? Usually just Main. 
                                            Let's show it on all for consistency if data exists, otherwise blank space is weird. */}
                                                <div className="flex-1 min-h-0 w-full relative transition-all duration-300 ease-in-out">
                                                    {shouldRenderChart ? (
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
                                                            stationName={guiDetails?.stationName || "Local Station"}
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
                                        ) : (
                                            /* INLAND / OFFSHORE LAYOUT */
                                            <div className="w-full max-h-full flex flex-col justify-start gap-1 overflow-y-auto safe-bottom">
                                                <div className="grid grid-cols-3 gap-2 w-full px-2 auto-rows-min">
                                                    {(() => {
                                                        const OFFSHORE_WIDGETS = ['wind', 'gust', 'wave', 'pressure', 'visibility', 'precip', 'waterTemperature', 'currentSpeed', 'currentDirection'];
                                                        const INLAND_WIDGETS = ['wind', 'gust', 'uv', 'pressure', 'humidity', 'precip', 'sunrise', 'sunset', 'moon'];

                                                        const widgets = (locationType === 'inland' || isLandlocked) ? INLAND_WIDGETS : OFFSHORE_WIDGETS;

                                                        return widgets.map((id: string, idx: number) => {
                                                            const align = idx % 3 === 0 ? 'left' : idx % 3 === 1 ? 'center' : 'right';
                                                            const justifyClass = align === 'left' ? 'items-start' : align === 'center' ? 'items-center' : 'items-end';

                                                            return (
                                                                <div
                                                                    key={id}
                                                                    className={`bg-white/[0.06] backdrop-blur-sm rounded-xl p-2 ${t.border.default} flex flex-col justify-center ${justifyClass}`}
                                                                >
                                                                    {renderHeroWidget(id, cardData, cardDisplayValues, units, !isHourly, trends, align, isLive ? (displayData as SourcedWeatherMetrics).sources : undefined, isCompact)}
                                                                </div>
                                                            );
                                                        });
                                                    })()}
                                                </div>
                                            </div>
                                        )}
                                    </div>


                                </div>
                            </div >
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

// Wrap with React.memo for performance - prevents re-renders when props haven't changed
export const HeroSlide = React.memo(HeroSlideComponent);
