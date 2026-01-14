
import React from 'react';
import { AdviceWidget } from './dashboard/Advice';
import { ForecastChartWidget, HourlyWidget, DailyWidget, MapWidget } from './dashboard/WeatherCharts';
import { BeaufortWidget, DetailedMetricsWidget } from './dashboard/WeatherGrid';
import { TideWidget, SunMoonWidget, VesselWidget, VesselStatusWidget } from './dashboard/TideAndVessel';
import { UnitPreferences, VesselProfile, WeatherMetrics, HourlyForecast, ForecastDay, Tide, TidePoint, ChartDataPoint, LockerItem } from '../types';
// Export Context Value
export const DashboardWidgetContext = React.createContext<DashboardWidgetContextType | null>(null);

export interface DashboardWidgetContextType {
    // Data
    current: WeatherMetrics;
    forecast: ForecastDay[];
    hourly: HourlyForecast[];
    tides: Tide[];
    tideHourly: TidePoint[];
    boatingAdvice: string;
    lockerItems: LockerItem[];
    locationName: string;
    timeZone?: string;
    modelUsed?: string;
    isLandlocked?: boolean;
    lat?: number; // Added for Southern Hemi Moon Logic
    tideGUIDetails?: any; // Added for Station Overlay

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

type WidgetRenderFn = (ctx: DashboardWidgetContextType) => React.ReactNode;

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
    'forecastChart': (ctx) => (
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
    ),
    'hourly': (ctx) => (
        <HourlyWidget hourly={ctx.hourly} units={ctx.units} isLandlocked={ctx.isLandlocked} />
    ),
    'daily': (ctx) => (
        <DailyWidget forecast={ctx.forecast} isPro={ctx.isPro} onTriggerUpgrade={ctx.onTriggerUpgrade} units={ctx.units} vessel={ctx.vessel} />
    ),
    // FALLBACK for old settings that might still have 'charts'
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
        <DetailedMetricsWidget
            current={ctx.current}
            units={ctx.units}
            hourly={ctx.hourly}
        />
    ),
    'metrics': (ctx) => (
        <div className="flex flex-col gap-6">
            <div className="w-full">
                <BeaufortWidget windSpeed={ctx.current.windSpeed} />
            </div>
        </div>
    ),
    'tides': (ctx) => (
        <TideWidget
            tides={ctx.tides}
            hourlyTides={ctx.hourly}
            tideHourly={ctx.tideHourly}
            units={ctx.units}
            timeZone={ctx.timeZone}
            modelUsed={ctx.modelUsed}
            guiDetails={ctx.tideGUIDetails}
        />
    ),
    'sunMoon': (ctx) => (
        <SunMoonWidget current={ctx.current} units={ctx.units} timeZone={ctx.timeZone} lat={ctx.lat} />
    ),
    'vessel': (ctx) => (
        <VesselWidget vessel={ctx.vessel!} vesselStatus={{}} />
    ),
    // KEEP LEGACY MAPPING JUST IN CASE OF CACHED SETTINGS
    'vesselStatus': (ctx) => (
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
            lat={ctx.lat}
        />
    ),
    'map': (ctx) => (
        <MapWidget onOpenMap={ctx.onOpenMap} />
    )
};

export const WidgetRenderer: React.FC<{ id: string; context: DashboardWidgetContextType }> = React.memo(({ id, context }) => {
    const renderFn = WIDGET_REGISTRY[id];
    if (!renderFn) return null;
    return (
        <>
            {renderFn(context)}
            {/* DEBUG VERSION LABEL - REMOVE LATER */}
            {id === 'dashboard' && (
                <div style={{
                    position: 'fixed', bottom: 85, left: 10,
                    background: 'red', color: 'white', padding: '2px 6px',
                    zIndex: 9999, fontSize: '10px', borderRadius: '4px',
                    fontWeight: 'bold', pointerEvents: 'none'
                }}>
                    v1.3.28
                </div>
            )}
        </>
    );
});
