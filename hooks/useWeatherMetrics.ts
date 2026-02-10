import { useMemo, useState, useEffect } from 'react';
import { HourlyForecast, WeatherMetrics, ForecastDay } from '../types';

interface UseWeatherMetricsParams {
    selectedTime: number | undefined;
    hourly: HourlyForecast[] | undefined;
    current: WeatherMetrics;
    forecast: ForecastDay[] | undefined;
    activeDay: number;
    dynamicHeaderMetrics: boolean;
}

interface UseWeatherMetricsResult {
    activeDayData: WeatherMetrics;
    activeHour: number;
}

/**
 * Custom hook for managing dynamic weather metrics based on selected time
 * Handles the complex logic of finding the right hourly data and merging it with daily data
 */
export const useWeatherMetrics = ({
    selectedTime,
    hourly,
    current,
    forecast,
    activeDay,
    dynamicHeaderMetrics
}: UseWeatherMetricsParams): UseWeatherMetricsResult => {
    const [activeDayData, setActiveDayData] = useState<WeatherMetrics>(current);
    const [activeHour, setActiveHour] = useState(0);

    // Pre-compute hourly data map for O(1) lookups
    const hourlyMap = useMemo(() => {
        if (!hourly) return new Map<number, HourlyForecast>();
        const map = new Map<number, HourlyForecast>();
        hourly.forEach(h => {
            const time = new Date(h.time).getTime();
            map.set(time, h);
        });
        return map;
    }, [hourly]);

    // Update metrics when selectedTime changes
    useEffect(() => {
        if (!dynamicHeaderMetrics) {
            setActiveDayData(current);
            return;
        }

        if (!selectedTime) {
            setActiveDayData(current);
            setActiveHour(0);
        } else {
            // Fast lookup using pre-computed map
            let matchedHourly = hourlyMap.get(selectedTime);

            // If exact match fails, try nearby times (within 30min window)
            if (!matchedHourly && hourly) {
                matchedHourly = hourly.find(h => {
                    const hTime = new Date(h.time).getTime();
                    return Math.abs(hTime - selectedTime) < 1800000;
                });
            }

            if (matchedHourly) {
                // Pre-compute date values
                const selectedDate = new Date(selectedTime);
                const selectedDateStr = selectedDate.toLocaleDateString('en-CA');
                const selectedHour = selectedDate.getHours();

                // Get day data
                const dayData = activeDay === 0 ? current : forecast?.find(f => f.isoDate === selectedDateStr) || current;

                // Batch state updates
                setActiveDayData({
                    ...matchedHourly,
                    airTemperature: matchedHourly.temperature,
                    windDirection: matchedHourly.windDirection || 'VAR',
                    description: matchedHourly.condition || current.description,
                    condition: matchedHourly.condition,
                    sunrise: 'sunrise' in dayData ? dayData.sunrise : undefined,
                    sunset: 'sunset' in dayData ? dayData.sunset : undefined,
                    highTemp: 'highTemp' in dayData ? dayData.highTemp : undefined,
                    lowTemp: 'lowTemp' in dayData ? dayData.lowTemp : undefined
                } as WeatherMetrics);

                const hourOffset = activeDay === 0
                    ? selectedHour - new Date().getHours()
                    : selectedHour;
                setActiveHour(hourOffset);
            }
        }
    }, [selectedTime, dynamicHeaderMetrics, hourly, hourlyMap, current, forecast, activeDay]);

    return {
        activeDayData,
        activeHour
    };
};
