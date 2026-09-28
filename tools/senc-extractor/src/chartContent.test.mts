import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameChartContentIgnoringSencBuildDate } from './chartContent.js';

function batch(date = '20260921') {
    return {
        cells: [
            {
                cellId: 'OC-61-001012',
                sourceCellId: 'AU210100',
                sourceHO: 'AU',
                edition: 2,
                updateNumber: 2,
                issued: '2017-12-20',
                sencCreateDate: date,
                soundingDatum: 'LAT',
                bbox: [150, -30, 151, -29],
                layers: {
                    DEPARE: {
                        type: 'FeatureCollection',
                        features: [
                            {
                                type: 'Feature',
                                properties: { DRVAL1: 5, sencCreateDate: 'a navigation property stays significant' },
                                geometry: {
                                    type: 'Polygon',
                                    coordinates: [
                                        [
                                            [150, -30],
                                            [151, -30],
                                            [151, -29],
                                            [150, -30],
                                        ],
                                    ],
                                },
                            },
                        ],
                    },
                },
            },
        ],
    };
}

test('only the top-level SENC build date is omitted from a same-content comparison', () => {
    const first = batch();
    const second = batch('20260824');
    assert.equal(sameChartContentIgnoringSencBuildDate(JSON.stringify(first), JSON.stringify(second)), true);
    // Transport whitespace and object member order are not chart content.
    const reversed = { cells: [Object.fromEntries(Object.entries(second.cells[0]).reverse())] };
    assert.equal(sameChartContentIgnoringSencBuildDate(JSON.stringify(first), JSON.stringify(reversed, null, 2)), true);
});

test('geometry, hazard properties, revisions, provenance, datum and unknown fields remain significant', () => {
    const original = JSON.stringify(batch());
    const changes: Array<(value: ReturnType<typeof batch>) => void> = [
        (value) => {
            value.cells[0].layers.DEPARE.features[0].geometry.coordinates[0][0][0] += 0.001;
        },
        (value) => {
            value.cells[0].layers.DEPARE.features[0].geometry.coordinates[0].reverse();
        },
        (value) => {
            value.cells[0].layers.DEPARE.features[0].properties.DRVAL1 = 1;
        },
        (value) => {
            value.cells[0].layers.DEPARE.features[0].properties.sencCreateDate = 'must not be ignored recursively';
        },
        (value) => {
            value.cells[0].edition = 3;
        },
        (value) => {
            value.cells[0].updateNumber = 3;
        },
        (value) => {
            value.cells[0].issued = '2018-01-01';
        },
        (value) => {
            value.cells[0].sourceCellId = 'AU210101';
        },
        (value) => {
            value.cells[0].sourceHO = 'NZ';
        },
        (value) => {
            value.cells[0].soundingDatum = 'MSL';
        },
        (value) => {
            Object.assign(value.cells[0], { futureNavigationField: 'changed' });
        },
    ];
    for (const change of changes) {
        const changed = batch('20260824');
        change(changed);
        assert.equal(sameChartContentIgnoringSencBuildDate(original, JSON.stringify(changed)), false);
    }
});

test('malformed batches and non-date metadata fail closed', () => {
    for (const invalid of [
        'not json',
        'null',
        '[]',
        '{}',
        '{"cells":[]}',
        '{"cells":[null]}',
        '{"cells":[{"depth":1e999}]}',
    ]) {
        assert.equal(sameChartContentIgnoringSencBuildDate(invalid, invalid), false);
    }
    const invalidDate = batch('unexpected');
    const excessiveDepth = '{"cells":[{"extra":' + '['.repeat(129) + '0' + ']'.repeat(129) + '}]}';
    assert.equal(sameChartContentIgnoringSencBuildDate(excessiveDepth, excessiveDepth), false);
    assert.equal(
        sameChartContentIgnoringSencBuildDate(JSON.stringify(invalidDate), JSON.stringify(invalidDate)),
        false,
    );
});
