import { fetchNearestMetar, getShortCondition } from './MetarService';
import { MarineWeatherReport, WeatherMetrics } from '../types';
import { degreesToCardinal } from '../utils';

export * from './weather';

export const REFRESH_RATES = {
    FAST: 60 * 1000,
    NORMAL: 5 * 60 * 1000,
    SLOW: 15 * 60 * 1000
};

/**
 * Super-fast fetch for "Now" card data using Airport METARs.
 * Used to paint the UI immediately while Marine models load.
 */
export const fetchFastAirportWeather = async (locationName: string, coords?: { lat: number, lon: number }, timeZone?: string): Promise<MarineWeatherReport | null> => {
    if (!coords) return null;

    try {
        const metar = await fetchNearestMetar(coords.lat, coords.lon);
        if (!metar) return null;

        const now = new Date(); // Device time, but we will format it if timeZone is present

        // Explicit Nulls so UI shows '--' instead of 0
        const current: WeatherMetrics = {
            windSpeed: metar.windSpeed, // Knots
            windGust: metar.windGust || null,
            windDirection: degreesToCardinal(metar.windDirection),
            windDegree: metar.windDirection,
            waveHeight: null,
            swellPeriod: null,
            swellDirection: undefined,
            airTemperature: metar.temperature,
            waterTemperature: null,
            pressure: metar.pressure,
            cloudCover: metar.cloudCover !== undefined ? metar.cloudCover : null,
            visibility: metar.visibility !== -1 ? metar.visibility : 10,
            humidity: null,
            uvIndex: undefined, // undefined shows '--' in some logic, null often preferred. Let's use undefined to match 'optional' types if needed. actually interface has optional.
            condition: getShortCondition(metar),
            description: metar.raw,
            day: timeZone ? now.toLocaleDateString('en-US', { weekday: 'long', timeZone }) : "Today",
            date: timeZone ? now.toLocaleDateString('en-US', { timeZone }) : now.toLocaleDateString(),
            isEstimated: false,
            stationId: metar.stationId
        } as unknown as WeatherMetrics;

        return {
            locationName: locationName,
            coordinates: coords,
            generatedAt: now.toISOString(),
            current: current,
            forecast: [], // Empty
            hourly: [],   // Empty
            tides: [],
            boatingAdvice: "Loading detailed marine forecast...",
            modelUsed: 'metar_airport_fast',
            isLandlocked: false,
            timeZone: timeZone // Pass it through so UI Clocks update immediately
        };

    } catch (e) {
        console.warn("Fast Airport Fetch Failed", e);
        return null;
    }
};

