/**
 * Split a wind image into Mapbox-safe longitude spans.
 *
 * Mapbox image sources do not wrap a full-world image cleanly. Keep every
 * image at or below a hemisphere, share the seam column between neighbours,
 * and explicitly map the International Date Line onto ±180°.
 */
export interface WindHeatmapSegment {
    /** Empty for the primary image source and `_r` for its companion. */
    sourceSuffix: '' | '_r';
    /** Inclusive source-canvas column bounds. */
    startColumn: number;
    endColumn: number;
    /** Mapbox longitude bounds, always in the conventional −180…180 range. */
    west: number;
    east: number;
}

export interface WindHeatmapGridShape {
    columns: number;
    west: number;
    east: number;
}

const EPSILON = 1e-6;

function mapLongitude(longitude: number, edge: 'west' | 'east'): number {
    const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
    // Mapbox accepts both forms of the date line. Choose the side that keeps
    // each image source on a continuous, non-wrapping interval.
    if (Math.abs(normalized + 180) < EPSILON) return edge === 'east' ? 180 : -180;
    return normalized;
}

/**
 * Returns one or two image spans. A split shares its boundary column, avoiding
 * the one-pixel/one-degree gap that otherwise shows through at a world seam.
 */
export function buildWindHeatmapSegments({ columns, west, east }: WindHeatmapGridShape): WindHeatmapSegment[] {
    if (!Number.isFinite(columns) || !Number.isFinite(west) || !Number.isFinite(east) || columns < 2) {
        return [];
    }

    const lastColumn = Math.floor(columns) - 1;
    let continuousEast = east;
    while (continuousEast <= west) continuousEast += 360;
    const span = continuousEast - west;
    if (!Number.isFinite(span) || span <= 0) return [];

    const global = span >= 359;
    const crossesDateLine = !global && west < 180 && continuousEast > 180;
    const needsSplit = global || crossesDateLine;
    if (!needsSplit) {
        return [
            {
                sourceSuffix: '',
                startColumn: 0,
                endColumn: lastColumn,
                west: mapLongitude(west, 'west'),
                east: mapLongitude(continuousEast, 'east'),
            },
        ];
    }

    // A normalised global grid is -180…180, while an upstream 0…360 grid
    // divides at 180. A smaller regional field only needs a date-line split.
    const seam = global ? (west < 0 ? 0 : 180) : 180;
    const rawSplitColumn = Math.round(((seam - west) / span) * lastColumn);
    const splitColumn = Math.max(1, Math.min(lastColumn - 1, rawSplitColumn));

    return [
        {
            sourceSuffix: '',
            startColumn: 0,
            endColumn: splitColumn,
            west: mapLongitude(west, 'west'),
            east: mapLongitude(seam, 'east'),
        },
        {
            sourceSuffix: '_r',
            startColumn: splitColumn,
            endColumn: lastColumn,
            west: mapLongitude(seam, 'west'),
            east: mapLongitude(continuousEast, 'east'),
        },
    ];
}
