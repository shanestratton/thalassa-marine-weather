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
        gusts:
            cardData.windSpeed !== null
                ? Math.round(convertSpeed(cardData.windGust ?? cardData.windSpeed * 1.3, units.speed)!)
                : '--',
        precip: (() => {
            if (!isHourly && index === 0) {
                return convertPrecip(cardData.precipitation, units.length) ?? '0';
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
    type: 'current' | 'hourly';
    data: SourcedWeatherMetrics;
    time: number | undefined;
}

/**
 * Build the slides array from base data + hourly forecasts.
 */
export function buildSlides(
    data: SourcedWeatherMetrics,
    index: number,
    hourlyToRender: HourlyForecast[],
    forecast: Array<{
        isoDate?: string;
        date?: string;
        precipChance?: number;
        highTemp?: number;
        lowTemp?: number;
        sunrise?: string;
        sunset?: string;
    }>,
): SlideData[] {
    if (!data) return [];
    return [
        ...(index === 0 ? [{ type: 'current' as const, data, time: undefined as number | undefined }] : []),
        ...(hourlyToRender || []).map((h) => {
            const hDate = new Date(h.time);
            const hDayStr = hDate.toLocaleDateString('en-CA');
            const matchDay = forecast.find((d) => d.isoDate === hDayStr || d.date === hDayStr);

            return {
                type: 'hourly' as const,
                data: {
                    ...h,
                    airTemperature: h.temperature,
                    feelsLike: h.feelsLike,
                    windSpeed: h.windSpeed,
                    waveHeight: h.waveHeight,
                    precipChance: h.precipChance ?? matchDay?.precipChance,
                    highTemp: matchDay?.highTemp,
                    lowTemp: matchDay?.lowTemp,
                    sunrise: matchDay?.sunrise || data.sunrise,
                    sunset: matchDay?.sunset || data.sunset,
                } as unknown as SourcedWeatherMetrics,
                time: hDate.getTime(),
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
                return convertPrecip(displayData.precipitation, units.length) ?? '0';
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
