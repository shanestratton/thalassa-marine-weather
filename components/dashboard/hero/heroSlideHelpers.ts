/**
 * HeroSlide display value computation — extracted from HeroSlide.tsx.
 *
 * Pure function that converts raw weather metrics into formatted
 * display strings using the user's unit preferences.
 */
import {
    convertTemp,
    convertSpeed,
    convertLength,
    convertPrecip,
    convertDistance,
    degreesToCardinal,
} from '../../../utils';
import { UnitPreferences, SourcedWeatherMetrics, HourlyForecast } from '../../../types';
import { ShipLogService } from '../../../services/ShipLogService';
import { circularMean } from '../../../utils/circularStats';

// ── Sun Phase Helper ────────────────────────────────────────────────

export interface SunPhaseResult {
    isDay: boolean;
    label: string;
    time: string;
}

/**
 * Determine sun phase (day/night/sunrise/sunset label) for a given card.
 */
export function computeSunPhase(cardData: SourcedWeatherMetrics | null, cardTime: number | undefined): SunPhaseResult {
    const fallbackCheck = (ts: number): SunPhaseResult => {
        const h = new Date(ts).getHours();
        return {
            isDay: h >= 6 && h < 18,
            label: h >= 6 && h < 18 ? 'Sunset' : 'Sunrise',
            time: '--:--',
        };
    };

    if (!cardData) return { isDay: true, label: 'Sunset', time: '--:--' };

    const currentTs = cardTime || Date.now();
    const sRise = cardData.sunrise;
    const sSet = cardData.sunset;

    if (!sRise || !sSet || sRise === '--:--' || sSet === '--:--') return fallbackCheck(currentTs);

    try {
        const [rH, rM] = sRise
            .replace(/[^0-9:]/g, '')
            .split(':')
            .map(Number);
        const [sH, sM] = sSet
            .replace(/[^0-9:]/g, '')
            .split(':')
            .map(Number);
        if (isNaN(rH) || isNaN(sH)) return fallbackCheck(currentTs);

        const d = new Date(currentTs);
        const riseDt = new Date(d);
        riseDt.setHours(rH, rM, 0);
        const setDt = new Date(d);
        setDt.setHours(sH, sM, 0);

        if (d < riseDt) return { isDay: false, label: 'Sunrise', time: sRise };
        if (d >= riseDt && d < setDt) return { isDay: true, label: 'Sunset', time: sSet };
        return { isDay: false, label: 'Sunrise', time: sRise };
    } catch {
        return fallbackCheck(currentTs);
    }
}

// ── Card Display Values ─────────────────────────────────────────────

export interface CardDisplayValues extends HeroDisplayValues {
    moon: string;
    cape: number | string;
    sogKts: number | string;
    cogDeg: number | string;
}

/**
 * Compute pre-rendered display values for a single hourly/current card.
 * This is the per-card equivalent of computeDisplayValues (which handles the
 * main "active" card). Here we handle the full carousel of cards.
 */
