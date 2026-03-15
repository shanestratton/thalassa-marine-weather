/**
 * Point Weather Service — fetches current weather for a single lat/lon tap on the map.
 *
 * Fires two lightweight parallel API calls:
 *   1. Open-Meteo Forecast — wind, pressure, temp, humidity, cloud cover
 *   2. Open-Meteo Marine — wave height, period, direction, swell
 *
 * Returns a unified PointWeatherData object for the popup display.
 */

import { getOpenMeteoKey } from './keys';

export interface PointWeatherData {
    lat: number;
    lon: number;
    // Atmospheric
    windSpeedKmh: number;
    windDirectionDeg: number;
    windGustsKmh: number;
    pressureMsl: number;
    temperatureC: number;
    humidity: number;
    cloudCover: number;
    // Marine (optional — null if on land)
    waveHeightM: number | null;
    wavePeriodS: number | null;
    waveDirectionDeg: number | null;
    swellHeightM: number | null;
    swellPeriodS: number | null;
    swellDirectionDeg: number | null;
}

/**
 * Fetch current weather conditions at a single point.
 * Both API calls fire in parallel for speed.
 */
export async function fetchPointWeather(lat: number, lon: number): Promise<PointWeatherData | null> {
    const apiKey = getOpenMeteoKey();
    if (!apiKey) return null;

    const latStr = lat.toFixed(4);
    const lonStr = lon.toFixed(4);

    // Fire both requests in parallel
    const [forecast, marine] = await Promise.allSettled([
        fetchForecastPoint(latStr, lonStr, apiKey),
        fetchMarinePoint(latStr, lonStr, apiKey),
    ]);

    const wx = forecast.status === 'fulfilled' ? forecast.value : null;
    if (!wx) return null; // Must have at least atmospheric data

    const sea = marine.status === 'fulfilled' ? marine.value : null;

    return {
        lat,
        lon,
        windSpeedKmh: wx.windSpeedKmh,
        windDirectionDeg: wx.windDirectionDeg,
        windGustsKmh: wx.windGustsKmh,
        pressureMsl: wx.pressureMsl,
        temperatureC: wx.temperatureC,
        humidity: wx.humidity,
        cloudCover: wx.cloudCover,
        waveHeightM: sea?.waveHeightM ?? null,
        wavePeriodS: sea?.wavePeriodS ?? null,
        waveDirectionDeg: sea?.waveDirectionDeg ?? null,
        swellHeightM: sea?.swellHeightM ?? null,
        swellPeriodS: sea?.swellPeriodS ?? null,
        swellDirectionDeg: sea?.swellDirectionDeg ?? null,
    };
}

// ── Forecast (atmospheric) ──────────────────────────────────────

interface AtmoData {
    windSpeedKmh: number;
    windDirectionDeg: number;
    windGustsKmh: number;
    pressureMsl: number;
    temperatureC: number;
    humidity: number;
    cloudCover: number;
}

async function fetchForecastPoint(lat: string, lon: string, apiKey: string): Promise<AtmoData | null> {
    const params = [
        `latitude=${lat}`,
        `longitude=${lon}`,
        'current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover',
        `apikey=${apiKey}`,
    ].join('&');

    const resp = await fetch(`https://customer-api.open-meteo.com/v1/forecast?${params}`);
    if (!resp.ok) return null;

    const data = await resp.json();
    const c = data?.current;
    if (!c) return null;

    return {
        windSpeedKmh: c.wind_speed_10m ?? 0,
        windDirectionDeg: c.wind_direction_10m ?? 0,
        windGustsKmh: c.wind_gusts_10m ?? 0,
        pressureMsl: c.pressure_msl ?? 1013.25,
        temperatureC: c.temperature_2m ?? 0,
        humidity: c.relative_humidity_2m ?? 0,
        cloudCover: c.cloud_cover ?? 0,
    };
}

// ── Marine (waves/swell) ────────────────────────────────────────

interface MarineData {
    waveHeightM: number;
    wavePeriodS: number;
    waveDirectionDeg: number;
    swellHeightM: number;
    swellPeriodS: number;
    swellDirectionDeg: number;
}

async function fetchMarinePoint(lat: string, lon: string, apiKey: string): Promise<MarineData | null> {
    const params = [
        `latitude=${lat}`,
        `longitude=${lon}`,
        'current=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction',
        `apikey=${apiKey}`,
    ].join('&');

    const resp = await fetch(`https://customer-api.open-meteo.com/v1/marine?${params}`);
    if (!resp.ok) return null;

    const data = await resp.json();
    const c = data?.current;
    if (!c) return null;

    // Marine API returns null for land locations
    if (c.wave_height == null && c.swell_wave_height == null) return null;

    return {
        waveHeightM: c.wave_height ?? 0,
        wavePeriodS: c.wave_period ?? 0,
        waveDirectionDeg: c.wave_direction ?? 0,
        swellHeightM: c.swell_wave_height ?? 0,
        swellPeriodS: c.swell_wave_period ?? 0,
        swellDirectionDeg: c.swell_wave_direction ?? 0,
    };
}
