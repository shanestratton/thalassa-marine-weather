/**
 * The offline water pack's tiles (Phase 2b, 2026-10-01): 0.05° squares keyed
 * by integer index, each holding WHOLE OSM features (never clipped) from the
 * overlay classes, assembled back with a dedupe and one safety rule — water
 * only where the pack also knows the obstacles.
 *
 * newport-pinkenba-osm.json.gz is a Pi capture of OpenStreetMap data
 * (© OpenStreetMap contributors, ODbL). The round trip below treats it as the
 * complete overlay of a box padded round its own features: a test of the
 * split and the assembly, not a claim about what was mapped outside it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
    ENABLING_CLASSES,
    OVERLAY_CLASSES,
    assembleFromTiles,
    dateWords,
    emptyPackOverlay,
    endpointAreaKeys,
    featureBbox,
    featureKey,
    overlayIsAllEmpty,
    overlayWithin,
    splitOverlayIntoTiles,
    tileAlignedFetchBbox,
    tileBounds,
    tileKeyFor,
    tileKeysForBbox,
    tileKeysFullyInside,
    tileSignature,
    type Bbox,
    type PackOverlay,
} from '../../services/waterPack/waterPackTiles';

const NEWPORT = { lat: -27.2127, lon: 153.0912 };
const HAMILTON_MARINA = { lat: -20.3487, lon: 148.9567 };
const AIRLIE = { lat: -20.2653, lon: 148.7082 };

const square = (w: number, s: number, e: number, n: number, props: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});
const overlayWith = (parts: Partial<Record<(typeof OVERLAY_CLASSES)[number], Feature[]>>): PackOverlay => {
    const o = emptyPackOverlay();
    for (const [k, features] of Object.entries(parts)) o[k as (typeof OVERLAY_CLASSES)[number]].features = features!;
    return o;
};

describe('tile keys', () => {
    it('names the tiles the plan names: Newport, Hamilton Island marina, Airlie', () => {
        expect(tileKeyFor(NEWPORT)).toBe('3061_-545');
        expect(tileKeyFor(HAMILTON_MARINA)).toBe('2979_-407');
        expect(tileKeyFor(AIRLIE)).toBe('2974_-406');
        expect(tileBounds('2974_-406').map((v) => +v.toFixed(6))).toEqual([148.7, -20.3, 148.75, -20.25]);
    });

    it("an endpoint's area reaches the next tile when the pin is within 0.01° of an edge", () => {
        // The Hamilton Island marina sits 1.4 km north of a tile edge.
        const keys = endpointAreaKeys(HAMILTON_MARINA);
        expect(keys).toContain('2979_-407');
        expect(keys).toContain('2979_-408');
        // So does Airlie's: its pin is 0.008° (~850 m) east of the 148.70° edge.
        expect(endpointAreaKeys(AIRLIE).sort()).toEqual(['2973_-406', '2974_-406']);
        // A pin well inside its tile needs only that tile.
        expect(endpointAreaKeys({ lat: -20.275, lon: 148.725 })).toEqual(['2974_-406']);
    });

    it('keeps only tiles fully inside the fetched bbox shrunk by the 0.01° margin', () => {
        // 153.04..153.16 × -27.26..-27.14 holds 153.05..153.15 × -27.25..-27.15.
        expect(tileKeysFullyInside([153.03, -27.27, 153.17, -27.13]).sort()).toEqual(
            ['3061_-545', '3061_-544', '3062_-545', '3062_-544'].sort(),
        );
        // The same box with no margin to spare loses the edge tiles.
        expect(tileKeysFullyInside([153.045, -27.255, 153.155, -27.145])).toEqual([]);
        expect(tileKeysFullyInside([153.045, -27.255, 153.155, -27.145], 0)).toHaveLength(4);
        // An aligned 3×3 square fetched ±0.01° yields exactly its nine tiles.
        expect(tileKeysFullyInside([148.64, -20.36, 148.81, -20.19])).toHaveLength(9);
    });

    it('lists the tiles a bbox touches, without the neighbour it only meets at an edge', () => {
        expect(tileKeysForBbox([153.06, -27.24, 153.12, -27.16]).sort()).toEqual(
            ['3061_-545', '3061_-544', '3062_-545', '3062_-544'].sort(),
        );
        expect(tileKeysForBbox([153.05, -27.25, 153.1, -27.2])).toEqual(['3061_-545']);
    });

    it('an antimeridian (W > E) or inverted bbox yields no tiles', () => {
        expect(tileKeysForBbox([179.9, -17, -179.9, -16.9])).toEqual([]);
        expect(tileKeysFullyInside([179.5, -17.5, -179.5, -16.5])).toEqual([]);
        expect(tileKeysForBbox([153.1, -27.1, 153.2, -27.2])).toEqual([]);
    });
});

describe('features', () => {
    it("computes a feature's bbox from its geometry, never trusting f.bbox", () => {
        const f = { ...square(153.06, -27.24, 153.07, -27.23), bbox: [0, 0, 1, 1] } as Feature;
        expect(featureBbox(f)).toEqual([153.06, -27.24, 153.07, -27.23]);
        expect(featureBbox({ type: 'Feature', properties: {}, geometry: null } as unknown as Feature)).toBeNull();
    });

    it('keys a feature by class, _osmId AND its own extent: multipolygon outers share an id', () => {
        const a = square(153.06, -27.24, 153.07, -27.23, { _osmId: 9 });
        const b = square(153.08, -27.24, 153.09, -27.23, { _osmId: 9 });
        expect(featureKey('water', a)).not.toBe(featureKey('water', b));
        expect(featureKey('water', a)).toBe(featureKey('water', structuredClone(a)));
        expect(featureKey('water', a)).not.toBe(featureKey('reef', a));
    });

    it('names the four enabling classes; the rest always count', () => {
        expect([...ENABLING_CLASSES].sort()).toEqual(['canalLines', 'marina', 'navLines', 'water']);
        expect(overlayIsAllEmpty(emptyPackOverlay())).toBe(true);
        expect(overlayIsAllEmpty(overlayWith({ berths: [square(0, 0, 0.001, 0.001)] }))).toBe(false);
    });
});

describe('split and assemble', () => {
    it('a round trip of newport-pinkenba-osm keeps every class count exactly (354 water, shared-id outers included)', () => {
        const raw = JSON.parse(
            gunzipSync(readFileSync(join(__dirname, '..', 'fixtures', 'newport-pinkenba-osm.json.gz'))).toString(),
        ) as Record<string, FeatureCollection>;
        const overlay = emptyPackOverlay();
        for (const k of OVERLAY_CLASSES) overlay[k] = raw[k];
        // The box round every feature, padded so all of its tiles are whole.
        let box: [number, number, number, number] = [180, 90, -180, -90];
        for (const k of OVERLAY_CLASSES)
            for (const f of overlay[k].features) {
                const b = featureBbox(f)!;
                box = [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])];
            }
        const fetched: [number, number, number, number] = [box[0] - 0.07, box[1] - 0.07, box[2] + 0.07, box[3] + 0.07];
        const tiles = splitOverlayIntoTiles(overlay, fetched);
        expect(tiles.size).toBeGreaterThan(20);
        const back = assembleFromTiles(tiles, box);
        expect(back.coverage).toBe('full');
        for (const k of OVERLAY_CLASSES) expect(back.overlay[k].features.length, k).toBe(overlay[k].features.length);
        expect(back.overlay.water.features).toHaveLength(354);
        // The multipolygon whose outers share one _osmId survived whole.
        const ids = overlay.water.features.map((f) => f.properties?._osmId);
        const shared = ids.find((id, i) => ids.indexOf(id) !== i);
        expect(shared).toBeDefined();
        expect(back.overlay.water.features.filter((f) => f.properties?._osmId === shared).length).toBe(
            overlay.water.features.filter((f) => f.properties?._osmId === shared).length,
        );
    });

    it('stores whole, unclipped features in every tile they touch, and only whole tiles', () => {
        // One canal polygon straddling the 153.10 edge of two tiles.
        const canal = square(153.09, -27.21, 153.11, -27.205, { _osmId: 1, waterway: 'canal' });
        const tiles = splitOverlayIntoTiles(overlayWith({ water: [canal] }), [153.03, -27.27, 153.17, -27.13]);
        expect([...tiles.keys()].sort()).toEqual(['3061_-545', '3061_-544', '3062_-545', '3062_-544'].sort());
        expect(tiles.get('3061_-545')!.water.features[0]).toEqual(canal);
        expect(tiles.get('3062_-545')!.water.features[0]).toEqual(canal);
        expect(overlayIsAllEmpty(tiles.get('3061_-544')!)).toBe(true);
    });

    it('water reaching a missing tile is dropped; a reef doing the same is kept', () => {
        const canal = square(153.09, -27.21, 153.11, -27.205, { _osmId: 1, waterway: 'canal' });
        const reef = square(153.09, -27.22, 153.11, -27.215, { _osmId: 2, natural: 'reef' });
        const inside = square(153.06, -27.22, 153.07, -27.21, { _osmId: 3, natural: 'water' });
        const tiles = splitOverlayIntoTiles(
            overlayWith({ water: [canal, inside], reef: [reef] }),
            [153.03, -27.27, 153.17, -27.13],
        );
        tiles.delete('3062_-545');
        const back = assembleFromTiles(tiles, [153.06, -27.24, 153.14, -27.16]);
        expect(back.coverage).toBe('partial');
        expect(back.overlay.water.features.map((f) => f.properties?._osmId)).toEqual([3]);
        expect(back.overlay.reef.features.map((f) => f.properties?._osmId)).toEqual([2]);
        // Only the part of the feature inside the asked bbox has to be present.
        const narrow = assembleFromTiles(tiles, [153.06, -27.24, 153.099, -27.16]);
        expect(narrow.overlay.water.features.map((f) => f.properties?._osmId).sort()).toEqual([1, 3]);
    });

    it('says none when no tile is present, and dedupes a feature held by two tiles', () => {
        expect(assembleFromTiles(new Map(), [153.06, -27.24, 153.14, -27.16]).coverage).toBe('none');
        const canal = square(153.09, -27.21, 153.11, -27.205, { _osmId: 1 });
        const tiles = splitOverlayIntoTiles(overlayWith({ water: [canal] }), [153.03, -27.27, 153.17, -27.13]);
        const back = assembleFromTiles(tiles, [153.06, -27.24, 153.14, -27.16]);
        expect(back.overlay.water.features).toHaveLength(1);
        expect(back.presentKeys.sort()).toEqual(['3061_-545', '3061_-544', '3062_-545', '3062_-544'].sort());
    });

    it('gives the same signature for the same content in any order, and a new one when a tag changes', () => {
        const a = square(153.06, -27.22, 153.07, -27.21, { _osmId: 1 });
        const b = square(153.08, -27.22, 153.09, -27.21, { _osmId: 2 });
        const one = splitOverlayIntoTiles(overlayWith({ water: [a, b] }), [153.03, -27.27, 153.17, -27.13]);
        const two = splitOverlayIntoTiles(overlayWith({ water: [b, a] }), [153.03, -27.27, 153.17, -27.13]);
        expect(tileSignature(one.get('3061_-545')!)).toBe(tileSignature(two.get('3061_-545')!));
        const edited = square(153.06, -27.22, 153.07, -27.21, { _osmId: 1, water: 'canal' });
        const three = splitOverlayIntoTiles(overlayWith({ water: [edited, b] }), [153.03, -27.27, 153.17, -27.13]);
        expect(tileSignature(three.get('3061_-545')!)).not.toBe(tileSignature(one.get('3061_-545')!));
    });
});

describe('dates in words', () => {
    it('says an absolute date for caveats', () => {
        const at = new Date(2026, 8, 28, 12).getTime();
        expect(dateWords(at, at)).toBe('28 Sep');
        expect(dateWords(new Date(2025, 11, 3, 12).getTime(), at)).toBe('3 Dec 2025');
    });
});

// Fix-up (2026-10-02).
describe('a newer saved tile supersedes the water an older neighbour still holds', () => {
    const DAY = 86_400_000;
    const JUNE = Date.UTC(2026, 5, 1);
    const SEPT = Date.UTC(2026, 8, 1);
    // The basin (way/1) as June had it: 153.07–153.13, across two tiles.
    const juneBasin = square(153.07, -27.23, 153.13, -27.21, { _osmId: 1, leisure: 'marina' });
    // September: the eastern half reclaimed — the basin now ends at 153.095.
    const septBasin = square(153.07, -27.23, 153.095, -27.21, { _osmId: 1, leisure: 'marina' });
    const ROUTE: Bbox = [153.06, -27.24, 153.14, -27.21];
    const A = '3061_-545';
    const B = '3062_-545';

    it('a newer tile that does not hold the basin drops it; the newer copy is used once its tile is saved', () => {
        const june = splitOverlayIntoTiles(overlayWith({ marina: [juneBasin] }), [153.04, -27.26, 153.16, -27.19]);
        expect([...june.keys()].sort()).toEqual([A, B]);
        // September's verified refresh covered only B (A lay only partly
        // inside its bbox): B now holds no such water.
        const sept = splitOverlayIntoTiles(overlayWith({ marina: [septBasin] }), [153.09, -27.26, 153.16, -27.19]);
        expect([...sept.keys()]).toEqual([B]);
        expect(overlayIsAllEmpty(sept.get(B)!)).toBe(true);
        const tiles = new Map([
            [A, june.get(A)!],
            [B, sept.get(B)!],
        ]);
        // Without dates: the old rule, the June basin over the hardstand.
        expect(assembleFromTiles(tiles, ROUTE).overlay.marina.features).toHaveLength(1);
        const dated = new Map([
            [A, JUNE],
            [B, SEPT],
        ]);
        const back = assembleFromTiles(tiles, ROUTE, dated);
        expect(back.coverage).toBe('full');
        expect(back.overlay.marina.features).toEqual([]);

        // September's refresh of A brings the new basin: used.
        const septA = splitOverlayIntoTiles(overlayWith({ marina: [septBasin] }), [153.04, -27.26, 153.11, -27.19]);
        tiles.set(A, septA.get(A)!);
        dated.set(A, SEPT + DAY);
        expect(assembleFromTiles(tiles, ROUTE, dated).overlay.marina.features).toEqual([septBasin]);
    });

    it('an older tile without the feature does not drop it, and obstacles are never dropped', () => {
        const reef = square(153.07, -27.24, 153.13, -27.235, { _osmId: 2, natural: 'reef' });
        const june = splitOverlayIntoTiles(overlayWith({ reef: [reef] }), [153.04, -27.26, 153.16, -27.19]);
        const sept = splitOverlayIntoTiles(overlayWith({ marina: [juneBasin] }), [153.04, -27.26, 153.16, -27.19]);
        const tiles = new Map([
            [A, sept.get(A)!],
            [B, june.get(B)!],
        ]);
        const back = assembleFromTiles(
            tiles,
            ROUTE,
            new Map([
                [A, SEPT],
                [B, JUNE],
            ]),
        );
        // A (newer) holds the basin; B (older) does not: the basin stays.
        expect(back.overlay.marina.features).toHaveLength(1);
        // The reef is only in B, which A (newer, without it) cannot drop.
        expect(back.overlay.reef.features).toHaveLength(1);
    });

    it('where two tiles hold the same feature, the newest copy is used', () => {
        const older = square(153.09, -27.21, 153.11, -27.205, { _osmId: 5, natural: 'water', name: 'old' });
        const newer = square(153.09, -27.21, 153.11, -27.205, { _osmId: 5, natural: 'water', name: 'new' });
        const a = splitOverlayIntoTiles(overlayWith({ water: [older] }), [153.04, -27.26, 153.16, -27.19]);
        const b = splitOverlayIntoTiles(overlayWith({ water: [newer] }), [153.04, -27.26, 153.16, -27.19]);
        const back = assembleFromTiles(
            new Map([
                [A, a.get(A)!],
                [B, b.get(B)!],
            ]),
            ROUTE,
            new Map([
                [A, JUNE],
                [B, SEPT],
            ]),
        );
        expect(back.overlay.water.features.map((f) => f.properties?.name)).toEqual(['new']);
    });
});

describe('fetched on the tile grid, a route bbox reads back whole (2026-10-02)', () => {
    it("every tile a route's bbox touches is wholly inside its aligned fetch bbox", () => {
        // newport-shane's router bbox (±0.1° round the pins) touches 54 tiles;
        // fetched as it was, 14 could be saved.
        const route: Bbox = [152.9912, -27.5442, 153.2046, -27.1127];
        expect(tileKeysForBbox(route)).toHaveLength(54);
        expect(tileKeysFullyInside(route)).toHaveLength(14);
        const fetch = tileAlignedFetchBbox(route);
        expect(fetch).toEqual([152.94, -27.56, 153.26, -27.09]);
        expect(tileKeysFullyInside(fetch).sort()).toEqual(tileKeysForBbox(route).sort());
        // Antimeridian: unchanged.
        expect(tileAlignedFetchBbox([179.9, -17, -179.9, -16.9])).toEqual([179.9, -17, -179.9, -16.9]);
    });

    it('overlayWithin keeps the features whose extent meets the bbox — the set the tiles give back', () => {
        const inside = square(153.06, -27.22, 153.07, -27.21, { _osmId: 1 });
        const across = square(153.13, -27.22, 153.17, -27.21, { _osmId: 2 });
        const outside = square(153.2, -27.22, 153.21, -27.21, { _osmId: 3 });
        const overlay = overlayWith({ water: [inside, across, outside] });
        const route: Bbox = [153.06, -27.24, 153.14, -27.16];
        const online = overlayWithin(overlay, route);
        expect(online.water.features.map((f) => f.properties?._osmId)).toEqual([1, 2]);
        const fetched = tileAlignedFetchBbox(route);
        const back = assembleFromTiles(splitOverlayIntoTiles(overlay, fetched), route);
        expect(back.coverage).toBe('full');
        expect(back.overlay.water.features.map((f) => f.properties?._osmId).sort()).toEqual([1, 2]);
    });

    it('lists the extents of the water it left out for a missing tile', () => {
        const canal = square(153.09, -27.21, 153.11, -27.205, { _osmId: 1, waterway: 'canal' });
        const tiles = splitOverlayIntoTiles(overlayWith({ water: [canal] }), [153.03, -27.27, 153.17, -27.13]);
        tiles.delete('3062_-545');
        const back = assembleFromTiles(tiles, [153.06, -27.24, 153.14, -27.16]);
        expect(back.overlay.water.features).toEqual([]);
        expect(back.unsavedWater).toEqual([[153.09, -27.21, 153.11, -27.205]]);
        expect(assembleFromTiles(tiles, [153.06, -27.24, 153.099, -27.16]).unsavedWater).toEqual([]);
    });
});
