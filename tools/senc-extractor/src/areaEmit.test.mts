import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { featureToGeoJson } from './geojsonEmitter.js';
import type { SencFeature } from './featureParser.js';

/**
 * End-to-end wiring for the S-63 area path.
 *
 * meshOutline is unit-tested on its own, but a correct algorithm that is not
 * actually reached emits exactly the same triangle soup as no algorithm at
 * all — the two are indistinguishable in the output file. These tests pin the
 * emitter side of that seam.
 */

const areaFeature = (geometry: SencFeature['geometry']): SencFeature => ({
    classCode: 42,
    acronym: 'DEPARE',
    rcid: 7,
    primitive: 3,
    attributes: { DRVAL1: 0, DRVAL2: 5 },
    geometry,
});

const square = (ox: number, oy: number, s = 1): [number, number][] => [
    [ox, oy],
    [ox + s, oy],
    [ox + s, oy + s],
    [ox, oy + s],
    [ox, oy],
];

describe('area emission', () => {
    it('emits a Polygon when the mesh dissolved to one outline', () => {
        const f = areaFeature({
            type: 'Area',
            triangles: [],
            polygons: [[square(0, 0)]],
            extent: { sLat: 0, nLat: 1, wLon: 0, eLon: 1 },
        });
        const out = featureToGeoJson(f);
        assert.ok(out?.geometry);
        assert.equal(out.geometry.type, 'Polygon');
    });

    it('emits a MultiPolygon for disjoint parts rather than nesting them', () => {
        // Through `rings` the second island would become a hole in the first.
        const f = areaFeature({
            type: 'Area',
            triangles: [],
            polygons: [[square(0, 0)], [square(10, 10)]],
            extent: { sLat: 0, nLat: 11, wLon: 0, eLon: 11 },
        });
        const out = featureToGeoJson(f);
        assert.ok(out?.geometry);
        assert.equal(out.geometry.type, 'MultiPolygon');
        assert.equal((out.geometry.coordinates as unknown[]).length, 2);
    });

    it('carries holes through in order, outer first', () => {
        const outer = square(0, 0, 30);
        const hole = square(10, 10, 10).slice().reverse() as [number, number][];
        const f = areaFeature({
            type: 'Area',
            triangles: [],
            polygons: [[outer, hole]],
            extent: { sLat: 0, nLat: 30, wLon: 0, eLon: 30 },
        });
        const out = featureToGeoJson(f);
        assert.ok(out?.geometry);
        assert.equal(out.geometry.type, 'Polygon');
        assert.equal((out.geometry.coordinates as unknown[]).length, 2, 'outer + hole');
    });

    it('still emits triangles when the mesh could not be dissolved', () => {
        // meshToPolygons returning null must leave today's behaviour intact,
        // not drop the feature.
        const tri: [[number, number], [number, number], [number, number]] = [
            [0, 0],
            [1, 0],
            [1, 1],
        ];
        const f = areaFeature({
            type: 'Area',
            triangles: [tri],
            extent: { sLat: 0, nLat: 1, wLon: 0, eLon: 1 },
        });
        const out = featureToGeoJson(f);
        assert.ok(out?.geometry, 'feature must survive the fallback');
        assert.equal(out.geometry.type, 'MultiPolygon');
        assert.equal((out.geometry.coordinates as unknown[]).length, 1);
    });

    it('prefers the dissolved outline over the triangles when both are present', () => {
        // The parser sets BOTH — triangles are kept as the fallback. If the
        // emitter picked triangles first, every fix above would be inert.
        const tri: [[number, number], [number, number], [number, number]] = [
            [0, 0],
            [1, 0],
            [1, 1],
        ];
        const f = areaFeature({
            type: 'Area',
            triangles: [tri],
            polygons: [[square(0, 0)]],
            extent: { sLat: 0, nLat: 1, wLon: 0, eLon: 1 },
        });
        const out = featureToGeoJson(f);
        assert.ok(out?.geometry);
        assert.equal(out.geometry.type, 'Polygon', 'outline must win over triangles');
    });
});
