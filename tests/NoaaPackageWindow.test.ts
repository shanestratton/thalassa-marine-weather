import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { partitionNoaaRecords } from '../scripts/noaa-enc/partition-records';
import { noaaFeatureBounds, noaaPartIntersects } from '../services/enc/noaaPackageContract';
import type { EncCell, EncConversionResult } from '../services/enc/types';
const state = vi.hoisted(() => ({
    parts: [] as string[],
    manifest: null as unknown,
    failAt: -1,
    read: [] as number[],
    changeVersion: false,
    version: 0,
}));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: {}, Directory: { Data: 'DATA' }, Encoding: { UTF8: 'utf8' } }));
vi.mock('../services/enc/noaaPackageStore', () => ({
    readNoaaPackage: async () => state.manifest,
    readNoaaPackagePart: async (
        _cell: EncCell,
        _manifest: unknown,
        descriptor: { sequence: number },
        bounds: number[],
    ) => {
        state.read.push(descriptor.sequence);
        if (descriptor.sequence === state.failAt) throw Error('Tampered local part');
        if (state.changeVersion) state.version++;
        const p = JSON.parse(state.parts[descriptor.sequence]);
        const layers = Object.fromEntries(
            p.records.map((r: { layer: string; features: GeoJSON.Feature[] }) => [
                r.layer,
                {
                    type: 'FeatureCollection',
                    features: r.features.filter((f) => noaaPartIntersects(noaaFeatureBounds(f), bounds)),
                },
            ]),
        );
        return { layers, selectedBytes: new TextEncoder().encode(JSON.stringify(layers)).length };
    },
}));
import * as metadata from '../services/enc/EncCellMetadata';
import { loadNoaaPackageWindow } from '../services/enc/noaaPackageWindow';
import { noaaResidentBytes, setBlobCachePlottingMode } from '../services/enc/EncCellStore';
import { clearMergedData } from '../services/enc/mergedDataCache';
const cell = { id: 'US3AK1EX', sourceHO: 'US' } as EncCell;
beforeEach(() => {
    clearMergedData();
    setBlobCachePlottingMode(false);
    state.version = 0;
    state.read = [];
    state.failAt = -1;
    state.changeVersion = false;
    vi.spyOn(metadata, 'getVersion').mockImplementation(() => state.version);
    const source: EncConversionResult = {
        cellId: cell.id,
        sourceHO: 'US',
        edition: 1,
        updateNumber: 0,
        issued: '2026-03-16',
        bbox: [-134, 55, -132, 56],
        soundingDatum: 12,
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: Array.from({ length: 32 }, (_, i) => ({
                    type: 'Feature',
                    id: i,
                    properties: { synthetic: 'x'.repeat(650000) },
                    geometry: { type: 'Point', coordinates: [-134 + i / 20, 55.5] },
                })),
            },
            M_SDAT: { type: 'FeatureCollection', features: [] },
        },
    };
    const result = partitionNoaaRecords(source, 'a'.repeat(64));
    state.parts = result.parts;
    state.manifest = result.manifest;
});
afterEach(() => {
    vi.restoreAllMocks();
    expect(noaaResidentBytes()).toBe(0);
});
describe('complete bounded NOAA query windows', () => {
    it('returns every intersecting original feature in order plus the original datum once', async () => {
        const view = await loadNoaaPackageWindow(cell, [-133.8, 55.4, -133.65, 55.6]);
        try {
            expect(view.blob.layers.DEPARE!.features.map((f) => f.id)).toEqual([4, 5, 6, 7]);
            expect(view.blob.soundingDatum).toBe(12);
            expect(view.blob.layers.M_SDAT!.features).toEqual([]);
            expect(state.read.length).toBeLessThan(state.parts.length);
        } finally {
            view.release();
        }
    });
    it('refuses the entire oversized view instead of returning a truncated chart', async () => {
        await expect(loadNoaaPackageWindow(cell, [-134, 55, -132, 56])).rejects.toThrow('resident');
    });
    it('a corrupt relevant part rejects the whole view and releases all borrowed bytes', async () => {
        state.failAt = 0;
        await expect(loadNoaaPackageWindow(cell, [-134, 55, -133, 56])).rejects.toThrow('Tampered');
    });
    it('does not publish geometry if the installed revision changes during a part read', async () => {
        state.changeVersion = true;
        await expect(loadNoaaPackageWindow(cell, [-134, 55, -133, 56])).rejects.toThrow('revision');
    });
});
