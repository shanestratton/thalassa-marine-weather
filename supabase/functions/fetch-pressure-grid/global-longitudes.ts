/**
 * Reframe NOAA's 0…360° full-globe columns as a conventional −180…180° grid.
 *
 * NOMADS returns global GFS data from Greenwich eastward. Mapbox/Thalassa use
 * a dateline-centred axis, so the values must move with their longitude labels
 * rather than merely relabelling column zero as −180°.
 */

export interface NormalizedGlobalPressureFrames {
    frames: number[][][];
    lons: number[];
}

function hasInclusiveMeridian(width: number): boolean {
    if (width < 3) return false;
    const step = 360 / (width - 1);
    // GFS is requested only at 1.0° or 0.25°, but recognising 0.5° keeps the
    // helper correct if the endpoint changes in future.
    return [1, 0.5, 0.25].some((expected) => Math.abs(step - expected) < 1e-6);
}

/**
 * Rotate full-globe rows into a dateline-centred longitude axis.
 *
 * Every returned row includes matching -180° and +180° endpoint values. The
 * duplicate closing column matters for raster consumers: a 360-column row
 * ending at 179° only covers 359° when used as an image source, exposing a
 * visible dark seam at the International Date Line.
 */
export function normalizeGlobalPressureFrames(rawFrames: number[][][]): NormalizedGlobalPressureFrames {
    if (rawFrames.length === 0 || rawFrames[0].length === 0 || rawFrames[0][0].length === 0) {
        throw new Error('Cannot normalize an empty global pressure grid');
    }

    const sourceWidth = rawFrames[0][0].length;
    const hasInclusiveEndpoint = hasInclusiveMeridian(sourceWidth);
    const uniqueWidth = hasInclusiveEndpoint ? sourceWidth - 1 : sourceWidth;

    if (uniqueWidth < 4 || uniqueWidth % 2 !== 0) {
        throw new Error(`Invalid full-globe pressure grid width: ${sourceWidth}`);
    }

    for (const frame of rawFrames) {
        if (frame.length === 0 || frame.some((row) => row.length !== sourceWidth)) {
            throw new Error('Pressure frames must all share one rectangular grid');
        }
    }

    const halfWidth = uniqueWidth / 2;
    const frames = rawFrames.map((frame) =>
        frame.map((row) => {
            const rotated = [...row.slice(halfWidth, uniqueWidth), ...row.slice(0, halfWidth)];
            // Always close the global axis at +180°. A 361-column source
            // already has this duplicate and a 360-column source needs it.
            return [...rotated, rotated[0]];
        })
    );

    const lons = Array.from({ length: uniqueWidth + 1 }, (_, index) => -180 + (360 * index) / uniqueWidth);

    return { frames, lons };
}
