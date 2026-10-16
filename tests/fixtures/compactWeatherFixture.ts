import { minifyWeather, type CompactSource } from '../../utils/compactWeather';

export const COMPACT_NOW = Date.parse('2026-10-16T02:17:19Z');
export function compactSource(lat = -27.12, lon = 153.12): CompactSource {
    return {
        provider: 'weatherkit',
        timestamp: '2026-10-16T02:14:11Z',
        coordinates: { lat, lon },
        timezone: 'Australia/Brisbane',
        isPremium: false,
        current: {
            temperature: null,
            feelsLike: 25.2,
            humidity: null,
            pressure: 1009.6,
            windSpeed: 0,
            windDirection: 0,
            windGust: null,
            condition: 'Heavy Rain',
            cloudCover: null,
            visibility: null,
            uvIndex: null,
            precipitation: 0,
            dewPoint: null,
            isDay: true,
        },
        hourly: Array.from({ length: 48 }, (_, i) => ({
            time: new Date(Date.parse('2026-10-16T00:00:00Z') + i * 3_600_000).toISOString(),
            temperature: null,
            windSpeed: i === 2 ? null : i,
            windDirection: 0,
            windGust: null,
            precipitation: null,
            precipProbability: null,
            condition: 'Unknown',
            pressure: null,
            cloudCover: null,
            humidity: null,
        })),
        daily: Array.from({ length: 7 }, (_, i) => ({
            date: `2026-10-${16 + i}`,
            tempMax: null,
            tempMin: 0,
            windSpeedMax: null,
            windGustMax: null,
            condition: 'Unknown',
            precipSum: null,
            precipProbability: null,
            sunrise: '',
            sunset: '',
            uvIndexMax: null,
        })),
    };
}
export const compactFixture = (lat = -27.12, lon = 153.12) => minifyWeather(compactSource(lat, lon), COMPACT_NOW);
