/**
 * Shared types for Hero card components
 * Extracted from HeroSlide.tsx for better maintainability
 */

import { WeatherMetrics, UnitPreferences, ForecastDay, Tide, HourlyForecast, VesselProfile } from '../../../types';

/**
 * Alignment options for widget content
 */
export type WidgetAlignment = 'left' | 'center' | 'right';

/**
 * Trend direction for metric changes
 */
export type TrendDirection = 'rising' | 'falling' | 'steady' | undefined;

/**
 * Map of metric keys to their trend directions
 */
export type TrendMap = Record<string, TrendDirection>;

/**
 * Data source color indicators
 * - green: Beacon (measured)
 * - amber: Airport (observed)
 * - red: StormGlass (modeled)
 */
export type SourceColor = 'green' | 'amber' | 'red';

/**
 * Source metadata for a metric
 */
export interface MetricSource {
    sourceColor: SourceColor;
    sourceName: string;
    sourceDistance?: string;
}

/**
 * Map of metric keys to their source metadata
 */
export type SourceMap = Record<string, MetricSource>;

/**
 * Display values for card metrics (formatted strings)
 */
export interface CardDisplayValues {
    airTemp: number;
    waterTemperature: string;
    windSpeed: string;
    windDirection: string;
    gusts: string;
    waveHeight: string;
    pressure: string;
    vis: string;
    humidity: string;
    precip: string;
    dewPoint: number;
    highTemp: number;
    lowTemp: number;
    uv: string;
    sunrise: string;
    sunset: string;
    currentSpeed: string;
    currentDirection: string;
}

/**
 * Props for HeroWidget component
 */
export interface HeroWidgetProps {
    id: string;
    data: WeatherMetrics;
    values: any;
    units: UnitPreferences;
    isLive: boolean;
    trends?: TrendMap;
    align?: WidgetAlignment;
    sources?: SourceMap;
}

/**
 * Props for HeroHeader component
 */
export interface HeroHeaderProps {
    cardData: WeatherMetrics;
    cardDisplayValues: CardDisplayValues;
    cardIsLive: boolean;
    cardTime: string | null;
    forceLabel?: string;
    timeZone: string;
    getCardSourceColor: (metricKey: string) => string;
}

/**
 * Props for HeroStatsRows component
 */
export interface HeroStatsRowsProps {
    cardData: WeatherMetrics;
    cardDisplayValues: CardDisplayValues;
    cardTime: string | null;
    timeZone: string;
    trends?: TrendMap;
    getCardSourceColor: (metricKey: string) => string;
}

/**
 * Props for HeroWidgetGrid component
 */
export interface HeroWidgetGridProps {
    layoutType: 'coastal' | 'offshore' | 'inland';
    data: WeatherMetrics;
    values: any;
    units: UnitPreferences;
    isLive: boolean;
    trends?: TrendMap;
    sources?: SourceMap;
    tides?: Tide[];
    timeZone: string;
    selectedTime: string | null;
}
