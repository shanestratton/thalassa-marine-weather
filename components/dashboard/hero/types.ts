/**
 * Shared types for Hero card components
 * Extracted from HeroSlide.tsx for better maintainability
 */

import { WeatherMetrics } from '../../../types';

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
    precipUnit?: string; // 'mm' for live, '%' for forecast
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
    cape?: number | string;
    secondarySwellHeight?: number | string;
    secondarySwellPeriod?: number | string;
    sogKts?: number | string;
    cogDeg?: number | string;
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
