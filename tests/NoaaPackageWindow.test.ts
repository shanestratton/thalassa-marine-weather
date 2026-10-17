import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { partitionNoaaRecords } from '../scripts/noaa-enc/partition-records';
import { noaaFeatureBounds, noaaPartIntersects, noaaLeadDependency } from '../services/enc/noaaPackageContract';
import type { EncCell, EncConversionResult } from '../services/enc/types';
const state = vi.hoisted(() => ({
    parts: [] as string[],
    manifest: null as unknown,
    failAt: -1,
    read: [] as number[],
    changeVersion: false,
    version: 0,
    failCell: '',
    manifestCells: [] as string[],
    partHold: null as Promise<void> | null,
}));
vi.mock('@capacitor/filesystem', () => ({ Filesystem: {}, Directory: { Data: 'DATA' }, Encoding: { UTF8: 'utf8' } }));
vi.mock('../services/enc/noaaPackageStore', () => ({
    readNoaaPackage: async (cell: EncCell) => {
        state.manifestCells.push(cell.id);
        if (cell.id === state.failCell) throw Error('Later cell is incomplete');
        return state.manifest;
    },
    readNoaaPackagePart: async (
        _cell: EncCell,
        _manifest: unknown,
        descriptor: { sequence: number },
        bounds: number[],
        completeLateralMarks = false,
    ) => {
        state.read.push(descriptor.sequence);
        if (state.partHold) await state.partHold;
        if (descriptor.sequence === state.failAt) throw Error('Tampered local part');
        if (state.changeVersion) state.version++;
        const p = JSON.parse(state.parts[descriptor.sequence]);
        const layers = Object.fromEntries(
            p.records.map((r: { layer: string; features: GeoJSON.Feature[] }) => [
                r.layer,
                {
                    type: 'FeatureCollection',
                    features: r.features.filter(
                        (f) =>
                            (completeLateralMarks && noaaLeadDependency(r.layer)) ||
                            noaaPartIntersects(noaaFeatureBounds(f), bounds),
                    ),
                },
            ]),
        );
        return { layers, selectedBytes: new TextEncoder().encode(JSON.stringify(layers)).length };
    },
}));
import * as metadata from '../services/enc/EncCellMetadata';
import { loadNoaaPackageCohort, loadNoaaPackageWindow } from '../services/enc/noaaPackageWindow';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { borrowRetainedNoaaWindow } from '../services/enc/noaaRetainedWindow';
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
    state.failCell = '';
    state.manifestCells = [];
    state.partHold = null;
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

