import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
const h = vi.hoisted(() => ({
    cells: [] as EncCell[],
    consent: true,
    consentWait: null as Promise<boolean> | null,
    paired: true,
    lan: true,
    version: 0,
    load: vi.fn(),
    window: vi.fn(),
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => (h.paired ? { deviceId: 'fixture-pi' } : null) }));
vi.mock('../services/PiCacheService', () => ({ piCache: { onStatusChange: () => () => {} } }));
vi.mock('../services/enc/piCellSync', () => ({ boatLanBaseNow: () => (h.lan ? 'https://10.0.0.2:3443' : null) }));
vi.mock('../services/enc/noaaAgreement', () => ({
    noaaAgreementAccepted: () => h.consentWait ?? Promise.resolve(h.consent),
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getDisplayCell: (id: string) => h.cells.find((c) => c.id === id) ?? null,
    listDisplayCells: () => h.cells,
    getVersion: () => h.version,
}));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: h.load }));
vi.mock('../services/enc/noaaPackageWindow', () => ({ loadNoaaPackageWindow: h.window }));
import {
    chartFindSelectionCurrent,
    chartFindViews,
    findChartObjects,
    readDownloadedChartFind,
} from '../services/enc/chartFind';
import { captureChartFindCell, indexChartFindCell, retireChartFindMemory } from '../services/enc/chartFindMemory';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const cell = (id = 'US5TEST1', overrides: Partial<EncCell> = {}): EncCell => ({
    id,
    sourceHO: id.slice(0, 2),
    edition: 1,
    issued: '2026-10-16',
    importedAt: '2026-10-16T00:00:00Z',
    bbox: [150, -28, 152, -26],
    geojsonPath: 'local',
    hazardCount: 0,
    ...overrides,
});
const blob = (id = 'US5TEST1'): EncConversionResult => ({
    cellId: id,
    sourceHO: id.slice(0, 2),
    edition: 1,
    issued: '2026-10-16',
    bbox: [150, -28, 152, -26],
    layers: {
        SEAARE: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { OBJNAM: 'Private bay' },
                    geometry: { type: 'Point', coordinates: [151, -27] },
                },
            ],
        },
    },
});
const index = (id: string, licence: 'open' | 'protected') =>
    indexChartFindCell(captureChartFindCell(id), blob(id), licence);
