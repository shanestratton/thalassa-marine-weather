/** Exact sparse display tiles, emitted from finite provider seafloor masks. */
// Reviewed AU build ceiling116,388 DEM/index objects. This is arithmetic
// metadata admission; phone tile, byte and saved-area caps remain separate.
export const RELIEF_AVAILABILITY_MAX_PAIRS = 58194;
export interface ReliefAvailability {
    schema: 1;
    region: string;
    version: string;
    minzoom: number;
    maxzoom: number;
    tilePairs: number;
    /** Canonical [zoom, y, firstX, lastX], sorted; adjacent runs are merged. */
    rows: readonly (readonly [number, number, number, number])[];
}
/** No network lane. A future publication must pin this immutable manifest before adding its registry row. */
export function parseReliefAvailability(
    input: unknown,
    expected: Pick<ReliefAvailability, 'region' | 'version' | 'minzoom' | 'maxzoom'>,
): ReliefAvailability | null {
    if (!input || typeof input !== 'object') return null;
    const value = input as Partial<ReliefAvailability>;
    if (
        value.schema !== 1 ||
        value.region !== expected.region ||
        value.version !== expected.version ||
        value.minzoom !== expected.minzoom ||
        value.maxzoom !== expected.maxzoom ||
        !/^[a-z][a-z0-9]{0,15}$/.test(expected.region) ||
        !/^v[1-9]\d{0,2}$/.test(expected.version) ||
        !Number.isInteger(expected.minzoom) ||
        !Number.isInteger(expected.maxzoom) ||
        expected.minzoom < 0 ||
        expected.minzoom > expected.maxzoom ||
        expected.maxzoom > 14 ||
        !Array.isArray(value.rows) ||
        value.rows.length > 50000
    )
        return null;
    const rows: [number, number, number, number][] = [];
    let count = 0;
    for (const row of value.rows) {
        if (!Array.isArray(row) || row.length !== 4 || !row.every(Number.isInteger)) return null;
        const [z, y, first, last] = row;
        if (
            z < expected.minzoom ||
            z > expected.maxzoom ||
            y < 0 ||
            y >= 2 ** z ||
            first < 0 ||
            first > last ||
            last >= 2 ** z
        )
            return null;
        const prior = rows.at(-1);
        if (prior && (z < prior[0] || (z === prior[0] && (y < prior[1] || (y === prior[1] && first <= prior[3] + 1)))))
            return null;
        count += last - first + 1;
        if (count > RELIEF_AVAILABILITY_MAX_PAIRS) return null;
        rows.push([z, y, first, last]);
    }
    return count === value.tilePairs ? { schema: 1, ...expected, tilePairs: count, rows } : null;
}
/** Arithmetic intersections precede allocations in saved-area planning. */
export function reliefAvailableRanges(
    availability: ReliefAvailability,
    z: number,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
) {
    const { rows } = availability;
    let lo = 0,
        hi = rows.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1,
            row = rows[mid];
        if (row[0] < z || (row[0] === z && row[1] < y0)) lo = mid + 1;
        else hi = mid;
    }
    const result: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (let i = lo; i < rows.length; i++) {
        const [zoom, y, first, last] = rows[i];
        if (zoom !== z || y > y1) break;
        const start = Math.max(first, x0),
            end = Math.min(last, x1);
        if (start <= end) result.push({ x0: start, x1: end, y0: y, y1: y });
    }
    return result;
}
export function reliefTileAvailable(
    availability: ReliefAvailability | undefined,
    z: number,
    x: number,
    y: number,
): boolean {
    return !availability || reliefAvailableRanges(availability, z, x, x, y, y).length > 0;
}
