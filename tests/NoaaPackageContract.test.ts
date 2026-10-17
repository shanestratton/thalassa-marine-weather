// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { partitionNoaaRecords } from '../scripts/noaa-enc/partition-records';
import {
    NOAA_PART_BYTES,
    noaaFeatureBounds,
    parseNoaaPackage,
    parseNoaaPart,
} from '../services/enc/noaaPackageContract';
import type { EncConversionResult } from '../services/enc/types';
const source = (n = 30): EncConversionResult => ({
    cellId: 'US3AK1EX',
    sourceHO: 'US',
    edition: 1,
    updateNumber: 0,
    issued: '2026-03-16',
    bbox: [-134.4, 55.2, -132, 56.4],
    extractorSchema: 3,
    soundingDatum: 12,
    layers: {
        DEPARE: {
            type: 'FeatureCollection',
            features: Array.from({ length: n }, (_, i) => ({
                type: 'Feature',
                id: i,
                properties: { DRVAL1: i, original: 'synthetic'.repeat(90000) },
                geometry: { type: 'Point', coordinates: [-134 + i / 100, 56] },
            })),
        },
        M_SDAT: { type: 'FeatureCollection', features: [] },
    },
});
describe('lossless public NOAA record packages', () => {
    it('represents a cell larger than16MiB as bounded complete features with unchanged metadata and order', () => {
        const original = source(),
            result = partitionNoaaRecords(original, 'a'.repeat(64));
        expect(Buffer.byteLength(JSON.stringify(original))).toBeGreaterThan(16 * 1024 * 1024);
        expect(result.parts.length).toBeGreaterThan(4);
        const rebuilt = structuredClone(result.manifest.metadata) as EncConversionResult;
        rebuilt.layers = Object.fromEntries(
            result.manifest.layers.map((l) => [l.name, { ...l.collection, features: [] }]),
        ) as EncConversionResult['layers'];
        for (const [i, text] of result.parts.entries()) {
            expect(Buffer.byteLength(text)).toBeLessThanOrEqual(NOAA_PART_BYTES);
            for (const record of parseNoaaPart(JSON.parse(text), result.manifest, result.manifest.parts[i]).records)
                rebuilt.layers[record.layer as keyof typeof rebuilt.layers]!.features.push(...record.features);
        }
        expect(rebuilt).toEqual(original);
        expect(partitionNoaaRecords(original, 'a'.repeat(64))).toEqual(result);
    });
    it.each(['missing', 'duplicate', 'ordinal', 'revision', 'bounds'])(
        'rejects %s rather than granting partial coverage',
        (fault) => {
            const { manifest, parts } = partitionNoaaRecords(source(1), 'a'.repeat(64));
            const broken = structuredClone(manifest);
            if (fault === 'missing') broken.parts.pop();
            if (fault === 'duplicate') broken.parts.push(broken.parts[0]);
            if (fault === 'ordinal') broken.parts[0].spans[0].first++;
            if (fault === 'revision') broken.metadata.sourceHO = 'AU';
            if (fault === 'bounds') broken.parts[0].bbox = [0, 0, 1, 1];
            expect(() => {
                parseNoaaPackage(broken);
                parseNoaaPart(JSON.parse(parts[0]), broken, broken.parts[0]);
            }).toThrow();
        },
    );
    it('refuses an indivisible oversized feature and impossible coordinates', () => {
        expect(() => partitionNoaaRecords(source(1), 'a'.repeat(64), 1024)).toThrow();
        expect(() =>
            noaaFeatureBounds({ type: 'Feature', geometry: { type: 'Point', coordinates: [181, 2] } }),
        ).toThrow();
    });
    it('retains null geometry conservatively and rejects a mismatched part identity', () => {
        expect(noaaFeatureBounds({ type: 'Feature', geometry: null })).toEqual([-180, -90, 180, 90]);
        const { manifest, parts } = partitionNoaaRecords(source(1), 'a'.repeat(64));
        const p = JSON.parse(parts[0]);
        p.cellId = 'US5CA1LK';
        expect(() => parseNoaaPart(p, manifest, manifest.parts[0])).toThrow();
    });
});
