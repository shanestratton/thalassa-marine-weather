import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_PREPPED_FEATURES, MAX_ROUTE_CELL_IDS, validateInshoreRouteBoundary } from './inshoreRouteBoundary.js';
import { routeInshore } from './services/inshoreRouter.js';

const normalRoute = {
    fromLat: -27.2,
    fromLon: 153.05,
    toLat: -27.35,
    toLon: 153.15,
    draftM: 2.4,
};

test('normal Pi inshore requests remain inside the shared budget', () => {
    assert.equal(
        validateInshoreRouteBoundary(
            {
                ...normalRoute,
                resolutionM: 50,
                safetyM: 0.5,
                obstructionBufferM: 60,
                minComponentCells: 25,
                cellIds: ['AU530150'],
            },
            { validateCellIds: true },
        ),
        null,
    );
    assert.equal(validateInshoreRouteBoundary({ ...normalRoute, layers: {} }, { validatePreparedLayers: true }), null);
});

test('world-scale and antimeridian-shaped requests fail before grid allocation', () => {
    for (const route of [
        { ...normalRoute, fromLon: -180, toLon: 180 },
        { ...normalRoute, fromLon: 179, toLon: -179 },
        { ...normalRoute, fromLat: -90, toLat: 90 },
    ]) {
        const result = validateInshoreRouteBoundary(route);
        assert.equal(result?.status, 413);
        assert.equal(result?.code, 'route-span-too-large');
    }

    const direct = routeInshore({}, { ...normalRoute, fromLon: -180, toLon: 180 });
    assert.equal('error' in direct, true);
    if ('error' in direct) assert.equal(direct.code, 'route-span-too-large');
});

test('tiny resolutions and otherwise excessive grids return stable 4xx issues', () => {
    for (const resolutionM of [0, -1, 0.001, 1_001, Number.POSITIVE_INFINITY, Number.NaN]) {
        const result = validateInshoreRouteBoundary({ ...normalRoute, resolutionM });
        assert.equal(result?.status, 400);
        assert.equal(result?.code, 'invalid-route-request');
    }

    // One degree is below the explicit span ceiling, but a 10 m padded grid
    // would contain hundreds of millions of cells. The size guard must win.
    const oversizedGrid = validateInshoreRouteBoundary({
        ...normalRoute,
        fromLat: -27,
        fromLon: 153,
        toLat: -26,
        toLon: 154,
        resolutionM: 10,
    });
    assert.equal(oversizedGrid?.status, 413);
    assert.equal(oversizedGrid?.code, 'route-grid-too-large');

    const direct = routeInshore(
        {},
        { ...normalRoute, fromLat: -27, fromLon: 153, toLat: -26, toLon: 154, resolutionM: 10 },
    );
    assert.equal('error' in direct, true);
    if ('error' in direct) assert.equal(direct.code, 'route-grid-too-large');
});

test('optional routing controls are finite and bounded', () => {
    for (const patch of [
        { resolutionM: '50' },
        { safetyM: -0.1 },
        { safetyM: 21 },
        { obstructionBufferM: -1 },
        { obstructionBufferM: 2_001 },
        { minComponentCells: 0 },
        { minComponentCells: 1.5 },
        { minComponentCells: 100_001 },
    ]) {
        const result = validateInshoreRouteBoundary({ ...normalRoute, ...patch });
        assert.equal(result?.status, 400, JSON.stringify(patch));
        assert.equal(result?.code, 'invalid-route-request', JSON.stringify(patch));
    }
});

test('explicit cell selection is an array of bounded canonical ids', () => {
    const tooMany = validateInshoreRouteBoundary(
        { ...normalRoute, cellIds: new Array(MAX_ROUTE_CELL_IDS + 1).fill('AU530150') },
        { validateCellIds: true },
    );
    assert.equal(tooMany?.status, 413);
    assert.equal(tooMany?.code, 'route-cell-selection-too-large');

    for (const cellIds of ['AU530150', ['../AU530150'], ['A'.repeat(65)], ['AU530150', 'AU530150']]) {
        const invalid = validateInshoreRouteBoundary({ ...normalRoute, cellIds }, { validateCellIds: true });
        assert.equal(invalid?.status, 400);
        assert.equal(invalid?.code, 'invalid-route-request');
    }
});

test('prepared route feature and coordinate totals are bounded', () => {
    const pointFeature = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [153.1, -27.2] },
    };
    const tooManyFeatures = validateInshoreRouteBoundary(
        {
            ...normalRoute,
            layers: {
                DEPARE: { type: 'FeatureCollection', features: new Array(MAX_PREPPED_FEATURES + 1).fill(pointFeature) },
            },
        },
        { validatePreparedLayers: true },
    );
    assert.equal(tooManyFeatures?.status, 413);
    assert.equal(tooManyFeatures?.code, 'route-data-too-large');

    // Reuse one small 21-position geometry 100,000 times. This exercises the
    // two-million-position ceiling without constructing a multi-million-object
    // fixture in the test process itself.
    const coordinateHeavyFeature = {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'LineString',
            coordinates: Array.from({ length: 21 }, (_, index) => [153 + index / 10_000, -27.2]),
        },
    };
    const tooManyCoordinates = validateInshoreRouteBoundary(
        {
            ...normalRoute,
            layers: {
                NAVLINE: {
                    type: 'FeatureCollection',
                    features: new Array(MAX_PREPPED_FEATURES).fill(coordinateHeavyFeature),
                },
            },
        },
        { validatePreparedLayers: true },
    );
    assert.equal(tooManyCoordinates?.status, 413);
    assert.equal(tooManyCoordinates?.code, 'route-data-too-large');

    const geometryCollection = validateInshoreRouteBoundary(
        {
            ...normalRoute,
            layers: {
                OBSTRN: {
                    type: 'FeatureCollection',
                    features: [
                        {
                            type: 'Feature',
                            properties: {},
                            geometry: {
                                type: 'GeometryCollection',
                                geometries: [
                                    { type: 'Point', coordinates: [153.1, -27.2] },
                                    { type: 'Point', coordinates: [153.11, -27.21] },
                                ],
                            },
                        },
                    ],
                },
            },
        },
        { validatePreparedLayers: true },
    );
    assert.equal(geometryCollection, null);
});
