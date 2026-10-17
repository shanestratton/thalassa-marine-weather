import { LOCAL_CHART_FILE_BYTES } from './localChartLimits';
export const LOCAL_RASTER_EDGE = 1024;
export const LOCAL_RASTER_PIXELS = LOCAL_RASTER_EDGE * LOCAL_RASTER_EDGE;
export const LOCAL_RASTER_BYTES = LOCAL_RASTER_PIXELS * 4;
export const LOCAL_RASTER_DECODE_MS = 15_000;
export interface LocalRasterImage {
    width: number;
    height: number;
    rgba: Uint8Array<ArrayBuffer>;
    bounds: [number, number, number, number];
    datum: 'WGS84';
    sourceProjection: 'WGS84 Mercator' | 'EPSG:4326' | 'EPSG:3857';
    note: string;
}
export function rasterRequire(condition: unknown, reason: string): asserts condition {
    if (!condition) throw new Error(reason);
}
export function rasterDimensions(width: number, height: number): void {
    rasterRequire(
        Number.isSafeInteger(width) &&
            Number.isSafeInteger(height) &&
            width > 0 &&
            height > 0 &&
            width <= LOCAL_RASTER_EDGE &&
            height <= LOCAL_RASTER_EDGE &&
            width * height <= LOCAL_RASTER_PIXELS,
        'This phone displays raster chart images up to 1024 × 1024 pixels. Export a bounded MBTiles pyramid for a larger chart.',
    );
}
export function rasterInput(bytes: Uint8Array): void {
    rasterRequire(
        bytes.length >= 8 && bytes.length <= LOCAL_CHART_FILE_BYTES,
        'Raster chart file exceeds 32 MiB or is incomplete.',
    );
}
export function rasterBounds(bounds: readonly number[]): asserts bounds is [number, number, number, number] {
    rasterRequire(
        bounds.length === 4 &&
            bounds.every(Number.isFinite) &&
            bounds[0] >= -180 &&
            bounds[2] <= 180 &&
            bounds[0] < bounds[2] &&
            bounds[1] < bounds[3] &&
            bounds[1] >= -85.05112878 &&
            bounds[3] <= 85.05112878,
        'This chart crosses an unsupported longitude boundary or the Mercator polar limit. Export a bounded MBTiles pyramid.',
    );
}
const DEG = Math.PI / 180;
export const webMercator = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
export const inverseWebMercator = (value: number) => Math.atan(Math.sinh(value)) / DEG;
/** Explicit WGS84 ellipsoidal Mercator; REF scale/origin is measured, never guessed. */
export function wgs84Mercator(lat: number): number {
    const eccentricity = Math.sqrt(0.0066943799901413165),
        sine = Math.sin(lat * DEG);
    return Math.log(
        Math.tan(Math.PI / 4 + (lat * DEG) / 2) *
            ((1 - eccentricity * sine) / (1 + eccentricity * sine)) ** (eccentricity / 2),
    );
}
export function inverseWgs84Mercator(value: number): number {
    const eccentricity = Math.sqrt(0.0066943799901413165);
    let phi = inverseWebMercator(value) * DEG;
    for (let i = 0; i < 12; i++)
        phi =
            2 *
                Math.atan(
                    Math.exp(value) *
                        ((1 + eccentricity * Math.sin(phi)) / (1 - eccentricity * Math.sin(phi))) ** (eccentricity / 2),
                ) -
            Math.PI / 2;
    return phi / DEG;
}
/** All parsing, expansion and output share one monotonic deadline. */
export function rasterDeadline(check: () => void = () => undefined, now = () => performance.now()): () => void {
    const started = now();
    return () => {
        check();
        rasterRequire(
            now() - started < LOCAL_RASTER_DECODE_MS,
            'Chart image decoding exceeded 15 seconds. Export a smaller MBTiles pyramid.',
        );
    };
}
