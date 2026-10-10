import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The ENC sheet's "Sync N charts from Pi" (Shane, 2026-10-01: it said 12 and
 * could never reach 0). Twelve Pi charts a sync cannot add: five the phone
 * refuses for having no depth areas, seven legacy Pi rows (no contentSha256)
 * the phone already holds. The button must never offer a sync that cannot add
 * anything; the refused charts get a plain note instead. Synthetic data.
 */

const mocks = vi.hoisted(() => ({
    listPiInstalledCharts: vi.fn(),
    getCoverage: vi.fn(),
}));
vi.mock('../services/EncImportService', () => ({
    pickEncFile: vi.fn(),
    isLikelyEncFile: vi.fn(),
    checkPiHasGdal: vi.fn(),
    importEncCell: vi.fn(),
    installEncFromUrl: vi.fn(),
    syncEncFromPi: vi.fn(),
    listPiInstalledCharts: mocks.listPiInstalledCharts,
    listRecentEncInstalls: vi.fn(async () => []),
    resumeEncInstall: vi.fn(),
    // The shape the sheet used before 2026-10-01, so this suite also runs
    // against a build whose sheet keyed held charts itself.
    encCellSyncKey: (id: string, edition: number, sizeBytes?: number, contentSha256?: string) =>
        contentSha256 ? `${id}@${edition}@sha256:${contentSha256}` : `${id}@${edition}@${sizeBytes ?? 'unknown'}`,
}));
vi.mock('../services/enc/EncHazardService', () => ({ getCoverage: mocks.getCoverage, removeCell: vi.fn() }));
vi.mock('../services/PiCacheService', () => ({
    piCache: { isAvailable: () => true, onStatusChange: () => () => {}, baseUrl: 'http://paired-pi.test' },
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ userId: 'owner', generation: 1 }),
    isAuthIdentityScopeCurrent: () => true,
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => ({ publicKeySpki: 'key-one' }) }));
// 127-C-c: the boat's charts, from the registry state.
const boat = vi.hoisted(() => ({ now: null as string | null }));
vi.mock('../services/enc/piCellSync', () => ({
    boatName: () => 'Serene Summer',
    boatChartsNow: () => boat.now,
    subscribeBoatRegistry: () => () => undefined,
}));
vi.mock('../stores/MapFitTargetStore', () => ({ requestMapFit: vi.fn() }));
vi.mock('../context/UIContext', () => ({ useUI: () => ({ setPage: vi.fn() }) }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { EncCellManager } from '../components/vessel/EncCellManager';
import { rememberPiCellWithoutDepthAreas } from '../services/enc/piSyncPlan';

const REFUSED = ['OC-61-031514', 'OC-61-360864', 'OC-33-A94074', 'OC-33-B94074', 'OC-33-C94074'];
const LEGACY = ['US5GA22M', 'OC-61-0P0525', 'OC-61-1P4525', 'OC-61-1P8625', 'OC-61-2P4525', 'FR466870', 'GB501494'];
const sha = (n: number): string => n.toString(16).padStart(64, '0');

const piRow = (cellId: string, i: number, withSha: boolean) => ({
    cellId,
    sourceHO: 'AU',
    edition: 2,
    issued: '2026-09-01',
    bbox: [150, -20, 151, -19] as [number, number, number, number],
    featureCount: 1,
    sizeBytes: 1_000_000 + i,
    installedAt: '2026-09-30T00:00:00.000Z',
    source: 'pi-decrypt' as const,
    ...(withSha ? { contentSha256: sha(i + 1) } : {}),
});
/** A phone copy of a legacy row: its own byte count, plus the Pi's size it was pulled at. */
const heldLegacy = (row: ReturnType<typeof piRow>) => ({
    id: row.cellId,
    sourceHO: 'AU',
    edition: row.edition,
    issued: row.issued,
    importedAt: '2026-10-01T00:00:00.000Z',
    bbox: row.bbox,
    geojsonPath: `enc/${row.cellId}.json`,
    hazardCount: 1,
    usage: 'navigation' as const,
    sizeBytes: row.sizeBytes - 691,
    piSizeBytes: row.sizeBytes,
});

async function openSheet(): Promise<void> {
    render(<EncCellManager />);
    await waitFor(() => expect(mocks.listPiInstalledCharts).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /ENC Charts/i }));
}

