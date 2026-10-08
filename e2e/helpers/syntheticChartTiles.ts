/**
 * Offline map tiles for browser specs, made on the spot from a few made-up
 * coastlines: no network, no binary fixtures in the repo. Built for the Log
 * map spec (browser-tests/log-mini-map-layout.spec.ts, 125-13a), whose page
 * asks Mapbox for dark-v11, mapbox.satellite, our relief tiles and OpenSeaMap,
 * and gets these instead:
 *
 *   fixtureStyle(origin)  a dark-v11 stand-in: its 'composite' vector source
 *                         (served here as Mapbox Vector Tiles with a 'water'
 *                         layer) and the land and water layers reliefBase
 *                         anchors on;
 *   compositeTile         the MVT: water everywhere but the land;
 *   reliefTile            an 8-bit depth index PNG or a Terrarium DEM PNG
 *                         (404 for an all-land tile, as the real bucket);
 *   imageryTile           a 512 px "satellite" PNG: fields and scrub on land,
 *                         dark water at sea (which the water fill must hide);
 *   seamarkTile           transparent PNG with a few buoys from z10.
 *
 * The coastlines are rough and fictional, placed at two public harbours: the
 * Solent (England) and the Whitsundays (Queensland, inside the GBR 30 m grid).
 * PNGs are encoded with node:zlib, MVTs with a few lines of protobuf.
 */
import { deflateSync } from 'node:zlib';

export type Pt = [number, number];

/** [lon, lat] rings, each a separate land mass. None overlap. */
export const LAND: Pt[][] = [
    // Hampshire, from the west of Hurst to Selsey.
    [
        [-1.75, 50.735],
        [-1.6, 50.728],
        [-1.55, 50.73],
        [-1.47, 50.76],
        [-1.4, 50.79],
        [-1.33, 50.8],
        [-1.25, 50.812],
        [-1.15, 50.795],
        [-1.05, 50.782],
        [-0.95, 50.78],
        [-0.95, 51.0],
        [-1.75, 51.0],
    ],
    // The Isle of Wight, its north shore at Cowes.
    [
        [-1.58, 50.67],
        [-1.52, 50.7],
        [-1.45, 50.72],
        [-1.38, 50.745],
        [-1.32, 50.757],
        [-1.29, 50.758],
        [-1.25, 50.745],
        [-1.17, 50.735],
        [-1.09, 50.7],
        [-1.08, 50.66],
        [-1.2, 50.59],
        [-1.3, 50.575],
        [-1.45, 50.6],
        [-1.55, 50.64],
    ],
    // The Queensland coast at Airlie Beach.
    [
        [148.5, -20.19],
        [148.62, -20.21],
        [148.72, -20.255],
        [148.79, -20.27],
        [148.86, -20.285],
        [148.95, -20.31],
        [149.02, -20.36],
        [149.05, -20.45],
        [149.05, -20.8],
        [148.5, -20.8],
    ],
    // Whitsunday Island.
    [
        [148.97, -20.2],
        [149.03, -20.14],
        [149.1, -20.17],
        [149.12, -20.25],
        [149.06, -20.29],
        [149.0, -20.27],
    ],
];

/** A few buoys for the seamark overlay: [lon, lat, colour]. */
const BUOYS: Array<[number, number, [number, number, number]]> = [
    [-1.318, 50.774, [34, 197, 94]],
    [-1.342, 50.777, [239, 68, 68]],
    [-1.395, 50.773, [250, 204, 21]],
    [148.84, -20.235, [34, 197, 94]],
    [148.9, -20.225, [239, 68, 68]],
];

const EXTENT = 4096;
const D2R = Math.PI / 180;

// ── Geometry ─────────────────────────────────────────────────────────────

