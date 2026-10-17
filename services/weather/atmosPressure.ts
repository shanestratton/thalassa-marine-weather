import type { AtmosView } from './api/atmosSession';
import { generateSelectedPressureSymbols } from './isobars';

/** Pa→hPa only, with original missing masks and an explicit repeated dateline column. */
export function atmosPressureSymbols(view: AtmosView) {
    const check = () => {
        if (!view.isCurrent()) throw new DOMException('Pressure source retired', 'AbortError');
    };
    check();
    const field = view.fields.pressure;
    if (
        !field ||
        field.width !== 360 ||
        field.height !== 181 ||
        field.west !== -180 ||
        field.south !== -90 ||
        field.dx !== 1 ||
        field.dy !== 1 ||
        !field.wrapLongitude
    )
        throw new Error('Pressure source grid invalid');
    const lats = Array.from({ length: 171 }, (_, index) => index - 85);
    const lons = Array.from({ length: 361 }, (_, index) => index - 180);
    const values = lats.map((lat) => {
        check();
        const row = new Float32Array(361);
        for (let col = 0; col <= 360; col++) {
            const original = (lat + 90) * 360 + (col % 360);
            row[col] = field.validMask[original] === 1 ? field.values[original] / 100 : NaN;
        }
        return row;
    });
    return generateSelectedPressureSymbols({ values, lats, lons, rows: lats.length, cols: lons.length }, check);
}
