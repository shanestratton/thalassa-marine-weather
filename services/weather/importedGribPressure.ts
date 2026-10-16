import type { ImportedGribFile } from './gribImportTypes';
import type { PressureGrid } from './isobars';
/** Keep actual pressure values/times. Missing pressure/wind cells never become filled values. */
export function importedGribPressure(file: ImportedGribFile): PressureGrid | null {
    const p = file.pressure;
    if (!p) return null;
    const missing = Array.from({ length: p.height }, () => Array(p.width).fill(NaN) as number[]);
    return {
        allHourlyPressure: p.frames.map((frame) =>
            Array.from({ length: p.height }, (_, row) => frame.subarray(row * p.width, (row + 1) * p.width)),
        ),
        allHourlyWindSpeed: p.frames.map(() => missing),
        allHourlyWindDir: p.frames.map(() => missing),
        lats: p.lats,
        lons: p.lons,
        rows: p.height,
        cols: p.width,
        totalHours: p.frames.length,
        refTime: p.refTime,
        keyframeFhrs: p.stepHours,
        stepHours: p.stepHours,
        subFrameStepHours: 1,
        source: 'imported-grib',
    };
}