function insideRing([x, y]: Pt, ring: Pt[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

export const isLand = (lon: number, lat: number) => LAND.some((ring) => insideRing([lon, lat], ring));

/** Kilometres to the nearest coast (equirectangular, plenty at this scale). */
function coastKm(lon: number, lat: number): number {
    const kx = 111.32 * Math.cos(lat * D2R);
    const ky = 110.57;
    let best = Infinity;
    for (const ring of LAND) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const ax = (ring[j][0] - lon) * kx;
            const ay = (ring[j][1] - lat) * ky;
            const bx = (ring[i][0] - lon) * kx;
            const by = (ring[i][1] - lat) * ky;
            const dx = bx - ax;
            const dy = by - ay;
            const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
            best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
        }
    }
    return best;
}

/**
 * A made-up seafloor: shoaling to the coast, a gentle swell of banks, and no
 * deeper than about 22 m, so every relief colour it draws stays clear of the
 * plain water fill's (reliefBase's ramp passes #1f5a85 near 50 m).
 */
export function depthAt(lon: number, lat: number): number {
    const km = coastKm(lon, lat);
    const shelf = 1.2 + 18 * (1 - Math.exp(-km / 2.5));
    return Math.max(0.6, shelf * (1 + 0.18 * Math.sin(lon * 160) * Math.cos(lat * 140)));
}

/** reliefBase.depthIndex: 0 = land, 1..254 log-scaled water. */
const depthIndex = (d: number) =>
    d <= 0.3 ? 0 : 1 + 253 * Math.min(1, Math.log1p(Math.min(d, 6000) / 2) / Math.log1p(3000));

function pixelLonLat(z: number, x: number, y: number, px: number, py: number, size: number): Pt {
    const n = 2 ** z;
    const lon = ((x + (px + 0.5) / size) / n) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + (py + 0.5) / size)) / n))) / D2R;
    return [lon, lat];
}

