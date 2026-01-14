
import { MarineWeatherReport, HourlyForecast, ForecastDay, WeatherMetrics, Tide, TidePoint, StormGlassHour, StormGlassResponse } from "../types";
import { generateSafetyAlerts, getBeaufort, expandCompassDirection, generateTacticalAdvice } from "../utils";

const BASE_URL = 'https://api.stormglass.io/v2';

const logConfig = (msg: string) => console.log(`[Stormglass Config] ${msg}`);

const getApiKey = () => {
    let key = "";

    // 1. Try Vite native
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_STORMGLASS_API_KEY) {
        key = import.meta.env.VITE_STORMGLASS_API_KEY as string;
    }

    // 2. Try Process Env (Direct access required for replacement)
    // Only try if not already found to avoid overwriting with potentially empty process.env in some builds
    if (!key) {
        try {
            // @ts-ignore
            if (typeof process !== 'undefined' && process.env && process.env.STORMGLASS_API_KEY) {
                // @ts-ignore
                key = process.env.STORMGLASS_API_KEY;
            }
        } catch (e) { }
    }

    // Clean up quotes if they got injected by build process
    if (key) {
        const cleanKey = key.replace(/["']/g, "").trim();
        if (cleanKey.length > 20) {
            return cleanKey;
        }
    }

    // HARDCODED FALLBACK (Restoring functionality)
    return "d5cfe8a6-da85-11f0-9b8c-0242ac130003-d5cfe950-da85-11f0-9b8c-0242ac130003";
};

const getOpenMeteoKey = () => {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_OPEN_METEO_API_KEY) {
        return import.meta.env.VITE_OPEN_METEO_API_KEY as string;
    }
    try {
        // @ts-ignore
        if (typeof process !== 'undefined' && process.env) {
            // @ts-ignore
            if (process.env.OPEN_METEO_API_KEY) return process.env.OPEN_METEO_API_KEY;
        }
    } catch (e) { }
    return null;
};

// --- STARTUP LOG ---
const sgKey = getApiKey();
// Log masked key to help debugging
const maskedKey = sgKey && sgKey.length > 5 ? `...${sgKey.slice(-4)}` : "None";
if (sgKey && sgKey.length > 20) {
    console.log(`Stormglass Status: Active (${maskedKey})`);
} else {
    console.log(`Stormglass Status: Free Mode (Open-Meteo)`);
}

export const getApiKeySuffix = () => {
    const key = getApiKey();
    if (!key || key.length < 5) return "NONE";
    return "..." + key.slice(-4);
}

export const isStormglassKeyPresent = () => {
    const key = getApiKey();
    return key && key.length > 20;
};

// Returns RAW string for debugging UI
export const debugStormglassConnection = async (): Promise<string> => {
    const apiKey = getApiKey();
    const now = new Date().toISOString();
    // Minimal request for debugging
    const url = `${BASE_URL}/weather/point?lat=0&lng=0&params=windSpeed&source=sg&start=${now}&end=${now}`;

    let log = `--- STORMGLASS DIAGNOSTIC ---\nTime: ${now}\nKey Suffix: ${apiKey ? apiKey.slice(-4) : 'MISSING'}\nURL: ${url}\n`;

    if (!apiKey) {
        return log + "\nINFO: API Key not found. App is running in Free Mode (OpenMeteo). This is normal if you haven't purchased a Stormglass key.";
    }

    try {
        const res = await fetch(url, {
            headers: { 'Authorization': apiKey },
            cache: 'no-store'
        });
        log += `Status: ${res.status} ${res.statusText}\n`;
        res.headers.forEach((val, key) => log += `  ${key}: ${val}\n`);
        const body = await res.text();
        log += `\nResponse Body:\n${body.substring(0, 500)}${body.length > 500 ? '...' : ''}`;
        return log;
    } catch (e: any) {
        log += `\nFATAL EXCEPTION:\n${e.message}\n${e.stack || ''}`;
        return log;
    }
}

