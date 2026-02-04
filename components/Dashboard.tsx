
import React, { useState } from 'react';
import { useDashboardController } from '../hooks/useDashboardController';
import { ClockIcon } from './Icons';
import { HeroSection } from './dashboard/Hero';
import { TideWidget, SunMoonWidget } from './dashboard/TideAndVessel';
import { CompactHeaderRow } from './dashboard/CompactHeaderRow';
import { getMoonPhase } from './dashboard/WeatherHelpers';
import { AdviceWidget } from './dashboard/Advice';
import { LogPage } from '../pages/LogPage';
import { HeroHeader } from './dashboard/HeroHeader';
import { HeroWidgets } from './dashboard/HeroWidgets';
import { HourlyStrip } from './dashboard/HourlyStrip';
import { useSettings } from '../context/SettingsContext';

import { DashboardWidgetContext } from './WidgetRenderer';
import { UnitPreferences } from '../types';

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

    // Derived UI Props
    const isDetailMode = props.viewMode === 'details';
    const [selectedTime, setSelectedTime] = useState<number | undefined>(undefined);

    // Fixed header state management
    const [activeDay, setActiveDay] = useState(0);
    const [activeHour, setActiveHour] = useState(0);
    const [activeDayData, setActiveDayData] = useState(current);

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

        // UI State stubs for context compatibility (can be expanded)
        chartData: [],
        chartView: chartView as 'hourly' | 'daily',
        hiddenSeries: {},
        isSpeaking: isPlaying,
        isBuffering: false,
        isAudioPreloading: false,
        isNightMode: props.isNightMode,
        backgroundUpdating: props.isRefreshing || false,

        setChartView: () => { },
        toggleChartSeries: () => { },
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
                            <div className="flex-shrink-0 z-[120] w-full bg-gradient-to-b from-black/80 to-transparent px-4 pt-2 pb-2 space-y-4 fixed top-0 left-0 right-0 pointer-events-none">
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

                            {/* MAXIMUM BLOCKER - Covers entire gap (shorter in Essential mode) */}
                            <div className={`absolute top-[0px] left-0 right-0 bg-black z-[100] ${isEssentialMode ? 'h-[260px]' : 'h-[350px]'}`}></div>

                            {/* FIXED HEADER - Absolutely positioned at top */}
                            <div className="absolute top-[80px] left-0 right-0 z-[110] px-4">
                                <HeroHeader
                                    data={dynamicHeaderEnabled ? activeDayData : current}
                                    units={units}
                                    isLive={dynamicHeaderEnabled ? (activeDay === 0 && activeHour === 0) : true}
                                    isDay={true}
                                    dateLabel={getDateLabel(activeDay)}
                                    timeLabel={getTimeLabel()}
                                    timeZone={data.timeZone}
                                    sources={(dynamicHeaderEnabled ? activeDayData : current as any).sources}
                                />
                            </div>


                            {/* HOURLY STRIP - Essential mode only, shows horizontal hourly forecast */}
                            {isEssentialMode && hourly && hourly.length > 0 && (
                                <div className="absolute top-[175px] left-0 right-0 z-[110]">
                                    <HourlyStrip
                                        hourly={hourly}
                                        units={units}
                                        timeZone={data.timeZone}
                                    />
                                </div>
                            )}

                            {/* FIXED WIDGETS - Absolutely positioned below header (hidden in Essential mode) */}
                            {!isEssentialMode && (
                                <div className="absolute top-[200px] left-0 right-0 z-[110] px-4">
                                    <HeroWidgets
                                        data={activeDayData}  // Bottom row - updates with scroll
                                        currentData={current}  // Top row - always shows current/live data
                                        units={units}
                                        cardTime={(() => {
                                            // Calculate the actual time for this card based on activeDay and activeHour
                                            if (activeDay === 0 && activeHour === 0) return Date.now();
                                            const now = new Date();
                                            if (activeDay === 0) {
                                                // Today - add hours from current hour
                                                return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + activeHour).getTime();
                                            } else {
                                                // Future day - use midnight + activeHour
                                                const forecast = data.forecast[activeDay];
                                                if (forecast?.isoDate) {
                                                    const [y, m, d] = forecast.isoDate.split('-').map(Number);
                                                    return new Date(y, m - 1, d, activeHour).getTime();
                                                }
                                            }
                                            return Date.now();
                                        })()}  // Calculate card time for UV nighttime check
                                        // CRITICAL FIX: Bottom row sources should use currentSources when showing current hour
                                        // activeDayData.sources doesn't exist, only current.sources does
                                        sources={(activeDay === 0 && activeHour === 0) ? (current as any).sources : (activeDayData as any).sources}
                                        currentSources={(current as any).sources}  // Sources for top row
                                        trends={(() => {
                                            // Calculate trends by comparing current with next hour
                                            if (!hourly || hourly.length < 2) return undefined;
                                            const nextHour = hourly[1];
                                            const trends: Record<string, 'up' | 'down' | 'stable'> = {};

                                            const compare = (current: number | null | undefined, next: number | null | undefined, threshold = 0.5): 'up' | 'down' | 'stable' => {
                                                if (current == null || next == null) return 'stable';
                                                const diff = next - current;
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
                                        })()}
                                        isLive={activeDay === 0 && activeHour === 0}
                                        topRowIsLive={true}
                                    />
                                </div>
                            )}


                            {/* HERO CONTAINER - Positioned below fixed headers (moves up in Essential mode) */}
                            <div className={`absolute left-0 right-0 bottom-0 overflow-hidden bg-black ${isEssentialMode ? 'top-[260px]' : 'top-[360px]'}`}>
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
                                    onTimeSelect={setSelectedTime}
                                    customTime={selectedTime}
                                    onDayChange={setActiveDay}
                                    onHourChange={setActiveHour}
                                    onActiveDataChange={setActiveDayData}
                                />
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

                    {/* DETAILED GRIDS / LOG PAGE */}
                    {isDetailMode && (
                        <LogPage />
                    )}
                </div>

                {data && (
                    <div className="mt-8 text-center pb-8 opacity-40 hover:opacity-100 transition-opacity">

                        <div className="mt-4 flex items-center justify-center gap-2 text-[10px] font-mono text-sky-500/50">
                            <ClockIcon className="w-3 h-3" />
                            <span>UPDATED: {new Date(data.generatedAt).toLocaleTimeString('en-US', { timeZone: data.timeZone, hour: 'numeric', minute: '2-digit' })}</span>
                            <span>•</span>
                            <span>NEXT: {((refreshInterval / 60000)).toFixed(0)}m</span>
                        </div>
                    </div>
                )}


            </div>
        </DashboardWidgetContext.Provider >
    );
});
