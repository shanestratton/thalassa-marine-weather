import { CapacitorHttp } from '@capacitor/core';
import { MarineWeatherReport, HourlyForecast, ForecastDay, SourcedWeatherMetrics, MetricSource } from '../../../types';
import { apiCacheGet, apiCacheSet } from '../apiCache';

// ── Types ─────────────────────────────────────────────────────

/** Observation from Apple WeatherKit */
export interface WeatherKitObservation {
    temperature: number | null;         // °C
    temperatureApparent: number | null; // Feels-like °C
    humidity: number | null;            // % (0-100)
    windSpeed: number | null;           // m/s
    windDirection: number | null;       // degrees
    windGust: number | null;            // m/s
    pressure: number | null;            // hPa
    visibility: number | null;          // km
    cloudCover: number | null;          // % (0-100)
    dewPoint: number | null;            // °C
    uvIndex: number | null;
    precipitationIntensity: number | null; // mm/hr
    weatherCode: number | null;         // Apple conditionCode
    condition: string;                  // Human-readable condition
    observationTime: string;            // ISO timestamp
}

/** Minutely rain data from Apple WeatherKit `forecastNextHour` */
export interface MinutelyRain {
    time: string;       // ISO timestamp
    intensity: number;  // mm/hr
}

/** Full WeatherKit response with forecasts + next-hour rain */
export interface WeatherKitFullResponse {
    observation: WeatherKitObservation | null;
    hourly: HourlyForecast[];
    daily: ForecastDay[];
    minutelyRain: MinutelyRain[];
    rainSummary: string;  // Apple's summary text (e.g. "Rain starting in 15 minutes")
}

// ── Apple Weather Condition → Human Readable ──────────────────

const CONDITION_MAP: Record<string, string> = {
    Clear: 'Clear',
    MostlyClear: 'Mostly Clear',
    PartlyCloudy: 'Partly Cloudy',
    MostlyCloudy: 'Mostly Cloudy',
    Cloudy: 'Cloudy',
    Foggy: 'Fog',
    Haze: 'Haze',
    Smoky: 'Smoky',
    Breezy: 'Breezy',
    Windy: 'Windy',
    Drizzle: 'Drizzle',
    HeavyRain: 'Heavy Rain',
    Rain: 'Rain',
    Showers: 'Showers',
    Flurries: 'Flurries',
    Snow: 'Snow',
    HeavySnow: 'Heavy Snow',
    Sleet: 'Sleet',
    FreezingDrizzle: 'Freezing Drizzle',
    FreezingRain: 'Freezing Rain',
    Hail: 'Hail',
    Thunderstorms: 'Thunderstorm',
    IsolatedThunderstorms: 'Isolated Thunderstorms',
    ScatteredThunderstorms: 'Scattered Thunderstorms',
    StrongStorms: 'Severe Storms',
    SunShowers: 'Sun Showers',
    Frigid: 'Frigid',
    Hot: 'Hot',
    Blizzard: 'Blizzard',
    TropicalStorm: 'Tropical Storm',
    Hurricane: 'Hurricane',
    SunFlurries: 'Sun Flurries',
    WintryMix: 'Wintry Mix',
    BlowingDust: 'Blowing Dust',
    BlowingSnow: 'Blowing Snow',
};

function mapCondition(code: string): string {
    return CONDITION_MAP[code] || code || 'Unknown';
}

// ── Cache ─────────────────────────────────────────────────────

let cachedFull: { data: WeatherKitFullResponse; fetchedAt: number; key: string } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Raw JSON payload from Apple WeatherKit API — loosely typed external data */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WeatherKitRaw = Record<string, any>;

// ── Supabase helpers ──────────────────────────────────────────

function getSupabaseUrl(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) {
        return import.meta.env.VITE_SUPABASE_URL;
    }
    return '';
}

function getSupabaseKey(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) {
        return import.meta.env.VITE_SUPABASE_KEY;
    }
    return '';
}

// ── Unit Converters ───────────────────────────────────────────

/** Apple km/h → m/s */
const kmhToMs = (v: number | null | undefined): number | null =>
    v != null ? v / 3.6 : null;

/** Apple km/h → knots (internal unit convention) */
const kmhToKnots = (v: number | null | undefined): number | null =>
    v != null ? v * 0.539957 : null;

/** Apple m/s wind speed → knots for display */
const msToKnots = (v: number | null | undefined): number =>
    v != null ? Math.round(v * 1.94384) : 0;