export function computeCardDisplayValues(
    cardData: SourcedWeatherMetrics,
    units: UnitPreferences,
    index: number,
    isHourly: boolean,
    isLandlocked?: boolean,
): CardDisplayValues {
    return {
        airTemp: cardData.airTemperature !== null ? convertTemp(cardData.airTemperature, units.temp) : '--',
        highTemp: cardData.highTemp !== undefined ? convertTemp(cardData.highTemp, units.temp) : '--',
        lowTemp: cardData.lowTemp !== undefined ? convertTemp(cardData.lowTemp, units.temp) : '--',
        windSpeed:
            cardData.windSpeed !== null && cardData.windSpeed !== undefined
                ? Math.round(convertSpeed(cardData.windSpeed, units.speed)!)
                : '--',
        waveHeight: isLandlocked
            ? '0'
            : cardData.waveHeight !== null && cardData.waveHeight !== undefined
              ? String(convertLength(cardData.waveHeight, units.length))
              : '--',
        vis:
            cardData.visibility && !isNaN(cardData.visibility)
                ? convertDistance(cardData.visibility, units.visibility || 'nm')
                : '--',
        // Real gusts only. This used to fall back to windSpeed * 1.3, so a
        // model with no gust field (ECMWF AIFS, JMA GSM) showed an invented
        // gust in the hero beside genuine readings.
        gusts: cardData.windGust != null ? Math.round(convertSpeed(cardData.windGust, units.speed)!) : '--',
        precip: (() => {
            if (!isHourly && index === 0) {
                // convertPrecip keys inches on the TEMPERATURE unit; units.length never says 'F', so
                // Fahrenheit users saw millimetres under an 'in' label (audit 2026-09-02).
                return convertPrecip(cardData.precipitation, units.temp) ?? '0';
            }
            const chance = cardData.precipChance;
            return chance !== undefined && chance !== null ? Math.round(chance) : 0;
        })(),
        precipUnit: !isHourly && index === 0 ? (units.temp === 'F' ? 'in' : 'mm') : '%',
        pressure: cardData.pressure && !isNaN(cardData.pressure) ? Math.round(cardData.pressure) : '--',
        cloudCover:
            cardData.cloudCover !== null && cardData.cloudCover !== undefined && !isNaN(cardData.cloudCover)
                ? Math.round(cardData.cloudCover)
                : '--',
        uv:
            cardData.uvIndex !== undefined && cardData.uvIndex !== null && !isNaN(cardData.uvIndex)
                ? Math.round(cardData.uvIndex)
                : '--',
        sunrise: cardData.sunrise || '--:--',
        sunset: cardData.sunset || '--:--',
        humidity:
            cardData.humidity !== undefined && cardData.humidity !== null && !isNaN(cardData.humidity)
                ? Math.round(cardData.humidity)
                : '--',
        feelsLike:
            cardData.feelsLike !== undefined && cardData.feelsLike !== null
                ? convertTemp(cardData.feelsLike, units.temp)
                : '--',
        dewPoint:
            cardData.dewPoint !== undefined && cardData.dewPoint !== null && !isNaN(cardData.dewPoint as number)
                ? convertTemp(cardData.dewPoint as number, units.temp)
                : '--',
        waterTemperature: (() => {
            const val = cardData.waterTemperature;
            return val !== undefined && val !== null && !isNaN(val) ? convertTemp(val, units.temp) : '--';
        })(),
        currentSpeed:
            cardData.currentSpeed !== undefined &&
            cardData.currentSpeed !== null &&
            !isNaN(cardData.currentSpeed as number)
                ? Number(cardData.currentSpeed).toFixed(1)
                : '--',
        currentDirection: (() => {
            const val = cardData.currentDirection;
            if (typeof val === 'number' && !isNaN(val)) return degreesToCardinal(val);
            if (typeof val === 'string') return val.replace(/[\d.°]+/g, '').trim() || val;
            return '--';
        })(),
        moon: cardData.moonPhase || 'Waxing',
        cape:
            cardData.cape !== undefined && cardData.cape !== null && !isNaN(cardData.cape as number)
                ? Math.round(cardData.cape as number)
                : '--',
        secondarySwellHeight: (() => {
            const v = cardData.secondarySwellHeight;
            return v !== undefined && v !== null && !isNaN(v) ? v : '--';
        })(),
        secondarySwellPeriod: (() => {
            const v = cardData.secondarySwellPeriod;
            return v !== undefined && v !== null && !isNaN(v) ? Math.round(v) : '--';
        })(),
        ...(() => {
            if (!isHourly && index === 0) {
                const nav = ShipLogService.getGpsNavData();
                return { sogKts: nav.sogKts ?? '--', cogDeg: nav.cogDeg ?? '--' };
            }
            return { sogKts: '--', cogDeg: '--' };
        })(),
    };
}

// ── Build Slides Array ──────────────────────────────────────────────

export interface SlideData {
    type: 'current' | 'hourly' | 'daily';
    data: SourcedWeatherMetrics;
    time: number | undefined;
    /** Present only when type === 'daily' — the day-overview summary fields. */
    daily?: DailySummary;
}

/** Day-overview values shown on the daily-summary landing card (forecast days). */
export interface DailySummary {
    highTemp?: number;
    lowTemp?: number;
    condition?: string;
    windSpeed?: number | null;
    windGust?: number | null;
    /** Day's general wind direction (deg FROM), circular-mean of the hourly. */
    windDegree?: number;
    waveHeight?: number | null;
    swellPeriod?: number;
    tideSummary?: string;
    sunrise?: string;
    sunset?: string;
    precipChance?: number;
}

/**
 * The daily forecast shape used by the hero carousel.  Keep this deliberately
 * small: hourly cards only need the daily fields which are safe to inherit
 * across every hour in a Glass day row.
 */
