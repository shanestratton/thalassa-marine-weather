import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VaultLookahead, validLookaheadRequest } from './lookahead.js';
import type { VaultLookaheadRequest, VaultCellMeta } from './protocol.js';
import type { EncConversionResult } from '../lookaheadShared/services/enc/types.js';

const makeRequest = (): VaultLookaheadRequest => ({
    fix: { lat: 0, lon: 0, at: Date.now(), sogKn: 6, cogDeg: 0 },
    draftM: 2,
    ukcM: 0.5,
    windowMin: 10,
    onLine: false,
});
const meta: VaultCellMeta = {
    cellId: 'ZZSYNTH',
    sourceHO: 'ZZ',
    edition: 1,
    issued: '2026-10-15',
    bbox: [-1, -1, 1, 1],
    featureCount: 1,
    sizeBytes: 100,
    contentSha256: 'a'.repeat(64),
    installedAt: '2026-10-15T00:00:00Z',
    source: 'pi-decrypt',
    licence: 'protected',
};
function chart(depth: number, datum?: number): EncConversionResult {
    return {
        cellId: meta.cellId,
        sourceHO: 'ZZ',
        edition: 1,
        issued: meta.issued,
        bbox: meta.bbox,
        extractorSchema: 3,
        ...(datum === undefined ? {} : { soundingDatum: datum }),
        layers: {
            M_SDAT: { type: 'FeatureCollection', features: [] },
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { DRVAL1: depth },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [-1, -1],
                                    [1, -1],
                                    [1, 1],
                                    [-1, 1],
                                    [-1, -1],
                                ],
                            ],
                        },
                    },
                ],
            },
        },
    };
}
function read(cell: EncConversionResult) {
    return async () => ({ bytes: Buffer.from(JSON.stringify({ cells: [cell] })), sha256: meta.contentSha256 });
}
test('vault refuses stale/future fixes, invalid speed, UKC, windows and oversized/unordered tide curves', () => {
    const q = makeRequest();
    assert.equal(validLookaheadRequest(q), true);
    for (const bad of [
        { ...q, fix: { ...q.fix, at: q.fix.at - 30_001 } },
        { ...q, fix: { ...q.fix, at: q.fix.at + 5001 } },
        { ...q, fix: { ...q.fix, sogKn: 0 } },
        { ...q, ukcM: 0.49 },
        { ...q, windowMin: 16 },
        {
            ...q,
            tide: {
                datum: 'LAT',
                expires: q.fix.at + 1000,
                points: Array.from({ length: 65 }, (_, i) => ({ dt: i, height: 1 })),
            },
        },
        {
            ...q,
            tide: {
                datum: 'LAT',
                expires: q.fix.at + 1000,
                points: [
                    { dt: 1, height: 1 },
                    { dt: 0, height: 1 },
                ],
            },
        },
    ])
        assert.equal(validLookaheadRequest(bad, q.fix.at), false);
});
test('the vault uses the shared exact draft+UKC rule and returns only generic safety state', async () => {
    const q = makeRequest();
    const answer = await new VaultLookahead().query(q, [meta], read(chart(2.49)));
    assert.deepEqual(answer, { coverage: 'charted', danger: true });
    assert.deepEqual(Object.keys(answer).sort(), ['coverage', 'danger']);
    assert.deepEqual(await new VaultLookahead().query(q, [meta], read(chart(2.5))), {
        coverage: 'charted',
        danger: false,
    });
    assert.equal((await new VaultLookahead().query({ ...q, ukcM: 0.7 }, [meta], read(chart(2.6)))).danger, true);
});
test('positive tide credit requires explicit matching per-cell datum, negative tide is retained', async () => {
    const q = makeRequest();
    q.tide = {
        datum: 'LAT',
        expires: Date.now() + 3600_000,
        points: [
            { dt: q.fix.at / 1000, height: 1 },
            { dt: q.fix.at / 1000 + 1000, height: 1 },
        ],
    };
    assert.equal((await new VaultLookahead().query(q, [meta], read(chart(2, 23)))).danger, false);
    assert.equal((await new VaultLookahead().query(q, [meta], read(chart(2)))).danger, true);
    assert.equal((await new VaultLookahead().query(q, [meta], read(chart(2, 12)))).danger, true);
    q.tide.points.forEach((p) => (p.height = -0.3));
    assert.equal((await new VaultLookahead().query(q, [meta], read(chart(2.6, 23)))).danger, true);
});
test('failed reads and partial area coverage never report charted clear water', async () => {
    const q = makeRequest();
    assert.deepEqual(
        await new VaultLookahead().query(q, [meta], async () => {
            throw new Error('offline');
        }),
        { coverage: 'unavailable', danger: false },
    );
    const cell = chart(20);
    cell.layers.DEPARE!.features[0].geometry = {
        type: 'Polygon',
        coordinates: [
            [
                [-1, -1],
                [1, -1],
                [1, 0.005],
                [-1, 0.005],
                [-1, -1],
            ],
        ],
    };
    assert.equal((await new VaultLookahead().query(q, [meta], read(cell))).coverage, 'partial');
});
test('canonical coastline-only intersections are retained without widening a neighbouring rock', async () => {
    const q = makeRequest();
    const cell = chart(20);
    cell.layers.COALNE = {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [-0.01, 0.005],
                        [0.01, 0.005],
                    ],
                },
            },
        ],
    };
    assert.equal((await new VaultLookahead().query(q, [meta], read(cell))).danger, true);
    cell.layers.COALNE.features = [];
    cell.layers.UWTROC = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0.001, 0.005] } }],
    };
    assert.equal((await new VaultLookahead().query(q, [meta], read(cell))).danger, false);
});
test('an outstanding chart read prevents overlapping queries', async () => {
    const q = makeRequest(),
        vault = new VaultLookahead();
    let release!: (got: { bytes: Buffer; sha256: string }) => void;
    const pending = vault.query(q, [meta], () => new Promise((resolve) => (release = resolve)));
    assert.deepEqual(await vault.query(q, [meta], read(chart(2))), { coverage: 'unavailable', danger: false });
    release(await read(chart(2))());
    assert.equal((await pending).danger, true);
});