describe('one complete multi-cell package cohort', () => {
    const packages = () =>
        ['US3AK1EX', 'US3AK2EX', 'US3AK3EX'].map((id) => ({ ...cell, id, noaaPackage: {} }) as EncCell);

    it('shares the 16MiB ceiling across cells, including the next decode transient', async () => {
        // Each individual view fits. The same logical request may not retain
        // three of these while continuing to decode another part.
        await expect(loadNoaaPackageCohort(packages(), [-134, 55, -133.5, 56])).rejects.toThrow('resident');
        expect(noaaResidentBytes()).toBe(0);
    });

    it('holds all whole-feature windows until its borrower explicitly detaches', async () => {
        const view = await loadNoaaPackageCohort(packages(), [-134, 55, -133.9, 56]);
        expect(view.blobs.size).toBe(3);
        expect(noaaResidentBytes()).toBeGreaterThan(0);
        for (const blob of view.blobs.values())
            expect(blob.layers.DEPARE!.features.map((f) => f.id)).toEqual([0, 1, 2]);
        view.check();
        view.release();
        view.release();
        expect(view.blobs.size).toBe(0);
        expect(() => view.check()).toThrow('changed');
    });

    it('refuses the whole cohort when a later cell fails and returns every earlier lease', async () => {
        state.failCell = 'US3AK2EX';
        await expect(loadNoaaPackageCohort(packages(), [-134, 55, -133.9, 56])).rejects.toThrow('Later cell');
        expect(state.manifestCells).toEqual(['US3AK1EX', 'US3AK2EX']);
        expect(noaaResidentBytes()).toBe(0);
    });

    it('keeps an explicit auth and revision fence after the final read', async () => {
        setAuthIdentityScope('synthetic-cohort-a');
        const view = await loadNoaaPackageCohort(packages(), [-134, 55, -133.9, 56]);
        try {
            state.version++;
            expect(() => view.check()).toThrow('changed');
            state.version--;
            setAuthIdentityScope('synthetic-cohort-b');
            expect(() => view.check()).toThrow('changed');
        } finally {
            view.release();
            setAuthIdentityScope(null);
        }
    });

    it('a cancelled late part remains charged until its actual parse settles, then cannot publish', async () => {
        let finish!: () => void;
        state.partHold = new Promise<void>((r) => (finish = r));
        const stop = new AbortController();
        const view = loadNoaaPackageCohort(packages(), [-134, 55, -133.9, 56], () => stop.signal.throwIfAborted());
        await vi.waitFor(() => expect(state.read.length).toBe(1));
        stop.abort();
        expect(noaaResidentBytes()).toBeGreaterThan(0);
        const refused = expect(view).rejects.toMatchObject({ name: 'AbortError' });
        finish();
        await refused;
        expect(state.manifestCells).toEqual(['US3AK1EX']);
        expect(noaaResidentBytes()).toBe(0);
    });

    it('only the fixed leads dependency retains lateral marks in nonintersecting parts', async () => {
        const mark = (id: number, layer: string): GeoJSON.Feature => ({
            type: 'Feature',
            id,
            properties: { acronym: layer, synthetic: 'x'.repeat(500) },
            geometry: { type: 'Point', coordinates: [-132.1, 55.8] },
        });
        const source: EncConversionResult = {
            cellId: cell.id,
            sourceHO: 'US',
            edition: 1,
            updateNumber: 0,
            issued: '2026-03-16',
            bbox: [-134, 55, -132, 56],
            layers: {
                BOYLAT: { type: 'FeatureCollection', features: [mark(1, 'BOYLAT'), mark(2, 'BOYLAT')] },
                BCNLAT: { type: 'FeatureCollection', features: [mark(3, 'BCNLAT')] },
                OBSTRN: { type: 'FeatureCollection', features: [mark(4, 'OBSTRN')] },
                RECTRC: {
                    type: 'FeatureCollection',
                    features: [
                        {
                            ...mark(5, 'RECTRC'),
                            geometry: {
                                type: 'LineString',
                                coordinates: [
                                    [-132.1, 55.8],
                                    [-132, 55.8],
                                ],
                            },
                        },
                    ],
                },
            },
        };
        const packed = partitionNoaaRecords(source, 'a'.repeat(64), 1024);
        state.parts = packed.parts;
        state.manifest = packed.manifest;
        const bounds: [number, number, number, number] = [-134, 55, -133.9, 55.1];
        const ordinary = await loadNoaaPackageWindow(cell, bounds);
        expect(ordinary.blob.layers.BOYLAT?.features).toEqual([]);
        ordinary.release();
        state.read = [];
        const leads = await loadNoaaPackageCohort(packages().slice(0, 1), bounds, () => {}, 'leads');
        try {
            const layers = leads.blobs.get(cell.id)!.layers;
            expect(layers.BOYLAT?.features).toEqual(source.layers.BOYLAT!.features);
            expect(layers.BCNLAT?.features).toEqual(source.layers.BCNLAT!.features);
            expect(layers.OBSTRN?.features).toEqual([]);
            expect(layers.RECTRC?.features).toEqual([]);
            expect(state.read).toEqual([0, 1, 2]);
        } finally {
            leads.release();
        }
    });
});

describe('actual already-accounted NOAA window borrowing', () => {
    it('borrows the actual loaded owner without another read/reservation and drops every raw borrowed ref on owner release', async () => {
        const bounds: [number, number, number, number] = [-133.8, 55.4, -133.65, 55.6];
        const owner = await loadNoaaPackageWindow(cell, bounds);
        try {
            const reads = state.read.length,
                bytes = noaaResidentBytes();
            const borrowed = borrowRetainedNoaaWindow(cell, bounds)!;
            expect(borrowed.blob).toBe(owner.blob);
            expect(borrowed.bytes).toBe(owner.bytes);
            expect(state.read.length).toBe(reads);
            expect(noaaResidentBytes()).toBe(bytes);
            const authority = borrowed.authorityCurrent;
            borrowed.release();
            expect(authority()).toBe(true);
            const second = borrowRetainedNoaaWindow(cell, bounds)!;
            owner.release();
            expect(second.blob).toBeUndefined();
            expect(second.isCurrent()).toBe(false);
            expect(authority()).toBe(false);
            expect(noaaResidentBytes()).toBe(0);
            second.release();
        } finally {
            owner.release();
        }
    });
});
