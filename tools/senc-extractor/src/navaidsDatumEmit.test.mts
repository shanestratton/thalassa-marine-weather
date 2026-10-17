import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SencFeature } from './featureParser.js';
import { emitCell } from './geojsonEmitter.js';
import { EXTRACTOR_SCHEMA, ROUTING_CLASSES } from './s57Classes.js';

const navaids = ['LITFLT', 'LITVES', 'BOYINB', 'MORFAC', 'FOGSIG', 'TOPMAR', 'DAYMAR'];
const feature = (acronym: string, rcid = 1): SencFeature => ({
    acronym,
    classCode: 1,
    rcid,
    primitive: 1,
    attributes: { TOPSHP: 14, CATMOR: 7 },
    geometry: { type: 'Point', coordinates: [153, -27] },
});
const zone = (rcid = 10): SencFeature => ({
    ...feature('M_SDAT', rcid),
    primitive: 3,
    attributes: { VERDAT: 23 },
    geometry: {
        type: 'Area',
        rings: [
            [
                [153, -27],
                [153.1, -27],
                [153.1, -27.1],
                [153, -27],
            ],
        ],
        triangles: [],
        extent: { sLat: -27.1, nLat: -27, wLon: 153, eLon: 153.1 },
    },
});
const opts = { cellId: 'AU5TEST1', sourceHO: 'AU' };

test('schema3 extracts all seven additional navaids with original attributes', () => {
    assert.equal(EXTRACTOR_SCHEMA, 3);
    for (const c of navaids) assert.ok(ROUTING_CLASSES.has(c), c);
    const cell = emitCell(
        { soundingDatum: 'LAT' },
        navaids.map((c, i) => feature(c, i + 1)),
        opts,
    );
    assert.equal(cell.soundingDatum, 'LAT');
    for (const c of navaids) {
        assert.equal(cell.layers[c].features.length, 1, c);
        assert.equal(cell.layers[c].features[0].properties.TOPSHP, 14);
    }
});
test('M_SDAT is complete-empty only when none charted; any unbuilt override makes it unknown', () => {
    assert.deepEqual(emitCell({}, [], opts).layers.M_SDAT, { type: 'FeatureCollection', features: [] });
    const good = zone();
    assert.equal(emitCell({}, [good], opts).layers.M_SDAT.features[0].properties.VERDAT, 23);
    const broken = { ...zone(11), geometry: null };
    assert.equal(emitCell({}, [good, broken], opts).layers.M_SDAT, undefined);
    assert.equal(emitCell({}, [broken], opts).layers.M_SDAT, undefined);
    const restricted = emitCell({}, [], { ...opts, classes: new Set(['DEPARE']) });
    assert.equal(restricted.layers.M_SDAT, undefined, 'a deliberately skipped layer is never complete-empty');
});