export const checkStormglassStatus = async (): Promise<{ status: 'OK' | 'ERROR' | 'MISSING_KEY', message: string, code?: number }> => {
    const apiKey = getApiKey();
    if (!apiKey) return { status: 'MISSING_KEY', message: 'Free Tier (Open-Meteo)', code: 200 };

    const now = new Date().toISOString();
    const url = `${BASE_URL}/weather/point?lat=0&lng=0&params=windSpeed&source=sg&start=${now}&end=${now}`;
    try {
        const res = await fetch(url, { headers: { 'Authorization': apiKey } });
        if (res.ok) return { status: 'OK', message: 'Active' };
        if (res.status === 402) return { status: 'ERROR', message: 'Quota/Plan Limit', code: 402 };
        if (res.status === 401 || res.status === 403) return { status: 'ERROR', message: 'Invalid Key', code: 403 };
        return { status: 'ERROR', message: `HTTP ${res.status}`, code: res.status };
    } catch (e: any) {
        return { status: 'ERROR', message: 'Network Connection Failed', code: 0 };
    }
};

const msToKnots = (ms: number | null) => (ms !== null && ms !== undefined) ? ms * 1.94384 : null;
const mToFt = (m: number | null) => (m !== null && m !== undefined) ? m * 3.28084 : null;

const degreesToCardinal = (deg: number): string => {
    if (deg === undefined || deg === null) return 'N';
    const val = Math.floor((deg / 22.5) + 0.5);
    const arr = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return arr[val % 16] || "N";
};

const getCondition = (cloudCover: number, precip: number, isDay: boolean): string => {
    if (precip > 0.5) return 'Rain';
    if (cloudCover <= 20) return isDay ? 'Sunny' : 'Clear';
    if (cloudCover <= 50) return isDay ? 'Mostly Sunny' : 'Mostly Clear';
    if (cloudCover <= 85) return 'Partly Cloudy';
    return 'Overcast';
};

const generateDescription = (condition: string, windSpeed: number | null, windDir: string, waveHeight: number | null): string => {
    const windDesc = getBeaufort(windSpeed).desc;
    const fullDir = expandCompassDirection(windDir);
    const waveStr = waveHeight !== null && waveHeight > 0 ? `Seas ${waveHeight.toFixed(1)}ft.` : '';
    return `${condition}. ${windDesc} from the ${fullDir}. ${waveStr}`;
};

interface StormGlassTideData {
    time: string;
    height: number;
    type?: string;
    sg?: number;
    noaa?: number;
    [key: string]: number | string | undefined;
}

const fetchSG = async <T>(endpoint: string, params: Record<string, any>, apiKey: string): Promise<T> => {
    // FIX: Robust URL construction (strip leading slashes from endpoint, ensure single slash from base)
    const cleanEndpoint = endpoint.replace(/^\/+/, '');
    const url = new URL(`${BASE_URL}/${cleanEndpoint}`);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    try {
        const res = await fetch(url.toString(), { headers: { 'Authorization': apiKey } });
        if (!res.ok) {
            const body = await res.text();
            console.error(`Stormglass API Error (${res.status}):`, body);

            if (res.status === 402 || res.status === 429) {
                throw new Error(`SG_QUOTA: ${res.status} - ${body}`);
            }
            throw new Error(`SG_HTTP_${res.status}: ${body}`);
        }
        return await res.json() as T;
    } catch (e: any) {
        throw e;
    }
};

const fetchSeaLevels = async (lat: number, lon: number, apiKey: string): Promise<StormGlassTideData[]> => {
    // USER REQUEST: FORCE MOCK DATA (Bypass SG API)
    return [];

    /* API DISABLED
    try {
        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
    
        const end = new Date(start.getTime() + 25 * 60 * 60 * 1000);
    
        const data = await fetchSG<{ data: StormGlassTideData[] }>('/tide/sea_level/point', { lat, lng: lon, start: start.toISOString(), end: end.toISOString(), datum: 'MLLW' }, apiKey);
        return data.data || [];
    } catch (e) {
        return [];
    }
        /* */
};

const generateMockTides = (): Tide[] => {
    const now = Date.now();
    const start = now - 24 * 60 * 60 * 1000;
    const end = now + 48 * 60 * 60 * 1000;
    const tides: Tide[] = [];
    let t = start;
    let isHigh = true;
    while (t < end) {
        tides.push({
            time: new Date(t).toISOString(),
            type: isHigh ? 'High' : 'Low',
            height: isHigh ? 2.5 : 0.5
        });
        t += (6 * 60 * 60 * 1000) + (12 * 60 * 1000);
        isHigh = !isHigh;
    }
    return tides;
};