export interface HeroDailyForecast {
    isoDate?: string;
    date?: string;
    precipChance?: number;
    highTemp?: number;
    lowTemp?: number;
    sunrise?: string;
    sunset?: string;
    condition?: string;
    windSpeed?: number | null;
    /** Null where the model publishes no gust field (AIFS, JMA GSM). */
    windGust?: number | null;
    waveHeight?: number | null;
    swellPeriod?: number;
    tideSummary?: string;
}

export interface DailyTemperatureRange {
    highTemp?: number;
    lowTemp?: number;
}

export interface DailyTemperatureResolutionOptions {
    /**
     * The forecast location's IANA timezone.  Never use the device timezone
     * to select a daily record for a location elsewhere in the world.
     */
    timeZone?: string;
    /**
     * Useful for a live/current row, whose metrics do not always carry a
     * calendar-date identity of their own.
     */
    referenceTime?: string | number | Date;
    /**
     * A Hero row already owns its resolved daily pair, while a fresh current
     * snapshot (Essential mode) should prefer the matching daily forecast.
     */
    preferForecast?: boolean;
    /**
     * WeatherKit can label its first local-today daily entry with the prior
     * UTC calendar date.  Opt in only for the live row, where this provider
     * convention is known and the first entry is the intended fallback.
     */
    allowLeadingPreviousDayFallback?: boolean;
}

const finiteTemperature = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Normalise the date-only portion without letting the device timezone parse it. */
const dateOnly = (value?: string): string | undefined => {
    const match = value?.match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1];
};

const localCalendarDate = (value: string | number | Date, timeZone?: string): string | undefined => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;

    try {
        return date.toLocaleDateString('en-CA', timeZone ? { timeZone } : undefined);
    } catch {
        // A malformed timezone must not prevent forecast rendering.  Falling
        // back to the runtime timezone is less precise, but still deterministic.
        return date.toLocaleDateString('en-CA');
    }
};

