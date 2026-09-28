import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';

const mocks = vi.hoisted(() => ({
    baseUrl: 'https://boat.test',
    pairingKey: 'paired-pi-key',
    accountRevision: 1,
    pinnedPiRequest: vi.fn(),
    fetchVerifiedFromPi: vi.fn(),
    getCoverage: vi.fn(),
    importCell: vi.fn(),
    publishNewCellsIfEnabled: vi.fn(),
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: {
        get baseUrl() {
            return mocks.baseUrl;
        },
        isAvailable: () => true,
    },
}));
vi.mock('../services/PiPairingService', () => ({
    pinnedPiRequest: mocks.pinnedPiRequest,
    fetchVerifiedFromPi: mocks.fetchVerifiedFromPi,
    getPairing: () => ({ publicKeySpki: mocks.pairingKey }),
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => mocks.accountRevision,
    isAuthIdentityScopeCurrent: (revision: number) => revision === mocks.accountRevision,
}));
vi.mock('../services/enc/EncHazardService', () => ({
    getCoverage: mocks.getCoverage,
    getDisplayCoverage: mocks.getCoverage,
    importCell: mocks.importCell,
}));
vi.mock('../services/enc/EncCellStore', () => ({
    parseJsonOffThread: async (text: string) => JSON.parse(text) as unknown,
}));
vi.mock('../services/enc/personalCellSync', () => ({
    publishNewCellsIfEnabled: mocks.publishNewCellsIfEnabled,
}));

import {
    EncInstallPendingError,
    installEncFromUrl,
    resumeEncInstall,
    syncEncFromPi,
    type PiInstalledCell,
} from '../services/EncImportService';

const DELIVERY_URL = 'https://charts.example.test/package.zip';
const CONTENT_HASH = 'a'.repeat(64);
const PACKAGE_HASH = 'b'.repeat(64);
const PACKAGE_SUMMARY = { new: 1, updated: 0, unchanged: 0, total: 1 };

function conversion(cellId = 'FR466870'): EncConversionResult {
    return {
        cellId,
        sourceHO: cellId.slice(0, 2),
        edition: 2,
        updateNumber: 1,
        issued: '2026-09-01',
        bbox: [165, -23, 167, -21],
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { DRVAL1: 10, DRVAL2: 20 },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [165.1, -22.9],
                                    [166.9, -22.9],
                                    [166.9, -21.1],
                                    [165.1, -22.9],
                                ],
                            ],
                        },
                    },
                ],
            },
        },
    };
}

function installed(cellId = 'FR466870', contentSha256 = CONTENT_HASH): PiInstalledCell {
    const cell = conversion(cellId);
    return {
        cellId,
        sourceHO: cell.sourceHO,
        edition: cell.edition,
        updateNumber: cell.updateNumber,
        issued: cell.issued,
        bbox: cell.bbox,
        contentSha256,
        sizeBytes: 1024,
        featureCount: 1,
        installedAt: '2026-09-27T00:00:00.000Z',
        source: 'pi-decrypt',
    };
}

function receipt(cellIds = ['FR466870']) {
    return {
        status: 'done',
        resultKind: 'installed',
        persistedCellIds: cellIds,
        packageSummary: { ...PACKAGE_SUMMARY, new: cellIds.length, total: cellIds.length },
    };
}

function respondWithInstalledCharts(cellIds = ['FR466870']) {
    mocks.fetchVerifiedFromPi.mockImplementation(async ({ url }: { url: string }) => {
        if (url.includes('/api/enc/jobs/')) return receipt(cellIds);
        if (url.endsWith('/api/enc/installed')) return { cells: cellIds.map((id) => installed(id)) };
        const id = /\/api\/enc\/installed\/([^/]+)\/data$/.exec(url)?.[1];
        if (id && cellIds.includes(id)) return { cells: [conversion(id)] };
        throw new Error(`Unexpected test endpoint: ${new URL(url).pathname}`);
    });
}

