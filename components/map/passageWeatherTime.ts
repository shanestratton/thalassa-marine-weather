import type { PassageLookAhead } from '../../stores/passageHudStore';
import { passageDepartureTime, passageForecastOffsetMs, passageForecastTime } from '../../services/passageDeparture';
import { windFrameForForecastHour } from './windTimeAxis';
import { rainFollowIndex, rainFrameForTime, type TimedRainFrame } from './rainTimeAxis';

const HOUR_MS = 3_600_000;
type PassageClock = Pick<PassageLookAhead, 'departureMs' | 'aheadMs'>;

/** The grid's own clock maps an absolute departure + elapsed time to a frame. */
export function passageWindTimeSelection(
    forecastHours: number[],
    refTime: string | null,
    look: PassageClock,
    now: number,
): {
    target: ReturnType<typeof windFrameForForecastHour>;
    coverageHours: number | null;
    unsynced: boolean;
} {
    const referenceMs = refTime ? Date.parse(refTime) : NaN;
    if (!Number.isFinite(referenceMs) || forecastHours.length === 0)
        return { target: null, coverageHours: null, unsynced: true };
    const departureHour = (passageDepartureTime(look, now) - referenceMs) / HOUR_MS;
    const forecastHour = (passageForecastTime(look, now) - referenceMs) / HOUR_MS;
    const target = windFrameForForecastHour(forecastHours, forecastHour);
    return {
        target,
        coverageHours: Math.max(0, forecastHours[forecastHours.length - 1] - departureHour),
        unsynced: !target || target.beyond,
    };
}

/** Rain is selected by absolute valid time; an expired fixed date never becomes Now. */
export function passageRainTimeSelection(
    frames: readonly TimedRainFrame[],
    nowIndex: number,
    look: PassageClock,
    now: number,
): { target: number; coverageHours: number | null; unsynced: boolean } {
    const observed = Math.max(0, Math.min(Number.isFinite(nowIndex) ? Math.trunc(nowIndex) : 0, frames.length - 1));
    const times = frames
        .map((frame) => frame.timeMs)
        .filter((at): at is number => typeof at === 'number' && Number.isFinite(at));
    if (times.length === 0) return { target: observed, coverageHours: null, unsynced: true };
    const first = Math.min(...times);
    const last = Math.max(...times);
    const coverageHours = Math.max(0, (last - passageDepartureTime(look, now)) / HOUR_MS);
    const targetMs = passageForecastTime(look, now);
    const hit = rainFrameForTime(frames, targetMs);
    const unavailable = !hit || hit.beyond || targetMs < first;
    // Keep the legacy rolling-Now rule: the first ten minutes show observed
    // radar. A chosen absolute date instead uses its nearest actual frame,
    // even after that date has passed while the user is viewing the chart.
    const target =
        look.departureMs == null
            ? rainFollowIndex(frames, nowIndex, now, passageForecastOffsetMs(look, now))
            : unavailable
              ? observed
              : hit.index;
    return { target, coverageHours, unsynced: unavailable || (look.departureMs == null && last <= now) };
}
