import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Position } from 'geojson';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import type { FineCoverage } from '../../services/enc/clipDepareOverlap';
import type { GlazeUpgradeItem } from '../../services/enc/geometryUpgrades';

class FakeWorker {
    static posted: unknown[] = [];
    onmessage = null;
    onerror = null;
    postMessage(message: unknown): void {
        FakeWorker.posted.push(message);
    }
}

const polygon = (count: number): Feature => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [new Array<Position>(count).fill([0, 0])] },
});

const item = (features: Feature[], coverageIds: string[] = []): GlazeUpgradeItem => ({
    cellId: 'coarse',
    glazeKey: 'coarse@1',
    features,
    coverageIds,
    untouched: [],
});

const shell = (): EncMergedVectorData =>
    ({
        DEPARE_GLAZE: { type: 'FeatureCollection', features: [] },
        DEPCNT_DERIVED: { type: 'FeatureCollection', features: [] },
        SOUNDG: { type: 'FeatureCollection', features: [] },
        cellCount: 1,
    }) as unknown as EncMergedVectorData;

describe('glaze structured-clone admission', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.stubGlobal('Worker', FakeWorker);
        FakeWorker.posted = [];
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('rejects one large polygon before postMessage and releases its parked majority', async () => {
        const { dispatchGeometryWork, GLAZE_CLONE_HARD_CAP } = await import('../../services/enc/geometryUpgrades');
        const { glazeAssemblyCount, isGlazeInFlight } = await import('../../services/enc/glazeCellCache');
        const large = item([polygon(GLAZE_CLONE_HARD_CAP + 1)]);
        large.untouched = [polygon(5)];

        dispatchGeometryWork('merge', shell(), false, [large], [large.glazeKey]);

        expect(FakeWorker.posted).toHaveLength(0);
        expect(glazeAssemblyCount()).toBe(0);
        expect(isGlazeInFlight(large.glazeKey)).toBe(false);
    });

    it('counts all multipolygon rings together with the shared coverage vertices', async () => {
        const { dispatchGeometryWork, GLAZE_CLONE_HARD_CAP } = await import('../../services/enc/geometryUpgrades');
        const half = Math.floor(GLAZE_CLONE_HARD_CAP / 2);
        const multi: Feature = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'MultiPolygon',
                coordinates: [[new Array<Position>(half).fill([0, 0])], [new Array<Position>(half - 10).fill([0, 0])]],
            },
        };
        const coverage = new Map<string, FineCoverage>([
            ['fine', { bbox: [0, 0, 1, 1], coverage: [[new Array<Position>(20).fill([0, 0])]] }],
        ]);
        const large = item([multi], ['fine']);

        dispatchGeometryWork('merge', shell(), false, [large], [large.glazeKey], coverage);

        expect(FakeWorker.posted).toHaveLength(0);
    });

    it('keeps small subjects and counts shared coverage once, ignoring unsent entries', async () => {
        const { dispatchGeometryWork, GLAZE_CLONE_HARD_CAP } = await import('../../services/enc/geometryUpgrades');
        const small = item([polygon(5)], ['fine']);
        const another = { ...item([polygon(5)], ['fine']), cellId: 'other', glazeKey: 'other@1' };
        const coverage = new Map<string, FineCoverage>([
            ['fine', { bbox: [0, 0, 1, 1], coverage: [[new Array<Position>(100).fill([0, 0])]] }],
            [
                'unused',
                { bbox: [0, 0, 1, 1], coverage: [[new Array<Position>(GLAZE_CLONE_HARD_CAP + 1).fill([0, 0])]] },
            ],
        ]);

        dispatchGeometryWork('merge', shell(), false, [small, another], [small.glazeKey, another.glazeKey], coverage);

        expect(FakeWorker.posted).toHaveLength(1);
        expect(Object.keys((FakeWorker.posted[0] as { coverageLib: object }).coverageLib)).toEqual(['fine']);
    });

    it('stops counting at the limit without visiting a subject tail', async () => {
        const { glazeCloneWeight } = await import('../../services/enc/geometryUpgrades');
        const features = [polygon(100)];
        Object.defineProperty(features, 1, {
            get: () => {
                throw new Error('over-budget tail must not be read');
            },
        });
        expect(glazeCloneWeight([item(features)], undefined, 20)).toBe(21);
    });

    it('counts polygon holes, multipolygons and geometry-collection members', async () => {
        const { glazeCloneWeight } = await import('../../services/enc/geometryUpgrades');
        const shape: Feature = {
            type: 'Feature',
            properties: {},
            geometry: {
                type: 'GeometryCollection',
                geometries: [
                    {
                        type: 'Polygon',
                        coordinates: [new Array<Position>(5).fill([0, 0]), new Array<Position>(8).fill([0, 0])],
                    },
                    { type: 'MultiPolygon', coordinates: [[new Array<Position>(9).fill([0, 0])]] },
                    {
                        type: 'LineString',
                        coordinates: [
                            [0, 0],
                            [1, 1],
                        ],
                    },
                ],
            },
        };
        const weight = glazeCloneWeight([item([shape])]);
        expect(weight).toBeGreaterThanOrEqual(5 + 8 + 9 + 2);
        expect(glazeCloneWeight([item([shape])], undefined, weight)).toBe(weight);
        expect(glazeCloneWeight([item([shape])], undefined, weight - 1)).toBe(weight);
    });
});
