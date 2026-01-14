
import React from 'react';
import { useDashboardController } from '../hooks/useDashboardController';
import { ClockIcon } from './Icons';
import { HeroSection } from './dashboard/Hero';
import { TideWidget, SunMoonWidget } from './dashboard/TideAndVessel';
import { DetailedMetricsWidget, AlertsBanner } from './dashboard/WeatherGrid';

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

    // Use Global Settings for Units
    // Fallback to defaults only if settings are missing (rare)
    const { settings } = useDashboardController(props.viewMode);
    const units: UnitPreferences = settings?.units || { speed: 'kts', length: 'ft', waveHeight: 'ft', temp: 'C', distance: 'nm', tideHeight: 'm' };

    console.log("[Dashboard] Render. data.tideGUIDetails:", data.tideGUIDetails);

    return (
        <DashboardWidgetContext.Provider value={{
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
            chartView: 'hourly',
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
        }}>
            <div className="h-[100dvh] w-full flex flex-col overflow-hidden relative bg-black"> {/* Flex Root */}

                {/* 1. Header & Advice */}
                <div className="flex-shrink-0 z-10 w-full bg-gradient-to-b from-black/80 to-transparent px-4 pt-2 pb-2 space-y-4">
                    <AlertsBanner alerts={data.alerts} />
                </div>

                {/* 2. Main Content Area */}
                <div className="flex-1 relative w-full min-h-0">


                    {/* MAIN CAROUSEL / GRID */}
                    {!isDetailMode && (
                        <div className="absolute inset-0">
                            <HeroSection
                                current={current}
                                forecasts={data.forecast}
                                units={units}
                                generatedAt={data.generatedAt}
                                isLandlocked={isLandlocked}
                                locationName={data.locationName}
                                tides={data.tides}
                                tideHourly={data.tideHourly}
                                timeZone={data.timeZone}
                                hourly={hourly}
                                modelUsed={data.modelUsed}
                                guiDetails={data.tideGUIDetails}
                                coordinates={data.coordinates}
                                locationType={data.locationType}
                            />

                            {data.tides && !isLandlocked && (
                                <TideWidget
                                    tides={data.tides}
                                    hourlyTides={hourly}
                                    tideHourly={data.tideHourly}
                                    units={units}
                                    timeZone={data.timeZone}
                                    modelUsed={data.modelUsed}
                                    guiDetails={data.tideGUIDetails}
                                />
                            )}
                        </div>
                    )}

                    {/* DETAILED GRIDS */}
                    {isDetailMode && (
                        <div className="h-full overflow-y-auto pb-32 px-2 space-y-2">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                <SunMoonWidget
                                    current={current}
                                    units={units}
                                    timeZone={data.timeZone}
                                    lat={data.coordinates?.lat}
                                />
                                <DetailedMetricsWidget
                                    current={current}
                                    units={units}
                                    hourly={hourly}
                                />
                            </div>
                        </div>
                    )}
                </div>



                {/* 3. Footer / Skippers Locker */}
                {isDetailMode && lockerItems.length > 0 && (
                    <div className="px-4 mt-8 mb-4">
                        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4">Skipper's Locker</h3>
                        <div className="grid grid-cols-2 gap-3">
                            {lockerItems.map((item, i) => (
                                <div key={i} className="bg-slate-800/50 rounded-xl p-3 flex items-center gap-3 border border-slate-700/50">
                                    <span className="text-2xl">{item.icon}</span>
                                    <div>
                                        <div className="text-sm font-medium text-white">{item.name}</div>
                                        <div className="text-sm text-slate-400 uppercase tracking-wider">{item.category}</div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {data && (
                    <div className="mt-8 text-center pb-8 opacity-40 hover:opacity-100 transition-opacity">
                        <InteractionHint />
                        <div className="mt-4 flex items-center justify-center gap-2 text-[10px] font-mono text-sky-500/50">
                            <ClockIcon className="w-3 h-3" />
                            <span>UPDATED: {new Date(data.generatedAt).toLocaleTimeString()}</span>
                            <span>•</span>
                            <span>NEXT: {((refreshInterval / 60000)).toFixed(0)}m</span>
                        </div>
                    </div>
                )}


            </div>
        </DashboardWidgetContext.Provider>
    );
});
