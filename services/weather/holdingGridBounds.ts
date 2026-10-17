/** Whole enclosing cells and temporal brackets, never a few samples. Linear
 * scalar / bilinear vector interpolation cannot exceed these node maxima.
 * This bounds the forecast representation; it proves no real local shelter. */
import type { WindGrid } from './windGridEncoding';
import type { HoldingBounds } from '../enc/holdingFootprint';
export function holdingGridMaximum(
    grid: WindGrid,
    bounds: HoldingBounds,
    fromMs: number,
    untilMs: number,
    kind: 'vector' | 'gust',
    check: () => void,
    plane: (step: number) => { u?: Float32Array; v?: Float32Array; gust?: Float32Array; mask?: Uint8Array } = (
        step,
    ) => ({ u: grid.u[step], v: grid.v[step], gust: grid.gust?.[step], mask: grid.landMask }),
    requireSeaMask = false,
): number | null {
    const { width: w, height: h, lats, lons } = grid,
        offsets = grid.stepHours ?? grid.hourOffsets;
    const ref = Date.parse(grid.refTime ?? '');
    if (
        !Number.isFinite(ref) ||
        !Number.isFinite(fromMs) ||
        !Number.isFinite(untilMs) ||
        untilMs <= fromMs ||
        !Number.isInteger(w) ||
        !Number.isInteger(h) ||
        w < 2 ||
        h < 2 ||
        w > 4096 ||
        h > 4096 ||
        lats.length !== h ||
        lons.length !== w ||
        !offsets?.length ||
        offsets.length > 673 ||
        !offsets.every((t, i) => Number.isFinite(t) && (!i || (t > offsets[i - 1] && t - offsets[i - 1] <= 3))) ||
        fromMs < ref + offsets[0] * 3600000 ||
        untilMs > ref + offsets.at(-1)! * 3600000
    )
        return null;
    if (
        grid.validUntil !== undefined &&
        (!Number.isFinite(Date.parse(grid.validUntil)) || untilMs > Date.parse(grid.validUntil))
    )
        return null;
    const axis = (coords: number[], lo: number, hi: number): [number, number] | null => {
        const ascending = coords.at(-1)! > coords[0];
        if (!coords.every((v, i) => Number.isFinite(v) && (!i || (ascending ? v > coords[i - 1] : v < coords[i - 1]))))
            return null;
        if (lo < Math.min(coords[0], coords.at(-1)!) || hi > Math.max(coords[0], coords.at(-1)!)) return null;
        let first = coords.length,
            last = -1;
        for (let i = 1; i < coords.length; i++) {
            if (Math.max(coords[i - 1], coords[i]) >= lo && Math.min(coords[i - 1], coords[i]) <= hi) {
                first = Math.min(first, i - 1);
                last = i;
            }
        }
        return last >= 0 ? [first, last] : null;
    };
    const x = axis(lons, bounds[0], bounds[2]),
        y = axis(lats, bounds[1], bounds[3]);
    if (!x || !y) return null;
    let start = -1,
        end = -1;
    for (let i = 0; i < offsets.length; i++) {
        const t = ref + offsets[i] * 3600000;
        if (t <= fromMs) start = i;
        if (t >= untilMs) {
            end = i;
            break;
        }
    }
    if (start < 0 || end < 0 || (end - start + 1) * (x[1] - x[0] + 1) * (y[1] - y[0] + 1) > 250000) return null;
    let max = 0,
        visited = 0;
    for (let step = start; step <= end; step++) {
        check();
        const p = plane(step),
            size = w * h;
        if (kind === 'vector' ? p.u?.length !== size || p.v?.length !== size : p.gust?.length !== size) return null;
        if ((requireSeaMask && p.mask?.length !== size) || (p.mask && p.mask.length !== size)) return null;
        for (let row = y[0]; row <= y[1]; row++)
            for (let col = x[0]; col <= x[1]; col++) {
                if (++visited % 256 === 0) check();
                const i = row * w + col;
                if (p.mask && p.mask[i] !== 0) return null;
                const n = kind === 'gust' ? p.gust![i] : Math.hypot(p.u![i], p.v![i]);
                if (!Number.isFinite(n) || n < 0) return null;
                max = Math.max(max, n);
            }
    }
    check();
    return max;
}
