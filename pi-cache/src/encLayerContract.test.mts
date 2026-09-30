import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
    chartBlobExtractorSchema,
    conversionLayers,
    ENC_ALWAYS_EMITTED_LAYERS,
    ENC_CONVERSION_SCHEMA,
} from './encLayerContract.js';

// Part B (inshore router, 2026-09-30): the ogr2ogr (.000 upload) path must
// carry the bridge / overhead-clearance layers like the SENC extractor does —
// an empty collection when the cell charts none ("extracted, none charted"),
// never a missing key, which the app reads as "not extracted" (no lead is
// ever clear) — and say which conversion schema produced the cell, so a
// re-install of the same chart revision can replace the older conversion.

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-layer-contract-'));
process.env.ENC_CHART_DIR = path.join(root, 'store');
after(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

const fc = (n = 0) => ({ type: 'FeatureCollection' as const, features: Array.from({ length: n }, () => ({})) });

test('the always-emitted set is the five structure layers, and the ogr2ogr path extracts them', async () => {
    // CONVYR (overhead conveyor) joined in round 2 (2026-09-30).
    assert.deepEqual([...ENC_ALWAYS_EMITTED_LAYERS].sort(), ['BRIDGE', 'CBLOHD', 'CONVYR', 'PIPOHD', 'PONTON']);
    const { ENC_LAYERS } = await import('./routes/enc.js');
    for (const layer of ENC_ALWAYS_EMITTED_LAYERS) assert.ok(ENC_LAYERS.includes(layer), layer);
});

test('a structure layer the cell does not have is carried EMPTY; one that failed to convert stays unknown', () => {
    const { layers, featureCount } = conversionLayers({
        DEPARE: fc(3),
        LNDARE: 'absent',
        BRIDGE: fc(1),
        PONTON: 'absent',
        CBLOHD: 'absent',
        PIPOHD: null,
        CONVYR: 'absent',
    });
    assert.deepEqual(Object.keys(layers).sort(), ['BRIDGE', 'CBLOHD', 'CONVYR', 'DEPARE', 'PONTON']);
    assert.deepEqual(layers.CONVYR, { type: 'FeatureCollection', features: [] });
    assert.deepEqual(layers.PONTON, { type: 'FeatureCollection', features: [] });
    assert.deepEqual(layers.CBLOHD, { type: 'FeatureCollection', features: [] });
    assert.equal(layers.PIPOHD, undefined, 'unreadable output is not "none charted"');
    assert.equal(layers.LNDARE, undefined, 'only the structure layers are stamped empty');
    assert.equal(featureCount, 4);
});

test('the conversion schema is recorded and read back; legacy blobs read as schema 1', () => {
    assert.ok(Number.isSafeInteger(ENC_CONVERSION_SCHEMA) && ENC_CONVERSION_SCHEMA >= 2);
    assert.equal(chartBlobExtractorSchema(JSON.stringify({ cells: [{ cellId: 'A', extractorSchema: 2 }] })), 2);
    assert.equal(chartBlobExtractorSchema(JSON.stringify({ cells: [{ cellId: 'A' }] })), 1);
    assert.equal(chartBlobExtractorSchema(JSON.stringify({ cells: [{ extractorSchema: 'x' }] })), null);
    assert.equal(chartBlobExtractorSchema(JSON.stringify({ cells: [] })), null);
    assert.equal(chartBlobExtractorSchema('not json'), null);
});

// Phase 2a review (2026-09-30): ogr2ogr runs with -skipfailures, so a cell
// charting three bridges whose third will not convert produced a BRIDGE layer
// of two — read downstream as "extracted, complete": no bar for the missing
// bridge, and the lead review trusted the layer. The cell's own summary
// (ogrinfo -al -so, already run for its metadata) says how many features
// each layer has; a structure layer that comes back short is UNKNOWN.
const OGRINFO_SUMMARY = `INFO: Open of \`AU5TEST1.000'
      using driver \`S57' successful.

Layer name: DSID
Geometry: None
Feature Count: 1
Layer name: BRIDGE
Geometry: Unknown (any)
Feature Count: 3
Extent: (153.100000, -27.300000) - (153.200000, -27.200000)
Layer SRS WKT:
GEOGCRS["WGS 84"]
Layer name: CBLOHD
Geometry: Line String
Feature Count: 1
Layer name: DEPARE
Geometry: Polygon
Feature Count: 12
`;

test('the compilation scale is read from the DSID row (DSPM_CSCL), never guessed', async () => {
    const { dsidCompilationScale } = await import('./encLayerContract.js');
    assert.equal(dsidCompilationScale({ DSID_EDTN: 0, DSPM_CSCL: 1 }, ['3', '22000']), 22000);
    assert.equal(dsidCompilationScale({ CSCL: 0 }, ['90000']), 90000);
    assert.equal(dsidCompilationScale({ DSID_EDTN: 0 }, ['3']), null);
    assert.equal(dsidCompilationScale({ DSPM_CSCL: 0 }, ['']), null);
    assert.equal(dsidCompilationScale({ DSPM_CSCL: 0 }, ['0']), null);
    assert.equal(dsidCompilationScale({ DSPM_CSCL: 0 }, ['abc']), null);
});

test('the per-layer feature counts are read from the ogrinfo summary', async () => {
    const { ogrinfoLayerFeatureCounts } = await import('./encLayerContract.js');
    assert.deepEqual(ogrinfoLayerFeatureCounts(OGRINFO_SUMMARY), { DSID: 1, BRIDGE: 3, CBLOHD: 1, DEPARE: 12 });
});

test('a structure layer short of the cell summary is UNKNOWN, never a shorter "complete" list', () => {
    const counts = { BRIDGE: 3, CBLOHD: 1, DEPARE: 12 };
    const { layers } = conversionLayers(
        { DEPARE: fc(11), BRIDGE: fc(2), CBLOHD: fc(1), PONTON: 'absent', PIPOHD: 'absent' },
        counts,
    );
    assert.equal(layers.BRIDGE, undefined, '2 of 3 bridges converted: unknown');
    assert.equal(layers.CBLOHD?.features.length, 1, 'complete: kept');
    assert.deepEqual(layers.PONTON, { type: 'FeatureCollection', features: [] }, 'none in the cell: none charted');
    // Only the structure layers are held to the count.
    assert.equal(layers.DEPARE?.features.length, 11);
});

test('an overhead conveyor is held to the ogrinfo count like every structure layer (round 2, 2026-09-30)', () => {
    const short = conversionLayers(
        { BRIDGE: 'absent', PONTON: 'absent', CBLOHD: 'absent', PIPOHD: 'absent', CONVYR: fc(1) },
        { CONVYR: 2 },
    );
    assert.equal(short.layers.CONVYR, undefined, '1 of 2 conveyors converted: unknown');
    const whole = conversionLayers(
        { BRIDGE: 'absent', PONTON: 'absent', CBLOHD: 'absent', PIPOHD: 'absent', CONVYR: fc(2) },
        { CONVYR: 2 },
    );
    assert.equal(whole.layers.CONVYR?.features.length, 2, 'complete: kept');
    const missing = conversionLayers(
        { BRIDGE: 'absent', PONTON: 'absent', CBLOHD: 'absent', PIPOHD: 'absent', CONVYR: 'absent' },
        { CONVYR: 1 },
    );
    assert.equal(missing.layers.CONVYR, undefined, 'the summary lists one, the converter found none: unknown');
});

test('a structure layer the summary cannot vouch for is UNKNOWN', () => {
    const { layers } = conversionLayers(
        { BRIDGE: fc(1), PONTON: 'absent', CBLOHD: 'absent', PIPOHD: 'absent' },
        {
            CBLOHD: 2,
        },
    );
    assert.equal(layers.BRIDGE, undefined, 'converted features the summary never listed: unknown');
    assert.equal(layers.CBLOHD, undefined, 'summary lists 2, the converter found no layer: unknown');
    assert.deepEqual(layers.PIPOHD, { type: 'FeatureCollection', features: [] });
});
