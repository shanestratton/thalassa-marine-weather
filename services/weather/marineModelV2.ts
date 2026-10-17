/** Pure admitted model samples. Heights cross the report boundary in feet exactly once. */
import {
    readMarineEnvelopeV2,
    type MarinePointV2,
    type MarineSourceV2,
} from '../../supabase/functions/_shared/marine-v2';
import { marineGridSnapKm } from '../../utils/marineGrid';
import { calculateDistance } from '../../utils/navigationCalculations';

export const MARINE_CURRENT_MAX_AGE_MS = 30 * 60_000;
export interface MarineReportValuesV2 {
    waveHeight: number | null;
    wavePeriod: number | null;
    waveDirection: number | null;
    windWaveHeight: number | null;
    windWavePeriod: number | null;
    windWaveDirection: number | null;
    swellHeight: number | null;
    swellPeriod: number | null;
    swellDirection: number | null;
    secondarySwellHeight: number | null;
    secondarySwellPeriod: number | null;
    secondarySwellDirection: number | null;
    waterTemperature: number | null;
    /** m/s; wave directions remain FROM, current direction remains the provider's setting direction. */
    currentSpeed: number | null;
    currentDirection: number | null;
}
export interface MarineCellV2 extends MarinePointV2 {
    snappedKm: number;
    local: boolean;
}
export interface MarineModelReadingV2 {
    via: 'pi' | 'supabase';
    fetchedAtMs: number;
    waveModel: 'meteofrance_wave';
    motionModel: 'best_match';
    waveCell: MarineCellV2 | null;
    motionCell: MarineCellV2 | null;
    /** Original forecast valid instants, never this device's receipt time. */
    waveCurrentAtMs: number | null;
    motionCurrentAtMs: number | null;
    current: MarineReportValuesV2;
    hourly: ({ timeMs: number } & MarineReportValuesV2)[];
}
const known = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const feet = (v: unknown) => {
    const n = known(v);
    return n === null ? null : Math.round(n * 3.28084 * 100) / 100;
};
function values(w: Record<string, unknown> | null, m: Record<string, unknown> | null): MarineReportValuesV2 {
    return {
        waveHeight: feet(w?.wave_height),
        wavePeriod: known(w?.wave_period),
        waveDirection: known(w?.wave_direction),
        windWaveHeight: feet(w?.wind_wave_height),
        windWavePeriod: known(w?.wind_wave_period),
        windWaveDirection: known(w?.wind_wave_direction),
        swellHeight: feet(w?.swell_wave_height),
        swellPeriod: known(w?.swell_wave_period),
        swellDirection: known(w?.swell_wave_direction),
        secondarySwellHeight: feet(w?.secondary_swell_wave_height),
        secondarySwellPeriod: known(w?.secondary_swell_wave_period),
        secondarySwellDirection: known(w?.secondary_swell_wave_direction),
        waterTemperature: known(m?.sea_surface_temperature),
        currentSpeed:
            known(m?.ocean_current_velocity) === null
                ? null
                : Math.round(((m!.ocean_current_velocity as number) / 3.6) * 1000) / 1000,
        currentDirection: known(m?.ocean_current_direction),
    };
}
function cell(source: MarineSourceV2 | null, point: MarinePointV2): MarineCellV2 | null {
    if (!source) return null;
    const snappedKm = calculateDistance(point.latitude, point.longitude, source.latitude, source.longitude) * 1.852;
    return {
        latitude: source.latitude,
        longitude: source.longitude,
        snappedKm,
        local: snappedKm <= marineGridSnapKm(point.latitude, 1.15),
    };
}
const currentFresh = (source: MarineSourceV2 | null, now: number) =>
    source &&
    now - source.current.time * 1000 >= -300000 &&
    now - source.current.time * 1000 <= MARINE_CURRENT_MAX_AGE_MS;
function hour(source: MarineSourceV2 | null, time: number): Record<string, unknown> | null {
    if (!source) return null;
    const index = source.hourly.time.indexOf(time);
    if (index < 0) return null;
    return Object.fromEntries(
        Object.entries(source.hourly)
            .filter(([key]) => key !== 'time')
            .map(([key, list]) => [key, list?.[index] ?? null]),
    );
}
/** Independently refuse distant cells and stale current clocks; never borrow the other model's fields. */
export function mapMarineModelV2(
    raw: unknown,
    point: MarinePointV2,
    now: number,
    via: 'pi' | 'supabase',
): MarineModelReadingV2 | null {
    const envelope = readMarineEnvelopeV2(raw, point, now);
    if (!envelope) return null;
    const waveCell = cell(envelope.waves, point),
        motionCell = cell(envelope.motion, point);
    const waves = waveCell?.local ? envelope.waves : null,
        motion = motionCell?.local ? envelope.motion : null;
    if (!waves && !motion) return null;
    const waveNow = currentFresh(waves, now) ? waves : null,
        motionNow = currentFresh(motion, now) ? motion : null;
    const times = [...new Set([...(waves?.hourly.time ?? []), ...(motion?.hourly.time ?? [])])].sort((a, b) => a - b);
    return {
        via,
        fetchedAtMs: envelope.fetched_at_ms,
        waveModel: envelope.wave_model,
        motionModel: envelope.motion_model,
        waveCell,
        motionCell,
        waveCurrentAtMs: waveNow ? waveNow.current.time * 1000 : null,
        motionCurrentAtMs: motionNow ? motionNow.current.time * 1000 : null,
        current: values(waveNow?.current ?? null, motionNow?.current ?? null),
        hourly: times.map((time) => ({ timeMs: time * 1000, ...values(hour(waves, time), hour(motion, time)) })),
    };
}