/** Apple 0-1 fraction → 0-100% */
const fractionToPercent = (v: number | null | undefined): number | null =>
    v != null ? Math.round(v * 100) : null;

/** Apple meters → km */
const mToKm = (v: number | null | undefined): number | null =>
    v != null ? v / 1000 : null;

/** Round an ISO timestamp to the nearest minute and format as HH:MM */
function roundToNearestMinute(isoStr: string): string {
    const d = new Date(isoStr);
    // Round: if seconds >= 30, bump to next minute
    if (d.getSeconds() >= 30) d.setMinutes(d.getMinutes() + 1);
    d.setSeconds(0, 0);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Response Mappers ──────────────────────────────────────────

/** Map Apple currentWeather → WeatherKitObservation */
function mapCurrentWeather(cw: WeatherKitRaw): WeatherKitObservation {
    const conditionCode = cw.conditionCode || '';
    return {
        temperature: cw.temperature ?? null,
        temperatureApparent: cw.temperatureApparent ?? null,
        humidity: fractionToPercent(cw.humidity),
        windSpeed: kmhToKnots(cw.windSpeed),     // MUST be knots — internal convention
        windDirection: cw.windDirection ?? null,
        windGust: kmhToKnots(cw.windGust),        // MUST be knots — internal convention
        pressure: cw.pressure ?? null,
        visibility: mToKm(cw.visibility),
        cloudCover: fractionToPercent(cw.cloudCover),
        dewPoint: cw.temperatureDewPoint ?? null,
        uvIndex: cw.uvIndex ?? null,
        precipitationIntensity: cw.precipitationIntensity ?? null,
        weatherCode: null,
        condition: mapCondition(conditionCode),
        observationTime: cw.asOf || new Date().toISOString(),
    };
}

/** Map Apple forecastHourly → HourlyForecast[] */
function mapHourlyForecast(forecastHourly: WeatherKitRaw): HourlyForecast[] {
    const hours = forecastHourly?.hours;
    if (!Array.isArray(hours)) return [];

    return hours.map((h: WeatherKitRaw): HourlyForecast => ({
        time: h.forecastStart || '',
        windSpeed: msToKnots(kmhToMs(h.windSpeed)),
        windGust: h.windGust != null ? msToKnots(kmhToMs(h.windGust)) : null,
        windDirection: h.windDirection != null
            ? degreesToCardinalSimple(h.windDirection)
            : undefined,
        windDegree: h.windDirection ?? undefined,
        waveHeight: 0, // WeatherKit doesn't provide waves — StormGlass fills this
        swellPeriod: null,
        temperature: h.temperature ?? 0,
        condition: mapCondition(h.conditionCode || ''),
        feelsLike: h.temperatureApparent ?? undefined,
        precipitation: h.precipitationAmount ?? null,
        precipChance: h.precipitationChance != null ? Math.round(h.precipitationChance * 100) : undefined,
        cloudCover: fractionToPercent(h.cloudCover),
        uvIndex: h.uvIndex ?? undefined,
        pressure: h.pressure ?? undefined,
        humidity: fractionToPercent(h.humidity),
        visibility: mToKm(h.visibility) ?? undefined,
        dewPoint: h.temperatureDewPoint ?? null,
    }));
}

/** Map Apple forecastDaily → ForecastDay[] */
function mapDailyForecast(forecastDaily: WeatherKitRaw): ForecastDay[] {
    const days = forecastDaily?.days;
    if (!Array.isArray(days)) return [];

    return days.map((d: WeatherKitRaw): ForecastDay => {
        const dateStr = d.forecastStart || '';
        const dateObj = new Date(dateStr);
        const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
        const isoDate = dateStr.substring(0, 10); // YYYY-MM-DD

        return {
            day: dayName,
            date: isoDate,
            isoDate,
            highTemp: d.temperatureMax ?? 0,
            lowTemp: d.temperatureMin ?? 0,
            windSpeed: msToKnots(kmhToMs(d.windSpeedAvg ?? d.windSpeedMax)),
            windGust: d.windGustSpeedMax != null ? msToKnots(kmhToMs(d.windGustSpeedMax)) : undefined,
            waveHeight: 0, // WeatherKit doesn't provide — StormGlass fills this
            condition: mapCondition(d.conditionCode || ''),
            precipitation: d.precipitationAmount ?? undefined,
            precipChance: d.precipitationChance != null ? Math.round(d.precipitationChance * 100) : undefined,
            cloudCover: fractionToPercent(d.daytimeForecast?.cloudCover) ?? undefined,
            uvIndex: d.maxUvIndex ?? undefined,
            sunrise: d.sunrise ? roundToNearestMinute(d.sunrise) : undefined,
            sunset: d.sunset ? roundToNearestMinute(d.sunset) : undefined,
            humidity: fractionToPercent(d.daytimeForecast?.humidity) ?? undefined,
            pressure: d.restOfDayForecast?.pressureTrend ?? undefined,
        };
    });
}

/** Map Apple forecastNextHour → MinutelyRain[] */
function mapNextHourForecast(forecastNextHour: WeatherKitRaw): { rain: MinutelyRain[]; summary: string } {
    const minutes = forecastNextHour?.minutes;
    const summary = forecastNextHour?.summary?.[0]?.condition
        ?? forecastNextHour?.metadata?.conditionCode
        ?? '';

    // Build human-readable summary from Apple's data
    let summaryText = '';
    if (forecastNextHour?.summary && Array.isArray(forecastNextHour.summary)) {
        // Apple provides summary periods with startTime, endTime, condition, precipitationChance
        const periods = forecastNextHour.summary;
        if (periods.length > 0) {
            const firstPrecip = periods.find((p: WeatherKitRaw) =>
                p.condition === 'rain' || p.condition === 'drizzle' ||
                p.condition === 'snow' || p.condition === 'sleet'
            );
            if (firstPrecip) {
                const startTime = new Date(firstPrecip.startTime);
                const now = new Date();
                const minsUntil = Math.round((startTime.getTime() - now.getTime()) / 60000);
                const condLabel = firstPrecip.condition.charAt(0).toUpperCase() + firstPrecip.condition.slice(1);
                if (minsUntil <= 0) {
                    summaryText = `${condLabel} expected to continue`;
                } else {
                    summaryText = `${condLabel} starting in ${minsUntil} min`;
                }
            } else {
                summaryText = 'No precipitation expected';
            }
        }
    }

    if (!Array.isArray(minutes) || minutes.length === 0) {
        return { rain: [], summary: summaryText };
    }

    const rain: MinutelyRain[] = minutes.slice(0, 60).map((m: WeatherKitRaw) => ({
        time: m.startTime || '',
        intensity: m.precipitationIntensity ?? 0,
    }));

    return { rain, summary: summaryText };
}

/** Simple degrees-to-cardinal for hourly forecast */
function degreesToCardinalSimple(deg: number): string {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
        'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
}

// ── Main Fetcher ──────────────────────────────────────────────

/**
 * Fetch full weather data from Apple WeatherKit via Supabase proxy.
 * Returns current conditions + hourly forecast + daily forecast.
 * Tier 2: Used for coastal/inland locations (≤20nm offshore).
 */
export const fetchWeatherKitFull = async (
    lat: number,
    lon: number,
): Promise<WeatherKitFullResponse | null> => {
    // 1. In-memory cache (fast — avoids localStorage deserialization)
    const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (cachedFull && cachedFull.key === cacheKey && (Date.now() - cachedFull.fetchedAt) < CACHE_TTL) {
        return cachedFull.data;
    }

    // 2. Persistent cache (survives app restarts — 15min TTL)
    const persistent = apiCacheGet<WeatherKitFullResponse>('weatherkit', lat, lon);
    if (persistent) {
        cachedFull = { data: persistent, fetchedAt: Date.now(), key: cacheKey };
        return persistent;
    }

    const supabaseUrl = getSupabaseUrl();
    const supabaseKey = getSupabaseKey();
    if (!supabaseUrl) {
        return null;
    }

    const url = `${supabaseUrl}/functions/v1/fetch-weatherkit`;
    // supabaseKey already retrieved above
    const body = {
        lat,
        lon,
        dataSets: ['currentWeather', 'forecastHourly', 'forecastDaily', 'forecastNextHour'],
    };

    try {
        let json: WeatherKitRaw;
        try {
            const res = await CapacitorHttp.post({
                url,
                headers: {
                    'Content-Type': 'application/json',
                    ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
                },
                data: body,
            });
            if (res.status !== 200) {
                const errBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                console.error(`[WeatherKit] Edge function HTTP ${res.status}: ${errBody?.substring(0, 300)}`);
                throw new Error(`HTTP ${res.status}: ${errBody?.substring(0, 100)}`);
            }
            json = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        } catch (capacitorErr: unknown) {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
                },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => '');
                console.error(`[WeatherKit] Fetch HTTP ${res.status}: ${errText.substring(0, 300)}`);
                throw new Error(`Fetch HTTP ${res.status}: ${errText.substring(0, 100)}`);
            }
            json = await res.json();
        }

        // Map all four datasets
        const observation = json?.currentWeather ? mapCurrentWeather(json.currentWeather) : null;
        const hourly = json?.forecastHourly ? mapHourlyForecast(json.forecastHourly) : [];
        const daily = json?.forecastDaily ? mapDailyForecast(json.forecastDaily) : [];
        const { rain: minutelyRain, summary: rainSummary } = json?.forecastNextHour
            ? mapNextHourForecast(json.forecastNextHour)
            : { rain: [], summary: '' };

        const result: WeatherKitFullResponse = { observation, hourly, daily, minutelyRain, rainSummary };

        // Cache (memory + persistent)
        cachedFull = { data: result, fetchedAt: Date.now(), key: cacheKey };
        apiCacheSet('weatherkit', lat, lon, result); return result;

    } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error('[WeatherKit] ❌ FETCH FAILED:', errMsg);
        console.error('[WeatherKit] This means ALL atmospheric data will fall back to StormGlass.');
        return null;
    }
};

