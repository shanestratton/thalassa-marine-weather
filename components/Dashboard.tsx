
import React, { useState } from 'react';
import { useDashboardController } from '../hooks/useDashboardController';
import { ClockIcon } from './Icons';
import { HeroSection } from './dashboard/Hero';
import { TideWidget, SunMoonWidget } from './dashboard/TideAndVessel';
import { AlertsBanner } from './dashboard/WeatherGrid';
import { AdviceWidget } from './dashboard/Advice';

import { InteractionHint } from './dashboard/InteractionHint';

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

    // Derived UI Props
    const isDetailMode = props.viewMode === 'details';
    const [selectedTime, setSelectedTime] = useState<number | undefined>(undefined);
    console.log('[PROP_TRACE] Dashboard Render. setSelectedTime:', !!setSelectedTime);


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
                            {/* Alerts only on Hero View */}
                            <div className="flex-shrink-0 z-10 w-full bg-gradient-to-b from-black/80 to-transparent px-4 pt-2 pb-2 space-y-4 fixed top-0 left-0 right-0 pointer-events-none">
                                <div className="pointer-events-auto">
                                    <AlertsBanner alerts={data.alerts} />
                                </div>
                            </div>

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
                                className="pt-20" // Fine-tuned: Reduced from pt-28
                                onTimeSelect={setSelectedTime}
                                customTime={selectedTime}
                            />

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

                    {/* DETAILED GRIDS */}
                    {isDetailMode && (
                        <div className="h-full overflow-y-auto pb-32 px-2 space-y-4 pt-4">

                            {/* 1. Celestial (Promoted to Top) */}
                            <SunMoonWidget
                                current={current}
                                units={units}
                                timeZone={data.timeZone}
                                lat={data.coordinates?.lat}
                            />

                            {/* 2. Captain's Log (Hidden for Inland) */}
                            {!isLandlocked && (
                                <AdviceWidget
                                    advice={boatingAdvice || ""}
                                    isPro={isPro}
                                    onUpgrade={props.onTriggerUpgrade}
                                    isSpeaking={isPlaying}
                                    isBuffering={false}
                                    isAudioPreloading={false}
                                    toggleBroadcast={handleAudioBroadcast}
                                    handleShare={shareReport}
                                    uvIndex={current.uvIndex || 0}
                                    lockerItems={lockerItems}
                                    isBackgroundUpdating={props.isRefreshing}
                                />
                            )}
                        </div>
                    )}
                </div>

                {data && (
                    <div className="mt-8 text-center pb-8 opacity-40 hover:opacity-100 transition-opacity">
                        <InteractionHint />
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
