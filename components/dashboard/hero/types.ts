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
export type SourceColor = 'emerald' | 'amber' | 'sky' | 'white';

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
 * Display values for card metrics (formatted for rendering).
 * All fields are `number | string` because fallback values use `'--'`.
 */
export interface CardDisplayValues {
    airTemp: number | string;
    waterTemperature: number | string;
    windSpeed: number | string;
    windDirection?: string;
    gusts: number | string;
    waveHeight: number | string;
    pressure: number | string;
    vis: number | string;
    humidity: number | string;
    precip: number | string;
    dewPoint: number | string;
    highTemp: number | string;
    lowTemp: number | string;
    uv: number | string;
    sunrise?: string;
    sunset?: string;
    currentSpeed: number | string;
    currentDirection: number | string;
    feelsLike?: number | string;
    cloudCover?: number | string;
    moon?: string;
}

/**
 * Props for HeroWidget component
 */
export interface HeroWidgetProps {
    id: string;
    data: WeatherMetrics;
    values: CardDisplayValues;
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
    values: CardDisplayValues;
    units: UnitPreferences;
    isLive: boolean;
    trends?: TrendMap;
    sources?: SourceMap;
    tides?: Tide[];
    timeZone: string;
    selectedTime: string | null;
}
