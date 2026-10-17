/** Bounded, unit-neutral scalar rendering. Source admission and lifetime belong to the caller. */
export interface ScalarGrid {
    readonly width: number;
    readonly height: number;
    /** Cell centres; rows run south to north and columns west to east. */
    readonly west: number;
    readonly south: number;
    readonly dx: number;
    readonly dy: number;
    readonly values: Float32Array;
    /** Exactly 1 is valid. Missing/non-finite contributing cells stay transparent. */
    readonly validMask: Uint8Array;
    /** A periodic grid has width * dx = 360, without a repeated eastern column. */
    readonly wrapLongitude?: boolean;
}

export type ScalarColourStop = readonly [value: number, r: number, g: number, b: number, a: number];
export type ScalarImageBounds = readonly [west: number, south: number, east: number, north: number];

export interface ScalarGridImage {
    readonly width: number;
    readonly height: number;
    /** Owned, north-first RGBA pixels. No canvas, URL or source data is retained. */
    readonly data: Uint8ClampedArray;
    /** Mapbox ImageSource order: north-west, north-east, south-east, south-west. */
    readonly coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

export const SCALAR_GRID_MAX_CELLS = 1_100_000;
export const SCALAR_IMAGE_MAX_EDGE = 1024;
export const SCALAR_MERCATOR_LAT = 85.0511287798066;
const EPSILON = 1e-9;

function validateGrid(grid: ScalarGrid): void {
    const { width, height, west, south, dx, dy, values, validMask } = grid;
    const count = width * height;
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 2 ||
        height < 2 ||
        count > SCALAR_GRID_MAX_CELLS ||
        !(values instanceof Float32Array) ||
        !(validMask instanceof Uint8Array) ||
        values.length !== count ||
        validMask.length !== count ||
        ![west, south, dx, dy].every(Number.isFinite) ||
        west < -180 ||
        west > 180 ||
        south < -90 ||
        dx <= 0 ||
        dy <= 0 ||
        south + (height - 1) * dy > 90 + EPSILON ||
        (width - 1) * dx > 360 + EPSILON ||
        (grid.wrapLongitude && Math.abs(width * dx - 360) > EPSILON)
    ) {
        throw new RangeError('Invalid or oversized scalar grid');
    }
}

function snapIndex(value: number): number {
    const rounded = Math.round(value);
    return Math.abs(value - rounded) <= EPSILON ? rounded : value;
}

function sampleValidated(grid: ScalarGrid, lon: number, lat: number): number | null {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const { width, height, west, south, dx, dy, values, validMask } = grid;
    let x = (lon - west) / dx;
    if (grid.wrapLongitude) x = ((x % width) + width) % width;
    x = snapIndex(x);
    const y = snapIndex((lat - south) / dy);
    if ((!grid.wrapLongitude && (x < 0 || x > width - 1)) || y < 0 || y > height - 1) return null;
    const x0 = Math.floor(x) % width;
    const x1 = grid.wrapLongitude ? (x0 + 1) % width : Math.min(width - 1, x0 + 1);
    const y0 = Math.floor(y);
    const y1 = Math.min(height - 1, y0 + 1);
    const fx = x - Math.floor(x);
    const fy = y - y0;
    let result = 0;
    // Zero-weight neighbours do not invalidate an exact cell centre or edge.
    for (let row = 0; row < 2; row++) {
        const rowWeight = row === 0 ? 1 - fy : fy;
        if (rowWeight === 0) continue;
        for (let col = 0; col < 2; col++) {
            const weight = rowWeight * (col === 0 ? 1 - fx : fx);
            if (weight === 0) continue;
            const index = (row === 0 ? y0 : y1) * width + (col === 0 ? x0 : x1);
            const value = values[index];
            if (validMask[index] !== 1 || !Number.isFinite(value)) return null;
            result += value * weight;
        }
    }
    return Number.isFinite(result) ? result : null;
}

/** Bilinear interpolation never crosses a missing contributing cell or extrapolates latitude. */
export function sampleScalarGrid(grid: ScalarGrid, lon: number, lat: number): number | null {
    validateGrid(grid);
    return sampleValidated(grid, lon, lat);
}

function validateStops(stops: readonly ScalarColourStop[]): void {
    if (
        stops.length < 2 ||
        stops.length > 64 ||
        stops.some(
            (stop, index) =>
                stop.length !== 5 ||
                !stop.every(Number.isFinite) ||
                (index > 0 && stop[0] <= stops[index - 1][0]) ||
                stop.slice(1).some((channel) => channel < 0 || channel > 255),
        )
    ) {
        throw new RangeError('Invalid scalar colour stops');
    }
}

const mercatorY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latitudeAtY = (y: number): number => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

/**
 * Paint pixel centres in Mercator, matching ImageSource's projected quad rather than stretching
 * latitude linearly. Bounds use increasing, possibly unwrapped longitude (e.g. 170..190).
 * The caller must recheck its source lease before/after encoding and before map publication.
 */
export function renderScalarGridImage(
    grid: ScalarGrid,
    stops: readonly ScalarColourStop[],
    options: {
        readonly width?: number;
        readonly height?: number;
        readonly bounds?: ScalarImageBounds;
        readonly check?: () => void;
    } = {},
): ScalarGridImage {
    options.check?.();
    validateGrid(grid);
    validateStops(stops);
    const width = options.width ?? 512;
    const height = options.height ?? 512;
    if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > SCALAR_IMAGE_MAX_EDGE ||
        height > SCALAR_IMAGE_MAX_EDGE
    ) {
        throw new RangeError('Invalid or oversized scalar image');
    }
    const bounds: ScalarImageBounds = options.bounds ?? [
        grid.west,
        Math.max(-SCALAR_MERCATOR_LAT, grid.south),
        grid.west + (grid.wrapLongitude ? 360 : (grid.width - 1) * grid.dx),
        Math.min(SCALAR_MERCATOR_LAT, grid.south + (grid.height - 1) * grid.dy),
    ];
    const [west, south, east, north] = bounds;
    if (
        bounds.length !== 4 ||
        !bounds.every(Number.isFinite) ||
        west < -540 ||
        east > 540 ||
        east <= west ||
        east - west > 360 + EPSILON ||
        south < -SCALAR_MERCATOR_LAT ||
        north > SCALAR_MERCATOR_LAT ||
        north <= south
    ) {
        throw new RangeError('Invalid scalar image bounds');
    }
    const data = new Uint8ClampedArray(width * height * 4);
    const yNorth = mercatorY(north);
    const ySouth = mercatorY(south);
    for (let row = 0; row < height; row++) {
        options.check?.();
        const lat = latitudeAtY(yNorth + ((row + 0.5) / height) * (ySouth - yNorth));
        for (let col = 0; col < width; col++) {
            const value = sampleValidated(grid, west + ((col + 0.5) / width) * (east - west), lat);
            if (value === null) continue;
            let upper = 1;
            while (upper < stops.length - 1 && value > stops[upper][0]) upper++;
            const low = stops[upper - 1];
            const high = stops[upper];
            const fraction = Math.max(0, Math.min(1, (value - low[0]) / (high[0] - low[0])));
            const offset = (row * width + col) * 4;
            for (let channel = 1; channel <= 4; channel++) {
                data[offset + channel - 1] = Math.round(low[channel] + fraction * (high[channel] - low[channel]));
            }
        }
    }
    options.check?.();
    return {
        width,
        height,
        data,
        coordinates: [
            [west, north],
            [east, north],
            [east, south],
            [west, south],
        ],
    };
}
