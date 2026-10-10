/**
 * mapboxWater: decode Mapbox's vector `water` layer (the canal and marina
 * water an ENC can omit), fully offline.
 *
 * Until 127 this read a real mapbox-streets-v8 tile committed under
 * tests/fixtures. A Mapbox tile is Mapbox's data and the repo is public, so
 * the tile is gone (127-C-a item 12): the tile here is hand-encoded in the
 * test (tests/helpers/handMvt.ts) with two invented water polygons, a
 * sinuous canal and a basin with an island, beside a road layer and a
 * water-layer line the decoder must ignore. The same tile is decoded at four
 * places, none of them Queensland, so no assertion leans on one coast.
 */
import { describe, expect, it } from 'vitest';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import {
    MAPBOX_WATER_ZOOM,
    decodeWaterFromTile,
    fetchMapboxWater,
    lonLatToTileXY,
    tilesForBbox,
} from '../services/mapboxWater';
import { encodeMvt, MVT_EXTENT, tilePxToLonLat, tileRingArea2, type MvtFeature } from './helpers/handMvt';

const Z = 16;

/** Four origins: IALA A Atlantic, IALA B Atlantic, the South Pacific, and the Arctic. */
const ORIGINS = {
    'Brittany-like (48.4N 4.5W)': [-4.5, 48.4],
    'Chesapeake-like (38.9N 76.4W)': [-76.4, 38.9],
    'Nouméa-like (22.3S 166.4E)': [166.4, -22.3],
    'Tromsø-like (69.6N 18.9E)': [18.9, 69.6],
} as const;

/** The canal's centre line at vertex i of 64. */
const canalCentre = (i: number): [number, number] => [
    Math.round(200 + (i * (MVT_EXTENT - 400)) / 63),
    1800 + Math.round(120 * Math.sin(i / 6)),
];

/** A canal 280 px wide whose banks wander, 64 vertices a side: the channel detail z16 keeps. */
function canal(): [number, number][] {
    const north: [number, number][] = [];
    const south: [number, number][] = [];
    for (let i = 0; i < 64; i++) {
        const [x, centre] = canalCentre(i);
        north.push([x, centre - 140]);
        south.push([x, centre + 140]);
    }
    // Clockwise on screen (y down): along the north bank, back along the south.
    return [...north, ...south.reverse()];
}

const BASIN: [number, number][] = [
    [2600, 2600],
    [3600, 2600],
    [3600, 3600],
    [2600, 3600],
];
const ISLAND: [number, number][] = [
    [3000, 3000],
    [3000, 3200],
    [3200, 3200],
    [3200, 3000],
];

/** The tile: a water layer (two polygons, the basin holed, and a line to ignore) and a road layer. */
function tile(): Uint8Array {
    const water: MvtFeature[] = [
        { type: 3, rings: [canal()], properties: { class: 'water' } },
        { type: 3, rings: [BASIN, ISLAND], properties: { class: 'water' } },
        {
            type: 2,
            rings: [
                [
                    [100, 100],
                    [900, 900],
                ],
            ],
            properties: { class: 'river-line' },
        },
    ];
    const road: MvtFeature[] = [
        {
            type: 2,
            rings: [
                [
                    [0, 1000],
                    [4096, 1000],
                ],
            ],
        },
    ];
    return encodeMvt([
        { name: 'water', features: water },
        { name: 'road', features: road },
    ]);
}

const BUF = tile();

function countVerts(coords: unknown): number {
    if (!Array.isArray(coords)) return 0;
    if (typeof coords[0] === 'number') return 1;
    return coords.reduce((n: number, c) => n + countVerts(c), 0);
}

describe('mapboxWater: slippy tile math', () => {
    it('numbers tiles from the antimeridian and the north edge', () => {
        expect(lonLatToTileXY(0, 0, 16)).toEqual({ x: 32768, y: 32768 });
        expect(lonLatToTileXY(-0.0001, 0.0001, 16)).toEqual({ x: 32767, y: 32767 });
        // Past the Mercator limit (about 85.05°) it clamps rather than leaving the grid.
        expect(lonLatToTileXY(-180, 85.1, 16)).toEqual({ x: 0, y: 0 });
        expect(lonLatToTileXY(180, -89.9, 16)).toEqual({ x: 65535, y: 65535 });
    });

    it.each(Object.entries(ORIGINS))('agrees with the decoder’s projection at %s', (_name, [lon, lat]) => {
        const { x, y } = lonLatToTileXY(lon, lat, Z);
        const [west, north] = tilePxToLonLat(0, 0, Z, x, y);
        const [east, south] = tilePxToLonLat(MVT_EXTENT, MVT_EXTENT, Z, x, y);
        expect(lon).toBeGreaterThanOrEqual(west);
        expect(lon).toBeLessThan(east);
        expect(lat).toBeLessThanOrEqual(north);
        expect(lat).toBeGreaterThan(south);
    });

    it('covers a multi-tile bbox, all at the requested zoom', () => {
        const tiles = tilesForBbox([-76.41, 38.89, -76.39, 38.91], 16);
        expect(tiles.length).toBeGreaterThan(1);
        expect(tiles.every((t) => t.z === 16)).toBe(true);
    });

    it('uses z16 as the water zoom (z15 generalises the channels away)', () => {
        expect(MAPBOX_WATER_ZOOM).toBe(16);
    });
});