const previousCalendarDate = (isoDate: string): string | undefined => {
    const date = new Date(`${isoDate}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return undefined;
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
};

/**
 * Pick a daily record once for the whole row.  Hourly cards must not each
 * repeat this lookup: a device in a different timezone can otherwise select
 * tomorrow's daily record while the Glass UI still says "TODAY".
 */
export function findHeroRowDailyForecast(
    data: Pick<SourcedWeatherMetrics, 'isoDate' | 'date'>,
    forecast: readonly HeroDailyForecast[],
    hourlyToRender: readonly HourlyForecast[],
    options: DailyTemperatureResolutionOptions = {},
): HeroDailyForecast | undefined {
    const candidates: string[] = [];
    const addCandidate = (value?: string) => {
        if (value && !candidates.includes(value)) candidates.push(value);
    };

    const findExact = (date: string): HeroDailyForecast | undefined =>
        forecast.find((day) => dateOnly(day.isoDate) === date || dateOnly(day.date) === date);

    const referenceDate =
        options.referenceTime !== undefined ? localCalendarDate(options.referenceTime, options.timeZone) : undefined;

    // The live row has a direct wall-clock identity. Do not let an old cached
    // hourly item silently replace it with yesterday's daily record.
    if (referenceDate) {
        const exact = findExact(referenceDate);
        if (exact) return exact;

        // WeatherKit's first local-today entry can have yesterday's UTC date.
        // This opt-in is deliberately restricted to the live row.
        if (options.allowLeadingPreviousDayFallback) {
            const first = forecast[0];
            const firstDate = first && (dateOnly(first.isoDate) || dateOnly(first.date));
            if (firstDate && previousCalendarDate(referenceDate) === firstDate) return first;
        }

        return undefined;
    }

    // A forecast row's actual hours are otherwise the most authoritative date
    // identity. Resolve them in the forecast location's timezone before
    // consulting provider date strings, which can be UTC or device-time based.
    for (const hour of hourlyToRender) {
        addCandidate(localCalendarDate(hour.time, options.timeZone));
        if (candidates.length > 0) break;
    }
    addCandidate(dateOnly(data.isoDate));
    addCandidate(dateOnly(data.date));

    for (const date of candidates) {
        const exact = findExact(date);
        if (exact) return exact;
    }

    return undefined;
}

/** A condition word that claims falling water (or frozen water). */
const WET_CONDITION = /drizzle|rain|shower|thunder|snow|hail|sleet/i;

/**
 * Reconcile the provider's DAILY condition with the row's own hourly cards.
 *
 * Open-Meteo's daily weather_code is the MOST SEVERE hour of the whole 24 h
 * day — one pre-dawn drizzle blip in a model run brands an otherwise sunny
 * day "Drizzle" while precipitation_sum reads 0.0 and every hourly card the
 * summary fronts says clear (Shane, 2026-08-10: tomorrow's overview said
 * drizzle, all 24 cards sunny, every other forecast fine). The summary card
 * summarizes the hours below it, so when they disagree the hours win:
 *
 *  - provider says WET, some daylight hour agrees → keep the provider word.
 *  - provider says WET, hours dry, but real water falls somewhere in the day
 *    (≥0.2 mm — night rain the daylight filter hides) → keep the provider
 *    word; suppressing actual rain would under-warn, the worse direction.
 *  - provider says WET, hours dry, day's precip rounds to nothing → the wet
 *    word is a severest-hour artefact: show the commonest daylight condition
 *    instead, so the overview agrees with the cards it stands in front of.
 *  - provider says a dry word → unchanged (dry-vs-dry shade differences are
 *    not worth second-guessing).
 *
 * Daylight = 06:00–20:00 read straight from the hour string, which is
 * location-local for the Open-Meteo path the Glass rides. A provider with
 * UTC hour strings only mis-scopes the daylight filter, and the full-day
 * precip guard still catches real rain — degraded, never dangerous.
 */
export function reconcileDayCondition(
    providerCondition: string | undefined,
    hours: readonly HourlyForecast[],
): string | undefined {
    if (!providerCondition || hours.length === 0 || !WET_CONDITION.test(providerCondition)) return providerCondition;
    const hourOf = (t: string): number => {
        const m = /T(\d{2})/.exec(t);
        return m ? Number(m[1]) : NaN;
    };
    const daylight = hours.filter((h) => {
        const hh = hourOf(h.time);
        return hh >= 6 && hh <= 20;
    });
    const scope = daylight.length > 0 ? daylight : hours;
    if (scope.some((h) => WET_CONDITION.test(h.condition))) return providerCondition;
    const totalPrecipMm = hours.reduce(
        (s, h) => s + (typeof h.precipitation === 'number' && Number.isFinite(h.precipitation) ? h.precipitation : 0),
        0,
    );
    if (totalPrecipMm >= 0.2) return providerCondition;
    const counts = new Map<string, number>();
    for (const h of scope) counts.set(h.condition, (counts.get(h.condition) ?? 0) + 1);
    let commonest: string | undefined;
    let n = 0;
    for (const [c, k] of counts) {
        if (k > n) {
            commonest = c;
            n = k;
        }
    }
    return commonest ?? providerCondition;
}

/**
 * Resolve the one high/low pair owned by a Glass day row.  Consumers then copy
 * this pair to Now, every hourly card, and the day summary rather than doing a
 * second timezone-sensitive lookup per card.
 */
export function resolveHeroRowTemperatureRange(
    data: Pick<SourcedWeatherMetrics, 'highTemp' | 'lowTemp' | 'isoDate' | 'date'>,
    forecast: readonly HeroDailyForecast[],
    hourlyToRender: readonly HourlyForecast[],
    options: DailyTemperatureResolutionOptions = {},
): DailyTemperatureRange {
    const matchedDaily = findHeroRowDailyForecast(data, forecast, hourlyToRender, options);
    const rowHigh = finiteTemperature(data.highTemp);
    const rowLow = finiteTemperature(data.lowTemp);
    const forecastHigh = finiteTemperature(matchedDaily?.highTemp);
    const forecastLow = finiteTemperature(matchedDaily?.lowTemp);

    if (options.preferForecast) {
        return {
            highTemp: forecastHigh ?? rowHigh,
            lowTemp: forecastLow ?? rowLow,
        };
    }

    return {
        highTemp: rowHigh ?? forecastHigh,
        lowTemp: rowLow ?? forecastLow,
    };
}

const withHeroRowTemperatureRange = <T extends SourcedWeatherMetrics>(
    data: T,
    temperatures: DailyTemperatureRange,
): T =>
    ({
        ...data,
        highTemp: temperatures.highTemp ?? data.highTemp,
        lowTemp: temperatures.lowTemp ?? data.lowTemp,
    }) as T;

/**
 * Build the slides array from base data + hourly forecasts.
 *
 * Today (index 0) leads with the live "NOW" card. Forecast days (index > 0)
 * lead with a DAY-OVERVIEW summary card instead of midnight — the hourly cards
 * (00:00, 01:00, …) follow it, one swipe left. (Midnight-first was useless.)
 */
/**
 * Timestamp to stand for a whole forecast day when no hourly frame exists to
 * borrow one from. Local midday off the row's own isoDate, falling back to
 * counting days from today when the row carries no date at all.
 */
function heroRowMiddayTs(rowData: SourcedWeatherMetrics, index: number): number {
    const iso = (rowData as { isoDate?: string; date?: string }).isoDate ?? (rowData as { date?: string }).date;
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
    }
    const d = new Date();
    d.setDate(d.getDate() + index);
    d.setHours(12, 0, 0, 0);
    return d.getTime();
}

export function buildSlides(
    data: SourcedWeatherMetrics,
    index: number,
    hourlyToRender: HourlyForecast[],
    forecast: HeroDailyForecast[],
    timeZone?: string,
): SlideData[] {
    if (!data) return [];

    // Resolve daily temperatures ONCE for this row.  `data` comes from the
    // location-timezone-aware day-row builder, so it wins when complete.  The
    // matching forecast is only a safe fallback for partial provider data.
    const temperatures = resolveHeroRowTemperatureRange(data, forecast, hourlyToRender, { timeZone });
    const rowData = withHeroRowTemperatureRange(data, temperatures);

    // Forecast days: prepend a day-overview summary as the landing card.
    //
    // This used to require `firstHour`, which quietly deleted the far end of
    // the carousel. WeatherKit's hourly stops at +120 h (weatherkit.ts) while
    // Hero builds ELEVEN day rows off the daily forecast, so every day past
    // about five out had no hourly, no overview and therefore no slides at
    // all — buildSlides returned [] and the day rendered as bare chrome.
    // Shane 2026-08-28: "it does not show the rain radar. it shows the same
    // as the normal glass page. this only happens when you are about 5 days
    // forward of today". Five days is not a coincidence; it is the horizon.
    //
    // We still hold real daily data for those days, so the overview stands on
    // its own. `time` falls back to the row's own date at local midday: it
    // only seeds the slide's clock, and midday is the least wrong hour to
    // stand for a whole day.
    let dailySlide: SlideData[] = [];
    const firstHour = hourlyToRender?.[0];
    if (index > 0) {
        // If the provider omits a matching daily record, keep the overview
        // using the row data rather than showing an adjacent (wrong-day)
        // forecast or dropping the overview altogether.
        const m: HeroDailyForecast = findHeroRowDailyForecast(rowData, forecast, hourlyToRender, { timeZone }) ?? {
            isoDate: rowData.isoDate,
            date: rowData.date,
            highTemp: temperatures.highTemp,
            lowTemp: temperatures.lowTemp,
            condition: rowData.condition,
            windSpeed: rowData.windSpeed,
            windGust: rowData.windGust,
            waveHeight: rowData.waveHeight,
            swellPeriod: rowData.swellPeriod ?? undefined,
            sunrise: rowData.sunrise,
            sunset: rowData.sunset,
            precipChance: rowData.precipChance,
        };
        // Day's general wind direction = circular mean of the day's hourly
        // bearings (the daily forecast carries no direction field).
        const dayWindDeg = circularMean(hourlyToRender.map((h) => h.windDegree));
        // The provider's severest-hour daily code must not contradict the
        // hourly cards this overview fronts — see reconcileDayCondition.
        const dayCondition = reconcileDayCondition(m.condition, hourlyToRender);
        dailySlide = [
            {
                type: 'daily' as const,
                // Synthesised metrics so the shared precompute/header don't
                // crash on this slide; the rich card reads `daily` directly.
                data: {
                    ...rowData,
                    airTemperature: temperatures.highTemp ?? m.highTemp,
                    windSpeed: m.windSpeed,
                    windGust: m.windGust,
                    waveHeight: m.waveHeight,
                    sunrise: m.sunrise || rowData.sunrise,
                    sunset: m.sunset || rowData.sunset,
                    precipChance: m.precipChance,
                } as unknown as SourcedWeatherMetrics,
                time: firstHour ? new Date(firstHour.time).getTime() : heroRowMiddayTs(rowData, index),
                daily: {
                    highTemp: temperatures.highTemp ?? m.highTemp,
                    lowTemp: temperatures.lowTemp ?? m.lowTemp,
                    condition: dayCondition,
                    windSpeed: m.windSpeed,
                    windGust: m.windGust,
                    windDegree: dayWindDeg ?? undefined,
                    waveHeight: m.waveHeight,
                    swellPeriod: m.swellPeriod,
                    tideSummary: m.tideSummary,
                    sunrise: m.sunrise || rowData.sunrise,
                    sunset: m.sunset || rowData.sunset,
                    precipChance: m.precipChance,
                },
            },
        ];
    }

    return [
        ...(index === 0
            ? [{ type: 'current' as const, data: rowData, time: undefined as number | undefined }]
            : dailySlide),
        ...(hourlyToRender || []).map((h) => {
            const matchDay = findHeroRowDailyForecast(rowData, forecast, [h], { timeZone });

            return {
                type: 'hourly' as const,
                data: {
                    ...h,
                    airTemperature: h.temperature,
                    feelsLike: h.feelsLike,
                    windSpeed: h.windSpeed,
                    waveHeight: h.waveHeight,
                    precipChance: h.precipChance ?? matchDay?.precipChance,
                    // These are deliberately the row-level pair.  Do not swap
                    // them for `matchDay`: that was the source of Now vs next
                    // hour disagreeing when the phone and forecast differ in TZ.
                    highTemp: temperatures.highTemp,
                    lowTemp: temperatures.lowTemp,
                    sunrise: matchDay?.sunrise || rowData.sunrise,
                    sunset: matchDay?.sunset || rowData.sunset,
                } as unknown as SourcedWeatherMetrics,
                time: new Date(h.time).getTime(),
            };
        }),
    ];
}

export interface HeroDisplayValues {
    airTemp: string;
    highTemp: string;
    lowTemp: string;
    windSpeed: number | string;
    waveHeight: string;
    vis: string;
    gusts: number | string;
    precip: string | number;
    precipUnit: string;
    pressure: number | string;
    cloudCover: number | string;
    uv: number | string;
    sunrise: string;
    sunset: string;
    currentSpeed: string;
    humidity: number | string;
    feelsLike: string;
    dewPoint: string;
    waterTemperature: string;
    currentDirection: string;
    secondarySwellHeight: number | string;
    secondarySwellPeriod: number | string;
}

/**
 * Compute all display values from raw weather data + units.
 */
export function computeDisplayValues(
    displayData: SourcedWeatherMetrics,
    units: UnitPreferences,
    index: number,
    isLandlocked?: boolean,
): HeroDisplayValues {
    const hasWind = displayData.windSpeed !== null && displayData.windSpeed !== undefined;
    const hasWave = displayData.waveHeight !== null && displayData.waveHeight !== undefined;
    const rawGust = displayData.windGust || (displayData.windSpeed || 0) * 1.3;

    return {
        airTemp: displayData.airTemperature !== null ? convertTemp(displayData.airTemperature, units.temp) : '--',
        highTemp: displayData.highTemp !== undefined ? convertTemp(displayData.highTemp, units.temp) : '--',
        lowTemp: displayData.lowTemp !== undefined ? convertTemp(displayData.lowTemp, units.temp) : '--',
        windSpeed: hasWind ? Math.round(convertSpeed(displayData.windSpeed!, units.speed)!) : '--',
        waveHeight: isLandlocked ? '0' : hasWave ? String(convertLength(displayData.waveHeight, units.length)) : '--',
        vis: displayData.visibility ? convertDistance(displayData.visibility, units.visibility || 'nm') : '--',
        gusts: hasWind ? Math.round(convertSpeed(rawGust!, units.speed)!) : '--',
        precip: (() => {
            if (index === 0) {
                return convertPrecip(displayData.precipitation, units.temp) ?? '0';
            }
            const chance = displayData.precipChance;
            return chance !== undefined && chance !== null ? Math.round(chance) : 0;
        })(),
        precipUnit: index === 0 ? (units.temp === 'F' ? 'in' : 'mm') : '%',
        pressure: displayData.pressure ? Math.round(displayData.pressure) : '--',
        cloudCover:
            displayData.cloudCover !== null && displayData.cloudCover !== undefined
                ? Math.round(displayData.cloudCover)
                : '--',
        uv: displayData.uvIndex !== undefined && displayData.uvIndex !== null ? Math.round(displayData.uvIndex) : '--',
        sunrise: displayData.sunrise || '--:--',
        sunset: displayData.sunset || '--:--',
        currentSpeed:
            displayData.currentSpeed !== undefined && displayData.currentSpeed !== null
                ? Number(displayData.currentSpeed).toFixed(1)
                : '--',
        humidity:
            displayData.humidity !== undefined && displayData.humidity !== null
                ? Math.round(displayData.humidity)
                : '--',
        feelsLike:
            displayData.feelsLike !== undefined && displayData.feelsLike !== null
                ? convertTemp(displayData.feelsLike, units.temp)
                : '--',
        dewPoint:
            displayData.dewPoint !== undefined && displayData.dewPoint !== null
                ? convertTemp(displayData.dewPoint, units.temp)
                : '--',
        waterTemperature:
            displayData.waterTemperature !== undefined && displayData.waterTemperature !== null
                ? convertTemp(displayData.waterTemperature, units.temp)
                : '--',
        currentDirection: (() => {
            const val = displayData.currentDirection;
            if (typeof val === 'number') return degreesToCardinal(val);
            if (typeof val === 'string') return val.replace(/[\d.°]+/g, '').trim() || val;
            return '--';
        })(),
        secondarySwellHeight: (() => {
            const v = displayData.secondarySwellHeight;
            return v !== undefined && v !== null && !isNaN(v) ? v : '--';
        })(),
        secondarySwellPeriod: (() => {
            const v = displayData.secondarySwellPeriod;
            return v !== undefined && v !== null && !isNaN(v) ? Math.round(v) : '--';
        })(),
    };
}

/**
 * Trend direction type used by the hero slide.
 */
export type TrendDirection = 'rising' | 'falling' | 'steady';

/**
 * Compute weather trends by comparing current data to adjacent hourly data.
 */
export function computeTrends(
    effectiveData: SourcedWeatherMetrics,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fullHourly: any[] | undefined,
    visualTime: number | undefined,
): Record<string, TrendDirection> | undefined {
    if (!fullHourly || fullHourly.length < 2) return undefined;

    const now = visualTime || Date.now();
    let currentIndex = fullHourly.findIndex((h: { time: string }) => {
        const t = new Date(h.time).getTime();
        return now >= t && now < t + 3600000;
    });

    if (currentIndex === -1) {
        let minDiff = Infinity;
        let bestIdx = -1;
        fullHourly.forEach((h: { time: string }, i: number) => {
            const t = new Date(h.time).getTime();
            const diff = Math.abs(t - now);
            if (diff < minDiff) {
                minDiff = diff;
                bestIdx = i;
            }
        });
        if (minDiff < 7200000 && bestIdx !== -1) {
            currentIndex = bestIdx;
        } else {
            return undefined;
        }
    }

    const current = effectiveData;
    let baseItem = fullHourly[currentIndex - 1];
    let isForecast = false;

    if (!baseItem) {
        const nextItem = fullHourly[currentIndex + 1];
        if (nextItem) {
            baseItem = nextItem;
            isForecast = true;
        }
    }
    if (!baseItem) return undefined;

    const prev = baseItem;

    const getTrend = (curr?: number | null, old?: number | null, threshold = 0): TrendDirection => {
        if (curr === undefined || curr === null || old === undefined || old === null) return 'steady';
        let diff = curr - old;
        if (isForecast) diff = old - curr;
        if (diff > threshold) return 'rising';
        if (diff < -threshold) return 'falling';
        return 'steady';
    };

    return {
        wind: getTrend(current.windSpeed, prev.windSpeed, 1),
        gust: getTrend(current.windGust, prev.windGust, 2),
        wave: getTrend(current.waveHeight, prev.waveHeight, 0.1),
        pressure: getTrend(current.pressure, prev.pressure, 0.5),
        waterTemp: getTrend(current.waterTemperature, prev.waterTemperature, 0.2),
        currentSpeed: getTrend(current.currentSpeed, prev.currentSpeed, 0.2),
        humidity: getTrend(current.humidity, prev.humidity, 3),
        visibility: getTrend(current.visibility, prev.visibility, 1),
        precip: getTrend(current.precipitation, prev.precipitation, 0.1),
        feels: getTrend(current.feelsLike, prev.feelsLike, 1),
        clouds: getTrend(current.cloudCover, prev.cloudCover, 5),
    };
}
