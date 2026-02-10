
import { StormGlassHour, MarineWeatherReport, HourlyForecast, ForecastDay, WeatherMetrics, Tide, StormGlassTideData } from '../../types';

import { getPrecipitationLabelV2 } from '../../services/WeatherFormatter';
import { calculateFeelsLike, getSunTimes } from '../../utils/math';
import { degreesToCardinal } from '../../utils/format';
import { generateTacticalAdvice, generateSafetyAlerts } from '../../utils/advisory';

/** StormGlass Astronomy API response shape */
export interface AstroEntry {
    sunrise?: string;
    sunset?: string;
    moonPhase?: { current?: { text?: string; value?: number } };
    moonFraction?: number;
}

// Helpers
export const abbreviate = (val: string): string => {
    if (!val) return "";
    if (val.length <= 12) return val;
    return val.substring(0, 10) + "..";
};

// Robust Day/Night Check handling UTC Date boundaries
export const checkIsDay = (now: Date, lat: number, lon: number): boolean => {
    const sun = getSunTimes(now, lat, lon);
    if (!sun) return true; // Fallback
    const nowTs = now.getTime();
    return nowTs >= sun.sunrise.getTime() && nowTs < sun.sunset.getTime();
};

export const getCondition = (cloudCover: number, precip: number, isDay: boolean): string => {
    if (precip > 5) return "Rain";
    if (precip > 0.5) return "Light Rain";
    if (cloudCover > 90) return "Overcast";
    if (cloudCover > 50) return "Cloudy";
    if (cloudCover > 20) return isDay ? "Clouds" : "Clouds";
    return isDay ? "Sunny" : "Clear";
};

export const generateDescription = (condition: string, windSpeed: number | null, windDir: string, waveHeight: number | null): string => {
    let desc = condition;
    if (windSpeed !== null) {
        desc += `. Winds ${windDir} at ${Math.round(windSpeed)}kts`;
    }
    if (waveHeight !== null && waveHeight > 2) {
        desc += `. Seas ${waveHeight.toFixed(1)}ft`;
    }
    return desc + ".";
};

