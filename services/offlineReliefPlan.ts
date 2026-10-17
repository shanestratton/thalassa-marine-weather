/** Only our versioned, redistributable terrain. Never OSM/Mapbox or licensed charts. */
import { RELIEF_DISPLAY_REGIONS, reliefRegionBase } from './reliefDisplayRegions';
import { reliefAvailableRanges, reliefTileAvailable } from './reliefAvailability';
export interface ReliefBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}
export const RELIEF_OFFLINE_LIMIT_BYTES = 128 * 1024 * 1024;
export const RELIEF_OFFLINE_LIMIT_TILES = 4096;
export const RELIEF_TILE_MAX_BYTES = 256 * 1024;
/** Matches the manually saved tile lane in public/sw.js. */
export const RELIEF_WEB_CACHE = 'thalassa-v195-tiles';
/** Local metadata belongs to the app origin, never a pretend remote tile. */
export const RELIEF_WEB_MANIFEST_PATH = '/__thalassa-offline-relief-manifest-v1';
export const RELIEF_OFFLINE_DIRECTORY = 'thalassa-offline-relief-v1';
export interface ReliefTile {
    key: string;
    url: string;
    mime: 'image/png' | 'image/webp';
}
const tileX = (lon: number, z: number) => Math.max(0, Math.min(2 ** z - 1, Math.floor(((lon + 180) / 360) * 2 ** z)));
const tileY = (latitude: number, z: number) => {
    const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
    return Math.max(
        0,
        Math.min(2 ** z - 1, Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z)),
    );
};
export function reliefTile(url: string): ReliefTile | null {
    try {
        const u = new URL(url);
        if (u.origin !== 'https://tiles.thalassatiles.com' || u.search || u.hash || u.username || u.password)
            return null;
        const m =
            /^\/(v[1-9]\d{0,2})\/relief-([a-z][a-z0-9]{0,15})\/(dem|idx)\/(0|[1-9]\d?)\/(0|[1-9]\d*)\/(0|[1-9]\d*)\.(webp|png)$/.exec(
                u.pathname,
            );
        if (!m) return null;
        const [, version, area, kind, zs, xs, ys, ext] = m,
            z = Number(zs),
            x = Number(xs),
            y = Number(ys),
            region = RELIEF_DISPLAY_REGIONS.find((candidate) => candidate.id === area);
        if (
            !region ||
            z > region.maxzoom ||
            z < region.minzoom ||
            (region.version && version !== region.version) ||
            !reliefTileAvailable(region.availability, z, x, y) ||
            x >= 2 ** z ||
            y >= 2 ** z ||
            (kind === 'dem' ? ext !== 'webp' : ext !== 'png')
        )
            return null;
        if (region.bounds) {
            const [west, south, east, north] = region.bounds;
            if (x < tileX(west, z) || x > tileX(east, z) || y < tileY(north, z) || y > tileY(south, z)) return null;
        }
        return {
            key: `${version}_${area}_${kind}_${z}_${x}_${y}.${ext}`,
            url: u.href,
            mime: ext === 'png' ? 'image/png' : 'image/webp',
        };
    } catch {
        return null;
    }
}
export function planReliefArea(bounds: ReliefBounds, detail: number, base = 'https://tiles.thalassatiles.com/v1') {
    const maxDetail = Math.max(13, ...RELIEF_DISPLAY_REGIONS.map((region) => region.maxzoom));
    if (
        !bounds ||
        ![bounds.north, bounds.south, bounds.west, bounds.east].every(Number.isFinite) ||
        bounds.south >= bounds.north ||
        bounds.south < -90 ||
        bounds.north > 90 ||
        Math.abs(bounds.west) > 180 ||
        Math.abs(bounds.east) > 180 ||
        bounds.west === bounds.east ||
        !Number.isInteger(detail) ||
        detail < 4 ||
        detail > maxDetail ||
        !/^https:\/\/tiles\.thalassatiles\.com\/v[1-9]\d{0,2}$/.test(base)
    )
        throw new Error(`Choose a valid area and a detail level from 4 to ${maxDetail}.`);
    const segments =
        bounds.west > bounds.east
            ? [
                  [bounds.west, 180],
                  [-180, bounds.east],
              ]
            : [[bounds.west, bounds.east]];
    const ranges: { set: string; z: number; x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const region of RELIEF_DISPLAY_REGIONS)
        for (let z = region.minzoom; z <= Math.min(detail, region.maxzoom); z++) {
            const atZoom: typeof ranges = [];
            for (const [west, east] of segments) {
                const [minLon, minLat, maxLon, maxLat] = region.bounds ?? [-180, -90, 180, 90],
                    w = Math.max(west, minLon),
                    e = Math.min(east, maxLon),
                    south = Math.max(bounds.south, minLat),
                    north = Math.min(bounds.north, maxLat);
                if (w >= e || south >= north) continue;
                atZoom.push({
                    set: region.id,
                    z,
                    x0: tileX(w, z),
                    x1: tileX(e, z),
                    y0: tileY(north, z),
                    y1: tileY(south, z),
                });
            }
            // Merge dateline intervals before counting, including the single world tile at z0.
            atZoom.sort((a, b) => a.x0 - b.x0);
            for (const range of atZoom) {
                const prior = ranges.at(-1);
                if (prior?.set === region.id && prior.z === z && range.x0 <= prior.x1 + 1)
                    prior.x1 = Math.max(prior.x1, range.x1);
                else ranges.push(range);
            }
        }
    const available = ranges.flatMap((range) => {
        const region = RELIEF_DISPLAY_REGIONS.find((candidate) => candidate.id === range.set)!;
        return region.availability
            ? reliefAvailableRanges(region.availability, range.z, range.x0, range.x1, range.y0, range.y1).map(
                  (sparse) => ({ ...range, ...sparse }),
              )
            : [range];
    });
    // Arithmetic first: world-sized requests never allocate millions of entries.
    const tileCount = available.reduce((sum, r) => sum + (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) * 2, 0);
    if (tileCount > RELIEF_OFFLINE_LIMIT_TILES)
        return { tileCount, estimatedBytes: tileCount * 32768, tooLarge: true, tiles: [] as ReliefTile[] };
    const tiles: ReliefTile[] = [];
    for (const r of available)
        for (let x = r.x0; x <= r.x1; x++)
            for (let y = r.y0; y <= r.y1; y++)
                for (const kind of ['dem', 'idx']) {
                    tiles.push(
                        reliefTile(
                            `${reliefRegionBase(base, RELIEF_DISPLAY_REGIONS.find((region) => region.id === r.set)!)}/relief-${r.set}/${kind}/${r.z}/${x}/${y}.${kind === 'dem' ? 'webp' : 'png'}`,
                        )!,
                    );
                }
    return { tileCount, estimatedBytes: tileCount * 32768, tooLarge: false, tiles };
}
/** Reject HTML, truncated headers, wrong-sized images and oversized bodies before storing. */
export function validateReliefBytes(bytes: Uint8Array, mime: ReliefTile['mime']): Uint8Array {
    const size = bytes.length,
        text = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
    let valid = size <= RELIEF_TILE_MAX_BYTES && size >= 30;
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (mime === 'image/png')
        valid =
            valid &&
            [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
            text(12, 4) === 'IHDR' &&
            d.getUint32(8) === 13 &&
            d.getUint32(16) === 256 &&
            d.getUint32(20) === 256;
    else if (valid) {
        valid = text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP' && d.getUint32(4, true) + 8 === size;
        const format = text(12, 4);
        if (format === 'VP8L')
            valid =
                valid &&
                bytes[20] === 47 &&
                1 + ((bytes[21] | (bytes[22] << 8)) & 0x3fff) === 256 &&
                1 + (((bytes[22] >> 6) | (bytes[23] << 2) | (bytes[24] << 10)) & 0x3fff) === 256;
        else if (format === 'VP8X')
            valid =
                valid &&
                1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) === 256 &&
                1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) === 256;
        else if (format === 'VP8 ')
            valid =
                valid &&
                bytes[23] === 157 &&
                bytes[24] === 1 &&
                bytes[25] === 42 &&
                (d.getUint16(26, true) & 0x3fff) === 256 &&
                (d.getUint16(28, true) & 0x3fff) === 256;
        else valid = false;
    }
    if (!valid) throw new Error('Relief tile image is invalid or exceeds its size limit.');
    return bytes;
}
export async function readReliefBytes(response: Response, mime: ReliefTile['mime']): Promise<Uint8Array> {
    if (
        !response.ok ||
        response.redirected ||
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mime ||
        Number(response.headers.get('content-length')) > RELIEF_TILE_MAX_BYTES ||
        !response.body
    )
        throw new Error('Relief tile unavailable or invalid.');
    const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > RELIEF_TILE_MAX_BYTES) {
                await reader.cancel();
                throw new Error('Relief tile exceeds its size limit.');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return validateReliefBytes(bytes, mime);
}
