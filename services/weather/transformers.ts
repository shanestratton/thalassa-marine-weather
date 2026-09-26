import {
    StormGlassHour,
    MarineWeatherReport,
    HourlyForecast,
    ForecastDay,
    WeatherMetrics,
    Tide,
    StormGlassTideData,
} from '../../types';

import { getPrecipitationLabelV2 } from '../../services/WeatherFormatter';
import { calculateFeelsLike, getSunTimes } from '../../utils/math';
import { degreesToCardinal } from '../../utils/format';
import { generateTacticalAdvice, generateSafetyAlerts } from '../../utils/advisory';
import { resolveTimeZone, formatTimeInZone } from '../../utils/timezone';
import { resolveOffshoreModel } from './forecastModels';
import { temperatureOrNull } from './temperatureOrNull';

/** Availability travels with the cached report: legacy numeric placeholders
 * must never overwrite real fallback forecasts when a model omits a field. */
interface StormGlassCoverage {
    current: string[];
    hourly: Record<string, string[]>;
    daily: Record<string, string[]>;
}
type CoveredStormGlassReport = MarineWeatherReport & { _stormglassCoverage?: StormGlassCoverage };

/** Selected StormGlass values win at every horizon; other real sources only
 * fill absent fields. Return a new report so a model switch cannot mutate a
 * provider cache entry or another caller's in-flight result. */
export function blendOffshoreForecast(
    selected: MarineWeatherReport,
    fallback: MarineWeatherReport | null,
): MarineWeatherReport {
    if (!fallback) return structuredClone(selected);
    const coverage = (selected as CoveredStormGlassReport)._stormglassCoverage;
    if (!coverage) return structuredClone(selected);
    const overlay = <T extends object>(base: T, preferred: T, keys: string[]): T => {
        const out = { ...base };
        for (const key of keys as (keyof T)[]) {
            if (preferred[key] != null) out[key] = preferred[key];
        }
        return out;
    };
    const toHour = (time: string) => Math.floor(new Date(time).getTime() / 3_600_000);
    const preferredHours = new Map(selected.hourly.map((h) => [toHour(h.time), h]));
    const preferredDays = new Map(selected.forecast.map((d) => [d.isoDate || d.date, d]));
    const report = structuredClone(fallback);
    report.current = overlay(report.current, selected.current, coverage.current);
    report.current.sources = { ...fallback.current.sources };
    for (const key of coverage.current as (keyof WeatherMetrics)[]) {
        if (selected.current.sources?.[key]) report.current.sources[key] = selected.current.sources[key];
    }
    const seenHours = new Set<number>();
    report.hourly = report.hourly.map((h) => {
        const key = toHour(h.time);
        seenHours.add(key);
        const sg = preferredHours.get(key);
        return sg ? overlay(h, sg, coverage.hourly[sg.time] || []) : h;
    });
    report.hourly.push(...selected.hourly.filter((h) => !seenHours.has(toHour(h.time))).map((h) => ({ ...h })));
    report.hourly.sort((a, b) => toHour(a.time) - toHour(b.time));
    const seenDays = new Set<string>();
    report.forecast = report.forecast.map((d) => {
        const key = d.isoDate || d.date;
        seenDays.add(key);
        const sg = preferredDays.get(key);
        return sg ? overlay(d, sg, coverage.daily[key] || []) : d;
    });
    report.forecast.push(...selected.forecast.filter((d) => !seenDays.has(d.isoDate || d.date)).map((d) => ({ ...d })));
    report.forecast.sort((a, b) => (a.isoDate || a.date).localeCompare(b.isoDate || b.date));
    // Keep warnings from both actual sources. Selecting forecast winds must
    // not discard their hazards merely because another report filled UV.
    report.alerts = [...new Set([...(fallback.alerts || []), ...(selected.alerts || [])])];
    report.boatingAdvice = generateTacticalAdvice(
        { ...report.current, waveHeight: selected.current.waveHeight ?? report.current.waveHeight },
        false,
        selected.locationName,
        undefined,
        [],
        report.current.sunset,
    );
    report.modelUsed = `${selected.modelUsed}+fallback:${fallback.modelUsed}`;
    return report;
}