export const mapStormGlassToReport = (
    hours: StormGlassHour[],
    lat: number,
    lon: number,
    name: string,
    dailyUV?: { time: string[], uv_index_max: number[] },
    tides: Tide[] = [],
    seaLevels: Partial<StormGlassTideData>[] = [],
    model: string = 'sg',
    astro?: AstroEntry[], // Pass astronomy data
    existingLocationType?: 'coastal' | 'offshore' | 'inland',
    timeZone?: string,
    utcOffset?: number
): MarineWeatherReport => {
    // 1. Current Conditions
    const now = new Date();
    const nowTime = now.getTime();

    let currentHour = hours[0];
    let minDiff = Infinity;

    // FIX: Sanity Filter for Data Corruption (Year 2030 Bug)
    // Filter out hours that are wildly in the past (>24h ago) or too far in future (>15 days)
    // This strips the bad test data causing the vertical cards to fail.
    const safeMin = nowTime - (24 * 60 * 60 * 1000);
    const safeMax = nowTime + (15 * 24 * 60 * 60 * 1000);

    const validHours = hours.filter(h => {
        const t = new Date(h.time).getTime();
        return t >= safeMin && t <= safeMax;
    });

    if (validHours.length > 0) {
        hours = validHours;
    } else {
        // Return empty or throw, do NOT use bad data.
        // Returning a dummy report with error flag/status to force UI to handle it gracefully?
        // For now, let's allow it but log heavily. Actually, let's EMPTY the hours to force blank UI instead of incorrectly labeled cards.
        // hours = []; // This might crash UI if it expects hours[0].
        // currentHour will be undefined below and throw "Stormglass returned no data"
        // This is BETTER than showing 2030 data.
        throw new Error("Data Corruption: All weather data is date-invalid (2028-2030 Bug). Aborting transform.");
    }

    currentHour = hours[0];

    for (const h of hours) {
        const diff = Math.abs(new Date(h.time).getTime() - nowTime);
        if (diff < minDiff) {
            minDiff = diff;
            currentHour = h;
        }
    }
    if (!currentHour) throw new Error("Stormglass returned no data");

    const trustedSources = ['icon', 'dwd', 'meto', 'metno', 'sg', 'noaa'];
    let winnerSource = 'sg';

    // Helper Interfaces
    type MultiSourceField = number | Record<string, number | undefined> | null | undefined;

    // Scan for highest wind speed
    if (currentHour.windSpeed) {
        const ws = currentHour.windSpeed as Record<string, number | undefined>;
        let maxWind = -1;
        trustedSources.forEach(src => {
            const val = ws[src];
            if (typeof val === 'number' && val > maxWind) {
                maxWind = val;
                winnerSource = src;
            }
        });
    }

    const getBest = (field: MultiSourceField): number => {
        if (field === undefined || field === null) return 0;
        if (typeof field === 'number') return field;

        const rec = field as Record<string, number | undefined>;

        const winVal = rec[winnerSource];
        if (typeof winVal === 'number') return winVal;

        for (const src of trustedSources) {
            const val = rec[src];
            if (typeof val === 'number') return val;
        }

        // Final Fallback: First value found
        const firstVal = Object.values(rec)[0];
        return typeof firstVal === 'number' ? firstVal : 0;
    };

    const getVal = (field: MultiSourceField): number | null => {
        if (field === undefined || field === null) return null;
        if (typeof field === 'number') return field;
        const rec = field as Record<string, number | undefined>;

        const val = rec.icon ?? rec.dwd ?? rec.metno ?? rec.meto ?? rec.sg ?? rec.noaa ?? Object.values(rec)[0];
        return typeof val === 'number' ? val : null;
    };

    // Cast properties to compatible types for helpers
    // StormGlassHour keys are string | number | StormGlassValue...
    let wSpeed = getBest(currentHour.windSpeed as MultiSourceField) * 1.94384;
    let wGust = getBest(currentHour.gust as MultiSourceField) * 1.94384;
    let wDir = getBest(currentHour.windDirection as MultiSourceField);
    let temp = getVal(currentHour.airTemperature as MultiSourceField) ?? 0;
    let pressure = getVal(currentHour.pressure as MultiSourceField) ?? 0;

    let vis = (getVal(currentHour.visibility as MultiSourceField) ?? 0) * 0.539957;
    const dew = getVal(currentHour.dewPointTemperature as MultiSourceField); // Dewpoint from StormGlass API
    const fogRisk = false;
    const cloudCover = getVal(currentHour.cloudCover as MultiSourceField) ?? 0;

    const waveM = getVal(currentHour.waveHeight as MultiSourceField) ?? 0;
    // Relaxed check: waveM could be 0, but isLandlocked usually implies < 0.2m
    const isLandlocked = waveM < 0.2;

    // Weather data sourced from marine models (StormGlass, BOM beacons)
    // METAR/airport data removed in v20.0 - was skewing marine conditions

    const sunTimes = getSunTimes(now, lat, lon);
    const fmtTime = (d: Date | null) => d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';
    const sRise = sunTimes ? fmtTime(sunTimes.sunrise) : "06:00";
    const sSet = sunTimes ? fmtTime(sunTimes.sunset) : "18:00";

    const rawUV = currentHour.uvIndex as MultiSourceField;
    const curUV = getVal(rawUV) ?? 0;

    const cIsDay = checkIsDay(now, lat, lon);
    const finalCondition = getCondition(getVal(currentHour.cloudCover as MultiSourceField) ?? 0, getVal(currentHour.precipitation as MultiSourceField) ?? 0, cIsDay);

    const hum = getVal(currentHour.humidity as MultiSourceField) ?? 0;
    const calculatedFeels = calculateFeelsLike(temp, hum, wSpeed * 0.8);

    const current: WeatherMetrics = {
        windSpeed: parseFloat(wSpeed.toFixed(1)),
        windGust: parseFloat(wGust.toFixed(1)),
        windDirection: degreesToCardinal(wDir),
        windDegree: wDir,
        waveHeight: parseFloat(((getVal(currentHour.waveHeight as MultiSourceField) ?? 0) * 3.28084).toFixed(1)),
        swellPeriod: getVal(currentHour.wavePeriod as MultiSourceField) ?? 0,
        swellDirection: degreesToCardinal(getVal(currentHour.waveDirection as MultiSourceField) ?? 0),
        airTemperature: temp,
        waterTemperature: getVal(currentHour.waterTemperature as MultiSourceField),
        pressure: pressure,
        cloudCover: cloudCover,
        visibility: vis,
        dewPoint: dew,
        fogRisk: fogRisk,
        precipitation: getVal(currentHour.precipitation as MultiSourceField) ?? 0,
        humidity: hum,
        uvIndex: curUV,
        condition: finalCondition,
        description: `${generateDescription(finalCondition, wSpeed, degreesToCardinal(getVal(currentHour.windDirection as MultiSourceField) ?? 0), (getVal(currentHour.waveHeight as MultiSourceField) ?? 0) * 3.28084)}  `,
        day: "Today",
        date: now.toLocaleDateString(),
        feelsLike: calculatedFeels,
        isDay: true,
        isEstimated: false,
        sunrise: astro?.[0]?.sunrise ? new Date(astro[0].sunrise).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : sRise,
        sunset: astro?.[0]?.sunset ? new Date(astro[0].sunset).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }) : sSet,
        moonPhase: astro?.[0]?.moonPhase?.current?.text,
        moonPhaseValue: astro?.[0]?.moonPhase?.current?.value,
        moonIllumination: astro?.[0]?.moonFraction,
        currentSpeed: parseFloat(((getVal(currentHour.currentSpeed as MultiSourceField) ?? 0) * 1.94384).toFixed(1)),
        currentDirection: (() => {
            const val = getVal(currentHour.currentDirection as MultiSourceField);
            if (val === null || val === 0) return undefined;
            // FIX: StormGlass often reports "Direction From" (Oceanographic naming collision).
            // "Set" must be "Direction To". If data is "From North", Set is "South".
            // We invert by +180 degrees.
            return (val + 180) % 360;
        })(),
        precipLabel: getPrecipitationLabelV2(null, getVal(currentHour.precipitation as MultiSourceField) || 0).label,
        precipValue: getPrecipitationLabelV2(null, getVal(currentHour.precipitation as MultiSourceField) || 0).value
    };

    // 2. Map Hourly
    const hourlyStr: HourlyForecast[] = hours.map((h, i) => {
        const windKts = (getVal(h.windSpeed as MultiSourceField) ?? 0) * 1.94384;
        const windDeg = getVal(h.windDirection as MultiSourceField) ?? 0;
        return {
            time: h.time,
            windSpeed: windKts,
            windDirection: degreesToCardinal(windDeg),
            windDegree: windDeg,
            currentSpeed: parseFloat(((getVal(h.currentSpeed as MultiSourceField) ?? 0) * 1.94384).toFixed(1)),
            currentDirection: (() => {
                const val = getVal(h.currentDirection as MultiSourceField);
                if (val === null || val === 0) return undefined;
                return (val + 180) % 360;
            })(),
            waterTemperature: getVal(h.waterTemperature as MultiSourceField) ?? undefined,
            visibility: (getVal(h.visibility as MultiSourceField) ?? 0) * 0.539957,
            humidity: getVal(h.humidity as MultiSourceField) ?? 0,
            windGust: (getVal(h.gust as MultiSourceField) ?? 0) * 1.94384,
            waveHeight: (getVal(h.waveHeight as MultiSourceField) ?? 0) * 3.28084,
            temperature: getVal(h.airTemperature as MultiSourceField) ?? 0,
            pressure: getVal(h.pressure as MultiSourceField) ?? 0,
            precipitation: getVal(h.precipitation as MultiSourceField) ?? 0,
            cloudCover: getVal(h.cloudCover as MultiSourceField) ?? 0,
            condition: getCondition(getVal(h.cloudCover as MultiSourceField) ?? 0, getVal(h.precipitation as MultiSourceField) ?? 0, checkIsDay(new Date(h.time), lat, lon)),
            isEstimated: false,
            swellPeriod: getVal(h.wavePeriod as MultiSourceField) ?? 0,
            tideHeight: 0,
            uvIndex: (() => {
                const uvField = h.uvIndex as MultiSourceField;
                return getVal(uvField) ?? 0;
            })(),
            feelsLike: calculateFeelsLike(getVal(h.airTemperature as MultiSourceField) ?? 0, getVal(h.humidity as MultiSourceField) ?? 0, windKts * 0.8),
            dewPoint: getVal(h.dewPointTemperature as MultiSourceField) ?? null
        };
    });



    // 3. Map Daily (Aggregate)
    const seenDays = new Set<string>();
    hours.forEach(h => seenDays.add(new Date(h.time).toLocaleDateString('en-CA')));
    const uniqueDays = Array.from(seenDays).sort().slice(0, 16);
    const dailies: ForecastDay[] = [];

    uniqueDays.forEach(dayIso => {
        const dayHours = hours.filter(h => new Date(h.time).toLocaleDateString('en-CA') === dayIso);
        if (dayHours.length > 0) {
            let minT = 100, maxT = -100;
            let maxWind = 0, maxGust = 0, maxWave = 0;
            let totalPrecip = 0, totalCloud = 0, totalPress = 0;
            let totalHum = 0, totalVis = 0;
            let totalWaterTemp = 0, waterTempCount = 0;
            let maxCurrentSpeed = 0;
            let currentDirVectorX = 0, currentDirVectorY = 0, currentDirCount = 0;
            let windDirVectorX = 0, windDirVectorY = 0, windDirCount = 0;
            let maxUV = 0;

            dayHours.forEach(h => {
                const t = getVal(h.airTemperature as MultiSourceField) ?? 0;
                if (t < minT) minT = t;
                if (t > maxT) maxT = t;

                const w = (getVal(h.windSpeed as MultiSourceField) ?? 0) * 1.94384;
                if (w > maxWind) maxWind = w;

                const g = (getVal(h.gust as MultiSourceField) ?? 0) * 1.94384;
                if (g > maxGust) maxGust = g;

                const wd = getVal(h.windDirection as MultiSourceField);
                if (wd !== null && wd !== undefined) {
                    const rad = wd * (Math.PI / 180);
                    windDirVectorX += Math.cos(rad);
                    windDirVectorY += Math.sin(rad);
                    windDirCount++;
                }

                const wh = (getVal(h.waveHeight as MultiSourceField) ?? 0) * 3.28084;
                if (wh > maxWave) maxWave = wh;

                totalPrecip += getVal(h.precipitation as MultiSourceField) ?? 0;
                totalCloud += getVal(h.cloudCover as MultiSourceField) ?? 0;
                totalPress += getVal(h.pressure as MultiSourceField) ?? 0;
                totalHum += getVal(h.humidity as MultiSourceField) ?? 0;
                totalVis += (getVal(h.visibility as MultiSourceField) ?? 0) * 0.539957;

                const wt = getVal(h.waterTemperature as MultiSourceField);
                if (wt) { totalWaterTemp += wt; waterTempCount++; }

                const cs = (getVal(h.currentSpeed as MultiSourceField) ?? 0) * 1.94384;
                if (cs > maxCurrentSpeed) maxCurrentSpeed = cs;

                const cd = getVal(h.currentDirection as MultiSourceField);
                if (cd) {
                    const rad = cd * (Math.PI / 180);
                    currentDirVectorX += Math.cos(rad);
                    currentDirVectorY += Math.sin(rad);
                    currentDirCount++;
                }

                const hUV = getVal(h.uvIndex as MultiSourceField) ?? 0;
                if (hUV > maxUV) maxUV = hUV;
            });

            if (maxUV < 1.0 && dailyUV && dailyUV.time && dailyUV.uv_index_max) {
                // Typed check for dailyUV
                const uvIdx = dailyUV.time.findIndex((t: string) => t.startsWith(dayIso));
                if (uvIdx !== -1 && dailyUV.uv_index_max[uvIdx]) {
                    maxUV = dailyUV.uv_index_max[uvIdx];
                }
            }

            const avgCloud = totalCloud / dayHours.length;

            const spl = dayIso.split('-');
            const dateObj = new Date(parseInt(spl[0]), parseInt(spl[1]) - 1, parseInt(spl[2]));
            const sunTimesDay = getSunTimes(dateObj, lat, lon);

            let avgCurrentDir = 0;
            if (currentDirCount > 0) {
                avgCurrentDir = (Math.atan2(currentDirVectorY / currentDirCount, currentDirVectorX / currentDirCount) * 180) / Math.PI;
                if (avgCurrentDir < 0) avgCurrentDir += 360;
            } else {
                avgCurrentDir = getVal(dayHours[0].currentDirection as MultiSourceField) ?? 0;
            }

            dailies.push({
                day: new Date(dayIso).toLocaleDateString('en-US', { weekday: 'long' }),
                date: new Date(dayIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                isoDate: dayIso,
                highTemp: parseFloat(maxT.toFixed(1)),
                lowTemp: parseFloat(minT.toFixed(1)),
                windSpeed: parseFloat(maxWind.toFixed(1)),
                windGust: parseFloat(maxGust.toFixed(1)),
                waveHeight: parseFloat(maxWave.toFixed(1)),
                condition: getCondition(avgCloud, totalPrecip, true),
                precipitation: parseFloat(totalPrecip.toFixed(1)),
                uvIndex: maxUV,
                sunrise: sunTimesDay ? sunTimesDay.sunrise.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : "06:00 AM",
                sunset: sunTimesDay ? sunTimesDay.sunset.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : "06:00 PM",
                pressure: parseFloat((totalPress / dayHours.length).toFixed(1)),
                cloudCover: Math.round(avgCloud),
                isEstimated: false,
                humidity: Math.round(totalHum / dayHours.length),
                visibility: parseFloat((totalVis / dayHours.length).toFixed(1)),
                waterTemperature: waterTempCount > 0 ? parseFloat((totalWaterTemp / waterTempCount).toFixed(1)) : undefined,
                currentSpeed: parseFloat(maxCurrentSpeed.toFixed(1)),
                currentDirection: Math.round(avgCurrentDir),
                precipLabel: getPrecipitationLabelV2(null, totalPrecip).label,
                precipValue: getPrecipitationLabelV2(null, totalPrecip).value
            });
        }
    });

    const todayIso = new Date().toLocaleDateString('en-CA');
    const todayDaily = dailies.find(d => d.isoDate === todayIso);
    if (todayDaily) {
        if (current.airTemperature !== null) {
            if (current.airTemperature > todayDaily.highTemp) todayDaily.highTemp = current.airTemperature;
            if (current.airTemperature < todayDaily.lowTemp) todayDaily.lowTemp = current.airTemperature;
            current.highTemp = todayDaily.highTemp;
            current.lowTemp = todayDaily.lowTemp;
        }
    }

    const advice = generateTacticalAdvice(current, false, name, undefined, [], current.sunset);

    // Sync Current to Hourly
    const currentHourIndex = hourlyStr.findIndex(h => Math.abs(new Date(h.time).getTime() - nowTime) < 30 * 60 * 1000);
    if (currentHourIndex !== -1) {
        const target = hourlyStr[currentHourIndex];
        if (current.windSpeed !== null && current.windSpeed !== undefined) target.windSpeed = current.windSpeed;
        if (current.windGust !== null && current.windGust !== undefined) target.windGust = current.windGust;
        if (current.windDirection !== undefined) target.windDirection = current.windDirection;
        if (current.airTemperature !== null && current.airTemperature !== undefined) target.temperature = current.airTemperature;
        if (current.pressure !== null && current.pressure !== undefined) target.pressure = current.pressure;
        if (current.visibility !== null && current.visibility !== undefined && current.visibility >= 0) target.visibility = current.visibility;
        if (current.cloudCover !== null && current.cloudCover !== undefined) target.cloudCover = current.cloudCover;
        if (current.condition) target.condition = current.condition;
    }

    // Determine Location Type
    const hasTides = tides && tides.length > 0;
    // waveHeight is in ft here. 0.2m is approx 0.65ft.
    const hasWaves = current.waveHeight !== null && current.waveHeight > 0.6;

    let locType: 'coastal' | 'offshore' | 'inland' = 'inland';

    if (existingLocationType) {
        locType = existingLocationType;
    } else {
        // Fallback (Should rarely be reached if services are updated)
        if (hasTides) locType = 'coastal';
        else if (hasWaves) locType = 'offshore';
        else locType = 'inland';
    }

    return {
        locationName: name,
        coordinates: { lat, lon },
        generatedAt: now.toISOString(),
        current,
        hourly: hourlyStr,
        forecast: dailies,
        tides: tides || [],
        tideHourly: seaLevels?.map(sl => ({ time: sl.time!, height: (((sl.sg || sl.noaa) || 0) * 3.28084) })) || [],
        modelUsed: 'stormglass_sg',
        boatingAdvice: advice,
        isLandlocked: locType === 'inland',
        locationType: locType,
        alerts: generateSafetyAlerts(current, dailies[0]?.highTemp, dailies),
        timeZone,
        utcOffset
    };
};
