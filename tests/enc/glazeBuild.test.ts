/**
 * buildCellGlaze branch coverage (closing audit 2026-07-18: the glaze fold's
 * cached / uncached / needQueue / upgraded-promotion paths shipped untested —
 * the exact seam a documented frozen-queue bug lived in). Drives the REAL
 * glazeCellCache + clip/scale-shadow deps through an explicit context; the
 * step only QUEUES worker upgrades (never dispatches), so no worker is needed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection, Position } from 'geojson';

import { buildCellGlaze, type GlazeBuildContext } from '../../services/enc/glazeBuild';
import type { GlazeUpgradeItem } from '../../services/enc/geometryUpgrades';
import type { CoverageGeom, FineCoverage } from '../../services/enc/clipDepareOverlap';
import { clearGlazeCell, clearAllGlazeAssemblies, getGlazeCell } from '../../services/enc/glazeCellCache';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import { accumulateCellLayers } from '../../services/enc/mergeFold';
import type { EncCell, EncConversionResult } from '../../services/enc/types';

/** A square DEPARE polygon at (x,y)..(x+1,y+1). */
const square = (x: number, y: number): Feature => ({
    type: 'Feature',
    properties: { drval1: 2 },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [x, y],
                [x + 1, y],
                [x + 1, y + 1],
                [x, y + 1],
                [x, y],
            ],
        ],
    },
});
const fc = (feats: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features: feats });
const cov: CoverageGeom = [[[[0, 0] as Position, [1, 0], [1, 1], [0, 1], [0, 0]]]];

const mergedShell = () =>
    ({ DEPARE_GLAZE: fc([]), DEPCNT_DERIVED: fc([]), SOUNDG: fc([]), cellCount: 1 }) as unknown as EncMergedVectorData;

interface Overrides {
    shadows?: GlazeBuildContext['glazeShadows'];
    coverageFor?: (id: string) => CoverageGeom | null;
    feature?: Feature;
}
const makeCtx = (o: Overrides = {}) => {
    const glazeUpgradeQueue: GlazeUpgradeItem[] = [];
    const merged = mergedShell();
    const mergeGlazeKeys: string[] = [];
    const shadows = o.shadows ?? [];
    const ctx: GlazeBuildContext = {
        cell: { id: 'cellX', bbox: [10, 10, 11, 11], edition: 3, sizeBytes: 100 },
        blob: { layers: { DEPARE: fc([o.feature ?? square(10, 10)]) } },
        glazeShadows: shadows,
        coverageFor: o.coverageFor ?? (() => cov),
        stripRectsFor: (_id, extent) => [extent],
        glazeCoverageLib: new Map<string, FineCoverage>(),
        glazeUpgradeQueue,
        merged,
        mergeGlazeKeys,
        yieldIfNeeded: async () => {},
    };
    return { ctx, glazeUpgradeQueue, merged, mergeGlazeKeys };
};

