/**
 * Satellite tiles for the satellite water check's tests (131-05): real PNG
 * bytes of invented pictures, at real z14 tile places in the synthetic
 * archipelago's waters (161.0E 20.3S; no real place, no real imagery).
 *
 * The canal scene is two tiles side by side: a smooth dark-blue canal 40 px
 * tall runs the whole width of both, across the seam between them, through a
 * textured "suburb" of 4 px roof-and-road blocks that the classifier must
 * reject. The land scene is the suburb alone (the classifier works through
 * every pixel and finds no water), which the long-task spec serves so the
 * route it measures is the same with or without a satellite picture.
 *
 * encodePng writes plain 8-bit RGB with no colour chunks, as a tile server
 * would; decodePng reads only what encodePng writes (the vitest decoder
 * stand-in, tests/satelliteWater.worker.test.ts). Both run in Node.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import type { FeatureCollection, Polygon } from 'geojson';

/** The canal scene's crop: x 15519-15520, y 9136 at z14. */
export const CANAL_BBOX: [number, number, number, number] = [161.005, -20.32, 161.025, -20.305];
export const SAT_ZOOM = 14;
export const TILE_PX = 512;
/** The canal's rows in the two-tile mosaic (both tiles share the row). */
export const CANAL_ROWS: [number, number] = [236, 276];

const CANAL: [number, number, number] = [30, 55, 75];
const ROOF: [number, number, number] = [200, 180, 160];
const ROAD: [number, number, number] = [30, 27, 24];

/** One tile's RGB pixels: the suburb, with the canal across it where `canal`. */
export function tilePixels(canal: boolean): Uint8Array {
    const rgb = new Uint8Array(TILE_PX * TILE_PX * 3);
    for (let y = 0; y < TILE_PX; y++)
        for (let x = 0; x < TILE_PX; x++) {
            const c =
                canal && y >= CANAL_ROWS[0] && y < CANAL_ROWS[1] ? CANAL : ((x >> 2) + (y >> 2)) % 2 ? ROOF : ROAD;
            rgb.set(c, (y * TILE_PX + x) * 3);
        }
    return rgb;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    const typed = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
    out.set(typed, 4);
    out.set(data, 8);
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typed, 0);
    crcInput.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcInput));
    return out;
}

/** A PNG of 8-bit RGB pixels, every row unfiltered. */
export function encodePng(rgb: Uint8Array, w: number, h: number): Uint8Array {
    const header = new Uint8Array(13);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, w);
    hv.setUint32(4, h);
    header.set([8, 2, 0, 0, 0], 8); // bit depth 8, RGB, deflate, no filter method, no interlace
    const raw = new Uint8Array(h * (1 + w * 3));
    for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (1 + w * 3) + 1);
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', new Uint8Array(deflateSync(raw))),
        chunk('IEND', new Uint8Array(0)),
    ];
    const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        png.set(p, at);
        at += p.length;
    }
    return png;
}

/** Reads back what encodePng wrote, as RGBA (alpha 255). */
export function decodePng(bytes: Uint8Array): { rgba: Uint8ClampedArray; w: number; h: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let w = 0;
    let h = 0;
    const idat: Uint8Array[] = [];
    for (let at = 8; at < bytes.length; ) {
        const len = view.getUint32(at);
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        const data = bytes.subarray(at + 8, at + 8 + len);
        if (type === 'IHDR') {
            w = view.getUint32(at + 8);
            h = view.getUint32(at + 12);
        } else if (type === 'IDAT') idat.push(data);
        at += 12 + len;
    }
    const raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const s = y * (1 + w * 3) + 1 + x * 3;
            rgba.set([raw[s], raw[s + 1], raw[s + 2], 255], (y * w + x) * 4);
        }
    return { rgba, w, h };
}

/** The canal scene's two tiles, as PNG bytes, keyed `x/y`. */
export function canalTiles(): Map<string, Uint8Array> {
    const png = encodePng(tilePixels(true), TILE_PX, TILE_PX);
    return new Map([
        ['15519/9136', png],
        ['15520/9136', png],
    ]);
}

/** A tile of the suburb alone: no water anywhere in it. */
export function landTile(): Uint8Array {
    return encodePng(tilePixels(false), TILE_PX, TILE_PX);
}

/** The z14 tile a satellite tile URL asks for (`.../mapbox.satellite/14/x/y@2x.png?...`), or null. */
export function satelliteTileOf(url: string): { z: number; x: number; y: number } | null {
    const m = /\/mapbox\.satellite\/(\d+)\/(\d+)\/(\d+)@2x\.png/.exec(url);
    return m ? { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) } : null;
}

/**
 * What is wrong with a reading of the canal scene, if anything: no water, water
 * off the canal (the suburb read as water), or a canal that stops at the seam
 * between the two tiles. Empty when the canal, and only the canal, is water.
 */
export function canalWaterProblems(water: FeatureCollection): string[] {
    if (water.features.length === 0) return ['no water'];
    const top = 9136 * TILE_PX;
    // Snapped to the 3 px routing cells: two cells either side is ample.
    const north = latOfRow(top + CANAL_ROWS[0] - 6);
    const south = latOfRow(top + CANAL_ROWS[1] + 6);
    const points = water.features.flatMap((f) => (f.geometry as Polygon).coordinates[0]);
    const problems: string[] = [];
    const off = points.filter(([, lat]) => lat >= north || lat <= south);
    if (off.length > 0) problems.push(`${off.length} corners of water off the canal, e.g. ${off[0].join(',')}`);
    const lons = points.map(([lon]) => lon);
    if (Math.min(...lons) >= lonOfColumn(15519 * TILE_PX + 12)) problems.push('the canal misses the first tile');
    if (Math.max(...lons) <= lonOfColumn(15521 * TILE_PX - 12)) problems.push('the canal misses the second tile');
    return problems;
}

/** Latitude of a global @2x pixel row at zoom z (the classifier's own inverse). */
export function latOfRow(gy: number, z = SAT_ZOOM): number {
    const world = TILE_PX * 2 ** z;
    return (Math.atan(Math.sinh((1 - (2 * gy) / world) * Math.PI)) * 180) / Math.PI;
}

/** Longitude of a global @2x pixel column at zoom z. */
export function lonOfColumn(gx: number, z = SAT_ZOOM): number {
    return (gx / (TILE_PX * 2 ** z)) * 360 - 180;
}