/** StormGlass Astronomy API response shape */
export interface AstroEntry {
    sunrise?: string;
    sunset?: string;
    moonPhase?: { current?: { text?: string; value?: number } };
    moonFraction?: number;
}

// Helpers
export const abbreviate = (val: string): string => {
    if (!val) return '';
    if (val.length <= 12) return val;
    return val.substring(0, 10) + '..';
};

// Robust Day/Night Check handling UTC Date boundaries
export const checkIsDay = (now: Date, lat: number, lon: number): boolean => {
    const sun = getSunTimes(now, lat, lon);
    if (!sun) return true; // Fallback
    const nowTs = now.getTime();
    return nowTs >= sun.sunrise.getTime() && nowTs < sun.sunset.getTime();
};

export const getCondition = (cloudCover: number | null, precip: number | null, isDay: boolean): string => {
    // Neither cloud nor precipitation from the source: '' is the sentinel the Glass renders as '--'.
    if (cloudCover == null && precip == null) return '';
    if (precip != null && precip > 5) return 'Rain';
    if (precip != null && precip > 0.5) return 'Light Rain';
    // Precipitation known but cloud cover not: the sky word cannot be inferred.
    if (cloudCover == null) return '';
    if (cloudCover > 90) return 'Overcast';
    if (cloudCover > 50) return 'Cloudy';
    if (cloudCover > 20) return isDay ? 'Clouds' : 'Clouds';
    return isDay ? 'Sunny' : 'Clear';
};

export const generateDescription = (
    condition: string,
    windSpeed: number | null,
    windDir: string,
    waveHeight: number | null,
): string => {
    let desc = condition;
    if (windSpeed !== null) {
        desc += `. Winds ${windDir} at ${Math.round(windSpeed)}kts`;
    }
    if (waveHeight !== null && waveHeight > 2) {
        desc += `. Seas ${waveHeight.toFixed(1)}ft`;
    }
    return desc + '.';
};

