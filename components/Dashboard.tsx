
import React, { useState, useMemo, useCallback, useRef } from 'react';
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
import { useSettings } from '../context/SettingsContext';
import { GestureTutorial, useTutorial } from './ui/GestureTutorial';
import { DashboardSkeleton, HeroWidgetsSkeleton } from './ui/Skeleton';

import { DashboardWidgetContext } from './WidgetRenderer';
import { UnitPreferences, WeatherMetrics, SourcedWeatherMetrics } from '../types';

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
        refreshInterval
    } = useDashboardController(props.viewMode);

    if (!data || !current) return null;

    // Settings for dynamic header metrics
    const { settings: userSettings, updateSettings } = useSettings();
    const dynamicHeaderEnabled = userSettings.dynamicHeaderMetrics === true;
    const isEssentialMode = userSettings.dashboardMode === 'essential';

    // Onboarding tutorial for first-time users
    const { showTutorial, dismissTutorial, neverShowAgain } = useTutorial();

    // Derived UI Props
    const isDetailMode = props.viewMode === 'details';
    const [selectedTime, setSelectedTime] = useState<number | undefined>(undefined);

    // Fixed header state management — refs + state for throttled updates
    // Refs hold the latest value instantly (no re-render). State triggers the UI update.
    const [activeDay, setActiveDay] = useState(0);
    const [activeHour, setActiveHour] = useState(0);
    const [activeDayData, setActiveDayData] = useState(current);
    const activeDayRef = useRef(0);
    const activeHourRef = useRef(0);
    const activeDayDataRef = useRef(current);
    const rafIdRef = useRef<number | null>(null);

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
            const forecast = data.forecast[activeDay];
            if (forecast?.isoDate) {
                const [y, m, d] = forecast.isoDate.split('-').map(Number);
                return new Date(y, m - 1, d, activeHour).getTime();
            }
        }
        return Date.now();
    }, [activeDay, activeHour, data.forecast]);

    const widgetSources = useMemo(() => {
        return (activeDay === 0 && activeHour === 0) ? current.sources : activeDayData.sources;
    }, [activeDay, activeHour, current, activeDayData]);

    const currentSources = useMemo(() => current.sources, [current]);

    // Memoize nextUpdate — compute the next scheduled wall-clock refresh time
    const nextUpdateTime = useMemo(() => {
        const now = new Date();
        const intervalMs = refreshInterval;
        const intervalMin = intervalMs / 60000;

        // Compute next aligned time based on interval
        if (intervalMin >= 60) {
            // On the hour
            const next = new Date(now);
            next.setMinutes(0, 0, 0);
            next.setHours(next.getHours() + 1);
            return next.getTime();
        } else if (intervalMin === 30) {
            // On the half hour
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
            // Every N minutes from last update (bad weather 10m)
            const next = new Date(data.generatedAt);
            next.setMinutes(next.getMinutes() + intervalMin);
            // If already passed, schedule from now
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
    }, [data.generatedAt, refreshInterval]);

    // Extract beacon and buoy names from current sources for StatusBadges
    const { beaconName, buoyName } = useMemo(() => {
        let beacon = '';
        let buoy = '';
        if (currentSources) {
            Object.values(currentSources).forEach((src) => {
                const s = src as { source?: string; sourceName?: string };
                if (s?.source === 'beacon' && s?.sourceName && !beacon) {
                    beacon = s.sourceName;
                } else if (s?.source === 'buoy' && s?.sourceName && !buoy) {
                    buoy = s.sourceName;
                }
            });
        }
        return { beaconName: beacon, buoyName: buoy };
    }, [currentSources]);

    const widgetTrends = useMemo(() => {
        if (!hourly || hourly.length < 2) return undefined;
        const nextHour = hourly[1];
        const trends: Record<string, 'up' | 'down' | 'stable'> = {};

        const compare = (currentVal: number | null | undefined, next: number | null | undefined, threshold = 0.5): 'up' | 'down' | 'stable' => {
            if (currentVal == null || next == null) return 'stable';
            const diff = next - currentVal;
            if (Math.abs(diff) < threshold) return 'stable';
            return diff > 0 ? 'up' : 'down';
        };

        trends['windSpeed'] = compare(activeDayData.windSpeed, nextHour.windSpeed, 2);
        trends['windGust'] = compare(activeDayData.windGust, nextHour.windGust, 2);
        trends['waveHeight'] = compare(activeDayData.waveHeight, nextHour.waveHeight, 0.3);
        trends['waterTemperature'] = compare(activeDayData.waterTemperature, nextHour.waterTemperature, 0.5);
        trends['pressure'] = compare(activeDayData.pressure, nextHour.pressure, 1);
        trends['visibility'] = compare(activeDayData.visibility, nextHour.visibility, 1);

        return trends;
    }, [hourly, activeDayData]);

    // Helper to generate proper date labels
    const getDateLabel = (dayIndex: number): string => {
        if (dayIndex === 0) return "TODAY";

        const forecast = data.forecast[dayIndex];
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
    const { settings } = useDashboardController(props.viewMode);
    const units: UnitPreferences = settings?.units || { speed: 'kts', length: 'ft', waveHeight: 'ft', temp: 'C', distance: 'nm', tideHeight: 'm' };



    const contextValue = React.useMemo(() => ({
        current,
        forecast: data.forecast,
        hourly,
        tides: data.tides || [],
        tideHourly: data.tideHourly || [],
        boatingAdvice: boatingAdvice || "",
        lockerItems: lockerItems,
        locationName: data.locationName,
        timeZone: data.timeZone,
        modelUsed: data.modelUsed,
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
        tideGUIDetails: data.tideGUIDetails,
    }), [
        current, data.forecast, hourly, data.tides, data.tideHourly, boatingAdvice, lockerItems,
        data.locationName, data.timeZone, data.modelUsed, isLandlocked, isPro, units,
        props.isNightMode, props.isRefreshing, isPlaying, handleAudioBroadcast, shareReport,
        props.onTriggerUpgrade, props.onOpenMap, data.tideGUIDetails, data
    ]);

    return (
        <DashboardWidgetContext.Provider value={contextValue}>
            <div className="h-[100dvh] w-full flex flex-col overflow-hidden relative bg-black"> {/* Flex Root */}

                {/* 2. Main Content Area */}
                <div className="flex-1 relative w-full min-h-0">

                    {/* MAIN CAROUSEL / GRID */}
                    {!isDetailMode && (
                        <div className="absolute inset-0">
                            {/* Compact Header Row - Warnings + Sunrise/Sunset/Rainfall */}
                            <div className="flex-shrink-0 z-[120] w-full bg-gradient-to-b from-black/80 to-transparent px-4 pb-2 space-y-4 fixed left-0 right-0 pointer-events-none" style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 81px)' }}>
                                <div className="pointer-events-auto">
                                    <CompactHeaderRow
                                        alerts={data.alerts}
                                        sunrise={current?.sunrise}
                                        sunset={current?.sunset}
                                        moonPhase={current?.moonPhase ? getMoonPhase(new Date()).emoji : undefined}
                                        dashboardMode={userSettings.dashboardMode || 'full'}
                                        onToggleDashboardMode={() => updateSettings({
                                            dashboardMode: userSettings.dashboardMode === 'essential' ? 'full' : 'essential'
                                        })}
                                    />
                                </div>
                            </div>

                            {/* MAXIMUM BLOCKER - Covers entire gap up to carousel */}
                            <div className="fixed top-[0px] left-0 right-0 bg-black z-[100]" style={{ height: 'calc(max(8px, env(safe-area-inset-top)) + 424px)' }}></div>

                            {/* FIXED HEADER - Positioned 8px below CompactHeaderRow */}
                            <div className="fixed left-0 right-0 z-[110] px-4" style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 132px)' }}>
                                <HeroHeader
                                    data={dynamicHeaderEnabled ? activeDayData : current}
                                    units={units}
                                    isLive={activeDay === 0 && activeHour === 0}
                                    isDay={true}
                                    dateLabel={getDateLabel(activeDay)}
                                    timeLabel={getTimeLabel()}
                                    timeZone={data.timeZone}
                                    sources={(dynamicHeaderEnabled ? activeDayData : current).sources}
                                    isEssentialMode={isEssentialMode}
                                    onToggleMode={() => updateSettings({ dashboardMode: isEssentialMode ? 'full' : 'essential' })}
                                />
                            </div>



                            {/* CURRENT CONDITIONS CARD - Essential mode only, same position as 5x2 HeroWidgets */}
                            {isEssentialMode && (
                                <div className="fixed left-0 right-0 z-[110] px-4" style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 254px)' }}>
                                    <CurrentConditionsCard
                                        data={activeDayData || current}
                                        units={units}
                                        timeZone={data.timeZone}
                                    />
                                </div>
                            )}

                            {/* FIXED WIDGETS - Absolutely positioned below header (hidden in Essential mode) */}
                            {!isEssentialMode && (
                                <div className="fixed left-0 right-0 z-[110] px-4" style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 254px)' }}>
                                    <HeroWidgets
                                        data={activeDayData}  // Bottom row - updates with scroll
                                        currentData={current}  // Top row - always shows current/live data
                                        units={units}
                                        cardTime={widgetCardTime}  // PERF: Memoized
                                        // CRITICAL FIX: Bottom row sources should use currentSources when showing current hour
                                        // activeDayData.sources doesn't exist, only current.sources does
                                        sources={widgetSources}  // PERF: Memoized
                                        currentSources={currentSources}  // PERF: Memoized
                                        trends={widgetTrends}  // PERF: Memoized
                                        isLive={activeDay === 0 && activeHour === 0}
                                        topRowIsLive={true}
                                    />
                                </div>
                            )}


                            {/* HERO CONTAINER - Positioned below fixed headers (same position in both modes) */}
                            <div className="fixed left-0 right-0 overflow-hidden bg-black" style={{ top: 'calc(max(8px, env(safe-area-inset-top)) + 424px)', bottom: 'calc(env(safe-area-inset-bottom) + 120px)' }}>
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
                                    isEssentialMode={isEssentialMode}
                                />
                            </div>

                            {/* HORIZONTAL POSITION DOTS - Shows current slide in horizontal scroll */}
                            <div className="fixed left-0 right-0 z-[110] flex justify-center" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 118px)' }}>
                                <div className="flex gap-[3px] px-4 py-1">
                                    {Array.from({ length: 24 }).map((_, i) => (
                                        <div
                                            key={i}
                                            className={`w-1.5 h-1.5 rounded-full transition-all duration-150 ${i === activeHour
                                                ? 'bg-sky-400 shadow-[0_0_4px_rgba(56,189,248,0.6)]'
                                                : 'bg-white/20'
                                                }`}
                                        />
                                    ))}
                                </div>
                            </div>

                            {/* STATIC BADGES - Fixed at bottom, outside hero scroll */}
                            <div className="fixed left-0 right-0 z-[110] px-4" style={{ bottom: 'calc(env(safe-area-inset-bottom) + 72px)' }}>
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
                                        current={current}
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