describe('buildCellGlaze', () => {
    beforeEach(() => {
        clearGlazeCell();
        clearAllGlazeAssemblies();
    });

    it('UNCACHED, no shadows: instant grade is FINAL (upgraded), painted into the merge, queued nothing', async () => {
        const { ctx, glazeUpgradeQueue, merged, mergeGlazeKeys } = makeCtx({ shadows: [] });
        await buildCellGlaze(ctx);
        expect(mergeGlazeKeys).toHaveLength(1);
        const entry = getGlazeCell(mergeGlazeKeys[0])!;
        expect(entry.upgraded).toBe(true); // no shadow → nothing to subtract
        expect(merged.DEPARE_GLAZE.features.length).toBeGreaterThan(0);
        expect(glazeUpgradeQueue).toHaveLength(0);
    });

    it('UNCACHED, shadow + coverage touching the band: caches un-upgraded and QUEUES the touched feature', async () => {
        const { ctx, glazeUpgradeQueue, mergeGlazeKeys } = makeCtx({
            shadows: [{ id: 'fineA', bbox: [10, 10, 11, 11] }], // overlaps the band
        });
        await buildCellGlaze(ctx);
        const entry = getGlazeCell(mergeGlazeKeys[0])!;
        expect(entry.upgraded).toBe(false); // awaiting the worker's true coverage
        expect(glazeUpgradeQueue).toHaveLength(1);
        expect(glazeUpgradeQueue[0]).toMatchObject({ cellId: 'cellX', glazeKey: mergeGlazeKeys[0] });
        expect(glazeUpgradeQueue[0].features.length).toBeGreaterThan(0);
    });

    it('UNCACHED, shadow but NO real coverage: instant grade PROMOTED to final, nothing queued', async () => {
        const { ctx, glazeUpgradeQueue, mergeGlazeKeys } = makeCtx({
            shadows: [{ id: 'fineA', bbox: [10, 10, 11, 11] }],
            coverageFor: () => null, // no coverage to subtract
        });
        await buildCellGlaze(ctx);
        expect(getGlazeCell(mergeGlazeKeys[0])!.upgraded).toBe(true);
        expect(glazeUpgradeQueue).toHaveLength(0);
    });

    it('UNCACHED, coverage present but the band does not TOUCH it: promoted, nothing queued', async () => {
        const { ctx, glazeUpgradeQueue, mergeGlazeKeys } = makeCtx({
            shadows: [{ id: 'fineA', bbox: [0, 0, 1, 1] }], // far from the band at (10,10)
            feature: square(10, 10),
        });
        await buildCellGlaze(ctx);
        expect(getGlazeCell(mergeGlazeKeys[0])!.upgraded).toBe(true);
        expect(glazeUpgradeQueue).toHaveLength(0);
    });

    it('CACHED hit: reuses the cached feats without recomputing, and does not re-queue an upgraded cell', async () => {
        const first = makeCtx({ shadows: [] });
        await buildCellGlaze(first.ctx); // populates the cache (upgraded)
        const key = first.mergeGlazeKeys[0];
        const cachedFeatCount = getGlazeCell(key)!.feats.length;

        // Second cell, same identity + shadow set → same glazeKey → cache hit.
        const second = makeCtx({ shadows: [] });
        await buildCellGlaze(second.ctx);
        expect(second.mergeGlazeKeys[0]).toBe(key); // same key
        expect(second.merged.DEPARE_GLAZE.features.length).toBe(cachedFeatCount); // reused
        expect(second.glazeUpgradeQueue).toHaveLength(0); // upgraded → no re-queue
    });

    it.each(['updateNumber', 'contentSha256'] as const)(
        'invalidates same-size cell content when %s changes',
        async (field) => {
            const first = makeCtx();
            Object.assign(first.ctx.cell, { updateNumber: 1, contentSha256: 'a'.repeat(64) });
            await buildCellGlaze(first.ctx);
            const replacement = square(10, 10);
            replacement.properties = { drval1: 6 };
            const second = makeCtx({ feature: replacement });
            Object.assign(second.ctx.cell, {
                updateNumber: 1,
                contentSha256: 'a'.repeat(64),
                [field]: field === 'updateNumber' ? 2 : 'b'.repeat(64),
            });
            await buildCellGlaze(second.ctx);
            expect(second.mergeGlazeKeys[0]).not.toBe(first.mergeGlazeKeys[0]);
            expect(second.merged.DEPARE_GLAZE.features[0].properties?.drval1).toBe(6);
        },
    );

    it.each(['updateNumber', 'contentSha256'] as const)(
        'reclips coarse glaze when a same-id shadow changes %s',
        async (field) => {
            const fine = {
                id: 'fineA',
                bbox: [10, 10, 11, 11] as [number, number, number, number],
                edition: 1,
                sizeBytes: 100,
                updateNumber: 1,
                contentSha256: 'a'.repeat(64),
            };
            const first = makeCtx({ shadows: [fine], coverageFor: () => null });
            first.ctx.stripRectsFor = () => [];
            await buildCellGlaze(first.ctx);
            expect(first.merged.DEPARE_GLAZE.features).toHaveLength(1);
            const second = makeCtx({
                shadows: [{ ...fine, [field]: field === 'updateNumber' ? 2 : 'b'.repeat(64) }],
                coverageFor: () => null,
            });
            await buildCellGlaze(second.ctx);
            expect(second.mergeGlazeKeys[0]).not.toBe(first.mergeGlazeKeys[0]);
            expect(second.merged.DEPARE_GLAZE.features).toHaveLength(0);
        },
    );

    it('reclips when a legacy shadow extent changes and preserves order-independent cache reuse', async () => {
        const first = makeCtx({ shadows: [{ id: 'fineA', bbox: [20, 20, 21, 21] }], coverageFor: () => null });
        await buildCellGlaze(first.ctx);
        expect(first.merged.DEPARE_GLAZE.features).toHaveLength(1);
        const second = makeCtx({ shadows: [{ id: 'fineA', bbox: [10, 10, 11, 11] }], coverageFor: () => null });
        await buildCellGlaze(second.ctx);
        expect(second.mergeGlazeKeys[0]).not.toBe(first.mergeGlazeKeys[0]);
        expect(second.merged.DEPARE_GLAZE.features).toHaveLength(0);
        const twoShadows: GlazeBuildContext['glazeShadows'] = [
            { id: 'fineA', bbox: [20, 20, 21, 21] },
            { id: 'fineB', bbox: [30, 30, 31, 31] },
        ];
        const third = makeCtx({ shadows: twoShadows });
        const reordered = makeCtx({ shadows: [...twoShadows].reverse() });
        await buildCellGlaze(third.ctx);
        await buildCellGlaze(reordered.ctx);
        expect(reordered.mergeGlazeKeys[0]).toBe(third.mergeGlazeKeys[0]);
    });

    it('preserves shadow revisions through the real merge-fold data-extent reanchoring', async () => {
        const coarse: EncCell = {
            id: 'AU530150',
            sourceHO: 'AU',
            edition: 1,
            issued: '2026-09-01',
            importedAt: '2026-09-27',
            bbox: [0, 0, 20, 20],
            geojsonPath: 'enc/coarse.json',
            hazardCount: 1,
        };
        const fineBbox: EncCell['bbox'] = [10, 10, 11, 11];
        const runFold = async (contentSha256: string, clip: boolean) => {
            const fixture = makeCtx();
            fixture.merged.DEPARE = fc([]);
            const blob: EncConversionResult = {
                cellId: coarse.id,
                sourceHO: 'AU',
                edition: 1,
                issued: coarse.issued,
                bbox: coarse.bbox,
                layers: fixture.ctx.blob.layers,
            };
            await accumulateCellLayers(coarse, blob, {
                merged: fixture.merged,
                cellExtents: [{ id: 'fineA', bbox: fineBbox, contentSha256, updateNumber: 1 }],
                depareExtent: new Map([['fineA', fineBbox]]),
                coverageFor: () => null,
                stripRectsFor: () => (clip ? [fineBbox] : []),
                lineLayerExtent: () => null,
                seaareByName: new Map(),
                glazeCoverageLib: fixture.ctx.glazeCoverageLib,
                glazeUpgradeQueue: fixture.glazeUpgradeQueue,
                mergeGlazeKeys: fixture.mergeGlazeKeys,
                buildGlaze: true,
                cullDeg: 0,
                yieldIfNeeded: async () => {},
            });
            return fixture;
        };
        const first = await runFold('a'.repeat(64), false);
        const second = await runFold('b'.repeat(64), true);
        expect(first.merged.DEPARE_GLAZE.features).toHaveLength(1);
        expect(second.merged.DEPARE_GLAZE.features).toHaveLength(0);
        expect(second.mergeGlazeKeys[0]).not.toBe(first.mergeGlazeKeys[0]);
    });
});
