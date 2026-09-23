import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
import type { VerifiedCanalExitProfile } from '../services/automaticCanalExit';
import { encCell } from './helpers/encCells';

const h = vi.hoisted(() => ({ profiles: [] as unknown[], load: vi.fn(), getCell: vi.fn() }));
vi.mock('../services/automaticCanalExit', async (original) => ({
    ...(await original<typeof import('../services/automaticCanalExit')>()),
    VERIFIED_CANAL_EXIT_PROFILES: h.profiles,
}));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: h.load }));
vi.mock('../services/enc/EncCellMetadata', () => ({ getCell: h.getCell }));
import { verifyCanalExitChart } from '../services/verifyCanalExitChart';

const CELL = 'TEST-CHART-1';
const SECOND = 'TEST-CHART-2';
const NOW = new Date('2026-09-13T00:00:00Z');
const profile = (): VerifiedCanalExitProfile => ({
    id: 'synthetic-exit',
    label: 'Synthetic exit',
    sourceRevision: 'test-revision-1',
    departureArea: {
        type: 'Polygon',
        coordinates: [
            [
                [153, -27],
                [153.001, -27],
                [153.001, -26.999],
                [153, -26.999],
                [153, -27],
            ],
        ],
    },
    source: { authority: 'Synthetic authority', reference: 'Test-only fixture', publishedAt: '2026-09-10T00:00:00Z' },
    reviewedAt: '2026-09-12T00:00:00Z',
    validUntil: '2026-09-19T00:00:00Z',
    terminalVerified: true,
    rule: 'centreline-permitted',
    outboundBearingDeg: 0,
    chartEvidence: [{ cellId: CELL, edition: 1, issued: '2022-03-07' }],
    gates: [
        {
            port: { id: `${CELL}/BCNLAT/2`, objectClass: 'BCNLAT', catlam: 1, lon: 153.0003, lat: -26.998 },
            starboard: { id: `${CELL}/BCNLAT/13`, objectClass: 'BCNLAT', catlam: 2, lon: 153.0007, lat: -26.998 },
        },
    ],
});
const metadata = (id = CELL): EncCell => ({
    id,
    sourceHO: 'AU',
    edition: 1,
    issued: '2022-03-07',
    importedAt: '2026-09-12T00:00:00Z',
    bbox: [153, -27, 153.01, -26.99],
    geojsonPath: `enc/${id}.json`,
    hazardCount: 20,
    usage: 'navigation',
});
const blob = (id = CELL): EncConversionResult => ({
    cellId: id,
    sourceHO: 'AU',
    edition: 1,
    issued: '2022-03-07',
    bbox: [153, -27, 153.01, -26.99],
    layers: {
        BCNLAT: {
            type: 'FeatureCollection',
            features: profile()
                .gates.flatMap((gate) => [gate.port, gate.starboard])
                .map((mark) => ({
                    type: 'Feature',
                    id: Number(mark.id.split('/').at(-1)),
                    properties: { acronym: 'BCNLAT', rcid: Number(mark.id.split('/').at(-1)), CATLAM: mark.catlam },
                    geometry: { type: 'Point', coordinates: [mark.lon, mark.lat] },
                })),
        },
    },
});
const verify = (controller = new AbortController()) => verifyCanalExitChart('synthetic-exit', controller.signal);
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    h.profiles.splice(0, h.profiles.length, profile());
    h.load.mockReset().mockImplementation(async (id: string) => blob(id));
    h.getCell.mockReset().mockImplementation((id: string) => metadata(id));
});
afterEach(() => vi.useRealTimers());

