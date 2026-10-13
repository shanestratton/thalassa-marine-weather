/**
 * The router reads two cells at once but pulls from the boat's Pi one at a
 * time, as before (128-ROUTE-P).
 *
 * loadCellGeoJSON takes an optional gate for its remote ladder (the Pi, then
 * the cloud's NOAA shelf): the router passes a one-at-a-time gate, so reading
 * cells together never fires more Pi pulls at once than the old one-by-one
 * loop did (tests/inshoreRouter.prepTimeline.test.ts counts them on a route).
 * Here: the whole ladder climbs inside the gate, and a cell already on the
 * phone never touches it.
 *
 * Fictional cell ids only (OC-99-ZZ…); the filesystem is in memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncConversionResult } from '../services/enc/types';

vi.mock('@capacitor/filesystem', async () => (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
const ladder = vi.hoisted(() => ({
    downloadPiCell: vi.fn(async (_cellId: string) => false),
    downloadCloudCell: vi.fn(async (_cellId: string) => false),
}));
vi.mock('../services/enc/piCellSync', () => ({ downloadPiCell: ladder.downloadPiCell }));
vi.mock('../services/enc/cloudCellSync', () => ({ downloadCloudCell: ladder.downloadCloudCell }));

import { loadCellGeoJSON, saveCellGeoJSON } from '../services/enc/EncCellStore';

const blob = (cellId: string): EncConversionResult =>
    ({
        cellId,
        sourceHO: 'ZZ',
        edition: 1,
        updateNumber: 0,
        issued: '2026-10-01',
        bbox: [161.0, -20.4, 161.1, -20.3],
        layers: { DEPARE: { type: 'FeatureCollection', features: [] } },
    }) as unknown as EncConversionResult;

/** A gate that counts its climbs and says whether one is under way inside it. */
function watchedGate() {
    const state = { inside: false, climbs: 0 };
    const gate = async <T>(climb: () => Promise<T>): Promise<T> => {
        state.climbs++;
        state.inside = true;
        try {
            return await climb();
        } finally {
            state.inside = false;
        }
    };
    return { gate, state };
}

beforeEach(() => {
    ladder.downloadPiCell.mockReset().mockResolvedValue(false);
    ladder.downloadCloudCell.mockReset().mockResolvedValue(false);
});

describe('loadCellGeoJSON with a ladder gate', () => {
    it("climbs the whole remote ladder for a missing cell inside the caller's gate", async () => {
        const { gate, state } = watchedGate();
        const seen: boolean[] = [];
        ladder.downloadPiCell.mockImplementation(async () => (seen.push(state.inside), false));
        ladder.downloadCloudCell.mockImplementation(async () => (seen.push(state.inside), false));
        await expect(loadCellGeoJSON('OC-99-ZZGATE1', true, gate)).resolves.toBeNull();
        expect(state.climbs).toBe(1);
        expect(ladder.downloadPiCell).toHaveBeenCalledWith('OC-99-ZZGATE1');
        expect(ladder.downloadCloudCell).toHaveBeenCalledWith('OC-99-ZZGATE1');
        expect(seen, 'the Pi rung and the cloud rung both inside the gate').toEqual([true, true]);
    });

    it('a cell the Pi hands over comes back, pulled inside the gate', async () => {
        const { gate, state } = watchedGate();
        let pulledInside: boolean | null = null;
        ladder.downloadPiCell.mockImplementation(async (id: string) => {
            pulledInside = state.inside;
            await saveCellGeoJSON(id, blob(id));
            return true;
        });
        const got = await loadCellGeoJSON('OC-99-ZZGATE3', true, gate);
        expect(got?.cellId).toBe('OC-99-ZZGATE3');
        expect(pulledInside).toBe(true);
        expect(ladder.downloadCloudCell).not.toHaveBeenCalled();
    });

    it('never touches the gate for a cell already on the phone', async () => {
        const { gate, state } = watchedGate();
        await saveCellGeoJSON('OC-99-ZZGATE2', blob('OC-99-ZZGATE2'));
        const got = await loadCellGeoJSON('OC-99-ZZGATE2', true, gate);
        expect(got?.cellId).toBe('OC-99-ZZGATE2');
        expect(state.climbs).toBe(0);
        expect(ladder.downloadPiCell).not.toHaveBeenCalled();
    });

    it('without a gate it climbs as before', async () => {
        await expect(loadCellGeoJSON('OC-99-ZZGATE5')).resolves.toBeNull();
        expect(ladder.downloadPiCell).toHaveBeenCalledWith('OC-99-ZZGATE5');
        expect(ladder.downloadCloudCell).toHaveBeenCalledWith('OC-99-ZZGATE5');
    });
});