beforeEach(() => {
    retireChartFindMemory();
    setAuthIdentityScope('chart-find-owner');
    h.cells = [];
    h.consent = true;
    h.consentWait = null;
    h.paired = true;
    h.lan = true;
    h.version = 0;
    h.load.mockReset().mockImplementation(async (id: string) => blob(id));
    h.window.mockReset();
});
describe('local chart search authority', () => {
    it('hides licensed names ashore/unpaired and denies selection across a transport loss during consent read', async () => {
        h.cells = [cell('AU5TEST1')];
        index('AU5TEST1', 'protected');
        const row = (await findChartObjects('bay'))!.matches[0];
        expect(row.name).toBe('Private bay');
        h.lan = false;
        expect((await findChartObjects('bay'))!.matches).toEqual([]);
        h.lan = true;
        h.paired = false;
        expect((await findChartObjects('bay'))!.matches).toEqual([]);
        h.paired = true;
        let done!: (accepted: boolean) => void;
        h.consentWait = new Promise((resolve) => {
            done = resolve;
        });
        const select = chartFindSelectionCurrent(row);
        h.lan = false;
        done(true);
        await expect(select).resolves.toBe(false);
    });
    it('allows consented downloaded NOAA ashore/offline, but not stale/missing or stricter metadata', async () => {
        h.cells = [cell()];
        index('US5TEST1', 'open');
        h.lan = false;
        h.paired = false;
        const row = (await findChartObjects('bay'))!.matches[0];
        expect(row).toBeDefined();
        expect(await chartFindSelectionCurrent(row)).toBe(true);
        h.consent = false;
        expect((await findChartObjects('bay'))!.matches).toEqual([]);
        h.consent = true;
        h.cells = [cell('US5TEST1', { licence: 'protected' })];
        expect((await findChartObjects('bay'))!.matches).toEqual([]);
        expect(await chartFindSelectionCurrent(row)).toBe(false);
        h.cells = [];
        expect((await findChartObjects('bay'))!.matches).toEqual([]);
    });
    it('rejects old-owner and re-paired async completions instead of publishing names into a new session', async () => {
        h.cells = [cell()];
        index('US5TEST1', 'open');
        let done!: (accepted: boolean) => void;
        h.consentWait = new Promise((resolve) => {
            done = resolve;
        });
        const search = findChartObjects('bay');
        setAuthIdentityScope('different-owner');
        done(true);
        await expect(search).resolves.toBeNull();
        h.consentWait = null;
        index('US5TEST1', 'open');
        const row = (await findChartObjects('bay'))!.matches[0];
        h.consentWait = new Promise((resolve) => {
            done = resolve;
        });
        const select = chartFindSelectionCurrent(row);
        retireChartFindMemory();
        done(true);
        await expect(select).resolves.toBe(false);
    });
});
describe('explicit bounded downloaded-chart read', () => {
    it('keeps one native local-read slot until a cancelled read settles, so repeated taps cannot multiply buffers', async () => {
        h.cells = [cell()];
        let finish!: (blob: EncConversionResult) => void;
        h.load.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const controller = new AbortController();
        const first = readDownloadedChartFind([150, -28, 152, -26], { signal: controller.signal });
        const rejected = expect(first).rejects.toThrow(/cancelled/);
        await vi.waitFor(() => expect(h.load).toHaveBeenCalledOnce());
        controller.abort();
        await expect(readDownloadedChartFind([150, -28, 152, -26])).rejects.toThrow(/still finishing/);
        expect(h.load).toHaveBeenCalledOnce();
        finish(blob());
        await rejected;
        expect((await readDownloadedChartFind([150, -28, 152, -26])).read).toBe(1);
        expect(h.load).toHaveBeenCalledTimes(2);
    });
    it('reads at most four local NOAA cells, never the remote ladder or protected cells, with no provider requests', async () => {
        h.cells = [cell('AU5TEST1'), ...Array.from({ length: 7 }, (_, i) => cell(`US5TEST${i}`))];
        h.lan = false;
        h.paired = false;
        const fetch = vi.spyOn(globalThis, 'fetch');
        try {
            expect(await readDownloadedChartFind([150, -28, 152, -26])).toEqual({
                read: 4,
                unavailable: 0,
                limited: true,
            });
            expect(h.load.mock.calls).toEqual(
                ['US5TEST0', 'US5TEST1', 'US5TEST2', 'US5TEST3'].map((id) => [id, false]),
            );
            expect(fetch).not.toHaveBeenCalled();
            expect((await findChartObjects('bay'))!.matches).toHaveLength(4);
        } finally {
            fetch.mockRestore();
        }
    });
    it('rejects world/invalid views and locally splits a dateline camera', () => {
        expect(chartFindViews([-180, -80, 180, 80])).toEqual([]);
        expect(chartFindViews([NaN, 1, 4, 5])).toEqual([]);
        expect(chartFindViews([179, -20, -179, -18])).toEqual([
            [179, -20, 180, -18],
            [-180, -20, -179, -18],
        ]);
        expect(chartFindViews([179, -20, 181, -18])).toEqual(chartFindViews([179, -20, -179, -18]));
        expect(chartFindViews([-181, -20, -179, -18])).toEqual(chartFindViews([179, -20, -179, -18]));
        expect(chartFindViews([539, -20, 541, -18])).toEqual(chartFindViews([179, -20, -179, -18]));
    });
    it('stops after a cancelled, over-deadline or changed-account read without scanning another cell', async () => {
        for (const change of ['abort', 'account', 'deadline', 'revision']) {
            h.cells = [cell('US5TEST1'), cell('US5TEST2')];
            const controller = new AbortController();
            const start = performance.now();
            const clock = vi.spyOn(performance, 'now').mockReturnValue(start);
            h.load.mockImplementationOnce(async () => {
                if (change === 'abort') controller.abort();
                if (change === 'account') setAuthIdentityScope('next-owner');
                if (change === 'deadline') clock.mockReturnValue(start + 10001);
                if (change === 'revision') h.version++;
                return blob();
            });
            try {
                await expect(
                    readDownloadedChartFind([150, -28, 152, -26], { signal: controller.signal }),
                ).rejects.toThrow(/changed or was cancelled/);
            } finally {
                clock.mockRestore();
            }
            expect(h.load).toHaveBeenCalledTimes(1);
            h.load.mockClear();
        }
    });
    it('always releases a package geometry lease if cancellation follows its final read', async () => {
        h.cells = [cell('US5TEST1', { noaaPackage: {} as NonNullable<EncCell['noaaPackage']> })];
        const release = vi.fn(),
            controller = new AbortController();
        h.window.mockImplementation(async () => {
            controller.abort();
            return { blob: blob(), bytes: 100, release };
        });
        await expect(readDownloadedChartFind([150, -28, 152, -26], { signal: controller.signal })).rejects.toThrow(
            /cancelled/,
        );
        expect(release).toHaveBeenCalledOnce();
    });
});