describe('ENC sheet Pi sync count', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    it('offers no sync when the only Pi charts left are refused or already held, and says why', async () => {
        const refusedRows = REFUSED.map((id, i) => piRow(id, i, true));
        const legacyRows = LEGACY.map((id, i) => piRow(id, 10 + i, false));
        for (const row of refusedRows) rememberPiCellWithoutDepthAreas(row);
        mocks.listPiInstalledCharts.mockResolvedValue([...refusedRows, ...legacyRows]);
        mocks.getCoverage.mockReturnValue(legacyRows.map(heldLegacy));

        await openSheet();
        await screen.findByText(/5 charts on the Pi can’t be used on this phone: they have no depth areas\./);
        expect(screen.queryByRole('button', { name: /Sync \d+ charts? from Pi/i })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Pi charts already in sync/i })).toBeInTheDocument();
    });

    it('counts only what a sync can add', async () => {
        const refusedRows = REFUSED.map((id, i) => piRow(id, i, true));
        for (const row of refusedRows) rememberPiCellWithoutDepthAreas(row);
        // Licensed rows open from the Pi in memory and are never counted
        // (127-C-c); the count is open (NOAA) charts a sync can add to disk.
        const fresh = { ...piRow('US5ZZ40M', 40, true), sourceHO: 'US' };
        const licensedFresh = piRow('OC-99-ZZ0041', 41, true);
        mocks.listPiInstalledCharts.mockResolvedValue([...refusedRows, fresh, licensedFresh]);
        mocks.getCoverage.mockReturnValue([]);

        await openSheet();
        expect(await screen.findByRole('button', { name: /Sync 1 chart from Pi/i })).toBeInTheDocument();
        expect(screen.getByText(/5 charts on the Pi can’t be used on this phone/)).toBeInTheDocument();
    });

    it('offers a refused chart again once the Pi holds a corrected revision', async () => {
        const refused = { ...piRow('US4ZZ94M', 0, true), sourceHO: 'US' };
        rememberPiCellWithoutDepthAreas(refused);
        mocks.listPiInstalledCharts.mockResolvedValue([{ ...refused, contentSha256: sha(999) }]);
        mocks.getCoverage.mockReturnValue([]);

        await openSheet();
        expect(await screen.findByRole('button', { name: /Sync 1 chart from Pi/i })).toBeInTheDocument();
        expect(screen.queryByText(/can’t be used on this phone/)).not.toBeInTheDocument();
    });
});

describe('the Charts card says where licensed charts are (127-C-c)', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
        boat.now = null;
    });

    const held = (id: string, sourceHO: string) => ({
        id,
        sourceHO,
        edition: 2,
        issued: '2026-09-01',
        importedAt: '2026-10-01T00:00:00.000Z',
        bbox: [-21.9, 64.1, -21.8, 64.2] as [number, number, number, number],
        geojsonPath: 'vault',
        hazardCount: 1,
        usage: 'navigation' as const,
        sizeBytes: 1000,
    });

    it('aboard: the count opened in memory, licensed rows say aboard with no Remove, and the licence line', async () => {
        mocks.listPiInstalledCharts.mockResolvedValue([]);
        mocks.getCoverage.mockReturnValue([
            held('OC-99-ZZ0051', 'ZZ'),
            held('OC-99-ZZ0052', 'ZZ'),
            held('OC-99-ZZ0053', 'ZZ'),
            held('US5ZZ01M', 'US'),
        ]);
        await openSheet();
        expect(
            screen.getByText(
                '3 charts aboard Serene Summer · opened in memory, never saved on this phone · 1 chart on this phone',
            ),
        ).toBeInTheDocument();
        expect(screen.getAllByText('aboard')).toHaveLength(3);
        expect(screen.getAllByRole('button', { name: /Remove/i })).toHaveLength(1);
        expect(
            screen.getByText(
                "Licensed charts stay on your boat's Pi. This phone opens them in memory on the boat's Wi-Fi and never saves them, as the chart licences require. Open charts (NOAA) are kept on this phone.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText(/stored on this phone/)).not.toBeInTheDocument();
    });

    it('ashore after a relaunch: says where her charts open, never claims them', async () => {
        boat.now = 'away';
        mocks.listPiInstalledCharts.mockResolvedValue([]);
        mocks.getCoverage.mockReturnValue([]);
        render(<EncCellManager />);
        expect(await screen.findByText("Serene Summer's charts open on the boat's Wi-Fi.")).toBeInTheDocument();
        expect(screen.queryByText(/charts aboard/)).not.toBeInTheDocument();
    });
});
