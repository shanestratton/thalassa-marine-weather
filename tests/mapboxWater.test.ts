/**
 * mapboxWater — decode Mapbox's vector `water` layer (the canal/marina water the
 * ENC omits). Proven OFFLINE against a real Newport canal tile (z16) captured
 * from mapbox-streets-v8: tests/fixtures/mapbox-water-16-60637-37918.mvt.
 *
 * The headline assertion: a known Newport canal point falls INSIDE the decoded
 * water — i.e. Mapbox charts the channel the ENC drew as land.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import {
    MAPBOX_WATER_ZOOM,
    decodeWaterFromTile,
    fetchMapboxWater,
    lonLatToTileXY,
    tilesForBbox,
} from '../services/mapboxWater';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUF = new Uint8Array(readFileSync(join(HERE, 'fixtures/mapbox-water-16-60637-37918.mvt')));
const Z = 16;
const X = 60637;
const Y = 37918;

function countVerts(coords: unknown): number {
    if (!Array.isArray(coords)) return 0;
    if (typeof coords[0] === 'number') return 1;
    return coords.reduce((n: number, c) => n + countVerts(c), 0);
}

describe('mapboxWater — slippy tile math', () => {
    it('locates the Newport canal tile at z16', () => {
        const { x, y } = lonLatToTileXY(153.0905, -27.2075, 16);
        expect({ x, y }).toEqual({ x: X, y: Y });
    });

    it('covers a multi-tile bbox, all at the requested zoom', () => {
        const tiles = tilesForBbox([153.085, -27.216, 153.097, -27.198], 16);
        expect(tiles.length).toBeGreaterThan(1);
        expect(tiles.every((t) => t.z === 16)).toBe(true);
    });

    it('uses z16 as the water zoom (z15 generalises the channels away)', () => {
        expect(MAPBOX_WATER_ZOOM).toBe(16);
    });
});

describe('mapboxWater — decode the real Newport canal tile', () => {
    it('decodes water polygons with channel-level detail', () => {
        const feats = decodeWaterFromTile(BUF, Z, X, Y);
        expect(feats.length).toBeGreaterThanOrEqual(1);
        feats.forEach((f) => expect(['Polygon', 'MultiPolygon']).toContain(f.geometry.type));
        const verts = feats.reduce((n, f) => n + countVerts(f.geometry.coordinates), 0);
        expect(verts).toBeGreaterThan(100); // z16 keeps the canal detail (z15 collapsed to ~32)
    });

    it('THE HEADLINE: a Newport canal point the ENC calls land is INSIDE Mapbox water', () => {
        const feats = decodeWaterFromTile(BUF, Z, X, Y);
        const inWater = feats.some((f) => booleanPointInPolygon([153.08855, -27.21034], f));
        expect(inWater).toBe(true);
    });

    it('returns [] for a buffer with no water layer', () => {
        expect(decodeWaterFromTile(new Uint8Array([]), Z, X, Y)).toEqual([]);
    });
});

describe('mapboxWater — fetchMapboxWater (injected fetcher, fully offline)', () => {
    it('fetches + decodes via the injected tile fetcher', async () => {
        const fc = await fetchMapboxWater([153.088, -27.212, 153.0945, -27.206], 'tok', {
            fetchTile: async () => BUF, // every covered tile returns the canned Newport tile
        });
        expect(fc.type).toBe('FeatureCollection');
        expect(fc.features.length).toBeGreaterThanOrEqual(1);
    });

    it('empty token → empty collection (graceful, no network)', async () => {
        const fc = await fetchMapboxWater([153, -27, 153.01, -26.99], '');
        expect(fc.features).toEqual([]);
    });

    it('failed tile fetch → empty collection (graceful degradation to ENC)', async () => {
        const fc = await fetchMapboxWater([153.088, -27.212, 153.09, -27.21], 'tok', {
            fetchTile: async () => null,
        });
        expect(fc.features).toEqual([]);
    });
});
