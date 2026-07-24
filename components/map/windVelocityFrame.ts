import type { WindGrid } from '../../services/weather/windGridEncoding';

export interface VelocityGribHeader {
    nx: number;
    ny: number;
    dx: number;
    dy: number;
    lo1: number;
    lo2: number;
    la1: number;
    la2: number;
    parameterCategory: number;
    parameterNumber: number;
    parameterNumberName: string;
}

export interface VelocityGribRecord {
    header: VelocityGribHeader;
    data: number[];
}

/**
 * Convert one selected-model WindGrid frame into leaflet-velocity's two-record
 * U/V shape.
 *
 * WindGrid rows are south → north, while leaflet-velocity consumes north →
 * south. Fractional frame indexes are interpolated before that row flip so
 * scrubber playback remains smooth.
 */
export function windGridFrameToVelocityData(
    grid: WindGrid | null | undefined,
    requestedFrame: number,
): VelocityGribRecord[] | null {
    if (!grid) return null;

    const nx = Math.floor(grid.width);
    const ny = Math.floor(grid.height);
    const size = nx * ny;
    const declaredFrames = Number.isFinite(grid.totalHours) ? Math.floor(grid.totalHours) : 0;
    const availableFrames = Math.min(declaredFrames, grid.u.length, grid.v.length);
    if (nx < 1 || ny < 1 || size < 1 || availableFrames < 1) return null;

    const finiteFrame = Number.isFinite(requestedFrame) ? requestedFrame : 0;
    const frame = Math.max(0, Math.min(finiteFrame, availableFrames - 1));
    const h0 = Math.floor(frame);
    const h1 = Math.min(h0 + 1, availableFrames - 1);
    const u0 = grid.u[h0];
    const v0 = grid.v[h0];
    if (!u0 || !v0 || u0.length < size || v0.length < size) return null;

    const candidateU1 = grid.u[h1];
    const candidateV1 = grid.v[h1];
    const canInterpolate =
        frame > h0 &&
        candidateU1 !== undefined &&
        candidateV1 !== undefined &&
        candidateU1.length >= size &&
        candidateV1.length >= size;
    const lerp = canInterpolate ? frame - h0 : 0;
    const u1 = canInterpolate ? candidateU1 : u0;
    const v1 = canInterpolate ? candidateV1 : v0;

    const uNorthToSouth = new Array<number>(size);
    const vNorthToSouth = new Array<number>(size);
    for (let row = 0; row < ny; row += 1) {
        const sourceRow = ny - 1 - row;
        const sourceOffset = sourceRow * nx;
        const destinationOffset = row * nx;
        for (let column = 0; column < nx; column += 1) {
            const sourceIndex = sourceOffset + column;
            const destinationIndex = destinationOffset + column;
            uNorthToSouth[destinationIndex] = u0[sourceIndex] * (1 - lerp) + u1[sourceIndex] * lerp;
            vNorthToSouth[destinationIndex] = v0[sourceIndex] * (1 - lerp) + v1[sourceIndex] * lerp;
        }
    }

    const dx =
        grid.lons.length > 1 && Number.isFinite(grid.lons[0]) && Number.isFinite(grid.lons[1])
            ? Math.abs(grid.lons[1] - grid.lons[0])
            : 1;
    const dy =
        grid.lats.length > 1 && Number.isFinite(grid.lats[0]) && Number.isFinite(grid.lats[1])
            ? Math.abs(grid.lats[1] - grid.lats[0])
            : 1;
    const baseHeader = {
        nx,
        ny,
        dx,
        dy,
        lo1: grid.west,
        lo2: grid.east,
        la1: grid.north,
        la2: grid.south,
        parameterCategory: 2,
    };

    return [
        {
            header: {
                ...baseHeader,
                parameterNumber: 2,
                parameterNumberName: 'U-component_of_wind',
            },
            data: uNorthToSouth,
        },
        {
            header: {
                ...baseHeader,
                parameterNumber: 3,
                parameterNumberName: 'V-component_of_wind',
            },
            data: vNorthToSouth,
        },
    ];
}
