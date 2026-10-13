/**
 * Hand-encoded Mapbox Vector Tiles, built in the test (127-C-a item 12).
 *
 * The tests used to read a real mapbox-streets-v8 tile from tests/fixtures.
 * A Mapbox tile is Mapbox's data (their terms, vision §4.3) and this repo is
 * public, so the tile left the tree: what the tests need is the encoding, not
 * Mapbox's geometry. This writes the MVT 2.1 wire format with `pbf` (the
 * decoder's own dependency): one message per layer, zig-zag command streams,
 * exterior rings clockwise in tile space and holes the other way, exactly as
 * the spec and services/mapboxWater's decoder expect.
 *
 * Code, not data: every polygon a test encodes is either invented here or
 * open data the test already holds (OpenStreetMap, ODbL).
 */
import Pbf from 'pbf';
import type { Position } from 'geojson';

export const MVT_EXTENT = 4096;

/** A tile-space feature: 1 point, 2 line, 3 polygon. Rings are open (no repeated first point). */
export interface MvtFeature {
    type: 1 | 2 | 3;
    rings: [number, number][][];
    properties?: Record<string, string | number | boolean>;
}

export interface MvtLayer {
    name: string;
    features: MvtFeature[];
}

const zigzag = (n: number): number => (n >= 0 ? 2 * n : -2 * n - 1);
const command = (id: number, count: number): number => (count << 3) | id;

/** Twice the signed area in tile space (y down): positive is clockwise on screen, the MVT exterior. */
export function tileRingArea2(ring: readonly [number, number][]): number {
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        sum += x1 * y2 - x2 * y1;
    }
    return sum;
}

function geometry(feature: MvtFeature): number[] {
    const out: number[] = [];
    let cx = 0;
    let cy = 0;
    for (const ring of feature.rings) {
        if (ring.length === 0) continue;
        const [first, ...rest] = ring;
        out.push(command(1, 1), zigzag(first[0] - cx), zigzag(first[1] - cy));
        [cx, cy] = first;
        if (feature.type === 1) continue;
        out.push(command(2, rest.length));
        for (const [x, y] of rest) {
            out.push(zigzag(x - cx), zigzag(y - cy));
            cx = x;
            cy = y;
        }
        if (feature.type === 3) out.push(command(7, 1));
    }
    return out;
}

/** Encode layers into one tile. Integers only: tile coordinates are rounded by the caller. */
export function encodeMvt(layers: readonly MvtLayer[], extent = MVT_EXTENT): Uint8Array {
    const pbf = new Pbf();
    for (const layer of layers) {
        const keys: string[] = [];
        const values: (string | number | boolean)[] = [];
        const tagsOf = (props: MvtFeature['properties'] = {}) =>
            Object.entries(props).flatMap(([key, value]) => {
                let k = keys.indexOf(key);
                if (k < 0) k = keys.push(key) - 1;
                let v = values.indexOf(value);
                if (v < 0) v = values.push(value) - 1;
                return [k, v];
            });
        const features = layer.features.map((feature) => ({ feature, tags: tagsOf(feature.properties) }));
        pbf.writeMessage(
            3,
            (_: unknown, out: Pbf) => {
                out.writeVarintField(15, 2);
                out.writeStringField(1, layer.name);
                for (const { feature, tags } of features)
                    out.writeMessage(
                        2,
                        (__: unknown, f: Pbf) => {
                            f.writePackedVarint(2, tags);
                            f.writeVarintField(3, feature.type);
                            f.writePackedVarint(4, geometry(feature));
                        },
                        null,
                    );
                for (const key of keys) out.writeStringField(3, key);
                for (const value of values)
                    out.writeMessage(
                        4,
                        (__: unknown, v: Pbf) => {
                            if (typeof value === 'string') v.writeStringField(1, value);
                            else if (typeof value === 'boolean') v.writeBooleanField(7, value);
                            else v.writeDoubleField(3, value);
                        },
                        null,
                    );
                out.writeVarintField(5, extent);
            },
            null,
        );
    }
    return pbf.finish();
}

/** lon/lat to this tile's pixel space (may fall outside 0..extent; MVT allows it). */
export function lonLatToTilePx(
    [lon, lat]: Position,
    z: number,
    x: number,
    y: number,
    extent = MVT_EXTENT,
): [number, number] {
    const size = extent * 2 ** z;
    const phi = (lat * Math.PI) / 180;
    const px = ((lon + 180) / 360) * size - extent * x;
    const py = (size / 2) * (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) - extent * y;
    return [px, py];
}

/** This tile's pixel space back to lon/lat, the decoder's own projection. */
export function tilePxToLonLat(px: number, py: number, z: number, x: number, y: number, extent = MVT_EXTENT): Position {
    const size = extent * 2 ** z;
    const lon = ((px + extent * x) * 360) / size - 180;
    const lat = (360 / Math.PI) * Math.atan(Math.exp((1 - ((py + extent * y) * 2) / size) * Math.PI)) - 90;
    return [lon, lat];
}

/** One ring in tile space, rounded, open, and wound as MVT wants (exterior clockwise, holes not). */
function tileRing(ring: readonly Position[], z: number, x: number, y: number, exterior: boolean): [number, number][] {
    const pts: [number, number][] = [];
    for (const position of ring) {
        const [px, py] = lonLatToTilePx(position, z, x, y).map(Math.round) as [number, number];
        const last = pts[pts.length - 1];
        if (!last || last[0] !== px || last[1] !== py) pts.push([px, py]);
    }
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (exterior !== tileRingArea2(pts) > 0) pts.reverse();
    return pts;
}

/**
 * A `water` tile from lon/lat polygons (each an exterior ring then holes), one
 * feature per polygon: the shape mapbox-streets-v8 serves. Rings that collapse
 * to under three points at this zoom are dropped.
 */
export function encodeWaterTile(polygons: readonly Position[][][], z: number, x: number, y: number): Uint8Array {
    const features: MvtFeature[] = [];
    for (const polygon of polygons) {
        const rings = polygon.map((ring, i) => tileRing(ring, z, x, y, i === 0)).filter((ring) => ring.length >= 3);
        if (rings.length > 0 && tileRingArea2(rings[0]) > 0)
            features.push({ type: 3, rings, properties: { class: 'water' } });
    }
    return encodeMvt([{ name: 'water', features }]);
}
