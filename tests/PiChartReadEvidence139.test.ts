import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionBatch } from '../services/enc/types';

const h = vi.hoisted(() => ({
    owner: { key: 'user:a', userId: 'a' as string | null, generation: 0 },
    settings: { activeVesselId: 'boat-a' as string | null, settings: {} },
    pairing: { deviceId: 'pi-a', publicKeySpki: 'key-a', fingerprint: 'fp-a', pairedAt: '2026-10-17' },
    pairingRevision: 0,
    cells: new Map<string, EncCell>(),
    authListeners: [] as (() => void)[],
    cellListeners: [] as (() => void)[],
    boatListeners: [] as ((
        next: { activeVesselId: string | null },
        previous: { activeVesselId: string | null },
    ) => void)[],
    fetch: vi.fn(),
    importCell: vi.fn(),
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        isAvailable: () => true,
        baseUrl: 'https://pi.local:3001',
        lanBaseUrlNow: () => 'https://pi.local:3001',
    },
}));
vi.mock('../services/PiPairingService', () => ({
    fetchVerifiedFromPi: h.fetch,
    getPairing: () => h.pairing,
    getPiEquipmentReadRevision: () => h.pairingRevision,
}));
vi.mock('../services/piPublicBetaBoundary', () => ({ PI_INTEGRATION_ENABLED: true }));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => h.owner,
    subscribeAuthIdentityScope: (fn: () => void) => {
        h.authListeners.push(fn);
        return () => {};
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => h.settings,
        subscribe: (
            fn: (next: { activeVesselId: string | null }, previous: { activeVesselId: string | null }) => void,
        ) => {
            h.boatListeners.push(fn);
            return () => {};
        },
    },
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getCell: (id: string) => {
        const cell = h.cells.get(id);
        return cell?.usage === 'reference' ? null : (cell ?? null);
    },
    getRegisteredCell: (id: string) => h.cells.get(id) ?? null,
    subscribe: (fn: () => void) => {
        h.cellListeners.push(fn);
        return () => {};
    },
    clearBoatRecords: () => {
        h.cells.clear();
        h.cellListeners.forEach((fn) => fn());
    },
    cellsForBBox: () => [],
}));
vi.mock('../services/enc/EncHazardService', () => ({ importCell: h.importCell }));
vi.mock('../services/enc/EncCellStore', () => ({ clearProtectedBlobs: () => {} }));
vi.mock('../services/enc/localEncPackImport', () => ({ validateLocalEncPack: (blob: EncConversionBatch) => blob }));

import {
    downloadPiCell,
    forgetBoatCharts,
    isPiChartReadEvidenceCurrent,
    readPiChartReadEvidence,
} from '../services/enc/piCellSync';
import * as vault from '../services/enc/boatCellVault';

const NOW = Date.parse('2026-10-17T01:00:00Z');
function cell(id = 'AU500001', hash = 'a'.repeat(64)): EncCell {
    return {
        id,
        sourceHO: 'AHO',
        edition: 1,
        updateNumber: 0,
        contentSha256: hash,
        issued: '2026-10-01',
        importedAt: '2026-10-17',
        bbox: [153, -28, 154, -27],
        geojsonPath: 'ram',
        hazardCount: 0,
        usage: 'navigation',
        licence: 'protected',
    };
}
function put(value: EncCell): void {
    h.cells.set(value.id, value);
    h.cellListeners.forEach((fn) => fn());
}
function boat(id: string): void {
    const previous = { ...h.settings };
    h.settings.activeVesselId = id;
    h.boatListeners.forEach((fn) => fn(h.settings, previous));
}
function owner(id: string): void {
    h.owner = { key: `user:${id}`, userId: id, generation: h.owner.generation + 1 };
    h.authListeners.forEach((fn) => fn());
}
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    forgetBoatCharts();
    h.settings.activeVesselId = 'boat-a';
    h.pairingRevision++;
    h.owner = { key: 'user:a', userId: 'a', generation: h.owner.generation + 1 };
    h.fetch.mockReset();
    h.importCell.mockReset();
    put(cell());
    h.fetch.mockImplementation(async ({ url }: { url: string }) => ({
        cells: [{ cellId: /installed\/([^/]+)/.exec(url)![1] }],
    }));
    h.importCell.mockImplementation(async (blob: { cellId: string }) => h.cells.get(blob.cellId));
});
afterEach(() => vi.restoreAllMocks());

