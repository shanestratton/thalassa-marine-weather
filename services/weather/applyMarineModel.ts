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

/** Recheck original clocks at the display boundary, including startup/history
 * and delayed enrichment. Persisting a report never renews a marine receipt. */
export function marineForecastForDisplay(input: MarineWeatherReport, now = Date.now()): MarineWeatherReport {
    const missing = display(empty(), false);
    const { waterTemperature: _water, currentSpeed: _speed, currentDirection: _direction, ...waves } = missing;
    const motion = { waterTemperature: null, currentSpeed: null, currentDirection: undefined };
    const meta = input.current.marine;
    const hasValues = (slot: typeof input.current | (typeof input.hourly)[number] | (typeof input.forecast)[number]) =>
        Object.keys(missing).some((key) => (slot as unknown as Record<string, unknown>)[key] != null) ||
        Object.values(slot.marine?.parts ?? {}).some(Boolean);
    const freshEnvelope =
        meta?.waveModel === 'meteofrance_wave' &&
        meta.motionModel === 'best_match' &&
        typeof meta.fetchedAtMs === 'number' &&
        Number.isFinite(meta.fetchedAtMs) &&
        meta.fetchedAtMs <= now + 5000 &&
        now - meta.fetchedAtMs <= 3_600_000 &&
        !!input.coordinates &&
        !!meta.requested &&
        Math.round(input.coordinates.lat * 10000) / 10000 === meta.requested.latitude &&
        Math.round(input.coordinates.lon * 10000) / 10000 === meta.requested.longitude;
    if (!freshEnvelope) {
        if (![input.current, ...input.hourly, ...input.forecast].some(hasValues)) return input;
        return applyMarineModel(input, null, meta?.status === 'enclosed');
    }
    const freshCurrent = (time: number | null) =>
        time !== null && Number.isFinite(time) && time <= now + 300_000 && now - time <= 1_800_000;
    const wavesOk = freshCurrent(meta.waveValidAtMs),
        motionOk = freshCurrent(meta.motionValidAtMs);
    const clearWave =
        !wavesOk &&
        (Object.keys(waves).some((key) => (input.current as unknown as Record<string, unknown>)[key] != null) ||
            Object.values(meta.parts).some(Boolean));
    const clearMotion =
        !motionOk &&
        (input.current.waterTemperature != null ||
            input.current.currentSpeed != null ||
            input.current.currentDirection != null);
    if (!clearWave && !clearMotion) return input;
    const report = structuredClone(input);
    report.current = {
        ...report.current,
        ...(clearWave ? waves : {}),
        ...(clearMotion ? motion : {}),
        marine: {
            ...meta,
            parts: clearWave ? emptyParts() : meta.parts,
            waveValidAtMs: clearWave ? null : meta.waveValidAtMs,
            motionValidAtMs: clearMotion ? null : meta.motionValidAtMs,
            status: meta.status === 'enclosed' ? 'enclosed' : clearWave ? 'unavailable' : meta.status,
            reason:
                meta.status === 'enclosed'
                    ? meta.reason
                    : clearWave
                      ? 'The original current sea sample has expired.'
                      : meta.reason,
        },
    };
    for (const key of Object.keys(missing) as (keyof typeof missing)[]) {
        const value = missing[key];
        const stale = key in motion ? clearMotion : clearWave;
        const prior = report.current.sources?.[key];
        if (stale && prior) report.current.sources![key] = { ...prior, value };
    }
    return report;
}

/** Forecast alerts/advice follow the final merged numbers, after all source and shelter decisions. */
export function finalizeMarineForecast(input: MarineWeatherReport, now = Date.now()): MarineWeatherReport {
    const report = marineForecastForDisplay(input, now);
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