const fetchRealTides = async (lat: number, lon: number, apiKey: string): Promise<Tide[]> => {
    // USER REQUEST: FORCE MOCK DATA
    console.log("[StormGlassService] Using Mock Tides (User Override)");
    return generateMockTides();

    /* API DISABLED
    try {
        const now = new Date();
        const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const end = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    
        const data = await fetchSG<{ data: StormGlassTideData[] }>('/tide/extremes/point', { lat, lng: lon, start: start.toISOString(), end: end.toISOString(), datum: 'MLLW' }, apiKey);
    
        if (data && data.data && data.data.length > 0) {
            return data.data.map((t) => ({
                time: t.time,
                type: t.type === 'high' ? 'High' : 'Low',
                height: parseFloat((t.height * 3.28084).toFixed(2))
            }));
        }
        return [];
    } catch (e) {
        return [];
    }
        */
};

const interpolateTideHeight = (timestamp: number, extremes: Tide[]): number | undefined => {
    if (!extremes || extremes.length < 2) return undefined;

    const sorted = [...extremes].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    let t1: Tide | null = null;
    let t2: Tide | null = null;

    for (let i = 0; i < sorted.length - 1; i++) {
        const tA = new Date(sorted[i].time).getTime();
        const tB = new Date(sorted[i + 1].time).getTime();
        if (timestamp >= tA && timestamp <= tB) {
            t1 = sorted[i];
            t2 = sorted[i + 1];
            break;
        }
    }

    if (!t1 || !t2) return undefined;

    const timeA = new Date(t1.time).getTime();
    const timeB = new Date(t2.time).getTime();
    const duration = timeB - timeA;
    const elapsed = timestamp - timeA;

    const phase = (elapsed / duration) * Math.PI;

    const h1 = t1.height;
    const h2 = t2.height;

    return (h1 + h2) / 2 + (h1 - h2) / 2 * Math.cos(phase);
};