describe('actual Pi download/import read evidence (synthetic transport)', () => {
    it('metadata and hashes alone issue no receipt', () => {
        expect(readPiChartReadEvidence(cell())).toBeNull();
    });
    it('issues only after the verified transport and successful import', async () => {
        expect(await downloadPiCell('AU500001')).toBe(true);
        expect(h.fetch).toHaveBeenCalledWith(expect.objectContaining({ expectedSha256: 'a'.repeat(64) }));
        expect(h.importCell).toHaveBeenCalledOnce();
        const receipt = readPiChartReadEvidence(cell())!;
        expect(receipt.readAtMs).toBe(NOW);
        expect(isPiChartReadEvidenceCurrent(receipt, cell())).toBe(true);
        expect(isPiChartReadEvidenceCurrent({ ...receipt }, cell())).toBe(false);
        expect(isPiChartReadEvidenceCurrent(JSON.parse(JSON.stringify(receipt)), cell())).toBe(false);
    });
    it.each(['transport', 'import'])('a failed %s cannot issue evidence', async (stage) => {
        (stage === 'transport' ? h.fetch : h.importCell).mockRejectedValueOnce(new Error('refused'));
        expect(await downloadPiCell('AU500001')).toBe(false);
        expect(readPiChartReadEvidence(cell())).toBeNull();
    });
    it('legacy imports without a signed expected hash stay unknown', async () => {
        const legacy = { ...cell(), contentSha256: undefined };
        put(legacy);
        expect(await downloadPiCell(legacy.id)).toBe(true);
        expect(readPiChartReadEvidence(legacy)).toBeNull();
    });
    it('does not infer navigation authority from a reference chart', async () => {
        const reference = { ...cell(), usage: 'reference' as const };
        put(reference);
        expect(await downloadPiCell(reference.id)).toBe(true);
        expect(readPiChartReadEvidence(reference)).toBeNull();
    });
    it('retains earlier members when another real cohort member imports', async () => {
        await downloadPiCell('AU500001');
        const receipt = readPiChartReadEvidence(cell())!;
        const other = cell('AU500002', 'b'.repeat(64));
        put(other);
        await downloadPiCell(other.id);
        expect(isPiChartReadEvidenceCurrent(receipt, cell())).toBe(true);
        expect(readPiChartReadEvidence(other)).not.toBeNull();
    });
    it('cell A/B/A retires the original receipt permanently', async () => {
        await downloadPiCell('AU500001');
        const receipt = readPiChartReadEvidence(cell())!;
        put(cell('AU500001', 'b'.repeat(64)));
        put(cell());
        expect(isPiChartReadEvidenceCurrent(receipt, cell())).toBe(false);
    });
    it.each(['boat', 'owner', 'pairing', 'vault'])('%s A/B/A retires an issued receipt', async (kind) => {
        await downloadPiCell('AU500001');
        const receipt = readPiChartReadEvidence(cell())!;
        if (kind === 'boat') {
            boat('boat-b');
            boat('boat-a');
        }
        if (kind === 'owner') {
            owner('b');
            owner('a');
        }
        if (kind === 'pairing') h.pairingRevision += 2;
        if (kind === 'vault') vault.clear();
        expect(isPiChartReadEvidenceCurrent(receipt, cell())).toBe(false);
    });
    it.each(['boat', 'owner', 'pairing', 'cell', 'vault'])('late %s transition cannot mint a receipt', async (kind) => {
        let finish!: (value: unknown) => void;
        h.fetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pull = downloadPiCell('AU500001');
        if (kind === 'boat') {
            boat('boat-b');
            boat('boat-a');
        }
        if (kind === 'owner') {
            owner('b');
            owner('a');
        }
        if (kind === 'pairing') h.pairingRevision += 2;
        if (kind === 'vault') vault.clear();
        if (kind === 'cell') {
            put(cell('AU500001', 'b'.repeat(64)));
            put(cell());
        }
        finish({ cells: [{ cellId: 'AU500001' }] });
        await pull;
        expect(readPiChartReadEvidence(cell())).toBeNull();
    });
    it('retirement, expiry and a clock rollback cannot refresh evidence', async () => {
        await downloadPiCell('AU500001');
        const receipt = readPiChartReadEvidence(cell())!;
        expect(readPiChartReadEvidence(cell(), receipt.expiresAtMs)).toBeNull();
        expect(isPiChartReadEvidenceCurrent(receipt, cell(), NOW)).toBe(false);
        await downloadPiCell('AU500001');
        expect(readPiChartReadEvidence(cell(), NOW - 1)).toBeNull();
        expect(readPiChartReadEvidence(cell(), NOW)).toBeNull();
    });
});