/** Attach the rejection handler before advancing the Pi poll timer. */
async function pollOnce<T>(pending: Promise<T>): Promise<T> {
    const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(2000);
    const result = await outcome;
    if ('error' in result) throw result.error;
    return result.value;
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mocks.baseUrl = 'https://boat.test';
    mocks.pairingKey = 'paired-pi-key';
    mocks.accountRevision = 1;
    mocks.getCoverage.mockReturnValue([]);
    // Capacitor's responseType:text returns JSON as a string on native devices.
    mocks.pinnedPiRequest.mockResolvedValue({ status: 202, data: JSON.stringify({ jobId: 'install-1' }) });
    mocks.importCell.mockImplementation(
        async (cell: EncConversionResult, options?: { contentSha256?: string }) =>
            ({
                id: cell.cellId,
                sourceHO: cell.sourceHO,
                edition: cell.edition,
                updateNumber: cell.updateNumber,
                issued: cell.issued,
                importedAt: '2026-09-27T00:00:00.000Z',
                bbox: cell.bbox,
                geojsonPath: `enc-cells/${cell.cellId}.geojson`,
                hazardCount: 1,
                sizeBytes: 1024,
                contentSha256: options?.contentSha256,
            }) satisfies EncCell,
    );
    respondWithInstalledCharts();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('o-charts Pi installation and phone-copy receipts', () => {
    it('parses a native text POST response and copies exactly receipt IDs with signed content hashes', async () => {
        const ids = ['FR466870', 'GB501494'];
        respondWithInstalledCharts(ids);
        const normalFetch = mocks.fetchVerifiedFromPi.getMockImplementation()!;
        mocks.fetchVerifiedFromPi.mockImplementation(async (request: { url: string }) => {
            if (request.url.endsWith('/api/enc/installed')) {
                return { cells: [...ids.map((id) => installed(id)), installed('AU5TEST1')] };
            }
            return normalFetch(request);
        });

        const result = await pollOnce(
            installEncFromUrl(DELIVERY_URL, 'charts.zip', undefined, { expectedSha256: PACKAGE_HASH }),
        );

        expect(mocks.pinnedPiRequest).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                method: 'POST',
                data: { url: DELIVERY_URL, filename: 'charts.zip', expectedSha256: PACKAGE_HASH },
            }),
        );
        expect(result).toMatchObject({ installedOnPi: true, skipped: [], packageSummary: { new: 2, total: 2 } });
        expect(result.cells.map((cell) => cell.id)).toEqual(ids);
        expect(mocks.importCell).toHaveBeenCalledTimes(2);
        for (const id of ids) {
            expect(mocks.fetchVerifiedFromPi).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: `https://boat.test/api/enc/installed/${id}/data`,
                    expectedSha256: CONTENT_HASH,
                }),
            );
            expect(mocks.importCell).toHaveBeenCalledWith(
                expect.objectContaining({ cellId: id, updateNumber: 1 }),
                expect.objectContaining({ contentSha256: CONTENT_HASH }),
            );
        }
        expect(mocks.fetchVerifiedFromPi.mock.calls.map(([request]) => request.url).join('\n')).not.toMatch(
            /\/result\/|AU5TEST1\/data/,
        );
    });

    it('keeps confirmed Pi success when the phone cannot fetch a cell', async () => {
        mocks.fetchVerifiedFromPi
            .mockResolvedValueOnce(receipt())
            .mockResolvedValueOnce({ cells: [installed()] })
            .mockRejectedValueOnce(new Error('Wi-Fi lost'));
        const result = await pollOnce(installEncFromUrl(DELIVERY_URL, 'charts.zip'));
        expect(result).toMatchObject({ cells: [], installedOnPi: true, packageSummary: PACKAGE_SUMMARY });
        expect(result.skipped).toEqual([{ filename: 'FR466870', error: 'Wi-Fi lost' }]);
        expect(mocks.importCell).not.toHaveBeenCalled();
        expect(mocks.pinnedPiRequest).toHaveBeenCalledTimes(1);
    });

    it.each([{ cells: [] as PiInstalledCell[] }, { cells: [installed('GB501494')] }])(
        'does not report a missing receipt cell as already in sync (%j)',
        async ({ cells }) => {
            const progress = vi.fn();
            mocks.fetchVerifiedFromPi.mockResolvedValueOnce(receipt()).mockResolvedValueOnce({ cells });
            const result = await pollOnce(resumeEncInstall('install-1', progress));
            expect(result).toMatchObject({ cells: [], installedOnPi: true });
            expect(result.skipped).toHaveLength(1);
            expect(progress.mock.calls.some(([value]) => /already in sync/.test(value.step ?? ''))).toBe(false);
            expect(mocks.importCell).not.toHaveBeenCalled();
            expect(mocks.pinnedPiRequest).not.toHaveBeenCalled();
        },
    );

    it('rejects staged files as unfinished instead of fetching a conversion result', async () => {
        mocks.fetchVerifiedFromPi.mockResolvedValueOnce({ status: 'done', resultKind: 'staged' });
        await expect(pollOnce(resumeEncInstall('staged-1'))).rejects.toThrow(/charts are not ready yet/i);
        expect(mocks.fetchVerifiedFromPi).toHaveBeenCalledTimes(1);
        expect(mocks.importCell).not.toHaveBeenCalled();
        expect(mocks.pinnedPiRequest).not.toHaveBeenCalled();
    });

    it('leaves a 404 receipt pending, and resume polls without starting another download', async () => {
        mocks.fetchVerifiedFromPi.mockRejectedValueOnce(new Error('Pi returned HTTP 404'));
        await expect(pollOnce(resumeEncInstall('missing-1'))).rejects.toMatchObject({
            name: 'EncInstallPendingError',
            jobId: 'missing-1',
            installationPending: true,
        });
        expect(mocks.pinnedPiRequest).not.toHaveBeenCalled();
        expect(mocks.fetchVerifiedFromPi).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                url: 'https://boat.test/api/enc/jobs/missing-1',
            }),
        );
    });

    it('treats an ambiguous POST network failure as pending instead of inviting another download', async () => {
        mocks.pinnedPiRequest.mockRejectedValueOnce(new Error('Connection closed after upload'));
        await expect(installEncFromUrl(DELIVERY_URL, 'charts.zip')).rejects.toBeInstanceOf(EncInstallPendingError);
        expect(mocks.pinnedPiRequest).toHaveBeenCalledTimes(1);
        expect(mocks.fetchVerifiedFromPi).not.toHaveBeenCalled();
    });

    it('rejects an invalid checksum before sending any request', async () => {
        await expect(
            installEncFromUrl(DELIVERY_URL, 'charts.zip', undefined, { expectedSha256: 'not-a-checksum' }),
        ).rejects.toThrow(/64 hexadecimal characters/i);
        expect(mocks.pinnedPiRequest).not.toHaveBeenCalled();
        expect(mocks.fetchVerifiedFromPi).not.toHaveBeenCalled();
    });

    it('skips cells with the same content hash even when local byte count differs', async () => {
        mocks.getCoverage.mockReturnValue([
            { id: 'FR466870', edition: 2, sizeBytes: 999, contentSha256: CONTENT_HASH },
        ]);
        const result = await pollOnce(resumeEncInstall('install-1'));
        expect(result).toMatchObject({ cells: [], skipped: [], installedOnPi: true });
        expect(mocks.fetchVerifiedFromPi).toHaveBeenCalledTimes(2);
        expect(mocks.importCell).not.toHaveBeenCalled();
        expect(mocks.pinnedPiRequest).not.toHaveBeenCalled();
    });

    it('refreshes equal-edition, equal-size cells when their content hash changes', async () => {
        mocks.getCoverage.mockReturnValue([
            { id: 'FR466870', edition: 2, sizeBytes: 1024, contentSha256: 'c'.repeat(64) },
        ]);
        const result = await pollOnce(resumeEncInstall('install-1'));
        expect(result.cells).toHaveLength(1);
        expect(result.cells[0].contentSha256).toBe(CONTENT_HASH);
        expect(mocks.importCell).toHaveBeenCalledTimes(1);
    });

    it.each(['account', 'Pi key', 'Pi address'])(
        'aborts when the %s changes while waiting for a receipt',
        async (change) => {
            const pending = resumeEncInstall('install-1');
            if (change === 'account') mocks.accountRevision += 1;
            else if (change === 'Pi key') mocks.pairingKey = 'different-pi';
            else mocks.baseUrl = 'https://other-boat.test';
            await expect(pollOnce(pending)).rejects.toThrow(/Account or paired Pi changed/i);
            expect(mocks.fetchVerifiedFromPi).not.toHaveBeenCalled();
            expect(mocks.importCell).not.toHaveBeenCalled();
        },
    );

    it('rejects a payload whose update number differs from its signed index', async () => {
        mocks.fetchVerifiedFromPi
            .mockResolvedValueOnce({ cells: [installed()] })
            .mockResolvedValueOnce({ cells: [{ ...conversion(), updateNumber: 0 }] });
        const result = await syncEncFromPi(undefined, { cellIds: ['FR466870'] });
        expect(result.cells).toEqual([]);
        expect(result.skipped[0].error).toMatch(/did not match its signed index/i);
        expect(mocks.importCell).not.toHaveBeenCalled();
    });

    it.each([
        { sourceHO: 'AU', sourceCellId: 'AU471680' },
        { sourceHO: 'FR', sourceCellId: 'FR471681' },
    ])('rejects a synthetic cell whose producer identity disagrees with the signed index (%j)', async (identity) => {
        const cellId = 'OC-33-086174';
        mocks.fetchVerifiedFromPi
            .mockResolvedValueOnce({ cells: [{ ...installed(), cellId, sourceCellId: 'FR471680' }] })
            .mockResolvedValueOnce({ cells: [{ ...conversion(), cellId, ...identity }] });
        const result = await syncEncFromPi(undefined, { cellIds: [cellId] });
        expect(result.cells).toEqual([]);
        expect(result.skipped[0].error).toMatch(/did not match its signed index/i);
        expect(mocks.importCell).not.toHaveBeenCalled();
    });

    it('preserves verified native identity when importing a synthetic o-charts filename', async () => {
        const cellId = 'OC-33-086174';
        mocks.fetchVerifiedFromPi
            .mockResolvedValueOnce({ cells: [{ ...installed(), cellId, sourceCellId: 'FR471680' }] })
            .mockResolvedValueOnce({ cells: [{ ...conversion(), cellId, sourceCellId: 'FR471680' }] });
        const result = await syncEncFromPi(undefined, { cellIds: [cellId] });
        expect(result.skipped).toEqual([]);
        expect(mocks.importCell).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ cellId, sourceHO: 'FR', sourceCellId: 'FR471680' }),
            expect.objectContaining({ contentSha256: CONTENT_HASH, assertAuthority: expect.any(Function) }),
        );
    });

    it.each(['account', 'Pi key', 'Pi address'])(
        'aborts if the %s changes during the final cell fetch, not just at the next poll',
        async (change) => {
            mocks.fetchVerifiedFromPi
                .mockResolvedValueOnce({ cells: [installed()] })
                .mockImplementationOnce(async () => {
                    if (change === 'account') mocks.accountRevision += 1;
                    else if (change === 'Pi key') mocks.pairingKey = 'different-pi';
                    else mocks.baseUrl = 'https://other-boat.test';
                    return { cells: [conversion()] };
                });
            await expect(syncEncFromPi(undefined, { cellIds: ['FR466870'] })).rejects.toThrow(
                /Account or paired Pi changed/i,
            );
            expect(mocks.importCell).not.toHaveBeenCalled();
        },
    );
});
