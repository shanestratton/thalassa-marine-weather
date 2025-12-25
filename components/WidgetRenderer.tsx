
import React from 'react';
import { AdviceWidget } from './dashboard/Advice';
import { ForecastChartWidget, HourlyWidget, DailyWidget, MapWidget } from './dashboard/WeatherCharts';
import { BeaufortWidget, DetailedMetricsWidget } from './dashboard/WeatherGrid';
import { VesselStatusWidget } from './dashboard/TideAndVessel';
import { UnitPreferences, VesselProfile, WeatherMetrics, HourlyForecast, ForecastDay, Tide, TidePoint, ChartDataPoint } from '../types';

export interface DashboardWidgetContext {
    // Data
    current: WeatherMetrics;
    forecast: ForecastDay[];
    hourly: HourlyForecast[];
    tides: Tide[];
    tideHourly: TidePoint[];
    boatingAdvice: string;
    lockerItems: string[];
    locationName: string;
    timeZone?: string;
    modelUsed?: string;
    isLandlocked?: boolean;
    
    // Settings
    units: UnitPreferences;
    vessel?: VesselProfile;
    isPro: boolean;
    
    // UI State & Computed
    chartData: ChartDataPoint[];
    chartView: 'hourly' | 'daily';
    hiddenSeries: Record<string, boolean>;
    isSpeaking: boolean;
    isBuffering: boolean;
    isAudioPreloading: boolean;
    isNightMode: boolean;
    backgroundUpdating: boolean;
    
    // Handlers
    setChartView: (v: 'hourly' | 'daily') => void;
    toggleChartSeries: (k: string) => void;
    handleAudioBroadcast: () => void;
    shareReport: () => void;
    onTriggerUpgrade: () => void;
    onOpenMap: () => void;
    
    // Access to full settings object if needed for deep nested props
    settings: any;
    weatherData: any;
}

type WidgetRenderFn = (ctx: DashboardWidgetContext) => React.ReactNode;

const WIDGET_REGISTRY: Record<string, WidgetRenderFn> = {
    'advice': (ctx) => (
        <AdviceWidget 
            advice={ctx.boatingAdvice} 
            isPro={ctx.isPro} 
            onUpgrade={ctx.onTriggerUpgrade}
            isSpeaking={ctx.isSpeaking}
            isBuffering={ctx.isBuffering}
            isAudioPreloading={ctx.isAudioPreloading}
            toggleBroadcast={ctx.handleAudioBroadcast}
            handleShare={ctx.shareReport}
            uvIndex={ctx.current.uvIndex}
            lockerItems={ctx.lockerItems}
            isBackgroundUpdating={ctx.backgroundUpdating}
        />
    ),
    'charts': (ctx) => (
        <div className="space-y-6">
            <ForecastChartWidget 
                data={ctx.chartData} 
                view={ctx.chartView} 
                setView={ctx.setChartView} 
                units={ctx.units} 
                hiddenSeries={ctx.hiddenSeries} 
                toggleSeries={ctx.toggleChartSeries} 
                locationName={ctx.locationName}
                vessel={ctx.vessel}
                isLandlocked={ctx.isLandlocked}
                isNightMode={ctx.isNightMode}
            />
            <HourlyWidget hourly={ctx.hourly} units={ctx.units} isLandlocked={ctx.isLandlocked} />
            <DailyWidget forecast={ctx.forecast} isPro={ctx.isPro} onTriggerUpgrade={ctx.onTriggerUpgrade} units={ctx.units} vessel={ctx.vessel} />
        </div>
    ),
    'beaufort': (ctx) => (
        <div className="w-full">
            <BeaufortWidget windSpeed={ctx.current.windSpeed} />
        </div>
    ),
    'details': (ctx) => (
        <div className="w-full">
            <DetailedMetricsWidget current={ctx.current} units={ctx.units} hourly={ctx.hourly} />
        </div>
    ),
    'metrics': (ctx) => (
        <div className="flex flex-col gap-6">
            <div className="w-full">
                <BeaufortWidget windSpeed={ctx.current.windSpeed} />
            </div>
            <div className="w-full">
                <DetailedMetricsWidget current={ctx.current} units={ctx.units} hourly={ctx.hourly} />
            </div>
        </div>
    ),
    'tides': (ctx) => (
        <VesselStatusWidget 
            vessel={ctx.vessel!} 
            current={ctx.current} 
            vesselStatus={{}} 
            statusStyles={{}} 
            tides={ctx.tides} 
            hourlyTides={ctx.hourly}
            tideHourly={ctx.tideHourly}
            units={ctx.units} 
            timeZone={ctx.timeZone}
            modelUsed={ctx.modelUsed}
            isLandlocked={ctx.isLandlocked}
        />
    ),
    'map': (ctx) => (
        <MapWidget onOpenMap={ctx.onOpenMap} />
    )
};

export const WidgetRenderer: React.FC<{ id: string; context: DashboardWidgetContext }> = React.memo(({ id, context }) => {
    const renderFn = WIDGET_REGISTRY[id];
    if (!renderFn) return null;
    return <>{renderFn(context)}</>;
});
