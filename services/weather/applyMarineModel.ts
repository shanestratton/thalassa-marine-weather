/** One final marine merge: unknown overwrites legacy placeholders at every horizon. */
import type { MarineWeatherReport, MarineModelSnapshot } from '../../types';
import type { MarineModelReadingV2, MarineReportValuesV2, MarineSeaPartsV2 } from './marineModelV2';
import { degreesToCardinal } from '../../utils/format';
import { generateSafetyAlerts, generateTacticalAdvice } from '../../utils/advisory';

const emptyParts = (): MarineSeaPartsV2 => ({ total: null, windSea: null, swell: null, secondarySwell: null });
const empty = (): MarineReportValuesV2 => ({
    waveHeight: null,
    wavePeriod: null,
    waveDirection: null,
    windWaveHeight: null,
    windWavePeriod: null,
    windWaveDirection: null,
    swellHeight: null,
    swellPeriod: null,
    swellDirection: null,
    secondarySwellHeight: null,
    secondarySwellPeriod: null,
    secondarySwellDirection: null,
    waterTemperature: null,
    currentSpeed: null,
    currentDirection: null,
});
function display(value: MarineReportValuesV2, blocked: boolean) {
    return {
        waveHeight: blocked ? null : value.waveHeight,
        // Legacy report names carry TOTAL period/direction, as its existing Glass rows do.
        wavePeriod: blocked ? null : value.wavePeriod,
        swellPeriod: blocked ? null : value.wavePeriod,
        swellDirection: !blocked && value.waveDirection !== null ? degreesToCardinal(value.waveDirection) : undefined,
        windWaveHeight: blocked ? null : value.windWaveHeight,
        windWavePeriod: blocked ? null : value.windWavePeriod,
        windWaveDirection: blocked ? null : value.windWaveDirection,
        secondarySwellHeight: blocked ? null : value.secondarySwellHeight,
        secondarySwellPeriod: blocked ? null : value.secondarySwellPeriod,
        secondarySwellDirection: blocked ? null : value.secondarySwellDirection,
        waterTemperature: value.waterTemperature,
        currentSpeed: blocked ? null : value.currentSpeed,
        currentDirection: !blocked ? (value.currentDirection ?? undefined) : undefined,
    };
}
function localDay(time: number, report: MarineWeatherReport): string | null {
    try {
        if (report.timeZone)
            return new Intl.DateTimeFormat('en-CA', {
                timeZone: report.timeZone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
            }).format(time);
        return report.utcOffset === 0 ? new Date(time).toISOString().slice(0, 10) : null;
    } catch {
        return null;
    }
}
export function applyMarineModel(
    input: MarineWeatherReport,
    source: MarineModelReadingV2 | null,
    enclosed = false,
): MarineWeatherReport {
    const report = structuredClone(input);
    const blocked = enclosed || report.locationType === 'inshore' || report.locationType === 'inland';
    const reason = blocked
        ? 'Ocean models do not resolve berths or enclosed water.'
        : source?.waveCell?.local === false
          ? 'The answering wave cell is too far from this position.'
          : !source?.currentParts.total
            ? 'Local sea forecast unavailable.'
            : null;
    const snapshot = (
        parts: MarineSeaPartsV2,
        waveAt: number | null,
        motionAt: number | null,
    ): MarineModelSnapshot => ({
        parts: blocked ? emptyParts() : structuredClone(parts),
        status: blocked ? 'enclosed' : parts.total ? 'available' : 'unavailable',
        reason: blocked ? reason : parts.total ? null : (reason ?? 'Local sea forecast unavailable.'),
        waveModel: 'meteofrance_wave',
        motionModel: 'best_match',
        fetchedAtMs: source?.fetchedAtMs ?? null,
        waveValidAtMs: blocked ? null : waveAt,
        // SST retains its own valid clock even where coarse tidal currents are refused.
        motionValidAtMs: motionAt,
        requested: source ? { ...source.requested } : null,
    });
    const currentValues = source?.current ?? empty();
    const displayed = display(currentValues, blocked);
    report.current = {
        ...report.current,
        ...displayed,
        marine: snapshot(
            source?.currentParts ?? emptyParts(),
            source?.waveCurrentAtMs ?? null,
            source?.motionCurrentAtMs ?? null,
        ),
    };
    const sources = { ...report.current.sources };
    for (const key of Object.keys(displayed) as (keyof typeof displayed)[]) {
        sources[key] = {
            value: displayed[key],
            source: 'marine_model',
            sourceColor: 'amber',
            sourceName:
                key === 'waterTemperature' || key === 'currentSpeed' || key === 'currentDirection'
                    ? 'Open-Meteo marine best match'
                    : 'Météo-France waves via Open-Meteo',
        };
    }
    report.current.sources = sources;
    const hours = new Map(source?.hourly.map((hour) => [hour.timeMs, hour]) ?? []);
    report.hourly = report.hourly.map((hour) => {
        const match = hours.get(new Date(hour.time).getTime());
        return {
            ...hour,
            ...display(match ?? empty(), blocked),
            marine: snapshot(
                match?.parts ?? emptyParts(),
                match?.waveValidAtMs ?? null,
                match?.motionValidAtMs ?? null,
            ),
        };
    });
    report.forecast = report.forecast.map((day) => {
        const key = day.isoDate ?? day.date;
        const matches = (source?.hourly ?? []).filter(
            (hour) => localDay(hour.timeMs, report) === key && hour.parts.total !== null,
        );
        const peak = matches.reduce<(typeof matches)[number] | null>(
            (best, hour) => (!best || hour.parts.total!.hM > best.parts.total!.hM ? hour : best),
            null,
        );
        return {
            ...day,
            ...display(peak ?? empty(), blocked),
            // A daily peak sea is not a daily current or water-temperature observation.
            currentSpeed: undefined,
            currentDirection: undefined,
            waterTemperature: undefined,
            marine: snapshot(peak?.parts ?? emptyParts(), peak?.waveValidAtMs ?? null, null),
        };
    });
    return report;
}

/** Forecast alerts/advice follow the final merged numbers, after all source and shelter decisions. */
export function finalizeMarineForecast(report: MarineWeatherReport): MarineWeatherReport {
    report.alerts = generateSafetyAlerts(report.current, report.forecast[0]?.highTemp, report.forecast);
    report.boatingAdvice = generateTacticalAdvice(
        report.current,
        report.isLandlocked === true,
        report.locationName,
        undefined,
        report.tides,
        report.current.sunset,
    );
    return report;
}
