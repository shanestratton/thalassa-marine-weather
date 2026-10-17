import type { ReliefDisplayRegion } from './reliefDisplayRegions';
import { reliefAvailableRanges, type ReliefAvailability } from './reliefAvailability';

const MERCATOR_LAT = 85.05112878;
const longitude = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const latitude = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
/** Enclosing tile footprint, never a claim of continuous surveyed coverage. */
export function reliefAvailabilityBounds(a: ReliefAvailability): [number, number, number, number] {
    return a.rows.reduce<[number, number, number, number]>(
        (b, [z, y, first, last]) => [
            Math.min(b[0], longitude(first, z)),
            Math.min(b[1], latitude(y + 1, z)),
            Math.max(b[2], longitude(last + 1, z)),
            Math.max(b[3], latitude(y, z)),
        ],
        [180, 90, -180, -90],
    );
}
/** Bounded arithmetic only; no tile/image allocation, fetching or depth interpretation. */
export function reliefViewportCovered(
    region: ReliefDisplayRegion,
    bounds: readonly [number, number, number, number],
    zoom: number,
): boolean {
    if (!region.availability) return false;
    const [west, south, east, north] = bounds;
    if (
        ![...bounds, zoom].every(Number.isFinite) ||
        south >= north ||
        south < -90 ||
        north > 90 ||
        east <= west ||
        east - west > 360 ||
        zoom < region.minzoom ||
        zoom >= Math.max(region.tintFade[1], region.shadeFade[1])
    )
        return false;
    const z = Math.min(region.maxzoom, Math.floor(zoom)),
        n = 2 ** z;
    const x = (lon: number) => Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
    const y = (lat: number) =>
        Math.max(
            0,
            Math.min(
                n - 1,
                Math.floor(
                    ((1 -
                        Math.asinh(Math.tan((Math.max(-MERCATOR_LAT, Math.min(MERCATOR_LAT, lat)) * Math.PI) / 180)) /
                            Math.PI) /
                        2) *
                        n,
                ),
            ),
        );
    const start = ((((west + 180) % 360) + 360) % 360) - 180,
        end = start + east - west;
    const parts =
        end > 180
            ? [
                  [start, 180],
                  [-180, end - 360],
              ]
            : [[start, end]];
    return parts.some(
        ([w, e]) => reliefAvailableRanges(region.availability!, z, x(w), x(e), y(north), y(south)).length > 0,
    );
}