export const fetchOpenMeteo = async (
    lat: number,
    lon: number,
    locationName: string,
    isFast: boolean
): Promise<MarineWeatherReport> => {
    const now = new Date();
    const apiKey = getOpenMeteoKey();
    const isCommercial = !!apiKey && apiKey.length > 5;

    const baseUrl = isCommercial
        ? "https://customer-api.open-meteo.com/v1/forecast"
        : "https://api.open-meteo.com/v1/forecast";

    const params = new URLSearchParams({
        latitude: lat.toFixed(4),
        longitude: lon.toFixed(4),
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        hourly: "temperature_2m,relative_humidity_2m,dew_point_2m,precipitation_probability,precipitation,weather_code,pressure_msl,surface_pressure,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,uv_index",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum,precipitation_hours,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant",
        timezone: "auto",
        forecast_days: "12",
        models: "best_match"
    });

    if (isCommercial) {
        params.append("apikey", apiKey!);
    }

    try {
        const res = await fetch(`${baseUrl}?${params.toString()}`);
        if (!res.ok) throw new Error(`OpenMeteo ${res.status}`);
        const wData = await res.json();

        // Marine Data Fetch (Waves)
        let waveData: any = null;
        try {
            const marineUrl = isCommercial
                ? "https://customer-api.open-meteo.com/v1/marine"
                : "https://marine-api.open-meteo.com/v1/marine";

            const marineParams = new URLSearchParams({
                latitude: lat.toFixed(4),
                longitude: lon.toFixed(4),
                current: "wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period,swell_wave_direction",
                hourly: "wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction",
                daily: "wave_height_max,wave_direction_dominant,wave_period_max",
                timezone: "auto",
                forecast_days: "12"
            });
            if (isCommercial) marineParams.append("apikey", apiKey!);

            const mRes = await fetch(`${marineUrl}?${marineParams.toString()}`);
            if (mRes.ok) waveData = await mRes.json();
        } catch (e) {
            console.warn("Marine data fetch failed", e);
        }

        // Helper for condition text
        const getWmoCondition = (code: number) => {
            const map: Record<number, string> = {
                0: 'Clear Sky', 1: 'Mainly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
                45: 'Fog', 48: 'Depositing Rime Fog',
                51: 'Light Drizzle', 53: 'Moderate Drizzle', 55: 'Dense Drizzle',
                61: 'Slight Rain', 63: 'Moderate Rain', 65: 'Heavy Rain',
                80: 'Slight Showers', 81: 'Moderate Showers', 82: 'Violent Showers',
                95: 'Thunderstorm', 96: 'Thunderstorm with Hail', 99: 'Heavy Thunderstorm'
            };
            return map[code] || 'Unknown';
        };

        const current = wData.current;
        const currentMarine = waveData?.current;

        const windSpeed = current.wind_speed_10m ? current.wind_speed_10m * 0.539957 : 0; // kmh to knots
        const windGust = current.wind_gusts_10m ? current.wind_gusts_10m * 0.539957 : 0;

        const waveHeight = currentMarine ? currentMarine.wave_height * 3.28084 : 0; // m to ft
        const isLandlocked = !currentMarine || currentMarine.wave_height === null;

        const currentMetrics: WeatherMetrics = {
            windSpeed: parseFloat(windSpeed.toFixed(1)),
            windGust: parseFloat(windGust.toFixed(1)),
            windDirection: degreesToCardinal(current.wind_direction_10m),
            windDegree: current.wind_direction_10m,
            waveHeight: waveHeight ? parseFloat(waveHeight.toFixed(1)) : 0,
            swellPeriod: currentMarine?.swell_wave_period || null,
            swellDirection: currentMarine ? degreesToCardinal(currentMarine.swell_wave_direction) : undefined,
            airTemperature: current.temperature_2m,
            waterTemperature: null,
            pressure: current.pressure_msl,
            cloudCover: current.cloud_cover,
            visibility: null,
            precipitation: current.precipitation,
            humidity: current.relative_humidity_2m,
            uvIndex: wData.daily?.uv_index_max?.[0] || 0,
            condition: getWmoCondition(current.weather_code),
            description: `${getWmoCondition(current.weather_code)}. Wind ${windSpeed.toFixed(0)}kts.`,
            day: "Today",
            date: now.toLocaleDateString(),
            feelsLike: current.apparent_temperature,
            isEstimated: false
        };

        const hourly: HourlyForecast[] = wData.hourly.time.slice(0, 24).map((t: string, i: number) => {
            const hMarine = waveData?.hourly;
            return {
                time: new Date(t).toLocaleTimeString([], { hour: 'numeric', hour12: true }),
                windSpeed: wData.hourly.wind_speed_10m[i] * 0.539957,
                windGust: wData.hourly.wind_gusts_10m[i] * 0.539957,
                waveHeight: hMarine ? hMarine.wave_height[i] * 3.28084 : 0,
                temperature: wData.hourly.temperature_2m[i],
                precipitation: wData.hourly.precipitation[i],
                cloudCover: wData.hourly.cloud_cover[i],
                condition: getWmoCondition(wData.hourly.weather_code[i]),
                swellPeriod: hMarine ? hMarine.swell_wave_period[i] : null,
                isEstimated: false,
                humidity: wData.hourly.relative_humidity_2m[i],
                visibility: wData.hourly.visibility[i] ? wData.hourly.visibility[i] * 0.000539957 : null // Convert Meters to NM
            };
        });

        const forecast: ForecastDay[] = wData.daily.time.map((t: string, i: number) => {
            const dMarine = waveData?.daily;
            return {
                day: new Date(t).toLocaleDateString('en-US', { weekday: 'long' }),
                date: new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                highTemp: wData.daily.temperature_2m_max[i],
                lowTemp: wData.daily.temperature_2m_min[i],
                windSpeed: wData.daily.wind_speed_10m_max[i] * 0.539957,
                windGust: wData.daily.wind_gusts_10m_max[i] * 0.539957,
                waveHeight: dMarine ? dMarine.wave_height_max[i] * 3.28084 : 0,
                condition: getWmoCondition(wData.daily.weather_code[i]),
                precipitation: wData.daily.precipitation_sum[i],
                uvIndex: wData.daily.uv_index_max[i],
                sunrise: new Date(wData.daily.sunrise[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                sunset: new Date(wData.daily.sunset[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                isEstimated: false,
                // Aggregate Daily Humidity/Visibility from Hourly (Pick Noon = Index 12)
                // Note: Hourly is flat 240 hours. Accessing by Day Index * 24 + 12
                humidity: wData.hourly.relative_humidity_2m[i * 24 + 12],
                visibility: wData.hourly.visibility[i * 24 + 12] ? wData.hourly.visibility[i * 24 + 12] * 0.000539957 : null
            };
        });



        // Use Robust Tactical Advice generator instead of generic "Conditions valid"
        const robustAdvice = generateTacticalAdvice(currentMetrics, isLandlocked);

        return {
            locationName,
            coordinates: { lat, lon },
            current: currentMetrics,
            forecast,
            hourly,
            tides: [], // No tides in OM basic
            boatingAdvice: robustAdvice,
            alerts: generateSafetyAlerts(currentMetrics, forecast[0]?.highTemp, forecast),
            generatedAt: now.toISOString(),
            modelUsed: isCommercial ? "Open-Meteo Commercial" : "Open-Meteo (Free)",
            groundingSource: "Open-Meteo",
            isLandlocked,
            timeZone: wData.timezone,
            utcOffset: wData.utc_offset_seconds ? wData.utc_offset_seconds / 3600 : 0
        };

    } catch (e: any) {
        throw new Error(`OpenMeteo Failed: ${e.message}`);
    }
};

export const fetchStormglassData = async (
    lat: number,
    lon: number,
    locationName: string,
    allowFallback: boolean = true,
    baseForecast?: ForecastDay[]
): Promise<MarineWeatherReport> => {
    const apiKey = getApiKey();

    // Check if we are using the secure environment variable
    const isSecureEnv = !!apiKey;
    let usedModelLabel = 'SG PRO';

    if (!apiKey) {
        // Force fallback if no key
        if (!allowFallback) throw new Error("No Stormglass Key configured.");
        console.warn("No Stormglass Key, failing over to Open-Meteo or NOAA if available.");
        // We throw here to trigger the catch block in the caller (weatherService) to try standard fallbacks
        throw new Error("Missing API Key");
    }

    const now = new Date();
    const endDate = new Date(now.getTime() + 12 * 24 * 60 * 60 * 1000);
    const startStr = now.toISOString();
    const endStr = endDate.toISOString();

    const fullParams = [
        'windSpeed', 'windDirection', 'gust',
        'waveHeight', 'wavePeriod', 'waveDirection',
        'swellHeight', 'swellPeriod',
        'airTemperature', 'pressure',
        'cloudCover', 'visibility', 'precipitation',
        'waterTemperature', 'humidity',
        'currentSpeed', 'currentDirection'
    ];

    let weatherData: StormGlassResponse | undefined;

    try {
        weatherData = await fetchSG<StormGlassResponse>('weather/point', {
            lat, lng: lon,
            params: fullParams.join(','),
            source: 'sg',
            start: startStr, end: endStr
        }, apiKey);
    } catch (e: any) {
        if (e.message.includes("SG_QUOTA") || e.message.includes("402") || e.message.includes("429")) {
            throw e;
        }

        if (!allowFallback) throw e;

        try {
            console.warn("SG Source Unreachable, trying NOAA GFS...");
            weatherData = await fetchSG<StormGlassResponse>('weather/point', {
                lat, lng: lon,
                params: fullParams.join(','),
                source: 'noaa',
                start: startStr, end: endStr
            }, apiKey);
            usedModelLabel = 'NOAA GFS (Official)';
        } catch (e2: any) {
            throw new Error(`Data Source Failure: ${e.message}`);
        }
    }

    let tideData: Tide[] = [];
    let seaLevelData: StormGlassTideData[] = [];

    const extremesPromise = fetchRealTides(lat, lon, apiKey).catch(() => []);
    const seaLevelPromise = fetchSeaLevels(lat, lon, apiKey).catch(() => []);

    [tideData, seaLevelData] = await Promise.all([extremesPromise, seaLevelPromise]);

    if (!weatherData || !weatherData.hours) throw new Error("Invalid Response Structure");

    const hours = weatherData.hours;
    const currentHour = hours[0];

    const getValue = (dataPoint: StormGlassHour, param: string, fallback: number | null = null): number | null => {
        if (!dataPoint || !dataPoint[param]) return fallback;
        const obj = dataPoint[param] as any;
        if (typeof obj.sg === 'number') return obj.sg;
        if (typeof obj.noaa === 'number') return obj.noaa;
        const keys = Object.keys(obj);
        if (keys.length > 0 && typeof obj[keys[0]] === 'number') return obj[keys[0]];
        return fallback;
    };

    const windSpdRaw = getValue(currentHour, 'windSpeed', null);
    const windSpd = msToKnots(windSpdRaw);
    const windGustRaw = getValue(currentHour, 'gust', null);
    const windGust = windGustRaw !== null ? msToKnots(windGustRaw) : (windSpd ? windSpd * 1.3 : null);

    const waveM = getValue(currentHour, 'waveHeight', getValue(currentHour, 'swellHeight', null));
    const waveHeightFt = mToFt(waveM);

    const currentSpdRaw = getValue(currentHour, 'currentSpeed', null);
    const currentSpd = msToKnots(currentSpdRaw);
    const currentDirRaw = getValue(currentHour, 'currentDirection', 0) || 0;


    const hasAirData = windSpd !== null && getValue(currentHour, 'airTemperature', null) !== null;
    // Relaxed Landlocked Check: Allow small noise < 0.2m (approx 0.6ft)
    const isLandlocked = hasAirData && (waveM === null || waveM < 0.2);

    const nowHour = now.getHours();
    const isDayCurrent = nowHour >= 6 && nowHour <= 18;

    const condition = getCondition(getValue(currentHour, 'cloudCover', 0) || 0, getValue(currentHour, 'precipitation', 0) || 0, isDayCurrent);
    const windDir = degreesToCardinal(getValue(currentHour, 'windDirection', 0) || 0);

    const baseCurrentDay = baseForecast ? baseForecast[0] : null;
    let uvCurrent = getValue(currentHour, 'uvIndex', null);

    let dewPointCurrent = getValue(currentHour, 'dewPointTemperature', null);
    if (dewPointCurrent === null) {
        const t = getValue(currentHour, 'airTemperature', null);
        const h = getValue(currentHour, 'humidity', null);
        if (t !== null && h !== null) {
            dewPointCurrent = t - ((100 - h) / 5);
        }
    }

    if (uvCurrent === null && baseCurrentDay) {
        const maxUV = baseCurrentDay.uvIndex || 0;
        let sunriseHour = 6;
        let sunsetHour = 18;

        if (baseCurrentDay.sunrise && baseCurrentDay.sunset && baseCurrentDay.sunrise !== '--:--') {
            try {
                const parseTime = (t: string) => {
                    const [time, period] = t.split(' ');
                    let [h] = time.split(':').map(Number);
                    if (period === 'PM' && h !== 12) h += 12;
                    if (period === 'AM' && h === 12) h = 0;
                    return h;
                }
                sunriseHour = parseTime(baseCurrentDay.sunrise);
                sunsetHour = parseTime(baseCurrentDay.sunset);
            } catch (e) { }
        }

        if (nowHour < sunriseHour || nowHour >= sunsetHour) {
            uvCurrent = 0;
        } else {
            const solarNoon = sunriseHour + (sunsetHour - sunriseHour) / 2;
            const distFromNoon = Math.abs(nowHour - solarNoon);
            const maxDist = (sunsetHour - sunriseHour) / 2;
            const radians = (distFromNoon / maxDist) * (Math.PI / 2);
            const factor = Math.max(0, Math.cos(radians));
            uvCurrent = parseFloat((maxUV * factor).toFixed(1));
        }
    } else if (uvCurrent === null) {
        uvCurrent = 0;
    }

    const currentMetrics: WeatherMetrics = {
        windSpeed: windSpd !== null ? parseFloat(windSpd.toFixed(1)) : null,
        windGust: windGust !== null ? parseFloat(windGust.toFixed(1)) : null,
        windDirection: windDir,
        windDegree: getValue(currentHour, 'windDirection', 0) || 0,
        waveHeight: waveHeightFt !== null ? parseFloat(waveHeightFt.toFixed(1)) : null,
        swellPeriod: getValue(currentHour, 'wavePeriod', null),
        swellDirection: degreesToCardinal(getValue(currentHour, 'waveDirection', 0) || 0),
        waterTemperature: getValue(currentHour, 'waterTemperature', null),
        airTemperature: getValue(currentHour, 'airTemperature', null),
        dewPoint: dewPointCurrent,
        pressure: getValue(currentHour, 'pressure', null),
        cloudCover: getValue(currentHour, 'cloudCover', null),
        visibility: getValue(currentHour, 'visibility', null),
        precipitation: getValue(currentHour, 'precipitation', null),
        humidity: getValue(currentHour, 'humidity', null),
        uvIndex: uvCurrent,
        condition: condition,
        description: generateDescription(condition, windSpd, windDir, waveHeightFt),
        day: "Today",
        date: now.toLocaleDateString(),
        feelsLike: getValue(currentHour, 'airTemperature', null),
        pressureTrend: 'steady',
        sunrise: baseCurrentDay?.sunrise || '--:--',
        sunset: baseCurrentDay?.sunset || '--:--',
        moonPhase: 'Unknown',
        isEstimated: false,
        currentSpeed: currentSpd !== null ? parseFloat(currentSpd.toFixed(1)) : null,
        currentDirection: degreesToCardinal(currentDirRaw)
    };

    const hourly: HourlyForecast[] = hours.map((h: StormGlassHour) => {
        const hTime = new Date(h.time).getTime();
        const matchingTide = seaLevelData.find((sl) => Math.abs(new Date(sl.time).getTime() - hTime) < 30 * 60 * 1000);
        let tideHeightInFeet = undefined;

        if (matchingTide) {
            let valM = matchingTide.sg;
            if (valM === undefined) valM = matchingTide.noaa;
            if (valM === undefined) {
                const keys = Object.keys(matchingTide);
                for (const k of keys) if (typeof matchingTide[k] === 'number') { valM = matchingTide[k] as number; break; }
            }
            if (valM !== undefined) {
                tideHeightInFeet = valM * 3.28084;
            }
        }

        if (tideHeightInFeet === undefined && tideData.length > 0) {
            tideHeightInFeet = interpolateTideHeight(hTime, tideData);
        }

        return {
            time: h.time,
            windSpeed: msToKnots(getValue(h, 'windSpeed', 0)) || 0,
            windGust: msToKnots(getValue(h, 'gust', 0)),
            waveHeight: mToFt(getValue(h, 'waveHeight', 0)) || 0,
            temperature: getValue(h, 'airTemperature', 0) || 0,
            precipitation: getValue(h, 'precipitation', 0),
            cloudCover: getValue(h, 'cloudCover', 0),
            condition: getCondition(getValue(h, 'cloudCover', 0) || 0, getValue(h, 'precipitation', 0) || 0, true),
            tideHeight: tideHeightInFeet,
            humidity: getValue(h, 'humidity', null),
            visibility: getValue(h, 'visibility', null),
            currentSpeed: msToKnots(getValue(h, 'currentSpeed', null)),
            currentDirection: degreesToCardinal(getValue(h, 'currentDirection', 0) || 0),
            waterTemperature: getValue(h, 'waterTemperature', null),
            isEstimated: false
        };
    });

    const tideHourly: TidePoint[] = seaLevelData.map((sl) => {
        let val = sl.sg;
        if (val === undefined) val = sl.noaa;
        if (val === undefined) {
            const keys = Object.keys(sl);
            for (const k of keys) {
                if (typeof sl[k] === 'number') { val = sl[k] as number; break; }
            }
        }
        return {
            time: sl.time,
            height: val ? val * 3.28084 : 0
        };
    });

    const dailyMap = new Map<string, ForecastDay>();
    hours.forEach((h: StormGlassHour, i: number) => {
        const date = new Date(h.time);
        const dayKey = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const dayName = date.toLocaleDateString('en-US', { weekday: 'long' });
        const temp = getValue(h, 'airTemperature', 0) || 0;
        const wind = msToKnots(getValue(h, 'windSpeed', 0)) || 0;
        const gust = msToKnots(getValue(h, 'gust', 0)) || 0;
        const wave = mToFt(getValue(h, 'waveHeight', 0)) || 0;
        const precip = getValue(h, 'precipitation', 0) || 0;
        const cloud = getValue(h, 'cloudCover', 0) || 0;
        const uv = getValue(h, 'uvIndex', 0) || 0;
        const baseDay = baseForecast?.find(d => d.date === dayKey);

        const hum = getValue(h, 'humidity', null);
        const vis = getValue(h, 'visibility', null);
        const cSpd = msToKnots(getValue(h, 'currentSpeed', null));
        const cDir = degreesToCardinal(getValue(h, 'currentDirection', 0) || 0);
        const wTemp = getValue(h, 'waterTemperature', null);



        if (!dailyMap.has(dayKey)) {
            dailyMap.set(dayKey, {
                day: dayName, date: dayKey,
                lowTemp: temp, highTemp: temp,
                windSpeed: wind, windGust: gust,
                waveHeight: wave,
                condition: getCondition(cloud, precip, true),
                precipitation: precip, cloudCover: cloud,
                uvIndex: Math.max(uv, baseDay?.uvIndex || 0),
                sunrise: baseDay?.sunrise || '--:--',
                sunset: baseDay?.sunset || '--:--',
                isEstimated: false,
                humidity: hum !== null ? hum : undefined,
                visibility: vis !== null ? vis : undefined,
                currentSpeed: cSpd !== null ? cSpd : undefined,
                currentDirection: cDir,
                waterTemperature: wTemp !== null ? wTemp : undefined
            });
        } else {
            const d = dailyMap.get(dayKey)!;
            d.lowTemp = Math.min(d.lowTemp, temp);
            d.highTemp = Math.max(d.highTemp, temp);
            d.windSpeed = Math.max(d.windSpeed, wind);
            if (gust > (d.windGust || 0)) d.windGust = gust;
            d.waveHeight = Math.max(d.waveHeight, wave);
            d.precipitation = (d.precipitation || 0) + precip;
            d.uvIndex = Math.max(d.uvIndex || 0, uv, baseDay?.uvIndex || 0);
            if (precip > 0.5) d.condition = 'Rain';
            if (d.sunrise === '--:--' && baseDay?.sunrise) d.sunrise = baseDay.sunrise;
            if (d.sunset === '--:--' && baseDay?.sunset) d.sunset = baseDay.sunset;

            // ROBUST DATA CAPTURE:
            // 1. Initialize with first valid value found (if undefined)
            if (d.humidity === undefined && hum !== null) d.humidity = hum;
            if (d.visibility === undefined && vis !== null) d.visibility = vis;
            if (d.currentSpeed === undefined && cSpd !== null) d.currentSpeed = cSpd;
            if (d.currentDirection === undefined && cDir) d.currentDirection = cDir;
            if (d.waterTemperature === undefined && wTemp !== null) d.waterTemperature = wTemp;

            // 2. Overwrite with Noon Data if available (Point-in-Time preference)
            if (new Date(h.time).getHours() === 12) {
                if (hum !== null) d.humidity = hum;
                if (vis !== null) d.visibility = vis;
                if (cSpd !== null) d.currentSpeed = cSpd;
                if (cDir) d.currentDirection = cDir;
                if (wTemp !== null) d.waterTemperature = wTemp;
            }
        }
    });

    const forecast = Array.from(dailyMap.values()).slice(0, 12);
    const todayHigh = forecast.length > 0 ? forecast[0].highTemp : undefined;

    // Use Robust Tactical Advice generator instead of generic "Watch set."
    const robustAdvice = generateTacticalAdvice(currentMetrics, isLandlocked);

    return {
        locationName,
        coordinates: { lat, lon },
        current: currentMetrics,
        forecast: forecast,
        hourly,
        tides: tideData,
        tideHourly,
        boatingAdvice: robustAdvice,
        alerts: generateSafetyAlerts(currentMetrics, todayHigh, forecast),
        generatedAt: now.toISOString(),
        modelUsed: usedModelLabel,
        groundingSource: usedModelLabel,
        isLandlocked: isLandlocked,
        debugInfo: {
            logs: ["Fetched from Stormglass"],
            candidatesChecked: 1,
            finalLocation: { lat, lon }
        }
    };
};
