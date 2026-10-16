import type { ImportedGribFile, ImportedGribGrid } from './gribImportTypes';
import { continuousLongitudeInGrid } from './windLongitude';
import type { WindGrid } from './windGridEncoding';

function sample(
    grid: ImportedGribGrid,
    frames: Float32Array[],
    hours: number[],
    refTime: string,
    lat: number,
    lon: number,
    validAt: number,
): number | null {
    const hour = (validAt - Date.parse(refTime)) / 3600000;
    const x =
        ((continuousLongitudeInGrid(lon, grid.west, grid.east) - grid.west) / (grid.east - grid.west)) *
        (grid.width - 1);
    const y = ((lat - grid.south) / (grid.north - grid.south)) * (grid.height - 1);
    if (
        ![hour, x, y].every(Number.isFinite) ||
        hour < hours[0] ||
        hour > hours.at(-1)! ||
        x < 0 ||
        x > grid.width - 1 ||
        y < 0 ||
        y > grid.height - 1
    )
        return null;
    let a = 0;
    while (a + 1 < hours.length && hours[a + 1] <= hour) a++;
    const b = Math.min(a + 1, hours.length - 1),
        t = a === b ? 0 : (hour - hours[a]) / (hours[b] - hours[a]);
    const x0 = Math.floor(x),
        x1 = Math.min(x0 + 1, grid.width - 1),
        y0 = Math.floor(y),
        y1 = Math.min(y0 + 1, grid.height - 1),
        fx = x - x0,
        fy = y - y0;
    const cell = (frame: Float32Array) => {
        if (!frame || frame.length !== grid.width * grid.height) return NaN;
        const values = [
            [frame[y0 * grid.width + x0], (1 - fx) * (1 - fy)],
            [frame[y0 * grid.width + x1], fx * (1 - fy)],
            [frame[y1 * grid.width + x0], (1 - fx) * fy],
            [frame[y1 * grid.width + x1], fx * fy],
        ];
        let total = 0;
        for (const [value, weight] of values) {
            if (weight === 0) continue;
            if (!Number.isFinite(value)) return NaN;
            total += value * weight;
        }
        return total;
    };
    const av = cell(frames[a]),
        bv = t === 0 ? av : cell(frames[b]),
        result = av + (bv - av) * t;
    return Number.isFinite(result) ? result : null;
}
/** Shared strict sampler for a covered downloaded grid; absent clocks/cells stay unknown. */
export function sampleWindGrid(
    grid: WindGrid,
    lat: number,
    lon: number,
    validAt: number,
): { speedKts: number; directionFromDeg: number } | null {
    if (!grid.refTime || !Number.isInteger(grid.totalHours) || grid.totalHours < 1) return null;
    const hours = grid.stepHours ?? grid.hourOffsets ?? Array.from({ length: grid.totalHours }, (_, i) => i);
    if (
        hours.length !== grid.totalHours ||
        !hours.every((hour, i) => Number.isFinite(hour) && (i === 0 || hour > hours[i - 1]))
    )
        return null;
    if (grid.validUntil && (!Number.isFinite(Date.parse(grid.validUntil)) || validAt > Date.parse(grid.validUntil)))
        return null;
    const u = sample(grid, grid.u, hours, grid.refTime, lat, lon, validAt),
        v = sample(grid, grid.v, hours, grid.refTime, lat, lon, validAt);
    return u === null || v === null
        ? null
        : {
              speedKts: Math.hypot(u, v) * 1.943844,
              directionFromDeg: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360,
          };
}
/** Strict space/time coverage of actual imported cells. No endpoint clamping, source substitution or network. */
export function sampleImportedGrib(
    file: ImportedGribFile,
    lat: number,
    lon: number,
    validAt: number,
): { wind: { speedKts: number; directionFromDeg: number } | null; pressureHpa: number | null } {
    const w = file.wind,
        p = file.pressure;
    return {
        wind: w ? sampleWindGrid(w, lat, lon, validAt) : null,
        pressureHpa: p ? sample(p, p.frames, p.stepHours, p.refTime, lat, lon, validAt) : null,
    };
}
