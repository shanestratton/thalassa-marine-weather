/**
 * Web-Mercator coordinate math for SENC simple-mercator → lat/lon conversion.
 *
 * OpenCPN / o-charts store AREA, LINE, and MULTIPOINT vertex coordinates as
 * little-endian float32 pairs measured in Web-Mercator meters relative to the
 * chart cell's reference point (the cell-extent midpoint).
 *
 * Source formulas: wellenvogel/ochartsng `Coordinates.h` —
 * `latLonToWorld`, `worldFromSM`, `worldxToLon`, `worldyToLat`, factored
 * down here to plain doubles (no fixed-point integer intermediates).
 */

const WGS84_SEMIMAJOR_M = 6378137.0;
const MERCATOR_K0 = 0.9996;
const Z = WGS84_SEMIMAJOR_M * MERCATOR_K0; // 6,372,797.555... m
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export interface LatLon {
    lat: number;
    lon: number;
}

export interface MercXY {
    x: number;
    y: number;
}

export function latLonToMerc(lat: number, lon: number): MercXY {
    // Clamp to Mercator's valid latitude band to avoid Infinity at the poles.
    const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
    const latRad = clampedLat * DEG2RAD;
    return {
        x: Z * lon * DEG2RAD,
        y: Z * Math.asinh(Math.tan(latRad)),
    };
}

export function mercToLatLon(x: number, y: number): LatLon {
    return {
        lon: (x / Z) * RAD2DEG,
        lat: Math.atan(Math.sinh(y / Z)) * RAD2DEG,
    };
}

/**
 * Convert a SENC simple-mercator vertex (delta from refPoint, in mercator m) to lat/lon.
 *
 * `sm_x` and `sm_y` are mercator-meter offsets stored in SENC binary as little-endian floats.
 * `refMerc` is the cell reference point pre-converted to absolute mercator-m once per chart.
 *
 * Sign convention: wellenvogel's `worldFromSM` computes `world.y = ref.y - sm_y * iwz`
 * because their world Y axis is screen-down. Here we work in true mercator (Y up),
 * so the equivalent operation is `merc.y = ref.y + sm_y`.
 *
 * Validated empirically: SENC vertex bytes for a Savannah-River OBSTRN polygon
 * project to lat/lon inside the chart's published bounding box.
 */
export function smVertexToLatLon(smX: number, smY: number, refMerc: MercXY): LatLon {
    return mercToLatLon(refMerc.x + smX, refMerc.y + smY);
}