function toTile(lon: number, lat: number, z: number, x: number, y: number): Pt {
    const n = 2 ** z;
    const r = lat * D2R;
    return [
        (((lon + 180) / 360) * n - x) * EXTENT,
        (((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - y) * EXTENT,
    ];
}

/** Sutherland-Hodgman against an axis-aligned square. */
function clipRing(ring: Pt[], min: number, max: number): Pt[] {
    const sides: Array<[(p: Pt) => boolean, (a: Pt, b: Pt) => Pt]> = [
        [(p) => p[0] >= min, (a, b) => [min, a[1] + ((b[1] - a[1]) * (min - a[0])) / (b[0] - a[0])]],
        [(p) => p[0] <= max, (a, b) => [max, a[1] + ((b[1] - a[1]) * (max - a[0])) / (b[0] - a[0])]],
        [(p) => p[1] >= min, (a, b) => [a[0] + ((b[0] - a[0]) * (min - a[1])) / (b[1] - a[1]), min]],
        [(p) => p[1] <= max, (a, b) => [a[0] + ((b[0] - a[0]) * (max - a[1])) / (b[1] - a[1]), max]],
    ];
    let out = ring;
    for (const [inside, cross] of sides) {
        const input = out;
        out = [];
        if (input.length === 0) break;
        let previous = input[input.length - 1];
        for (const current of input) {
            if (inside(current)) {
                if (!inside(previous)) out.push(cross(previous, current));
                out.push(current);
            } else if (inside(previous)) out.push(cross(previous, current));
            previous = current;
        }
    }
    return out;
}

/** Surveyor's formula in tile space (y down): positive is an MVT exterior ring. */
const signedArea = (ring: Pt[]) =>
    ring.reduce((sum, [x, y], i) => {
        const [nx, ny] = ring[(i + 1) % ring.length];
        return sum + x * ny - nx * y;
    }, 0) / 2;

// ── Protobuf (just enough for a vector tile) ─────────────────────────────

class Proto {
    bytes: number[] = [];
    varint(value: number) {
        let n = value;
        while (n > 127) {
            this.bytes.push((n & 127) | 128);
            n = Math.floor(n / 128);
        }
        this.bytes.push(n);
    }
    field(field: number, wire: number) {
        this.varint(field * 8 + wire);
    }
    uint(field: number, value: number) {
        this.field(field, 0);
        this.varint(value);
    }
    raw(field: number, data: ArrayLike<number>) {
        this.field(field, 2);
        this.varint(data.length);
        for (let i = 0; i < data.length; i += 1) this.bytes.push(data[i]);
    }
    string(field: number, text: string) {
        this.raw(field, Buffer.from(text, 'utf8'));
    }
    packed(field: number, values: number[]) {
        const inner = new Proto();
        for (const value of values) inner.varint(value);
        this.raw(field, inner.bytes);
    }
    message(field: number, write: (inner: Proto) => void) {
        const inner = new Proto();
        write(inner);
        this.raw(field, inner.bytes);
    }
}

const zigzag = (n: number) => ((n << 1) ^ (n >> 31)) >>> 0;

function polygonGeometry(rings: Pt[][]): number[] {
    const out: number[] = [];
    let cx = 0;
    let cy = 0;
    for (const ring of rings) {
        const points = ring.map(([x, y]) => [Math.round(x), Math.round(y)] as Pt);
        out.push((1 & 7) | (1 << 3), zigzag(points[0][0] - cx), zigzag(points[0][1] - cy));
        [cx, cy] = points[0];
        out.push((2 & 7) | ((points.length - 1) << 3));
        for (const [x, y] of points.slice(1)) {
            out.push(zigzag(x - cx), zigzag(y - cy));
            cx = x;
            cy = y;
        }
        out.push((7 & 7) | (1 << 3));
    }
    return out;
}

/** The 'composite' tile: one 'water' polygon, the tile square less the land. */
export function compositeTile(z: number, x: number, y: number): Buffer {
    const outer: Pt[] = [
        [-128, -128],
        [EXTENT + 128, -128],
        [EXTENT + 128, EXTENT + 128],
        [-128, EXTENT + 128],
    ];
    const holes: Pt[][] = [];
    for (const ring of LAND) {
        // Densify so a long straight coast follows the Mercator curve.
        const dense: Pt[] = [];
        for (let i = 0; i < ring.length; i += 1) {
            const [a, b] = [ring[i], ring[(i + 1) % ring.length]];
            for (let s = 0; s < 8; s += 1) dense.push([a[0] + ((b[0] - a[0]) * s) / 8, a[1] + ((b[1] - a[1]) * s) / 8]);
        }
        const clipped = clipRing(
            dense.map(([lon, lat]) => toTile(lon, lat, z, x, y)),
            -64,
            EXTENT + 64,
        );
        if (clipped.length < 3 || Math.abs(signedArea(clipped)) < 1) continue;
        holes.push(signedArea(clipped) > 0 ? [...clipped].reverse() : clipped);
    }
    const tile = new Proto();
    tile.message(3, (layer) => {
        layer.uint(15, 2);
        layer.string(1, 'water');
        layer.message(2, (feature) => {
            feature.uint(3, 3);
            feature.packed(4, polygonGeometry([outer, ...holes]));
        });
        layer.uint(5, EXTENT);
    });
    return Buffer.from(tile.bytes);
}

// ── PNG ──────────────────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(data: Buffer): number {
    let c = 0xffffffff;
    for (const byte of data) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

export function encodePng(size: number, rgba: Uint8Array): Buffer {
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let row = 0; row < size; row += 1) {
        raw[row * (size * 4 + 1)] = 0;
        Buffer.from(rgba.buffer, rgba.byteOffset + row * size * 4, size * 4).copy(raw, row * (size * 4 + 1) + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function raster(size: number, z: number, x: number, y: number, paint: (lon: number, lat: number) => number[]) {
    const rgba = new Uint8Array(size * size * 4);
    for (let py = 0; py < size; py += 1) {
        for (let px = 0; px < size; px += 1) {
            const [lon, lat] = pixelLonLat(z, x, y, px, py, size);
            rgba.set(paint(lon, lat), (py * size + px) * 4);
        }
    }
    return encodePng(size, rgba);
}

// ── Tiles ────────────────────────────────────────────────────────────────

function tileTouchesWater(z: number, x: number, y: number): boolean {
    for (let py = 0; py <= 8; py += 1)
        for (let px = 0; px <= 8; px += 1) {
            const [lon, lat] = pixelLonLat(z, x, y, px * 32 - 0.5, py * 32 - 0.5, 256);
            if (!isLand(lon, lat)) return true;
        }
    return false;
}

/** Relief: 'idx' is the depth index in red, 'dem' Terrarium; null (a 404) for an all-land tile. */
export function reliefTile(kind: 'idx' | 'dem', z: number, x: number, y: number): Buffer | null {
    if (!tileTouchesWater(z, x, y)) return null;
    return raster(256, z, x, y, (lon, lat) => {
        const land = isLand(lon, lat);
        if (kind === 'idx') return [land ? 0 : Math.round(depthIndex(depthAt(lon, lat))), 0, 0, 255];
        const metres = (land ? 4 : -depthAt(lon, lat) * 3) + 32768;
        return [Math.floor(metres / 256), Math.floor(metres) % 256, Math.round((metres % 1) * 255), 255];
    });
}

function hash(ix: number, iy: number): number {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const s = fx * fx * (3 - 2 * fx);
    const t = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * s + (c - a) * t + (a - b - c + d) * s * t;
}

/** "Satellite": scrub, fields and towns on land; dark water at sea, hidden by the water fill. */
export function imageryTile(z: number, x: number, y: number): Buffer {
    return raster(512, z, x, y, (lon, lat) => {
        const n = 0.6 * noise(lon * 300, lat * 300) + 0.4 * noise(lon * 1400, lat * 1400);
        if (!isLand(lon, lat)) return [24 + 18 * n, 52 + 20 * n, 66 + 24 * n, 255];
        if (noise(lon * 90 + 7, lat * 90) > 0.72) return [128 + 40 * n, 126 + 36 * n, 118 + 30 * n, 255];
        const field = noise(lon * 600 + 3, lat * 600) > 0.5;
        return field ? [96 + 60 * n, 118 + 46 * n, 62 + 22 * n, 255] : [64 + 40 * n, 86 + 40 * n, 50 + 20 * n, 255];
    });
}

export function seamarkTile(z: number, x: number, y: number): Buffer {
    const rgba = new Uint8Array(256 * 256 * 4);
    if (z >= 10) {
        for (const [lon, lat, colour] of BUOYS) {
            const [tx, ty] = toTile(lon, lat, z, x, y).map((v) => (v / EXTENT) * 256);
            for (let py = Math.floor(ty - 6); py <= ty + 6; py += 1)
                for (let px = Math.floor(tx - 6); px <= tx + 6; px += 1) {
                    if (px < 0 || py < 0 || px > 255 || py > 255) continue;
                    const r = Math.hypot(px - tx, py - ty);
                    if (r > 5.5) continue;
                    rgba.set(r > 4 ? [255, 255, 255, 255] : [...colour, 255], (py * 256 + px) * 4);
                }
        }
    }
    return encodePng(256, rgba);
}

/** A stand-in for dark-v11: its composite vector source and the layers reliefBase needs. */
export function fixtureStyle(origin: string) {
    return {
        version: 8,
        name: 'Log map fixture (dark-v11 stand-in)',
        sources: {
            composite: {
                type: 'vector',
                tiles: [`${origin}/__log-map-fixture/composite/{z}/{x}/{y}.mvt`],
                maxzoom: 14,
                attribution:
                    '<a href="https://www.mapbox.com/about/maps/">© Mapbox</a> <a href="https://www.openstreetmap.org/about/">© OpenStreetMap</a>',
            },
        },
        layers: [
            { id: 'land', type: 'background', paint: { 'background-color': '#2a2f36' } },
            {
                id: 'water',
                type: 'fill',
                source: 'composite',
                'source-layer': 'water',
                paint: { 'fill-color': '#191a1a' },
            },
            {
                id: 'road-primary',
                type: 'line',
                source: 'composite',
                'source-layer': 'road',
                paint: { 'line-color': '#ff00ff', 'line-width': 3 },
            },
        ],
    };
}
