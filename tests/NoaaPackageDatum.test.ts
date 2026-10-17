import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';
const state = vi.hoisted(() => ({ version: 1, records: [] as EncCell[], load: vi.fn(), window: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => state.version,
    cellsForBBox: () => state.records,
    displayCellsForBBox: () => state.records,
}));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: state.load }));
vi.mock('../services/enc/noaaPackageWindow', () => ({ loadNoaaPackageWindow: state.window }));
import { readChartDatumForBounds } from '../services/enc/readChartDatum';
const bounds: [number, number, number, number] = [-133.8, 55.4, -133.6, 55.6];
const blob = (datum = 12): EncConversionResult => ({
    cellId: 'US3AK1EX',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-03-16',
    bbox: [-134, 55, -132, 56],
    extractorSchema: 3,
    soundingDatum: datum,
    layers: { M_SDAT: { type: 'FeatureCollection', features: [] } },
});
beforeEach(() => {
    state.version++;
    state.records = [{ id: 'US3AK1EX', noaaPackage: {} } as EncCell];
    state.load.mockReset();
    state.window.mockReset();
});
describe('request-scoped sounding datum from complete public packages', () => {
    it('reads the whole requested window and releases it after taking datum evidence', async () => {
        const release = vi.fn();
        state.window.mockResolvedValue({ blob: blob(), release });
        expect(await readChartDatumForBounds(bounds)).toBe('MLLW');
        expect(state.window).toHaveBeenCalledWith(state.records[0], bounds);
        expect(release).toHaveBeenCalledOnce();
        expect(state.load).not.toHaveBeenCalled();
    });
    it.each(['Missing part', 'Resident cap'])(
        'refuses %s without a generic read or network fallback',
        async (reason) => {
            state.window.mockRejectedValue(Error(reason));
            expect(await readChartDatumForBounds(bounds)).toBeNull();
            expect(state.load).not.toHaveBeenCalled();
        },
    );
    it('rejects mixed package/monolith datums and releases every completed view', async () => {
        state.records.push({ id: 'US5TEST1' } as EncCell);
        const release = vi.fn();
        state.window.mockResolvedValue({ blob: blob(), release });
        state.load.mockResolvedValue(blob(23));
        expect(await readChartDatumForBounds(bounds)).toBeNull();
        expect(release).toHaveBeenCalledOnce();
    });
    it('revokes delayed datum evidence after a registry/account generation change', async () => {
        const release = vi.fn();
        state.window.mockImplementation(async () => {
            state.version++;
            return { blob: blob(), release };
        });
        expect(await readChartDatumForBounds(bounds)).toBeNull();
        expect(release).toHaveBeenCalledOnce();
    });
});
