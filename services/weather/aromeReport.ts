import type { ForecastDay, HourlyForecast, MarineWeatherReport } from '../../types';
import { type AromePointForecast, parseAromePoint } from './aromePointContract';
import { degreesToCardinal } from '../../utils/format';
import { getMoonData, getSolarTimes, getSolarTimesForDate } from '../../utils/celestial';
import { resolveTimeZone } from '../../utils/timezone';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const value = (sample: unknown) => (finite(sample) ? sample : null);
const hourKey = (time: string) => Math.floor(Date.parse(time) / 3_600_000);

/** Independent offline metadata for a caller already classified inshore/coastal.
 * This scaffold is never returned unless the native adapter actually qualifies.
 */
export function aromeContext(
    point: { lat: number; lon: number },
    name: string,
    locationType: 'inshore' | 'coastal',
    now: number,
): MarineWeatherReport {
    const timeZone = resolveTimeZone(point.lat, point.lon);
    const date = new Date(now),
        solar = getSolarTimes(date, point.lat, point.lon, timeZone);
    const moon = getMoonData(date, point.lat, point.lon, timeZone);
    return {
        locationName: name,
        coordinates: { ...point },
        locationType,
        timeZone,
        generatedAt: date.toISOString(),
        modelUsed: 'regional_pending',
        current: {
            windSpeed: null,
            windDirection: '',
            waveHeight: null,
            swellPeriod: null,
            airTemperature: null,
            condition: '',
            description: '',
            uvIndex: null,
            ...solar,
            moonPhase: moon.phaseName,
            moonIllumination: moon.illumination,
            moonPhaseValue: moon.phaseRatio,
            moonrise: moon.moonrise,
            moonset: moon.moonset,
        },
        forecast: [],
        hourly: [],
        tides: [],
        boatingAdvice: '',
        alerts: [],
    };
}

/** Conservative Glass admission, separate from the comparison's nullable series.
 * The legacy hourly report requires a numeric temperature. A missing native
 * temperature therefore refuses this adapter, rather than borrowing a global
 * value, dropping an original hour or hiding a null with a cast.
 */