describe('mapboxWater: decode a hand-encoded water tile', () => {
    it('the test tile is wound as MVT wants: exteriors clockwise in tile space, the hole the other way', () => {
        expect(tileRingArea2(canal())).toBeGreaterThan(0);
        expect(tileRingArea2(BASIN)).toBeGreaterThan(0);
        expect(tileRingArea2(ISLAND)).toBeLessThan(0);
    });

    it.each(Object.entries(ORIGINS))(
        'decodes the two polygons, with channel-level detail, at %s',
        (_name, [lon, lat]) => {
            const { x, y } = lonLatToTileXY(lon, lat, Z);
            const feats = decodeWaterFromTile(BUF, Z, x, y);
            // The water line and the road layer are not water polygons.
            expect(feats).toHaveLength(2);
            feats.forEach((f) => expect(['Polygon', 'MultiPolygon']).toContain(f.geometry.type));
            expect(feats.map((f) => f.properties?.class)).toEqual(['water', 'water']);
            const verts = feats.reduce((n, f) => n + countVerts(f.geometry.coordinates), 0);
            expect(verts).toBeGreaterThan(100);
        },
    );

    it.each(Object.entries(ORIGINS))(
        'puts canal and basin water where the tile drew it, and not the island or the land, at %s',
        (_name, [lon, lat]) => {
            const { x, y } = lonLatToTileXY(lon, lat, Z);
            const feats = decodeWaterFromTile(BUF, Z, x, y);
            const wet = (px: number, py: number) =>
                feats.some((f) => booleanPointInPolygon(tilePxToLonLat(px, py, Z, x, y), f));
            expect(wet(...canalCentre(32))).toBe(true); // mid-canal
            expect(wet(...canalCentre(5))).toBe(true); // near its west end
            expect(wet(2700, 2700)).toBe(true); // the basin
            expect(wet(3100, 3100)).toBe(false); // the island in it
            expect(wet(canalCentre(32)[0], canalCentre(32)[1] - 400)).toBe(false); // the land north of the canal
            expect(wet(1000, 3000)).toBe(false); // the land between canal and basin
        },
    );

    it('returns [] for a buffer with no water layer', () => {
        expect(decodeWaterFromTile(new Uint8Array([]), Z, 0, 0)).toEqual([]);
        const roadsOnly = encodeMvt([
            {
                name: 'road',
                features: [
                    {
                        type: 2,
                        rings: [
                            [
                                [0, 0],
                                [10, 10],
                            ],
                        ],
                    },
                ],
            },
        ]);
        expect(decodeWaterFromTile(roadsOnly, Z, 0, 0)).toEqual([]);
    });
});

describe('mapboxWater: fetchMapboxWater (injected fetcher, fully offline)', () => {
    const BBOX: [number, number, number, number] = [-76.41, 38.89, -76.39, 38.91];

    it('strict connector mode rejects even one missing tile', async () => {
        let calls = 0;
        await expect(
            fetchMapboxWater(BBOX, 'tok', {
                requireComplete: true,
                fetchTile: async () => (++calls === 1 ? null : BUF),
            }),
        ).rejects.toThrow(/incomplete/);
    });

    it('fetches + decodes via the injected tile fetcher, each tile in its own place', async () => {
        const urls: string[] = [];
        const fc = await fetchMapboxWater(BBOX, 'tok', {
            fetchTile: async (url) => {
                urls.push(url);
                return BUF; // every covered tile returns the same hand-made tile
            },
        });
        expect(fc.type).toBe('FeatureCollection');
        expect(urls).toHaveLength(tilesForBbox(BBOX, 16).length);
        expect(urls.every((url) => /\/16\/\d+\/\d+\.mvt\?access_token=tok$/.test(url))).toBe(true);
        expect(fc.features).toHaveLength(2 * urls.length);
    });

    it('empty token → empty collection (graceful, no network)', async () => {
        const fc = await fetchMapboxWater(BBOX, '');
        expect(fc.features).toEqual([]);
    });

    it('failed tile fetch → empty collection (graceful degradation to ENC)', async () => {
        const fc = await fetchMapboxWater(BBOX, 'tok', {
            fetchTile: async () => null,
        });
        expect(fc.features).toEqual([]);
    });
});