/**
 * Convenience: fetch only currentWeather observation.
 * For backward compatibility with code that only needs live data.
 */
export const fetchWeatherKitRealtime = async (
    lat: number,
    lon: number,
): Promise<WeatherKitObservation | null> => {
    const full = await fetchWeatherKitFull(lat, lon);
    return full?.observation ?? null;
};

/**
 * Fetch minute-by-minute rain forecast from WeatherKit.
 * Fetch minute-by-minute rain from WeatherKit `forecastNextHour`.
 * Returns 60 data points (1 per minute) for the next hour.
 */
export const fetchMinutelyRain = async (
    lat: number,
    lon: number,
): Promise<MinutelyRain[]> => {
    const full = await fetchWeatherKitFull(lat, lon);
    return full?.minutelyRain ?? [];
};

/**
 * Fetch minute-by-minute rain forecast WITH Apple's native summary text.
 * Used by the RainForecastCard for progressive disclosure display.
 */
export const fetchMinutelyRainWithSummary = async (
    lat: number,
    lon: number,
): Promise<{ rain: MinutelyRain[]; summary: string }> => {
    const full = await fetchWeatherKitFull(lat, lon);
    return {
        rain: full?.minutelyRain ?? [],
        summary: full?.rainSummary ?? '',
    };
};

