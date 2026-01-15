import { MarineWeatherReport, WeatherModel } from '../../../types';
import { getOpenMeteoKey } from '../keys';
import { getCondition, generateDescription } from '../transformers';
import { calculateFeelsLike, calculateDistance } from '../../../utils/math';
import { degreesToCardinal } from '../../../utils/format';

import { generateTacticalAdvice, generateSafetyAlerts } from '../../../utils/advisory';
import { fetchRealTides } from './tides';


export const attemptGridSearch = async (lat: number, lon: number, name: string): Promise<MarineWeatherReport | null> => { return null; };

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
        throw new Error("STRICT MODE: Commercial Open-Meteo Key Missing. Free tier disabled.");
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
        models: model
    });

    if (isCommercial) params.append("apikey", apiKey!);

    // Fetch Weather
    const res = await fetch(`${baseUrl}?${params.toString()}`);
    if (!res.ok) throw new Error(`OpenMeteo HTTP ${res.status}`);
    const wData = await res.json();

    // Fetch Marine (Waves)
    let waveData: any = null;
    try {
        const marineUrl = "https://customer-api.open-meteo.com/v1/marine";
        const marineParams = new URLSearchParams({
            latitude: safeLat.toFixed(4),
            longitude: safeLon.toFixed(4),
            current: "wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_period,swell_wave_direction",
            hourly: "wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction",
            daily: "wave_height_max,wave_direction_dominant,wave_period_max",
            timezone: "auto",
            forecast_days: "16"
        });
        if (isCommercial) marineParams.append("apikey", apiKey!);

        const mRes = await fetch(`${marineUrl}?${marineParams.toString()}`);
        if (mRes.ok) waveData = await mRes.json();
    } catch {
        // ignore marine failure
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
        day: "Today",
        date: now.toLocaleDateString(),
        feelsLike: calculateFeelsLike(cur.temperature_2m, cur.relative_humidity_2m, cur.wind_speed_10m * kFactor * 0.8), // Approx
        isDay: cur.is_day === 1,
        isEstimated: false,
        sunrise: "", // Filled from daily
        sunset: "",
        moonPhase: "",
        moonIllumination: 0,
        currentSpeed: 0,
        currentDirection: 0
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
        alerts: generateSafetyAlerts(currentMetrics, dailies[0]?.highTemp, dailies)
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
        console.warn("OpenMeteo Tide Fetch Failed", e);
    }

    // Infer Location Type
    let locType: 'coastal' | 'offshore' | 'inland' = 'offshore';

    // 1. Determine "Distance to Water" using Marine Grid Snap
    // OpenMeteo Marine API snaps to the nearest water grid point.
    // If our requested lat/lon is far from the returned marine lat/lon, we are on land.
    let distToWaterIdx = 9999;
    let hasMarineData = false;

    if (waveData?.latitude && waveData?.longitude) {
        distToWaterIdx = calculateDistance(lat, lon, waveData.latitude, waveData.longitude);
        const maxWave = waveData?.daily?.wave_height_max ? Math.max(...waveData.daily.wave_height_max) : 0;
        if (maxWave > 0.1) hasMarineData = true;
    }

    // 2. Perform Geocoding Lookup (Context)
    // We need this to determine distance to land (for Offshore rule) AND verify if we are actually on land.
    let landCtx: any = null;
    let distToLand = 9999;
    try {
        const { reverseGeocodeContext } = await import('./geocoding');
        landCtx = await reverseGeocodeContext(lat, lon);
        if (landCtx) {
            distToLand = calculateDistance(lat, lon, landCtx.lat, landCtx.lon);
        }
    } catch (e) {
        console.warn("LocType Geocode Failed", e);
    }

    // 3. Robust Classification Logic
    // Fix: If we filtered out "Ocean" and found NO land context, we are definitely OFFSHORE,
    // regardless of what the grid snap says (which can be >2km in deep ocean).
    console.log('[LocType Debug] Land Context:', landCtx);
    console.log('[LocType Debug] Distances:', { distToLand, distToWaterIdx });

    if (!landCtx) {
        locType = 'offshore';
        console.log(`[LocType] No Land Context found (Ocean filtered). Type: OFFSHORE`);
    } else {
        // We have a nearby land feature (island, coast, city).

        // Check 1: OFFSHORE Rule (> 50nm from land)
        // 50 NM = 92.6 km
        if (distToLand > 92.6) {
            locType = 'offshore';
            console.log(`[LocType] Dist to Land > 50nm (${distToLand.toFixed(1)}km). Type: OFFSHORE`);
        } else {
            // We are within 50nm of land. We are either COASTAL or INLAND.
            // Distinguish using "Distance to Water" (Marine Grid Snap).

            // Refined "Is On Land" check:
            // If grid snap is tight (< 5km), we are likely ON WATER (or very close to it).
            // Note: Increased threshold from 2km to 5km to avoid false positive "Land" in ocean gaps.
            const isWaterSnap = hasMarineData && distToWaterIdx < 5.0;

            if (isWaterSnap) {
                // We are ON WATER (approx), and < 50nm from land.
                locType = 'coastal';
                console.log(`[LocType] ON WATER (Grid ${distToWaterIdx.toFixed(1)}km) & < 50nm Land. Type: COASTAL`);
            } else {
                // We are ON LAND (approx).
                // Rule: > 5nm from water = INLAND.
                // Rule: < 5nm from water = COASTAL.
                // 5 NM = 9.26 km.
                if (distToWaterIdx > 9.26) {
                    locType = 'inland';
                    console.log(`[LocType] ON LAND & > 5nm Water (${distToWaterIdx.toFixed(1)}km). Type: INLAND`);
                } else {
                    locType = 'coastal';

                    // REFINEMENT: Waterway Check (Creek, River, Lake)
                    // Users reported creeks/lakes being flagged as Coastal even when inland.
                    // If name implies inland water, we enforce a STRICTER threshold (3km instead of 9km)
                    // to ensure we are truly at the "Actual Coast" (Ocean).
                    if (landCtx?.name) {
                        const n = landCtx.name.toUpperCase();
                        const isWaterway = ["CREEK", "RIVER", "LAKE", "DAM", "RESERVOIR", "POND", "CANAL"].some(k => n.includes(k));
                        if (isWaterway) {
                            if (distToWaterIdx > 3.0) {
                                locType = 'inland';
                                console.log(`[LocType] '${landCtx.name}' is Waterway & > 3km from Grid. Forcing INLAND.`);
                            }
                        }
                    }

                    if (locType === 'coastal') {
                        console.log(`[LocType] ON LAND & < 5nm Water (${distToWaterIdx.toFixed(1)}km). Type: COASTAL`);
                    }
                }
            }
        }
    }

    report.locationType = locType;
    report.isLandlocked = locType === 'inland'; // Backwards compat

    return report;
};