export function aromeReport(
    base: MarineWeatherReport,
    source: AromePointForecast,
    point: { lat: number; lon: number },
    now: number,
    supplement: MarineWeatherReport | null = null,
): MarineWeatherReport | null {
    const admitted = parseAromePoint(source, source.model, point, now);
    if (!admitted || !source.hourly.temperature_2m.every(finite) || !base.timeZone) return null;
    let dateFormatter: Intl.DateTimeFormat;
    try {
        dateFormatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: base.timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
    } catch {
        return null;
    }
    const dateKey = (time: number) => {
        const parts = dateFormatter.formatToParts(time);
        const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
        return `${part('year')}-${part('month')}-${part('day')}`;
    };
    const currentIndex = source.hourly.time.findIndex(
        (time) => Math.floor(time / 3600) === Math.floor(now / 3_600_000),
    );
    if (currentIndex < 0) return null;
    const temperatures = source.hourly.temperature_2m;
    const supplementAtPoint =
        supplement?.coordinates?.lat === point.lat && supplement?.coordinates?.lon === point.lon ? supplement : null;
    const supplementalHours = new Map(supplementAtPoint?.hourly.map((row) => [hourKey(row.time), row]) ?? []);
    let supplemented = false;
    const hourly: HourlyForecast[] = [];
    for (let index = 0; index < 49; index++) {
        const temperature = temperatures[index];
        if (!finite(temperature)) return null;
        const speed = source.hourly.wind_speed_10m[index];
        const direction = source.hourly.wind_direction_10m[index];
        const time = new Date(source.hourly.time[index] * 1000).toISOString();
        const extra = supplementalHours.get(hourKey(time));
        const uvIndex = value(extra?.uvIndex),
            visibility = value(extra?.visibility);
        supplemented ||= uvIndex !== null || visibility !== null;
        hourly.push({
            time,
            temperature,
            windSpeed: speed,
            windGust: null,
            windDirection: direction === null ? '' : degreesToCardinal(direction),
            ...(direction === null ? {} : { windDegree: direction }),
            pressure: source.hourly.pressure_msl[index],
            humidity: source.hourly.relative_humidity_2m[index],
            condition: '',
            precipitation: null,
            cloudCover: null,
            cape: null,
            dewPoint: null,
            uvIndex,
            visibility,
            waveHeight: null,
            swellPeriod: null,
            waterTemperature: null,
            currentSpeed: null,
            isEstimated: false,
        });
    }
    const dates = new Map<string, number[]>();
    for (let index = 0; index < 49; index++) {
        const key = dateKey(source.hourly.time[index] * 1000);
        const indices = dates.get(key) ?? [];
        indices.push(index);
        dates.set(key, indices);
    }
    const today = dateKey(now),
        forecast: ForecastDay[] = [];
    for (const [key, indices] of dates) {
        const first = source.hourly.time[indices[0]] * 1000;
        const last = source.hourly.time[indices.at(-1)!] * 1000;
        // Both original neighbouring hours must lie outside this calendar day.
        // This also handles23/25-hour local days without inventing a24th sample.
        if (key < today || dateKey(first - 3_600_000) === key || dateKey(last + 3_600_000) === key) continue;
        const temps = indices.map((index) => temperatures[index]).filter(finite);
        if (temps.length !== indices.length) continue;
        const winds = indices.map((index) => source.hourly.wind_speed_10m[index]);
        const extra = supplementAtPoint?.forecast.find((row) => row.isoDate === key);
        const uvIndex = value(extra?.uvIndex);
        supplemented ||= uvIndex !== null;
        const contextDay = base.forecast.find((row) => row.isoDate === key);
        const solar = getSolarTimesForDate(key, point.lat, point.lon, base.timeZone);
        forecast.push({
            day: new Date(first).toLocaleDateString('en-US', { weekday: 'long', timeZone: base.timeZone }),
            date: new Date(first).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                timeZone: base.timeZone,
            }),
            isoDate: key,
            highTemp: Math.max(...temps),
            lowTemp: Math.min(...temps),
            windSpeed: winds.every(finite) ? Math.max(...winds) : null,
            windGust: null,
            waveHeight: null,
            condition: '',
            precipitation: null,
            pressure: null,
            uvIndex,
            sunrise: contextDay?.sunrise ?? solar.sunrise,
            sunset: contextDay?.sunset ?? solar.sunset,
            isEstimated: false,
        });
    }
    const current = hourly[currentIndex];
    const currentUv = value(supplementAtPoint?.current.uvIndex);
    const currentVis = value(supplementAtPoint?.current.visibility);
    const todayForecast = forecast.find((day) => day.isoDate === today);
    supplemented ||= currentUv !== null || currentVis !== null;
    const report: MarineWeatherReport = {
        ...base,
        current: {
            ...base.current,
            sources: undefined,
            windSpeed: current.windSpeed,
            windGust: null,
            windDirection: current.windDirection ?? '',
            windDegree: current.windDegree,
            airTemperature: current.temperature,
            pressure: current.pressure,
            pressureTrend: undefined,
            humidity: current.humidity,
            condition: '',
            description: 'Original AROME-OM sea-cell forecast',
            precipitation: null,
            precipDetail: undefined,
            precipLabel: undefined,
            precipValue: undefined,
            stationId: undefined,
            debugNote: undefined,
            cloudCover: null,
            dewPoint: null,
            feelsLike: null,
            cape: null,
            uvIndex: currentUv,
            visibility: currentVis,
            highTemp: todayForecast?.highTemp,
            lowTemp: todayForecast?.lowTemp,
            precipChance: undefined,
            fogRisk: undefined,
            windSpeedMin: undefined,
            windSpeedMax: undefined,
            isEstimated: false,
        },
        hourly,
        forecast,
        modelUsed: `arome:${source.model}`,
        forecastSampling: 'original-regional-sea-cell',
        forecastRunAt: source.runUtc,
        regionalAtmosphere: {
            model: source.model,
            cohortSha256: source.cohortSha256,
            maskSha256: source.maskSha256,
            latitude: source.seaCell.latitude,
            longitude: source.seaCell.longitude,
            firstValidAt: hourly[0].time,
            lastValidAt: hourly[48].time,
            ...(supplemented && supplementAtPoint ? { supplementTag: supplementAtPoint.modelUsed } : {}),
        },
        // The orchestrator regenerates model/sea alerts from this atmosphere.
        alerts: [],
        boatingAdvice: '',
    };
    return report;
}
