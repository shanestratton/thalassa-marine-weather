
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { t } from '../theme';
import { useDashboardController } from '../hooks/useDashboardController';
import { ClockIcon } from './Icons';
import { HeroSection } from './dashboard/Hero';
import { TideWidget, SunMoonWidget } from './dashboard/TideAndVessel';
import { CompactHeaderRow } from './dashboard/CompactHeaderRow';
import { StatusBadges } from './dashboard/StatusBadges';
import { getMoonPhase } from './dashboard/WeatherHelpers';
import { AdviceWidget } from './dashboard/Advice';
const LogPage = React.lazy(() => import('../pages/LogPage').then(m => ({ default: m.LogPage })));
import { HeroHeader } from './dashboard/HeroHeader';
import { HeroWidgets } from './dashboard/HeroWidgets';
import { CurrentConditionsCard } from './dashboard/CurrentConditionsCard';
import { RainForecastCard } from './dashboard/RainForecastCard';
import { useSettings } from '../context/SettingsContext';
import { GestureTutorial, useTutorial } from './ui/GestureTutorial';
import { DashboardSkeleton, HeroWidgetsSkeleton } from './ui/Skeleton';

import { DashboardWidgetContext, DashboardWidgetContextType } from './WidgetRenderer';
import { UnitPreferences, WeatherMetrics, SourcedWeatherMetrics } from '../types';
import { fetchMinutelyRain, MinutelyRain } from '../services/weather/api/tomorrowio';

interface DashboardProps {
    onOpenMap: () => void;
    onTriggerUpgrade: () => void;
    favorites: string[];
    displayTitle: string;
    timeZone?: string;
    utcOffset?: number;
    timeDisplaySetting: string;
    onToggleFavorite: () => void;
    isRefreshing?: boolean;
    isNightMode: boolean;
    isMobileLandscape?: boolean;
    viewMode?: 'overview' | 'details';
}

