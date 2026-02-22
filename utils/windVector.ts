export interface WindData {
    uComponent: number; // m/s, eastward
    vComponent: number; // m/s, northward
}

export interface WindVector {
    speedKnots: number;
    directionDegrees: number;
}

const MS_TO_KNOTS = 1.94384;

/**
 * Calculate wind speed (knots) and meteorological direction (degrees, where wind blows FROM)
 * from raw GRIB U and V components.
 *
 * U = eastward component (m/s), V = northward component (m/s).
 * Meteorological direction: 0° = wind from North, 90° = wind from East, etc.
 */
export function calculateWindVector(data: WindData): WindVector {
    const { uComponent, vComponent } = data;

    const speedMs = Math.sqrt(uComponent * uComponent + vComponent * vComponent);
    const speedKnots = speedMs * MS_TO_KNOTS;

    // Meteorological direction = direction wind is coming FROM
    // atan2(-u, -v) gives the angle FROM which the wind blows
    const directionRad = Math.atan2(-uComponent, -vComponent);
    const directionDeg = (directionRad * 180) / Math.PI;

    // Normalize to 0–359
    const directionDegrees = ((directionDeg % 360) + 360) % 360;

    return { speedKnots, directionDegrees };
}
