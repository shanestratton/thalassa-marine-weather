import { MarineWeatherReport, WeatherMetrics } from '../types';

export * from './weather';

export const REFRESH_RATES = {
    FAST: 60 * 1000,
    NORMAL: 5 * 60 * 1000,
    SLOW: 15 * 60 * 1000
};
