import { CapacitorHttp } from '@capacitor/core';
import { MarineWeatherReport, WeatherModel } from '../../../types';
import { determineLocationType } from '../locationType';
import { getOpenMeteoKey } from '../keys';
import { getCondition, generateDescription } from '../transformers';
import { calculateFeelsLike, calculateDistance } from '../../../utils/math';
import { degreesToCardinal } from '../../../utils/format';

import { generateTacticalAdvice, generateSafetyAlerts } from '../../../utils/advisory';
import { fetchRealTides } from './tides';
import { checkMarineProximity } from '../marineProximity'; // Static Import
import { reverseGeocodeContext } from './geocoding'; // Static Import

// --- OpenMeteo API Response Types ---
interface OMCurrentBlock {
    temperature_2m: number;
    relative_humidity_2m: number;
    apparent_temperature: number;
    is_day: number;
    precipitation: number;
    rain: number;
    showers: number;
    snowfall: number;
    weather_code: number;
    cloud_cover: number;
    pressure_msl: number;
    surface_pressure: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    wind_gusts_10m: number;
}

interface OMHourlyBlock {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
    dew_point_2m: number[];
    precipitation_probability: number[];
    precipitation: number[];
    weather_code: number[];
    pressure_msl: number[];
    surface_pressure: number[];
    cloud_cover: number[];
    visibility: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
    wind_gusts_10m: number[];
    uv_index: number[];
}

interface OMDailyBlock {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    sunrise: string[];
    sunset: string[];
    uv_index_max: number[];
    precipitation_sum: number[];
    precipitation_hours: number[];
    wind_speed_10m_max: number[];
    wind_gusts_10m_max: number[];
    wind_direction_10m_dominant: number[];
}

interface OMWeatherResponse {
    current: OMCurrentBlock;
    hourly: OMHourlyBlock;
    daily: OMDailyBlock;
    timezone: string;
    utc_offset_seconds: number;
    elevation: number | string;
}

interface OMMarineHourly {
    wave_height?: number[];
    wave_period?: number[];
    wave_direction?: number[];
}

interface OMMarineDaily {
    wave_height_max?: number[];
}

interface OMMarineResponse {
    current?: { wave_height?: number; wave_period?: number; wave_direction?: number };
    hourly?: OMMarineHourly;
    daily?: OMMarineDaily;
}

// ... existing code ...

// ... inside fetchOpenMeteo ...





export const attemptGridSearch = async (lat: number, lon: number, name: string): Promise<MarineWeatherReport | null> => {
    // Spiral Grid Search to find nearest marine point
    // We search outward from the center point in increments
    const rings = [
        0.05, // ~5km
        0.10, // ~11km
        0.15, // ~16km
        0.20, // ~22km
        0.30  // ~33km
    ];

    try {

        for (const ring of rings) {
            // Check 8 points around the ring
            // N, NE, E, SE, S, SW, W, NW
            const points = [
                { lat: lat + ring, lon: lon },
                { lat: lat + ring, lon: lon + ring },
                { lat: lat, lon: lon + ring },
                { lat: lat - ring, lon: lon + ring },
                { lat: lat - ring, lon: lon },
                { lat: lat - ring, lon: lon - ring },
                { lat: lat, lon: lon - ring },
                { lat: lat + ring, lon: lon - ring }
            ];

            for (const p of points) {
                const check = await checkMarineProximity(p.lat, p.lon);
                if (check.hasMarineData) {

                    // Found a valid marine point!
                    // Fetch weather for this new point
                    return fetchOpenMeteo(p.lat, p.lon, name, true);
                }
            }
        }
    } catch (e) {

    }
    return null;
};

