import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversionLayers, dsidDatum } from './encLayerContract.js';
const fc = (n = 0) => ({ type: 'FeatureCollection' as const, features: Array.from({ length: n }, () => ({})) });
test('DSPM SDAT and VDAT stay distinct, missing differs from explicit unknown', () => {
    assert.equal(dsidDatum({ DSPM_SDAT: 0, DSPM_VDAT: 1 }, ['12', '23'], 'SDAT'), 12);
    assert.equal(dsidDatum({ DSPM_SDAT: 0, DSPM_VDAT: 1 }, ['12', '23'], 'VDAT'), 23);
    assert.equal(dsidDatum({ DSPM_VDAT: 0 }, ['23'], 'SDAT'), undefined);
    assert.equal(dsidDatum({ SDAT: 0 }, [''], 'SDAT'), undefined);
    assert.equal(dsidDatum({ SDAT: 0 }, ['0'], 'SDAT'), 0);
    assert.equal(dsidDatum({ SDAT: 0 }, ['bad'], 'SDAT'), 0);
    assert.equal(dsidDatum({ SDAT: 0 }, ['65535'], 'SDAT'), 65535);
});

test('M_SDAT requires complete feature counts; failed and partial extraction cannot assert none', () => {
    assert.deepEqual(conversionLayers({ M_SDAT: 'absent' }, {}).layers.M_SDAT, {
        type: 'FeatureCollection',
        features: [],
    });
    assert.equal(conversionLayers({ M_SDAT: null }, {}).layers.M_SDAT, undefined);
    assert.equal(conversionLayers({ M_SDAT: 'absent' }, { M_SDAT: 1 }).layers.M_SDAT, undefined);
    assert.equal(conversionLayers({ M_SDAT: fc(1) }, { M_SDAT: 2 }).layers.M_SDAT, undefined);
    assert.equal(conversionLayers({ M_SDAT: fc(1) }, {}).layers.M_SDAT, undefined);
    assert.equal(conversionLayers({ M_SDAT: fc(2) }, { M_SDAT: 2 }).layers.M_SDAT?.features.length, 2);
});
