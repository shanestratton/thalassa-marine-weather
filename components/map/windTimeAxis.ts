import type { WindGrid } from '../../services/weather/windGridEncoding';

type WindTimeGrid = Pick<WindGrid, 'totalHours' | 'u' | 'v' | 'speed' | 'hourOffsets' | 'stepHours'>;

/**
 * A timeline is usable only when every advertised frame has vector and scalar
 * data. This keeps the scrubber from presenting frames the renderer cannot
 * display.
 */
export function usableWindFrameCount(grid: WindTimeGrid | null | undefined): number {
    if (!grid || !Number.isInteger(grid.totalHours) || grid.totalHours <= 0) return 0;

    const count = grid.totalHours;
    return grid.u.length >= count && grid.v.length >= count && grid.speed.length >= count ? count : 0;
}

export function isUsableWindGrid(grid: WindTimeGrid | null | undefined): boolean {
    return usableWindFrameCount(grid) > 0;
}

function validTimeAxis(candidate: number[] | undefined, count: number): number[] | null {
    if (!candidate || candidate.length !== count) return null;

    for (let index = 0; index < candidate.length; index += 1) {
        const hour = candidate[index];
        if (!Number.isFinite(hour) || hour < 0 || (index > 0 && hour <= candidate[index - 1])) return null;
    }

    return candidate.slice();
}

/**
 * Resolve step index → forecast-hour offset for the active grid.
 *
 * Producers that publish `hourOffsets` or `stepHours` own the time axis. Plain
 * Open-Meteo grids are hourly and publish neither, so their safe fallback is
 * [0, 1, …, totalHours - 1] — never the non-uniform GFS schedule.
 */
export function windForecastHoursForGrid(grid: WindTimeGrid | null | undefined): number[] {
    const count = usableWindFrameCount(grid);
    if (!grid || count === 0) return [];

    return (
        validTimeAxis(grid.hourOffsets, count) ??
        validTimeAxis(grid.stepHours, count) ??
        Array.from({ length: count }, (_, index) => index)
    );
}

/** Resolve a fractional scrubber frame onto the grid's real forecast-hour axis. */
export function windForecastHourAtFrame(forecastHours: number[], frameIndex: number): number | null {
    if (forecastHours.length === 0 || !Number.isFinite(frameIndex)) return null;

    const clamped = Math.max(0, Math.min(frameIndex, forecastHours.length - 1));
    const lowerIndex = Math.floor(clamped);
    const upperIndex = Math.ceil(clamped);
    const lowerHour = forecastHours[lowerIndex];
    const upperHour = forecastHours[upperIndex];
    if (!Number.isFinite(lowerHour) || !Number.isFinite(upperHour)) return null;
    if (lowerIndex === upperIndex) return lowerHour;

    return lowerHour + (upperHour - lowerHour) * (clamped - lowerIndex);
}

/** Hours represented by `frameIndex`, relative to the frame labelled Now. */
export function windHoursFromNow(forecastHours: number[], frameIndex: number, nowFrameIndex: number): number | null {
    const frameHour = windForecastHourAtFrame(forecastHours, frameIndex);
    const nowHour = windForecastHourAtFrame(forecastHours, nowFrameIndex);
    return frameHour === null || nowHour === null ? null : frameHour - nowHour;
}