export const mapStormGlassToReport = (
    hours: StormGlassHour[],
    lat: number,
    lon: number,
    name: string,
    dailyUV?: { time: string[]; uv_index_max: number[] },
    tides: Tide[] = [],
    seaLevels: Partial<StormGlassTideData>[] = [],
    model: string = 'sg',
    astro?: AstroEntry[], // Pass astronomy data
    existingLocationType?: 'inshore' | 'coastal' | 'offshore' | 'inland',
    timeZone?: string,
    utcOffset?: number,
): CoveredStormGlassReport => {
    // Resolve target-location IANA tz. Prefer an upstream-supplied tz (e.g. from
    // OpenMeteo) if valid; otherwise derive from lat/lon so sunrise/sunset
    // render in LOCAL-TO-LOCATION time regardless of where the skipper stands.
    const tz = resolveTimeZone(lat, lon, timeZone);

    // 1. Current Conditions
    const now = new Date();
    const nowTime = now.getTime();

    let currentHour = hours[0];
    let minDiff = Infinity;

    // FIX: Sanity Filter for Data Corruption (Year 2030 Bug)
    // Filter out hours that are wildly in the past (>24h ago) or too far in future (>15 days)
    // This strips the bad test data causing the vertical cards to fail.
    const safeMin = nowTime - 24 * 60 * 60 * 1000;
    const safeMax = nowTime + 15 * 24 * 60 * 60 * 1000;

    const validHours = hours.filter((h) => {
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
        throw new Error('Data Corruption: All weather data is date-invalid (2028-2030 Bug). Aborting transform.');
    }

    currentHour = hours[0];

    for (const h of hours) {
        const diff = Math.abs(new Date(h.time).getTime() - nowTime);
        if (diff < minDiff) {
            minDiff = diff;
            currentHour = h;
        }
    }
    if (!currentHour) throw new Error('Stormglass returned no data');

    const selectedModel = resolveOffshoreModel(model);
    // StormGlass documents GFS under NOAA, not the UI's friendly `gfs` id.
    const selectedSources = selectedModel === 'gfs' ? ['noaa', 'gfs'] : [selectedModel];
    const sourceOrder = [...new Set([...selectedSources, 'sg', 'ecmwf', 'noaa', 'icon', 'dwd', 'meto', 'metno'])];
    const usedSources = new Set<string>();
    type MultiSourceField = number | Record<string, number | undefined> | null | undefined;
    const select = (field: MultiSourceField): { value: number; source: string } | null => {
        if (typeof field === 'number') return Number.isFinite(field) ? { value: field, source: 'unlabelled' } : null;
        if (!field) return null;
        for (const source of [...new Set([...sourceOrder, ...Object.keys(field)])]) {
            const value = field[source];
            if (typeof value === 'number' && Number.isFinite(value)) return { value, source };
        }
        return null;
    };
    const getVal = (field: MultiSourceField): number | null => {
        const reading = select(field);
        if (reading) usedSources.add(reading.source);
        return reading?.value ?? null;
    };
    const atmosphericInputs: Record<string, string[]> = {
        windSpeed: ['windSpeed'],
        windGust: ['gust'],
        windDirection: ['windDirection'],
        windDegree: ['windDirection'],
        airTemperature: ['airTemperature'],
        temperature: ['airTemperature'],
        highTemp: ['airTemperature'],
        lowTemp: ['airTemperature'],
        pressure: ['pressure'],
        humidity: ['humidity'],
        visibility: ['visibility'],
        cloudCover: ['cloudCover'],
        precipitation: ['precipitation'],
        precipLabel: ['precipitation'],
        precipValue: ['precipitation'],
        dewPoint: ['dewPointTemperature'],
        uvIndex: ['uvIndex'],
        feelsLike: ['airTemperature', 'humidity', 'windSpeed'],
        condition: ['cloudCover', 'precipitation'],
        description: ['cloudCover', 'precipitation', 'windSpeed', 'windDirection'],
    };
    const providedKeys = (rows: StormGlassHour[]) =>
        Object.entries(atmosphericInputs)
            .filter(([, inputs]) =>
                inputs.every((field) => rows.some((h) => select(h[field] as MultiSourceField) !== null)),
            )
            .map(([key]) => key);
    const coverage: StormGlassCoverage = { current: providedKeys([currentHour]), hourly: {}, daily: {} };

    // ── Unit conversion that PRESERVES ABSENCE ──────────────────────────
    // Marine fields used `?? 0` before a unit multiply, which turned "the
    // provider has no coverage here" into a confident 0.0 — flat seas and
    // slack water on a go/no-go screen. types/weather.ts:172-176 already
    // spells out the contract these violated: null "is distinct from 0 which
    // means 'calm seas'. UIs should render '—' for null, never coerce to 0."
    //
    // The fabricated 0 also travelled: it passes the `!= null` merge guards
    // in services/weather/index.ts, so it OVERWROTE real WeatherKit wave data
    // with zero and then stamped the source as StormGlass — the UI attributed
    // an invented reading to a named provider. openmeteo.ts:448-452 already
    // returns null here for exactly this reason; this file was the outlier.
    //
    // Two variants only because the call sites rounded inconsistently, and
    // matching each keeps this change null-handling ONLY, with no shift in
    // any displayed precision.
    /** Scale, rounded to 1dp. null in → null out. */
    const scale1 = (v: number | null, factor: number): number | null =>
        v === null ? null : parseFloat((v * factor).toFixed(1));
    /** Scale, unrounded. null in → null out. */
    const scale = (v: number | null, factor: number): number | null => (v === null ? null : v * factor);

    // The atmospherics carry absence the same way (UX scorecard run 6). A
    // model without 10 m wind, gust, temperature, visibility, cloud or
    // humidity at this hour reports null, which the Glass renders '--'. The
    // old `?? 0` said "calm" and "0 °C" — and a 0 visibility raised a DENSE
    // FOG advisory in generateSafetyAlerts off no reading at all.
    // Cast properties to compatible types for helpers
    // StormGlassHour keys are string | number | StormGlassValue...
    const wSpeed = scale(getVal(currentHour.windSpeed as MultiSourceField), 1.94384);
    const wGust = scale(getVal(currentHour.gust as MultiSourceField), 1.94384);
    const wDir = getVal(currentHour.windDirection as MultiSourceField);
    const temp = getVal(currentHour.airTemperature as MultiSourceField);
    const pressure = getVal(currentHour.pressure as MultiSourceField);

    const vis = scale(getVal(currentHour.visibility as MultiSourceField), 0.539957);
    const dew = getVal(currentHour.dewPointTemperature as MultiSourceField); // Dewpoint from StormGlass API
    const fogRisk = false;
    const cloudCover = getVal(currentHour.cloudCover as MultiSourceField);

    // Weather data sourced from marine models (StormGlass, BOM beacons)
    // METAR/airport data removed in v20.0 - was skewing marine conditions

    // No sun times (polar day/night) → no sunrise/sunset, not a made-up
    // 06:00/18:00 that the solar arc and the night-sailing advice would trust.
    const sunTimes = getSunTimes(now, lat, lon);
    const fmtTime = (d: Date | null) => (d ? formatTimeInZone(d, tz) : '--:--');
    const sRise = sunTimes ? fmtTime(sunTimes.sunrise) : undefined;
    const sSet = sunTimes ? fmtTime(sunTimes.sunset) : undefined;

    const rawUV = currentHour.uvIndex as MultiSourceField;
    const curUV = getVal(rawUV);

    const cIsDay = checkIsDay(now, lat, lon);
    const finalCondition = getCondition(
        getVal(currentHour.cloudCover as MultiSourceField),
        getVal(currentHour.precipitation as MultiSourceField),
        cIsDay,
    );

    const hum = getVal(currentHour.humidity as MultiSourceField);
    // Feels-like needs all three of its inputs (atmosphericInputs.feelsLike);
    // with one missing there is no feels-like, not one built on an invented 0.
    const calculatedFeels =
        temp != null && hum != null && wSpeed != null ? calculateFeelsLike(temp, hum, wSpeed * 0.8) : null;

    const current: WeatherMetrics = {
        windSpeed: wSpeed == null ? null : parseFloat(wSpeed.toFixed(1)),
        windGust: wGust == null ? null : parseFloat(wGust.toFixed(1)),
        windDirection: degreesToCardinal(wDir),
        windDegree: wDir ?? undefined,
        waveHeight: scale1(getVal(currentHour.waveHeight as MultiSourceField), 3.28084),
        swellPeriod: getVal(currentHour.wavePeriod as MultiSourceField),
        swellDirection: (() => {
            const d = getVal(currentHour.waveDirection as MultiSourceField);
            return d != null ? degreesToCardinal(d) : undefined;
        })(),
        secondarySwellHeight: (() => {
            const v = getVal(currentHour.secondarySwellHeight as MultiSourceField);
            return v != null ? parseFloat((v * 3.28084).toFixed(1)) : null;
        })(),
        secondarySwellPeriod: getVal(currentHour.secondarySwellPeriod as MultiSourceField) ?? null,
        airTemperature: temp,
        waterTemperature: getVal(currentHour.waterTemperature as MultiSourceField),
        pressure: pressure,
        cloudCover: cloudCover,
        visibility: vis,
        dewPoint: dew,
        fogRisk: fogRisk,
        precipitation: getVal(currentHour.precipitation as MultiSourceField),
        humidity: hum,
        uvIndex: curUV,
        condition: finalCondition,
        // Wave passed as null-when-absent: generateDescription's 4th parameter
        // is already `number | null` and guards on it, so `?? 0` was fighting
        // its own signature. Same text either way (0 fails its `> 2` gate),
        // but it no longer claims a measurement it does not have.
        description: `${generateDescription(finalCondition, wSpeed, degreesToCardinal(wDir), scale(getVal(currentHour.waveHeight as MultiSourceField), 3.28084))}  `,
        day: 'Today',
        date: now.toLocaleDateString(),
        feelsLike: calculatedFeels,

        cape: typeof currentHour.cape === 'number' ? currentHour.cape : null,
        isDay: true,
        isEstimated: false,
        sunrise: astro?.[0]?.sunrise ? formatTimeInZone(astro[0].sunrise, tz) : sRise,
        sunset: astro?.[0]?.sunset ? formatTimeInZone(astro[0].sunset, tz) : sSet,
        moonPhase: astro?.[0]?.moonPhase?.current?.text,
        moonPhaseValue: astro?.[0]?.moonPhase?.current?.value,
        moonIllumination: astro?.[0]?.moonFraction,
        currentSpeed: scale1(getVal(currentHour.currentSpeed as MultiSourceField), 1.94384),
        currentDirection: (() => {
            const val = getVal(currentHour.currentDirection as MultiSourceField);
            if (val === null || val === 0) return undefined;
            // FIX: StormGlass often reports "Direction From" (Oceanographic naming collision).
            // "Set" must be "Direction To". If data is "From North", Set is "South".
            // We invert by +180 degrees.
            return (val + 180) % 360;
        })(),
        precipLabel: getPrecipitationLabelV2(null, getVal(currentHour.precipitation as MultiSourceField)).label,
        precipValue: getPrecipitationLabelV2(null, getVal(currentHour.precipitation as MultiSourceField)).value,
    };

    // 2. Map Hourly
    const hourlyStr: HourlyForecast[] = hours.map((h, _i) => {
        coverage.hourly[h.time] = providedKeys([h]);
        const windKts = scale(getVal(h.windSpeed as MultiSourceField), 1.94384);
        const windDeg = getVal(h.windDirection as MultiSourceField);
        return {
            time: h.time,
            windSpeed: windKts,
            windDirection: degreesToCardinal(windDeg),
            windDegree: windDeg ?? undefined,
            currentSpeed: scale1(getVal(h.currentSpeed as MultiSourceField), 1.94384),
            currentDirection: (() => {
                const val = getVal(h.currentDirection as MultiSourceField);
                if (val === null || val === 0) return undefined;
                return (val + 180) % 360;
            })(),
            waterTemperature: getVal(h.waterTemperature as MultiSourceField) ?? undefined,
            visibility: scale(getVal(h.visibility as MultiSourceField), 0.539957),
            humidity: getVal(h.humidity as MultiSourceField),
            windGust: scale(getVal(h.gust as MultiSourceField), 1.94384),
            waveHeight: scale(getVal(h.waveHeight as MultiSourceField), 3.28084),
            temperature: temperatureOrNull(getVal(h.airTemperature as MultiSourceField)),
            pressure: getVal(h.pressure as MultiSourceField),
            precipitation: getVal(h.precipitation as MultiSourceField),
            cloudCover: getVal(h.cloudCover as MultiSourceField),
            condition: getCondition(
                getVal(h.cloudCover as MultiSourceField),
                getVal(h.precipitation as MultiSourceField),
                checkIsDay(new Date(h.time), lat, lon),
            ),
            isEstimated: false,
            // null, not 0 — a "0 second" swell period is not a reading.
            swellPeriod: getVal(h.wavePeriod as MultiSourceField),
            secondarySwellHeight: (() => {
                const v = getVal(h.secondarySwellHeight as MultiSourceField);
                return v != null ? parseFloat((v * 3.28084).toFixed(1)) : null;
            })(),
            secondarySwellPeriod: getVal(h.secondarySwellPeriod as MultiSourceField) ?? null,
            // No tideHeight: these are weather hours. A 0 here drew a flat
            // zero-metre tide in TideGraph's hourly fallback.
            uvIndex: (() => {
                const uvField = h.uvIndex as MultiSourceField;
                return getVal(uvField);
            })(),
            feelsLike: (() => {
                const t = getVal(h.airTemperature as MultiSourceField);
                const rh = getVal(h.humidity as MultiSourceField);
                return t != null && rh != null && windKts != null
                    ? calculateFeelsLike(t, rh, windKts * 0.8)
                    : undefined;
            })(),
            dewPoint: getVal(h.dewPointTemperature as MultiSourceField) ?? null,

            cape: typeof h.cape === 'number' ? h.cape : null,
        };
    });

    // 3. Map Daily (Aggregate)
    const seenDays = new Set<string>();
    hours.forEach((h) => seenDays.add(new Date(h.time).toLocaleDateString('en-CA')));
    const uniqueDays = Array.from(seenDays).sort().slice(0, 16);
    const dailies: ForecastDay[] = [];

    uniqueDays.forEach((dayIso) => {
        const dayHours = hours.filter((h) => new Date(h.time).toLocaleDateString('en-CA') === dayIso);
        if (dayHours.length > 0) {
            coverage.daily[dayIso] = providedKeys(dayHours);
            let minT = 100,
                maxT = -100;
            let maxWind = 0,
                maxGust = 0,
                maxWave = 0;
            // Counted like waves below: a day where no hour carried wind, gust,
            // humidity or visibility reports absence, not 0.
            let windCount = 0,
                gustCount = 0,
                humCount = 0,
                visCount = 0;
            // Counted, not null-seeded: 0 is a REAL reading ("calm"), so a day
            // where no hour carried a wave figure must report absence rather
            // than flat seas. A `number | null` accumulator reads better but
            // TypeScript narrows it to `null` here — assignment happens inside
            // the forEach callback below, which its control-flow analysis does
            // not track — making the emit branch `never`. The count matches
            // the waterTempCount idiom already used a few lines down.
            let waveCount = 0;
            let totalPrecip = 0,
                totalCloud = 0,
                totalPress = 0;
            let totalHum = 0,
                totalVis = 0;
            let totalWaterTemp = 0,
                waterTempCount = 0;
            let maxCurrentSpeed = 0,
                currentSpeedCount = 0;
            let currentDirVectorX = 0,
                currentDirVectorY = 0,
                currentDirCount = 0;
            let _windDirVectorX = 0,
                _windDirVectorY = 0,
                _windDirCount = 0;
            let maxUV: number | null = null;
            let precipCount = 0;
            let cloudCount = 0;

            dayHours.forEach((h) => {
                const t = getVal(h.airTemperature as MultiSourceField);
                if (t !== null && t < minT) minT = t;
                if (t !== null && t > maxT) maxT = t;

                const w = scale(getVal(h.windSpeed as MultiSourceField), 1.94384);
                if (w !== null) {
                    windCount++;
                    if (w > maxWind) maxWind = w;
                }

                const g = scale(getVal(h.gust as MultiSourceField), 1.94384);
                if (g !== null) {
                    gustCount++;
                    if (g > maxGust) maxGust = g;
                }

                const wd = getVal(h.windDirection as MultiSourceField);
                if (wd !== null && wd !== undefined) {
                    const rad = wd * (Math.PI / 180);
                    _windDirVectorX += Math.cos(rad);
                    _windDirVectorY += Math.sin(rad);
                    _windDirCount++;
                }

                const wh = scale(getVal(h.waveHeight as MultiSourceField), 3.28084);
                if (wh !== null) {
                    waveCount++;
                    if (wh > maxWave) maxWave = wh;
                }

                const hPrecip = getVal(h.precipitation as MultiSourceField);
                if (hPrecip != null) {
                    totalPrecip += hPrecip;
                    precipCount++;
                }
                const hCloud = getVal(h.cloudCover as MultiSourceField);
                if (hCloud != null) {
                    totalCloud += hCloud;
                    cloudCount++;
                }
                const hPress = getVal(h.pressure as MultiSourceField);
                if (hPress != null) totalPress += hPress;
                const hHum = getVal(h.humidity as MultiSourceField);
                if (hHum != null) {
                    totalHum += hHum;
                    humCount++;
                }
                const hVis = scale(getVal(h.visibility as MultiSourceField), 0.539957);
                if (hVis != null) {
                    totalVis += hVis;
                    visCount++;
                }

                const wt = getVal(h.waterTemperature as MultiSourceField);
                if (wt) {
                    totalWaterTemp += wt;
                    waterTempCount++;
                }

                const cs = scale(getVal(h.currentSpeed as MultiSourceField), 1.94384);
                if (cs !== null) {
                    currentSpeedCount++;
                    if (cs > maxCurrentSpeed) maxCurrentSpeed = cs;
                }

                const cd = getVal(h.currentDirection as MultiSourceField);
                if (cd) {
                    const rad = cd * (Math.PI / 180);
                    currentDirVectorX += Math.cos(rad);
                    currentDirVectorY += Math.sin(rad);
                    currentDirCount++;
                }

                const hUV = getVal(h.uvIndex as MultiSourceField);
                if (hUV != null && (maxUV == null || hUV > maxUV)) maxUV = hUV;
            });

            if ((maxUV == null || maxUV < 1.0) && dailyUV && dailyUV.time && dailyUV.uv_index_max) {
                // Typed check for dailyUV
                const uvIdx = dailyUV.time.findIndex((t: string) => t.startsWith(dayIso));
                const dUV = uvIdx !== -1 ? dailyUV.uv_index_max[uvIdx] : undefined;
                // typeof, not truthiness: a reported UV 0 is a reading, not an absence
                if (typeof dUV === 'number' && Number.isFinite(dUV)) {
                    maxUV = dUV;
                }
            }

            const count = (field: string) =>
                dayHours.filter((h) => select(h[field] as MultiSourceField) !== null).length || 1;
            const pressCount = dayHours.filter((h) => select(h.pressure as MultiSourceField) !== null).length;
            const avgCloud = totalCloud / count('cloudCover');

            const spl = dayIso.split('-');
            const dateObj = new Date(parseInt(spl[0]), parseInt(spl[1]) - 1, parseInt(spl[2]));
            const sunTimesDay = getSunTimes(dateObj, lat, lon);

            let avgCurrentDir: number | null = null;
            if (currentDirCount > 0) {
                avgCurrentDir =
                    (Math.atan2(currentDirVectorY / currentDirCount, currentDirVectorX / currentDirCount) * 180) /
                    Math.PI;
                if (avgCurrentDir < 0) avgCurrentDir += 360;
            } else {
                avgCurrentDir = getVal(dayHours[0].currentDirection as MultiSourceField);
            }

            dailies.push({
                day: new Date(dayIso).toLocaleDateString('en-US', { weekday: 'long' }),
                date: new Date(dayIso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                isoDate: dayIso,
                highTemp: temperatureOrNull(maxT === -100 ? null : parseFloat(maxT.toFixed(1))),
                lowTemp: temperatureOrNull(minT === 100 ? null : parseFloat(minT.toFixed(1))),
                windSpeed: windCount > 0 ? parseFloat(maxWind.toFixed(1)) : null,
                windGust: gustCount > 0 ? parseFloat(maxGust.toFixed(1)) : null,
                waveHeight: waveCount > 0 ? parseFloat(maxWave.toFixed(1)) : null,
                condition: getCondition(cloudCount > 0 ? avgCloud : null, precipCount > 0 ? totalPrecip : null, true),
                precipitation: precipCount > 0 ? parseFloat(totalPrecip.toFixed(1)) : undefined,
                uvIndex: maxUV,
                sunrise: sunTimesDay ? formatTimeInZone(sunTimesDay.sunrise, tz) : undefined,
                sunset: sunTimesDay ? formatTimeInZone(sunTimesDay.sunset, tz) : undefined,
                pressure: pressCount > 0 ? parseFloat((totalPress / count('pressure')).toFixed(1)) : undefined,
                cloudCover: cloudCount > 0 ? Math.round(avgCloud) : undefined,
                isEstimated: false,
                humidity: humCount > 0 ? Math.round(totalHum / humCount) : undefined,
                visibility: visCount > 0 ? parseFloat((totalVis / visCount).toFixed(1)) : undefined,
                waterTemperature:
                    waterTempCount > 0 ? parseFloat((totalWaterTemp / waterTempCount).toFixed(1)) : undefined,
                // undefined, not null: ForecastDay.currentSpeed is `number?`
                // (types/weather.ts:190) while waveHeight above is `number | null`.
                // Both read as absent at every consumer, which checks `!= null`.
                currentSpeed: currentSpeedCount > 0 ? parseFloat(maxCurrentSpeed.toFixed(1)) : undefined,
                currentDirection: avgCurrentDir != null ? Math.round(avgCurrentDir) : undefined,
                precipLabel: getPrecipitationLabelV2(null, precipCount > 0 ? totalPrecip : null).label,
                precipValue: getPrecipitationLabelV2(null, precipCount > 0 ? totalPrecip : null).value,
            });
        }
    });

    const todayIso = new Date().toLocaleDateString('en-CA');
    const todayDaily = dailies.find((d) => d.isoDate === todayIso);
    if (todayDaily) {
        if (current.airTemperature !== null) {
            // highTemp/lowTemp are null on a day no hour reported temperature.
            if (todayDaily.highTemp == null || current.airTemperature > todayDaily.highTemp)
                todayDaily.highTemp = current.airTemperature;
            if (todayDaily.lowTemp == null || current.airTemperature < todayDaily.lowTemp)
                todayDaily.lowTemp = current.airTemperature;
            current.highTemp = todayDaily.highTemp;
            current.lowTemp = todayDaily.lowTemp;
        }
    }

    const advice = generateTacticalAdvice(current, false, name, undefined, [], current.sunset);

    // Sync Current to Hourly
    const currentHourIndex = hourlyStr.findIndex(
        (h) => Math.abs(new Date(h.time).getTime() - nowTime) < 30 * 60 * 1000,
    );
    if (currentHourIndex !== -1) {
        const target = hourlyStr[currentHourIndex];
        if (current.windSpeed !== null && current.windSpeed !== undefined) target.windSpeed = current.windSpeed;
        if (current.windGust !== null && current.windGust !== undefined) target.windGust = current.windGust;
        if (current.windDirection !== undefined) target.windDirection = current.windDirection;
        if (current.airTemperature !== null && current.airTemperature !== undefined)
            target.temperature = current.airTemperature;
        if (current.pressure !== null && current.pressure !== undefined) target.pressure = current.pressure;
        if (current.visibility !== null && current.visibility !== undefined && current.visibility >= 0)
            target.visibility = current.visibility;
        if (current.cloudCover !== null && current.cloudCover !== undefined) target.cloudCover = current.cloudCover;
        if (current.condition) target.condition = current.condition;
    }

    // Determine Location Type
    const hasTides = tides && tides.length > 0;
    // waveHeight is in ft here. 0.2m is approx 0.65ft.
    const hasWaves = current.waveHeight !== null && current.waveHeight > 0.6;

    let locType: 'inshore' | 'coastal' | 'offshore' | 'inland' = 'inland';

    if (existingLocationType) {
        locType = existingLocationType;
    } else {
        // Fallback (Should rarely be reached if services are updated)
        if (hasTides) locType = 'coastal';
        else if (hasWaves) locType = 'offshore';
        else locType = 'inland';
    }

    const currentSources: NonNullable<MarineWeatherReport['current']['sources']> = {};
    for (const key of coverage.current as (keyof WeatherMetrics)[]) {
        const reading = select(currentHour[atmosphericInputs[key][0]] as MultiSourceField);
        if (reading && key in current) {
            currentSources[key] = {
                value: current[key as keyof WeatherMetrics] as number | string | null,
                source: 'stormglass',
                sourceColor: 'sky',
                sourceName: `StormGlass · ${reading.source.toUpperCase()}`,
            };
        }
    }
    const fallbackSources = [...usedSources].filter((source) => !selectedSources.includes(source));
    return {
        locationName: name,
        coordinates: { lat, lon },
        generatedAt: now.toISOString(),
        current: { ...current, sources: currentSources },
        hourly: hourlyStr,
        forecast: dailies,
        tides: tides || [],
        tideHourly: seaLevels?.map((sl) => ({ time: sl.time!, height: (sl.sg || sl.noaa || 0) * 3.28084 })) || [],
        modelUsed: `stormglass_${selectedModel}${fallbackSources.length ? `+fallback:${fallbackSources.sort().join(',')}` : ''}`,
        _stormglassCoverage: coverage,
        boatingAdvice: advice,
        isLandlocked: locType === 'inland',
        locationType: locType,
        alerts: generateSafetyAlerts(current, dailies[0]?.highTemp ?? undefined, dailies),
        timeZone: tz, // Resolved (tz-lookup fallback when caller didn't pass one)
        utcOffset,
    };
};