// ── WeatherKit → MarineWeatherReport Builder ──────────────────
// Builds a complete MarineWeatherReport directly from WeatherKit data.
// This is the PRIMARY source — no more layering on top of OpenMeteo.
// Marine fields (wave, swell, water temp, currents) are zero/null here
// and get filled by StormGlass in the orchestrator.

/**
 * Build a full MarineWeatherReport from WeatherKit data.
 * All atmospheric fields (temp, wind, pressure, cloud, etc.) come from Apple.
 * Marine fields default to zero/null — StormGlass fills them.
 */
export function buildReportFromWeatherKit(
    wk: WeatherKitFullResponse,
    lat: number,
    lon: number,
    name: string,
): MarineWeatherReport {
    const obs = wk.observation;
    const today = wk.daily[0];

    // Source tracking helper
    const wkSource = (val: number | string | null) => ({
        value: val,
        source: 'weatherkit' as const,
        sourceColor: 'emerald' as const,
        sourceName: 'Apple Weather',
    });

    // Build sources map — every atmospheric field from WeatherKit
    const sources: Record<string, MetricSource> = {};
    if (obs) {
        if (obs.temperature !== null) sources['airTemperature'] = wkSource(obs.temperature);
        if (obs.temperatureApparent !== null) sources['feelsLike'] = wkSource(obs.temperatureApparent);
        if (obs.humidity !== null) sources['humidity'] = wkSource(obs.humidity);
        if (obs.dewPoint !== null) sources['dewPoint'] = wkSource(obs.dewPoint);
        if (obs.windSpeed !== null) sources['windSpeed'] = wkSource(obs.windSpeed);
        if (obs.windGust !== null) sources['windGust'] = wkSource(obs.windGust);
        if (obs.windDirection !== null) sources['windDirection'] = wkSource(degreesToCardinalSimple(obs.windDirection));
        if (obs.pressure !== null) sources['pressure'] = wkSource(obs.pressure);
        if (obs.visibility !== null) sources['visibility'] = wkSource(obs.visibility);
        if (obs.cloudCover !== null) sources['cloudCover'] = wkSource(obs.cloudCover);
        if (obs.uvIndex !== null) sources['uvIndex'] = wkSource(obs.uvIndex);
        if (obs.precipitationIntensity !== null) sources['precipitation'] = wkSource(obs.precipitationIntensity);
    }

    // Cross-reference observation with hourly for best condition
    let condition = obs?.condition ?? 'Unknown';
    if (wk.hourly.length > 0) {
        const now = new Date();
        const currentHourStr = now.toISOString().slice(0, 13);
        const currentHourly = wk.hourly.find(h => h.time?.startsWith(currentHourStr));
        if (currentHourly?.condition && obs?.condition) {
            // Use severity ranking — same logic as orchestrator
            const SEVERITY: Record<string, number> = {
                'Clear': 0, 'Mostly Clear': 1, 'Partly Cloudy': 2,
                'Mostly Cloudy': 3, 'Cloudy': 4, 'Overcast': 4,
                'Haze': 5, 'Fog': 6, 'Breezy': 6, 'Windy': 7,
                'Drizzle': 8, 'Light Rain': 9, 'Rain': 10, 'Showers': 10,
                'Heavy Rain': 11, 'Freezing Rain': 12, 'Sleet': 12,
                'Snow': 12, 'Heavy Snow': 13, 'Blizzard': 14,
                'Thunderstorm': 15, 'Severe Storms': 16,
            };
            const sevObs = SEVERITY[obs.condition] ?? 2;
            const sevHourly = SEVERITY[currentHourly.condition] ?? 2;
            if (sevHourly > sevObs) condition = currentHourly.condition;
        }
    }

    const current: SourcedWeatherMetrics = {
        airTemperature: obs?.temperature ?? null,
        feelsLike: obs?.temperatureApparent ?? null,
        windSpeed: obs?.windSpeed != null ? parseFloat(obs.windSpeed.toFixed(1)) : null,
        windGust: obs?.windGust != null ? parseFloat(obs.windGust.toFixed(1)) : null,
        windDirection: obs?.windDirection != null ? degreesToCardinalSimple(obs.windDirection) : '---',
        windDegree: obs?.windDirection ?? undefined,
        waveHeight: null,        // StormGlass fills
        swellPeriod: null,       // StormGlass fills
        swellDirection: undefined,
        waterTemperature: null,  // StormGlass fills
        currentSpeed: 0,         // StormGlass fills
        currentDirection: 0,     // StormGlass fills
        condition,
        description: `${condition}. Wind ${obs?.windSpeed != null ? parseFloat(obs.windSpeed.toFixed(1)) : '--'} kts ${obs?.windDirection != null ? degreesToCardinalSimple(obs.windDirection) : ''}`,
        pressure: obs?.pressure ?? null,
        cloudCover: obs?.cloudCover ?? null,
        visibility: obs?.visibility ?? null,
        humidity: obs?.humidity ?? null,
        dewPoint: obs?.dewPoint ?? null,
        uvIndex: obs?.uvIndex ?? 0,
        precipitation: obs?.precipitationIntensity ?? null,
        sunrise: today?.sunrise ?? '--:--',
        sunset: today?.sunset ?? '--:--',
        highTemp: today?.highTemp,
        lowTemp: today?.lowTemp,
        moonPhase: '',
        moonIllumination: 0,
        day: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
        date: new Date().toLocaleDateString('en-US'),
        isDay: true, // Will be computed by consumer from sunrise/sunset
        isEstimated: false,
        cape: null, // OpenMeteo fills (thunderstorm energy)
        sources,
    } as SourcedWeatherMetrics;

    return {
        locationName: name,
        coordinates: { lat, lon },
        current,
        hourly: wk.hourly,
        forecast: wk.daily,
        tides: [],
        tideHourly: [],
        boatingAdvice: '',
        alerts: [],
        generatedAt: new Date().toISOString(),
        modelUsed: 'weatherkit',
        timeZone: undefined, // Will be set by OpenMeteo or StormGlass
        utcOffset: undefined,
    };
}