// Main Component
export const Dashboard: React.FC<DashboardProps> = React.memo((props) => {

    // 1. Controller Hook (Encapsulated Logic)
    const {
        data,
        current,
        hourly,
        boatingAdvice,
        lockerItems,
        isLandlocked,
        isPro,

        // State
        chartView,
        view,
        isPlaying,
        hasPreloadedAudio,

        // Actions
        handleAudioBroadcast,
        shareReport,
        refreshInterval,
        settings
    } = useDashboardController(props.viewMode);

    // Settings
    const { settings: userSettings, updateSettings } = useSettings();
    const isExpanded = userSettings.dashboardMode !== 'essential';

    // Onboarding tutorial for first-time users
    const { showTutorial, dismissTutorial, neverShowAgain } = useTutorial();

    // Derived UI Props
    const isDetailMode = props.viewMode === 'details';
    const [selectedTime, setSelectedTime] = useState<number | undefined>(undefined);

    // Fixed header state management — refs + state for throttled updates
    // Refs hold the latest value instantly (no re-render). State triggers the UI update.
    const [activeDay, setActiveDay] = useState(0);
    const [activeHour, setActiveHour] = useState(0);
    const [activeDayData, setActiveDayData] = useState<SourcedWeatherMetrics | null>(null);
    const activeDayRef = useRef(0);
    const activeHourRef = useRef(0);
    const activeDayDataRef = useRef<SourcedWeatherMetrics | null>(null);
    const rafIdRef = useRef<number | null>(null);

    // Sync activeDayData ref & state with current when current first loads
    useEffect(() => {
        if (current && !activeDayDataRef.current) {
            activeDayDataRef.current = current;
            setActiveDayData(current);
        }
    }, [current]);

    // Minutely rain data from Tomorrow.io
    const [minutelyRain, setMinutelyRain] = useState<MinutelyRain[]>([]);
    const [rainStatus, setRainStatus] = useState<'loading' | 'loaded' | 'error'>('loading');

    useEffect(() => {
        if (!data?.coordinates) return;
        const { lat, lon } = data.coordinates;
        let cancelled = false;
        setRainStatus('loading');

        // Initial fetch
        fetchMinutelyRain(lat, lon).then(result => {
            if (!cancelled) {
                setMinutelyRain(result);
                setRainStatus(result.length > 0 ? 'loaded' : 'error');
            }
        }).catch(() => {
            if (!cancelled) setRainStatus('error');
        });

        // Live refresh every 5 minutes (Tomorrow.io has 10min internal cache)
        const rainTimer = setInterval(() => {
            if (!navigator.onLine) return;
            fetchMinutelyRain(lat, lon).then(result => {
                if (!cancelled) {
                    setMinutelyRain(result);
                    setRainStatus(result.length > 0 ? 'loaded' : 'error');
                }
            }).catch(() => {
                if (!cancelled) setRainStatus('error');
            });
        }, 5 * 60 * 1000);

        return () => { cancelled = true; clearInterval(rainTimer); };
    }, [data?.coordinates?.lat, data?.coordinates?.lon]);

    // Stable scroll callbacks that batch state updates via rAF
    const handleTimeSelect = useCallback((time: number | undefined) => {
        // Only update selectedTime for TideWidget — no need to re-render carousel
        setSelectedTime(time);
    }, []);

    const handleDayChange = useCallback((day: number) => {
        activeDayRef.current = day;
        if (!rafIdRef.current) {
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = null;
                setActiveDay(activeDayRef.current);
                setActiveHour(activeHourRef.current);
            });
        }
    }, []);

    const handleHourChange = useCallback((hour: number) => {
        activeHourRef.current = hour;
        if (!rafIdRef.current) {
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = null;
                setActiveDay(activeDayRef.current);
                setActiveHour(activeHourRef.current);
            });
        }
    }, []);

    const handleActiveDataChange = useCallback((newData: SourcedWeatherMetrics) => {
        activeDayDataRef.current = newData;
        if (!rafIdRef.current) {
            rafIdRef.current = requestAnimationFrame(() => {
                rafIdRef.current = null;
                setActiveDayData(activeDayDataRef.current);
                setActiveDay(activeDayRef.current);
                setActiveHour(activeHourRef.current);
            });
        }
    }, []);

    // PERFORMANCE: Memoize expensive inline computations that were previously IIFEs
    const widgetCardTime = useMemo(() => {
        if (activeDay === 0 && activeHour === 0) return Date.now();
        const now = new Date();
        if (activeDay === 0) {
            return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + activeHour).getTime();
        } else {
            const forecast = data?.forecast?.[activeDay];
            if (forecast?.isoDate) {
                const [y, m, d] = forecast.isoDate.split('-').map(Number);
                return new Date(y, m - 1, d, activeHour).getTime();
            }
        }
        return Date.now();
    }, [activeDay, activeHour, data?.forecast]);

    const safeActive = activeDayData || current;

    const widgetSources = useMemo(() => {
        return (activeDay === 0 && activeHour === 0) ? current?.sources : safeActive?.sources;
    }, [activeDay, activeHour, current, safeActive]);

    // Compute day/night for the active card time (fixes "Sunny" at midnight)
    const isActiveDay = useMemo(() => {
        const activeData = safeActive;
        if (!activeData) {
            const h = new Date(widgetCardTime).getHours();
            return h >= 6 && h < 18;
        }
        const sRise = activeData.sunrise;
        const sSet = activeData.sunset;
        if (!sRise || !sSet || sRise === '--:--' || sSet === '--:--') {
            const h = new Date(widgetCardTime).getHours();
            return h >= 6 && h < 18;
        }
        try {
            const [rH, rM] = sRise.replace(/[^0-9:]/g, '').split(':').map(Number);
            const [sH, sM] = sSet.replace(/[^0-9:]/g, '').split(':').map(Number);
            if (isNaN(rH) || isNaN(sH)) {
                const h = new Date(widgetCardTime).getHours();
                return h >= 6 && h < 18;
            }
            const d = new Date(widgetCardTime);
            const rise = new Date(d); rise.setHours(rH, rM, 0, 0);
            const set = new Date(d); set.setHours(sH, sM, 0, 0);
            return d >= rise && d < set;
        } catch {
            const h = new Date(widgetCardTime).getHours();
            return h >= 6 && h < 18;
        }
    }, [safeActive, widgetCardTime]);

    // Memoize nextUpdate — compute the next scheduled wall-clock refresh time
    const nextUpdateTime = useMemo(() => {
        const now = new Date();
        const intervalMs = refreshInterval;
        const intervalMin = intervalMs / 60000;

        // Compute next aligned time based on interval
        if (intervalMin >= 60) {
            const next = new Date(now);
            next.setMinutes(0, 0, 0);
            next.setHours(next.getHours() + 1);
            return next.getTime();
        } else if (intervalMin === 30) {
            const next = new Date(now);
            const currentMin = next.getMinutes();
            if (currentMin < 30) {
                next.setMinutes(30, 0, 0);
            } else {
                next.setMinutes(0, 0, 0);
                next.setHours(next.getHours() + 1);
            }
            return next.getTime();
        } else {
            if (!data?.generatedAt) return Date.now() + intervalMs;
            const next = new Date(data.generatedAt);
            next.setMinutes(next.getMinutes() + intervalMin);
            if (next.getTime() <= now.getTime()) {
                const nextFromNow = new Date(now);
                const currentMin = nextFromNow.getMinutes();
                const nextSlot = Math.ceil(currentMin / intervalMin) * intervalMin;
                nextFromNow.setMinutes(nextSlot, 0, 0);
                if (nextFromNow.getTime() <= now.getTime()) {
                    nextFromNow.setMinutes(nextFromNow.getMinutes() + intervalMin);
                }
                return nextFromNow.getTime();
            }
            return next.getTime();
        }
    }, [data?.generatedAt, refreshInterval]);

    // Extract beacon and buoy names from live sources for StatusBadges
    const { beaconName, buoyName } = useMemo(() => {
        let beacon = '';
        let buoy = '';
        const liveSources = current?.sources;
        if (liveSources) {
            Object.values(liveSources).forEach((src) => {
                const s = src as { source?: string; sourceName?: string };
                if (s?.source === 'beacon' && s?.sourceName && !beacon) {
                    beacon = s.sourceName;
                } else if (s?.source === 'buoy' && s?.sourceName && !buoy) {
                    buoy = s.sourceName;
                }
            });
        }
        return { beaconName: beacon, buoyName: buoy };
    }, [current]);

    const widgetTrends = useMemo(() => {
        if (!hourly || hourly.length < 2 || !safeActive) return undefined;
        const nextHour = hourly[1];
        const trends: Record<string, 'up' | 'down' | 'stable'> = {};

        const compare = (currentVal: number | null | undefined, next: number | null | undefined, threshold = 0.5): 'up' | 'down' | 'stable' => {
            if (currentVal == null || next == null) return 'stable';
            const diff = next - currentVal;
            if (Math.abs(diff) < threshold) return 'stable';
            return diff > 0 ? 'up' : 'down';
        };

        trends['windSpeed'] = compare(safeActive.windSpeed, nextHour.windSpeed, 0.5);
        trends['windGust'] = compare(safeActive.windGust, nextHour.windGust, 0.5);
        trends['waveHeight'] = compare(safeActive.waveHeight, nextHour.waveHeight, 0.1);
        trends['waterTemperature'] = compare(safeActive.waterTemperature, nextHour.waterTemperature, 0.2);
        trends['pressure'] = compare(safeActive.pressure, nextHour.pressure, 0.3);
        trends['visibility'] = compare(safeActive.visibility, nextHour.visibility, 0.5);

        return trends;
    }, [hourly, safeActive]);

    // Helper to generate proper date labels
    const getDateLabel = (dayIndex: number): string => {
        if (dayIndex === 0) return "TODAY";

        const forecast = data?.forecast?.[dayIndex];
        if (forecast?.isoDate) {
            const [y, m, day] = forecast.isoDate.split('-').map(Number);
            const d = new Date(y, m - 1, day, 12, 0, 0);
            return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
        }

        return `DAY ${dayIndex + 1}`; // Fallback
    };

    // Helper to generate time label for active hour
    const getTimeLabel = (): string => {
        if (activeDay === 0 && activeHour === 0) {
            // Live card - show current hour
            const now = new Date();
            const currentHour = now.getHours();
            const nextHour = (currentHour + 1) % 24;
            return `${String(currentHour).padStart(2, '0')}:00 - ${String(nextHour).padStart(2, '0')}:00`;
        }

        // For other hours, calculate based on activeHour index
        // For TODAY: activeHour 0 = NOW, 1 = next hour, etc.
        // For FORECAST days: activeHour 0 = 00:00, 1 = 01:00, etc.
        if (activeDay === 0) {
            // TODAY - offset by current hour
            const now = new Date();
            const currentHour = now.getHours();
            const hour = currentHour + activeHour;
            const nextHour = (hour + 1) % 24;
            return `${String(hour).padStart(2, '0')}:00 - ${String(nextHour).padStart(2, '0')}:00`;
        } else {
            // FORECAST - start from midnight
            const hour = activeHour;
            const nextHour = (hour + 1) % 24;
            return `${String(hour).padStart(2, '0')}:00 - ${String(nextHour).padStart(2, '0')}:00`;
        }
    };


    // Use Global Settings for Units
    // Fallback to defaults only if settings are missing (rare)
    const units: UnitPreferences = settings?.units || { speed: 'kts', length: 'ft', waveHeight: 'ft', temp: 'C', distance: 'nm', tideHeight: 'm' };

    const contextValue = React.useMemo(() => ({
        current,
        forecast: data?.forecast,
        hourly,
        tides: data?.tides || [],
        tideHourly: data?.tideHourly || [],
        boatingAdvice: boatingAdvice || "",
        lockerItems: lockerItems,
        locationName: data?.locationName,
        timeZone: data?.timeZone,
        modelUsed: data?.modelUsed,
        isLandlocked: isLandlocked,
        isPro: isPro,

        units: units,

        // UI State
        isSpeaking: isPlaying,
        isBuffering: false,
        isAudioPreloading: false,
        isNightMode: props.isNightMode,
        backgroundUpdating: props.isRefreshing || false,
        handleAudioBroadcast: handleAudioBroadcast,
        shareReport: shareReport,
        onTriggerUpgrade: props.onTriggerUpgrade,
        onOpenMap: props.onOpenMap,

        settings: {},
        weatherData: data,
        tideGUIDetails: data?.tideGUIDetails,
    }), [
        current, data, hourly, boatingAdvice, lockerItems,
        isLandlocked, isPro, units,
        props.isNightMode, props.isRefreshing, isPlaying, handleAudioBroadcast, shareReport,
        props.onTriggerUpgrade, props.onOpenMap
    ]);

    // GUARD: All hooks above, early return here is safe
    if (!data || !current || !safeActive) return null;

    return (
        <DashboardWidgetContext.Provider value={contextValue as DashboardWidgetContextType}>
            <div className="h-[100dvh] w-full flex flex-col overflow-hidden relative bg-black"> {/* Flex Root */}

                {/* 2. Main Content Area */}
                <div className="flex-1 relative w-full min-h-0">

                    {/* MAIN CAROUSEL / GRID */}
                    {!isDetailMode && (
                        <div className="absolute inset-0">
                            {/* Compact Header Row - Warnings + Sunrise/Sunset/Rainfall */}
                            {/* App Header height is ~108px. With 10px gap, top should be 118px */}
                            <div className="flex-shrink-0 z-[120] w-full bg-gradient-to-b from-black/80 to-transparent px-4 pb-0 fixed left-0 right-0 pointer-events-none" style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 118px)' }}>
                                <div className="pointer-events-auto">
                                    <CompactHeaderRow
                                        alerts={data.alerts}
                                        sunrise={activeDayData?.sunrise || current?.sunrise}
                                        sunset={activeDayData?.sunset || current?.sunset}
                                        moonPhase={getMoonPhase(new Date(widgetCardTime)).emoji}
                                        dashboardMode={userSettings.dashboardMode || 'full'}
                                        onToggleDashboardMode={() => updateSettings({
                                            dashboardMode: userSettings.dashboardMode === 'essential' ? 'full' : 'essential'
                                        })}
                                    />
                                </div>
                            </div>

                            {/* MAXIMUM BLOCKER - Covers entire gap up to carousel */}
                            <div className="fixed top-[0px] left-0 right-0 bg-black z-[100] transition-all duration-300" style={{ height: isExpanded ? 'calc(max(8px, env(safe-area-inset-top)) + 412px)' : 'calc(max(8px, env(safe-area-inset-top)) + 332px)' }}></div>

                            {/* FIXED HEADER - Positioned 7px below CompactHeaderRow (118 + 40 + 7 = 165) */}
                            <div className="fixed left-0 right-0 z-[110] px-4" style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 165px)' }}>
                                <HeroHeader
                                    data={safeActive}
                                    units={units}
                                    isLive={activeDay === 0 && activeHour === 0}
                                    isDay={isActiveDay}
                                    dateLabel={getDateLabel(activeDay)}
                                    timeLabel={getTimeLabel()}
                                    timeZone={data.timeZone}
                                    sources={safeActive.sources}
                                    isExpanded={isExpanded}
                                    onToggleExpand={() => updateSettings({ dashboardMode: isExpanded ? 'essential' : 'full' })}
                                />
                            </div>



                            {/* CURRENT CONDITIONS CARD - Collapsed mode only (165 + 70 + 8 = 243) */}
                            <div
                                className="fixed left-0 right-0 z-[110] px-4 transition-all duration-300 ease-in-out"
                                style={{
                                    top: 'calc(max(8px, env(safe-area-inset-top)) + 243px)',
                                    opacity: !isExpanded ? 1 : 0,
                                    transform: !isExpanded ? 'translateY(0)' : 'translateY(-10px)',
                                    pointerEvents: !isExpanded ? 'auto' : 'none',
                                }}
                            >
                                <CurrentConditionsCard
                                    data={activeDayData || current}
                                    units={units}
                                    timeZone={data.timeZone}
                                />
                            </div>

                            {/* FIXED WIDGETS - Slide down when expanded (165 + 70 + 8 = 243) */}
                            <div
                                className="fixed left-0 right-0 z-[110] px-4 transition-all duration-300 ease-in-out"
                                style={{
                                    top: 'calc(max(8px, env(safe-area-inset-top)) + 243px)',
                                    opacity: isExpanded ? 1 : 0,
                                    transform: isExpanded ? 'translateY(0)' : 'translateY(-10px)',
                                    pointerEvents: isExpanded ? 'auto' : 'none',
                                }}
                            >
                                <HeroWidgets
                                    data={safeActive}
                                    units={units}
                                    cardTime={widgetCardTime}
                                    sources={widgetSources}
                                    trends={widgetTrends}
                                    isLive={activeDay === 0 && activeHour === 0}
                                />
                            </div>


                            {/* HERO CONTAINER - Shifts up when collapsed to reclaim dead space */}
                            {/* MATH: 
                                Expanded Top: 243 (widgets) + 160 (height) + 9 (gap) = 412px
                                Collapsed Top: 243 (conditions card) + 80 (height) + 9 (gap) = 332px
                            */}
                            <div className="fixed left-0 right-0 overflow-hidden bg-black transition-[top] duration-300 flex flex-col gap-[7px] pt-0" style={{ top: isExpanded ? 'calc(max(8px, env(safe-area-inset-top)) + 412px)' : 'calc(max(8px, env(safe-area-inset-top)) + 332px)', bottom: 'calc(env(safe-area-inset-bottom) + 120px)' }}>
                                {/* STATIC RAIN FORECAST — always visible, outside both carousels */}
                                {minutelyRain && minutelyRain.length > 0 ? (
                                    <div className="shrink-0 px-4">
                                        <RainForecastCard
                                            data={minutelyRain}
                                            timeZone={data.timeZone}
                                        />
                                    </div>
                                ) : (
                                    <div className="shrink-0 px-4">
                                        <div className="w-full rounded-xl overflow-hidden"
                                            style={{
                                                background: 'linear-gradient(135deg, rgba(30, 58, 138, 0.4), rgba(15, 23, 42, 0.5), rgba(30, 64, 175, 0.25))',
                                                border: '1px solid rgba(96, 165, 250, 0.1)',
                                            }}
                                        >
                                            <div className="px-4 py-2.5 flex items-center justify-center gap-2">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-blue-400/40 shrink-0">
                                                    <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"
                                                        fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.5" />
                                                </svg>
                                                <span className="text-xs font-semibold uppercase tracking-wider text-blue-300/40">
                                                    {rainStatus === 'loading' ? 'Checking rain forecast…' : 'Rain data unavailable'}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                )}
                                <HeroSection
                                    current={current}
                                    forecasts={data.forecast}
                                    units={units}
                                    generatedAt={data.generatedAt}
                                    locationName={props.displayTitle}
                                    tides={data.tides}
                                    tideHourly={data.tideHourly}
                                    timeZone={data.timeZone}
                                    hourly={hourly}
                                    modelUsed={data.modelUsed}
                                    guiDetails={data.tideGUIDetails}
                                    coordinates={data.coordinates}
                                    locationType={data.locationType}
                                    utcOffset={data.utcOffset}
                                    className="px-4"
                                    onTimeSelect={handleTimeSelect}
                                    onDayChange={handleDayChange}
                                    onHourChange={handleHourChange}
                                    onActiveDataChange={handleActiveDataChange}
                                    isEssentialMode={!isExpanded}
                                    vessel={userSettings.vessel}
                                    minutelyRain={minutelyRain}
                                />
                            </div>

                            {/* HORIZONTAL POSITION DOTS - Shows current slide in horizontal scroll */}
                            <div className="fixed left-0 right-0 z-[110] flex justify-center" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 122px)' }}>
                                <div className="flex gap-[2px] px-4 py-1">
                                    {Array.from({ length: 24 }).map((_, i) => (
                                        <div
                                            key={i}
                                            className={`w-1 h-1 rounded-full transition-all duration-150 ${i === activeHour
                                                ? 'bg-sky-400 shadow-[0_0_3px_rgba(56,189,248,0.6)]'
                                                : 'bg-white/20'
                                                }`}
                                        />
                                    ))}
                                </div>
                            </div>

                            {/* STATIC BADGES - Fixed at bottom, outside hero scroll */}
                            {/* Height is ~42px. Bottom is 74px. Top of badges is 74+42 = 116px.
                                Hero container bottom is 120px. 
                                Gap = 120 - 116 = 4px. (Adjusted per user request to be 4px tighter)
                            */}
                            <div className="fixed left-0 right-0 z-[110] px-4" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 74px)' }}>
                                <div className={`rounded-xl bg-black/40 ${t.border.default} p-2`}>
                                    <StatusBadges
                                        isLandlocked={isLandlocked}
                                        locationName={props.displayTitle || ''}
                                        displaySource={data.modelUsed || 'Model'}
                                        nextUpdate={nextUpdateTime}
                                        fallbackInland={false}
                                        stationId={undefined}
                                        locationType={data.locationType}
                                        beaconName={beaconName}
                                        buoyName={buoyName}
                                        sources={widgetSources}
                                        activeData={safeActive}
                                        isLive={activeDay === 0 && activeHour === 0}
                                        modelUsed={data.modelUsed}
                                        generatedAt={data.generatedAt}
                                        coordinates={data.coordinates}
                                    />
                                </div>
                            </div>

                            {data.tides && !isLandlocked && data.locationType !== 'offshore' && (
                                <TideWidget
                                    tides={data.tides}
                                    hourlyTides={hourly}
                                    tideHourly={data.tideHourly}
                                    units={units}
                                    timeZone={data.timeZone}
                                    modelUsed={data.modelUsed}
                                    guiDetails={data.tideGUIDetails}
                                    customTime={selectedTime}
                                />
                            )}
                        </div>
                    )}

                    {/* DETAILED GRIDS / LOG PAGE - Full height container for proper internal scrolling */}
                    {isDetailMode && (
                        <div className="absolute inset-0 overflow-hidden">
                            <React.Suspense fallback={<div className="flex items-center justify-center h-full bg-black"><div className="text-white/40 text-sm">Loading Log...</div></div>}>
                                <LogPage />
                            </React.Suspense>
                        </div>
                    )}
                </div>

                {data && (
                    <div className="mt-8 text-center pb-8 opacity-40 hover:opacity-100 transition-opacity">

                        <div className="mt-4 flex items-center justify-center gap-2 text-sm font-mono text-sky-500/50">
                            <ClockIcon className="w-3 h-3" />
                            <span>UPDATED: {new Date(data.generatedAt).toLocaleTimeString('en-US', { timeZone: data.timeZone, hour: 'numeric', minute: '2-digit' })}</span>
                            <span>•</span>
                            <span>NEXT: {((refreshInterval / 60000)).toFixed(0)}m</span>
                        </div>
                    </div>
                )}


            </div>

            {/* Gesture Tutorial Overlay - First-time users */}
            {showTutorial && (
                <GestureTutorial
                    onDismiss={dismissTutorial}
                    onNeverShow={neverShowAgain}
                />
            )}
        </DashboardWidgetContext.Provider >
    );
});