describe('installed ENC proof for automatic canal exits', () => {
    it('matches exact chart revision and real lateral objects with standard read-through', async () => {
        expect(await verify()).toBe(true);
        expect(h.load).toHaveBeenCalledExactlyOnceWith(CELL);
        expect(h.getCell).toHaveBeenCalledWith(CELL);
    });

    it('reads the actual SENC rcid fields and legacy layer wrapper without a redundant collection type', async () => {
        const id = 'OC-61-10RCS5';
        const fixture = encCell(id);
        const value = profile();
        const mark = (rcid: number) => {
            const feature = fixture.layers.BCNLAT.features.find((candidate) => candidate.properties?.rcid === rcid)!;
            if (feature.geometry.type !== 'Point') throw new Error('Fixture marker must be a point');
            return {
                id: `${id}/BCNLAT/${rcid}`,
                objectClass: 'BCNLAT' as const,
                catlam: feature.properties!.CATLAM as 1 | 2,
                lon: feature.geometry.coordinates[0],
                lat: feature.geometry.coordinates[1],
            };
        };
        value.gates = [
            [2, 17],
            [14, 427],
            [16, 13],
            [430, 15],
        ].map(([port, starboard]) => ({ port: mark(port), starboard: mark(starboard) }));
        value.chartEvidence = [{ cellId: id, edition: 1, issued: '2022-03-07' }];
        h.profiles.splice(0, 1, value);
        h.load.mockResolvedValue({ ...blob(id), layers: fixture.layers });
        expect(await verify()).toBe(true);
    });

    it.each(['reference', 'demo', 'pending'])(
        'rejects non-navigation %s metadata before loading a stale blob',
        async (usage) => {
            h.getCell.mockReturnValue({ ...metadata(), usage });
            expect(await verify()).toBe(false);
            expect(h.load).not.toHaveBeenCalled();
        },
    );

    it('rejects removed or retired navigation records before a stored blob can authorize an exit', async () => {
        h.getCell.mockReturnValue(null);
        expect(await verify()).toBe(false);
        expect(h.load).not.toHaveBeenCalled();
    });

    it.each([{ edition: 2 }, { issued: '2022-03-08' }, { id: SECOND }, { cloudManifestVersion: 1, hazardCount: 0 }])(
        'rejects changed or unavailable registered chart revision %j',
        async (change) => {
            h.getCell.mockReturnValue({ ...metadata(), ...change });
            expect(await verify()).toBe(false);
            expect(h.load).not.toHaveBeenCalled();
        },
    );

    it.each([{ edition: 2 }, { issued: '2022-03-08' }, { cellId: SECOND }, { layers: {} }])(
        'rejects blob identity/revision mismatch %j',
        async (change) => {
            h.load.mockResolvedValue({ ...blob(), ...change });
            expect(await verify()).toBe(false);
        },
    );

    it('rejects a missing or failed chart load', async () => {
        h.load.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
        expect(await verify()).toBe(false);
        expect(await verify()).toBe(false);
    });

    it.each([{ acronym: 'BOYLAT' }, { CATLAM: 2 }, { CATLAM: '1' }, { rcid: '2' }, { rcid: 99 }, { RCID: 99 }])(
        'rejects wrong object identity/category %j',
        async (change) => {
            const cell = blob();
            Object.assign(cell.layers.BCNLAT!.features[0].properties!, change);
            h.load.mockResolvedValue(cell);
            expect(await verify()).toBe(false);
        },
    );

    it('requires every gate marker at the exact reviewed position', async () => {
        const cell = blob();
        const geometry = cell.layers.BCNLAT!.features[0].geometry;
        if (geometry.type === 'Point') geometry.coordinates[0] += 0.000001;
        h.load.mockResolvedValue(cell);
        expect(await verify()).toBe(false);
        cell.layers.BCNLAT!.features.pop();
        expect(await verify()).toBe(false);
    });

    it('rejects a matching numeric id from the wrong layer or a non-point object', async () => {
        const cell = blob();
        cell.layers.BOYLAT = cell.layers.BCNLAT;
        delete cell.layers.BCNLAT;
        h.load.mockResolvedValue(cell);
        expect(await verify()).toBe(false);
        const second = blob();
        second.layers.BCNLAT!.features[0].geometry = {
            type: 'LineString',
            coordinates: [
                [153.0003, -26.998],
                [153.0004, -26.998],
            ],
        };
        h.load.mockResolvedValue(second);
        expect(await verify()).toBe(false);
    });

    it('rejects conflicting duplicates rather than accepting the first matching record', async () => {
        const cell = blob();
        const duplicate = structuredClone(cell.layers.BCNLAT!.features[0]);
        cell.layers.BCNLAT!.features.push(duplicate);
        h.load.mockResolvedValue(cell);
        expect(await verify()).toBe(true);
        duplicate.properties!.CATLAM = 2;
        expect(await verify()).toBe(false);
    });

    it('rejects changed installed metadata while a cell is loading', async () => {
        const pending = deferred<EncConversionResult>();
        h.load.mockReturnValue(pending.promise);
        const result = verify();
        h.getCell.mockReturnValue({ ...metadata(), personalManifestVersion: 2 });
        pending.resolve(blob());
        expect(await result).toBe(false);
    });

    it('rejects a chart removed while a cell is loading', async () => {
        const pending = deferred<EncConversionResult>();
        h.load.mockReturnValue(pending.promise);
        const result = verify();
        h.getCell.mockReturnValue(null);
        pending.resolve(blob());
        expect(await result).toBe(false);
    });

    it('checks only one cell at a time and rechecks earlier metadata after later loads', async () => {
        const value = profile();
        value.chartEvidence = [...value.chartEvidence!, { cellId: SECOND, edition: 1, issued: '2022-03-07' }];
        value.gates[0].starboard.id = `${SECOND}/BCNLAT/13`;
        h.profiles.splice(0, 1, value);
        const first = deferred<EncConversionResult>(),
            second = deferred<EncConversionResult>();
        h.load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const result = verify();
        expect(h.load).toHaveBeenCalledTimes(1);
        first.resolve(blob());
        await vi.advanceTimersByTimeAsync(1);
        expect(h.load.mock.calls).toEqual([[CELL], [SECOND]]);
        h.getCell.mockImplementation((id: string) => (id === CELL ? null : metadata(id)));
        second.resolve(blob(SECOND));
        expect(await result).toBe(false);
    });

    it('does not load anything after an already cancelled request', async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await verify(controller)).toBe(false);
        expect(h.load).not.toHaveBeenCalled();
    });

    it('resolves false promptly on abort and ignores the late successful read', async () => {
        const pending = deferred<EncConversionResult>();
        h.load.mockReturnValue(pending.promise);
        const controller = new AbortController();
        const result = verify(controller);
        controller.abort();
        expect(await result).toBe(false);
        pending.resolve(blob());
        await vi.advanceTimersByTimeAsync(1);
        expect(h.load).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('has a 15-second total deadline and cannot become true after timeout', async () => {
        const pending = deferred<EncConversionResult>();
        h.load.mockReturnValue(pending.promise);
        const result = verify();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await result).toBe(false);
        pending.resolve(blob());
        await vi.advanceTimersByTimeAsync(1);
        expect(h.load).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects expiry or profile changes while loading', async () => {
        const value = profile();
        value.validUntil = '2026-09-13T00:00:01Z';
        h.profiles.splice(0, 1, value);
        const pending = deferred<EncConversionResult>();
        h.load.mockReturnValue(pending.promise);
        const result = verify();
        await vi.advanceTimersByTimeAsync(1001);
        pending.resolve(blob());
        expect(await result).toBe(false);
        h.profiles.splice(0, 1, profile());
        const later = deferred<EncConversionResult>();
        h.load.mockReturnValue(later.promise);
        const secondResult = verify();
        (h.profiles[0] as VerifiedCanalExitProfile).sourceRevision = 'changed';
        later.resolve(blob());
        expect(await secondResult).toBe(false);
    });

    it('requires unique, complete, bounded chart evidence, never a guessed cell from a marker id', async () => {
        for (const chartEvidence of [
            undefined,
            [],
            [...profile().chartEvidence!, ...profile().chartEvidence!],
            [{ cellId: SECOND, edition: 1, issued: '2022-03-07' }],
            Array.from({ length: 5 }, (_, i) => ({ cellId: `TEST-${i}`, edition: 1, issued: '2022-03-07' })),
        ]) {
            h.profiles.splice(0, 1, { ...profile(), chartEvidence });
            expect(await verify()).toBe(false);
        }
        expect(h.load).not.toHaveBeenCalled();
    });

    it.each([
        { cellId: '../TEST', edition: 1, issued: '2022-03-07' },
        { cellId: CELL, edition: 0, issued: '2022-03-07' },
        { cellId: CELL, edition: 1.5, issued: '2022-03-07' },
        { cellId: CELL, edition: 1, issued: '2022-02-30' },
        { cellId: CELL, edition: 1, issued: '2026-09-14' },
    ])('rejects malformed or unreviewable chart evidence %j', async (evidence) => {
        h.profiles.splice(0, 1, { ...profile(), chartEvidence: [evidence] });
        expect(await verify()).toBe(false);
        expect(h.load).not.toHaveBeenCalled();
    });

    it('treats malformed registry entries and metadata lookup failures as unavailable', async () => {
        h.profiles.splice(0, h.profiles.length, null);
        expect(await verify()).toBe(false);
        h.profiles.splice(0, h.profiles.length, profile());
        h.getCell.mockImplementation(() => {
            throw new Error('metadata unavailable');
        });
        expect(await verify()).toBe(false);
        expect(h.load).not.toHaveBeenCalled();
    });

    it('rejects unknown, ambiguous and unstructured marker identities', async () => {
        expect(await verifyCanalExitChart('unknown', new AbortController().signal)).toBe(false);
        h.profiles.push(profile());
        expect(await verify()).toBe(false);
        for (const id of ['2', `${CELL}/BCNLAT/02`, `${CELL}/BOYLAT/2`, `${CELL}/BCNLAT/4294967296`]) {
            const value = profile();
            value.gates[0].port.id = id;
            h.profiles.splice(0, h.profiles.length, value);
            expect(await verify()).toBe(false);
        }
        expect(h.load).not.toHaveBeenCalled();
    });

    it('bounds marker scanning and fails closed on malformed feature arrays', async () => {
        const cell = blob();
        cell.layers.BCNLAT!.features = Array.from({ length: 20_001 }, () => cell.layers.BCNLAT!.features[0]);
        h.load.mockResolvedValue(cell);
        expect(await verify()).toBe(false);
        h.load.mockResolvedValue({ ...blob(), layers: { BCNLAT: { type: 'FeatureCollection', features: null } } });
        expect(await verify()).toBe(false);
    });
});