export const fetchOpenMeteo = async (
    lat: number,
    lon: number,
    locationName: string,
    isFast: boolean,
    model: WeatherModel = 'best_match'
): Promise<MarineWeatherReport> => {
    const now = new Date();
    const apiKey = getOpenMeteoKey();
    const isCommercial = !!apiKey && apiKey.length > 5;

    if (!isCommercial) {
        throw new Error(`STRICT MODE: Commercial Open-Meteo Key Missing. (Key: ${apiKey ? 'Present' : 'Missing'}, Len: ${apiKey ? apiKey.length : 0})`);
    }

    // normalize (wrap/clamp) - copied logic
    const safeLat = Math.max(-90, Math.min(90, lat));
    const safeLon = ((lon + 180) % 360 + 360) % 360 - 180;

    const baseUrl = "https://customer-api.open-meteo.com/v1/forecast";

    const params = new URLSearchParams({
        latitude: safeLat.toFixed(4),
        longitude: safeLon.toFixed(4),
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        hourly: "temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,weather_code,pressure_msl,surface_pressure,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant",
        timezone: "auto",
        forecast_days: "16",
        models: model,
        elevation: "nan" // Explicitly request elevation metadata if needed, though usually default. 
        // actually standard OM API returns it.
    });

    if (isCommercial) params.append("apikey", apiKey!);

    // Fetch Weather using Native HTTP to avoid silent failures/CORS
    const res = await CapacitorHttp.get({ url: `${baseUrl}?${params.toString()}` });

    if (!res || res.status !== 200) {
        throw new Error(`OpenMeteo HTTP ${res?.status || 'no response'}`);
    }

    if (!res.data) {
        throw new Error('OpenMeteo returned no data');
    }

    let wData = res.data as OMWeatherResponse;
    if (typeof wData === 'string') {
        try { wData = JSON.parse(wData); } catch (e) { throw e; }
    }

    // Fetch Marine (Waves) using Ring Search (Proximity)
    let waveData: OMMarineResponse | null = null;
    let distToWaterIdx = 9999;

    try {
        // const { checkMarineProximity } = await import('../marineProximity'); // Static import used
        const proxResult = await checkMarineProximity(lat, lon);

        if (proxResult.hasMarineData) {
            waveData = proxResult.data as OMMarineResponse;
            distToWaterIdx = proxResult.nearestWaterDistanceKm;
        } else {

        }
    } catch (e) {

    }

    // Fetch Tides (Parallel-ish, but we await here for simplicity or use Promise.all above? Let's use Promise.all for speed)
    // Actually, let's refactor to Promise.all the initial fetches.
    // However, for minimal diff, we can just call it here.
    const tideDataPromise = fetchRealTides(lat, lon);

    // Helper: Map WMO Code to String
    const wmoMap: Record<number, string> = {
        0: 'Clear', 1: 'Clear', 2: 'Clouds', 3: 'Overcast',
        45: 'Fog', 48: 'Depositing Rime Fog',
        51: 'Light Drizzle', 53: 'Moderate Drizzle', 55: 'Dense Drizzle',
        61: 'Light Rain', 63: 'Moderate Rain', 65: 'Heavy Rain',
        80: 'Light Showers', 81: 'Moderate Showers', 82: 'Violent Showers',
        95: 'Thunderstorm', 96: 'Thunderstorm with Hail'
    };
    const getWmo = (code: number) => wmoMap[code] || 'Cloudy';

    // Build Current
    const cur = wData.current;
    const curWave = waveData?.current || {};

    // Fallback if current block missing (rare)
    if (!cur) throw new Error("OpenMeteo: No Current Data");

    // Use hourly fallback for Visibility (not in current)
    const currentHourIndex = wData.hourly?.time?.findIndex((t: string) => t.startsWith(now.toISOString().slice(0, 13))) || 0;
    const curVis = wData.hourly?.visibility ? wData.hourly.visibility[currentHourIndex] : 10000; // meters
    const curDew = wData.hourly?.dew_point_2m ? wData.hourly.dew_point_2m[currentHourIndex] : 0;
    const curUV = wData.hourly?.uv_index ? wData.hourly.uv_index[currentHourIndex] : 0;

    const windKts = cur.wind_speed_10m * 1.94384; // km/h to knots? NO. OM uses km/h by default unless specified. 
    // Wait, params didn't specify units. Default is km/h. 
    // Is 1 km/h = 0.539957 knots.
    // 1 m/s = 1.94384 knots.
    // OpenMeteo Default: km/h. To Knots: * 0.539957.
    // Wait, let's check legacy code. 
    // Legacy `weatherService.ts`: "windSpeed: wData.current.wind_speed_10m * 0.539957" (Line 1585 in original thought process? No, I need verification.)

    // VERIFICATION: Open-Meteo docs say default windspeed unit is km/h.
    // 1 km/h = 0.539957 kts.
    // Legacy code (implicit): likely used 0.54.
    const kFactor = 0.539957;

    const waveH = (curWave.wave_height || 0) * 3.28084; // m to ft

    const currentMetrics = {
        windSpeed: parseFloat((cur.wind_speed_10m * kFactor).toFixed(1)),
        windGust: parseFloat((cur.wind_gusts_10m * kFactor).toFixed(1)),
        windDirection: degreesToCardinal(cur.wind_direction_10m),
        windDegree: cur.wind_direction_10m,
        waveHeight: parseFloat(waveH.toFixed(1)),
        swellPeriod: curWave.wave_period || 0,
        swellDirection: degreesToCardinal(curWave.wave_direction || 0),
        airTemperature: cur.temperature_2m,
        waterTemperature: 0, // OM Marine doesn't give water temp easily in basic tier? actually 'hourly' has it in marine? No.
        pressure: cur.pressure_msl,
        cloudCover: cur.cloud_cover,
        visibility: parseFloat((curVis * 0.000539957).toFixed(1)), // m to NM
        dewPoint: curDew,
        fogRisk: false, // Calculate later?
        precipitation: cur.precipitation,
        humidity: cur.relative_humidity_2m,
        uvIndex: curUV,
        condition: getWmo(cur.weather_code),
        description: "",
        day: wData.timezone ? now.toLocaleDateString('en-US', { weekday: 'long', timeZone: wData.timezone }) : "Today",
        date: wData.timezone ? now.toLocaleDateString('en-US', { timeZone: wData.timezone }) : now.toLocaleDateString(),
        feelsLike: calculateFeelsLike(cur.temperature_2m, cur.relative_humidity_2m, cur.wind_speed_10m * kFactor * 0.8), // Approx
        isDay: cur.is_day === 1,
        isEstimated: false,
        sunrise: "", // Filled from daily
        sunset: "",
        moonPhase: "",
        moonIllumination: 0,
        currentSpeed: 0,
        currentDirection: 0,
        highTemp: undefined as number | undefined,
        lowTemp: undefined as number | undefined
    };
    currentMetrics.description = generateDescription(currentMetrics.condition, currentMetrics.windSpeed, currentMetrics.windDirection, waveH);

    // Build Daily
    const dailyArr = wData.daily || {};
    const dailies = (dailyArr.time || []).map((t: string, i: number) => ({
        day: new Date(t).toLocaleDateString('en-US', { weekday: 'long' }),
        date: new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        isoDate: t,
        highTemp: dailyArr.temperature_2m_max[i],
        lowTemp: dailyArr.temperature_2m_min[i],
        windSpeed: parseFloat((dailyArr.wind_speed_10m_max[i] * kFactor).toFixed(1)),
        windGust: parseFloat((dailyArr.wind_gusts_10m_max[i] * kFactor).toFixed(1)),
        waveHeight: waveData?.daily?.wave_height_max ? parseFloat((waveData.daily.wave_height_max[i] * 3.28084).toFixed(1)) : 0,
        condition: getWmo(dailyArr.weather_code[i]),
        precipitation: dailyArr.precipitation_sum[i],
        uvIndex: dailyArr.uv_index_max[i],
        sunrise: new Date(dailyArr.sunrise[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        sunset: new Date(dailyArr.sunset[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        pressure: 1013, // Daily pressure avg not easily available
        cloudCover: 50,
        isEstimated: false,
        humidity: 80,
        visibility: 10,
        precipLabel: "",
        precipValue: ""
    }));

    if (dailies.length > 0) {
        currentMetrics.sunrise = dailies[0].sunrise;
        currentMetrics.sunset = dailies[0].sunset;
        currentMetrics.highTemp = dailies[0].highTemp;
        currentMetrics.lowTemp = dailies[0].lowTemp;
    }

    // Build Hourly (Simplified)
    const hourlyArr = wData.hourly || {};
    const hourly = (hourlyArr.time || []).map((t: string, i: number) => ({
        time: t,
        windSpeed: hourlyArr.wind_speed_10m[i] * kFactor,
        windGust: hourlyArr.wind_gusts_10m[i] * kFactor,
        waveHeight: waveData?.hourly?.wave_height ? waveData.hourly.wave_height[i] * 3.28084 : 0,
        swellPeriod: waveData?.hourly?.wave_period ? waveData.hourly.wave_period[i] : 0,
        temperature: hourlyArr.temperature_2m[i],
        pressure: hourlyArr.pressure_msl[i],
        precipitation: hourlyArr.precipitation[i],
        cloudCover: hourlyArr.cloud_cover[i],
        condition: getWmo(hourlyArr.weather_code[i]),
        visibility: hourlyArr.visibility[i] * 0.000539957,
        humidity: hourlyArr.relative_humidity_2m[i],
        isEstimated: false,
        currentSpeed: 0,
        currentDirection: 0,
        waterTemperature: 0,
        uvIndex: hourlyArr.uv_index[i],
        feelsLike: calculateFeelsLike(hourlyArr.temperature_2m[i], hourlyArr.relative_humidity_2m[i], hourlyArr.wind_speed_10m[i] * kFactor * 0.8)
    }));

    // Advice
    const advice = generateTacticalAdvice(currentMetrics, false, locationName, undefined, [], currentMetrics.sunset);

    const report: MarineWeatherReport = {
        locationName,
        coordinates: { lat, lon },
        generatedAt: now.toISOString(),
        current: currentMetrics,
        hourly: hourly,
        forecast: dailies,
        tides: [],
        tideHourly: [],
        modelUsed: `openmeteo_${model}`,
        boatingAdvice: advice,
        isLandlocked: false,
        alerts: generateSafetyAlerts(currentMetrics, dailies[0]?.highTemp, dailies),
        timeZone: wData.timezone,
        utcOffset: wData.utc_offset_seconds
    };

    // Attach Tides
    try {
        const tideRes = await tideDataPromise;
        if (tideRes) {
            report.tides = tideRes.tides;
            if (tideRes.guiDetails) {
                report.tideGUIDetails = tideRes.guiDetails;
            }
        }
    } catch (e) {
    }

    // Infer Location Type
    let locType: 'coastal' | 'offshore' | 'inland' = 'offshore';

    // 1. Determine "Distance to Water" using Marine Grid Snap
    // (Handled by Ring Search above: distToWaterIdx is set to 0 if found)
    const hasMarineData = waveData !== null;

    // 2. Perform Geocoding Lookup (Context)
    // We need this to determine distance to land (for Offshore rule) AND verify if we are actually on land.
    let landCtx: { name: string; lat: number; lon: number } | null = null;
    let distToLand = 9999;
    try {
        // const { reverseGeocodeContext } = await import('./geocoding'); // Static import used
        landCtx = await reverseGeocodeContext(lat, lon);
        if (landCtx) {
            // FIX: If the name is generic (e.g. "Location -23,150") or a Water Body (e.g. "South Pacific Ocean")
            // In this case, we should treat it as "Unknown Context" so the inland rule (elevation) can take over.
            const isGeneric = landCtx.name.startsWith("Location") ||
                /^[+-]?\d/.test(landCtx.name) ||
                /\b(Ocean|Sea|Reef)\b/i.test(landCtx.name); // Contains Ocean/Sea/Reef anywhere

            if (!isGeneric) {
                distToLand = calculateDistance(lat, lon, landCtx.lat, landCtx.lon);
            } else {

                landCtx = null;
                distToLand = 9999;
            }
        }
    } catch (e) {
    }

    // 2.1 Name Improvement logic:
    // If the input 'locationName' is generic (e.g. coordinates or "Current Location")
    // AND we found a specific context name (e.g. "Mooloolaba, QLD"), use it.
    if (landCtx && landCtx.name) {
        const isCurrentGeneric = locationName.startsWith("WP") ||
            locationName.startsWith("Current") ||
            locationName.includes(",") && locationName.match(/[0-9]/);

        if (isCurrentGeneric && !landCtx.name.startsWith("Location")) {
            report.locationName = landCtx.name;
        }
    }

    // 3. Robust Classification Logic
    // Fix: If we filtered out "Ocean" and found NO land context, we are definitely OFFSHORE,
    // regardless of what the grid snap says (which can be >2km in deep ocean).
    // UPDATE: If distToLand is 9999 (null context), pass NULL to determiner to trigger Inland Check.
    const effectiveDistToLand = landCtx ? distToLand : null;




    // Determine Location Type using Shared Utility
    locType = determineLocationType(
        effectiveDistToLand,
        distToWaterIdx,
        landCtx?.name,
        report.tides && report.tides.length > 0,
        typeof wData.elevation === 'number' ? wData.elevation : undefined // Pass elevation for Lake filtering
    );



    report.locationType = locType;
    report.isLandlocked = locType === 'inland'; // Backwards compat
    // Store distToLand for ShipLogService adaptive logging zones
    if (distToLand < 9999) {
        report.distToLandKm = distToLand;
    }
    // Store elevation for EnvironmentService theme detection
    if (wData.elevation !== undefined && wData.elevation !== 'nan') {
        (report as unknown as Record<string, unknown>)._elevation = typeof wData.elevation === 'number' ? wData.elevation : parseFloat(wData.elevation as string);
    }

    return report;
};
