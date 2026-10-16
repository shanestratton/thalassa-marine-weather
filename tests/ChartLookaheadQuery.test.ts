import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aheadCone, type AheadHazard } from '../services/underway/lookaheadRule';
const state = vi.hoisted(() => ({
    version: 1,
    cells: [] as { id: string; bbox: number[] }[],
    load: vi.fn(),
    tide: vi.fn(),
}));
vi.mock('../services/enc/EncHazardService', () => ({ getCoverage: () => state.cells }));
vi.mock('../services/enc/EncCellMetadata', () => ({ getVersion: () => state.version }));
vi.mock('../services/enc/EncCellStore', () => ({ loadCellGeoJSON: state.load }));
vi.mock('../services/enc/encHazardParse', () => ({
    buildHazardsForCell: (blob: { hazards: unknown[] }) => blob.hazards,
    buildCoastlines: () => [],
}));
vi.mock('../services/enc/chartDatum', () => ({ cellSoundingDatum: (blob: { datum: string }) => blob.datum }));
vi.mock('../services/TideHeightService', () => ({ fetchTideCurve: state.tide }));
vi.mock('../services/enc/EncSpatialIndex', () => ({
    EncSpatialIndex: class {
        constructor(
            _id: string,
            private readonly hazards: unknown[],
        ) {}
        lookaheadCandidates() {
            return this.hazards;
        }
    },
}));
const cone = aheadCone({ lat: 30, lon: -150, at: 1792100000000, sogKn: 6, cogDeg: 0 })!;
const area = (depth: number): AheadHazard => ({
    layer: 'DEPARE',
    minDepthM: depth,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [-151, 29],
                [-149, 29],
                [-149, 32],
                [-151, 32],
                [-151, 29],
            ],
        ],
    },
});
beforeEach(() => {
    vi.resetModules();
    state.version = 1;
    state.cells = [{ id: 'TEST_CELL', bbox: [-151, 29, -149, 32] }];
    state.load.mockReset();
    state.tide.mockReset();
    state.tide.mockResolvedValue(null);
});
describe('chart lookahead query uses current chart evidence and proven tide datums', () => {
    it('never claims chart coverage when there are no installed cells or a chart cannot load', async () => {
        const { queryChartLookahead } = await import('../services/underway/ChartLookaheadQuery');
        state.cells = [];
        expect(await queryChartLookahead(cone, 2, 0.5)).toEqual({ hit: null, coverage: 'none' });
        expect(state.load).not.toHaveBeenCalled();
        state.cells = [{ id: 'TEST_CELL', bbox: [-151, 29, -149, 32] }];
        state.load.mockResolvedValue(null);
        expect(await queryChartLookahead(cone, 2, 0.5)).toEqual({ hit: null, coverage: 'none' });
    });
    it('uses exact depth-area coverage for a genuinely deep charted pass', async () => {
        state.load.mockResolvedValue({ datum: 'MLLW', hazards: [area(20)] });
        const { queryChartLookahead } = await import('../services/underway/ChartLookaheadQuery');
        expect(await queryChartLookahead(cone, 2, 0.5)).toEqual({ hit: null, coverage: 'charted' });
        expect(state.tide).not.toHaveBeenCalled();
    });
    it('uses negative tide at ETA only for proven matching LAT and does not mix a different tide datum', async () => {
        state.load.mockResolvedValue({ datum: 'LAT', hazards: [area(3)] });
        state.tide.mockResolvedValue({ datum: 'LAT', heightAt: () => -1 });
        const { queryChartLookahead } = await import('../services/underway/ChartLookaheadQuery');
        expect((await queryChartLookahead(cone, 2, 0.5)).hit?.kind).toBe('depth');
        state.version++;
        state.load.mockResolvedValue({ datum: 'LAT', hazards: [area(1)] });
        state.tide.mockResolvedValue({ datum: 'MLLW', heightAt: () => 10 });
        expect((await queryChartLookahead(cone, 2, 0.5)).hit?.kind).toBe('depth');
    });
    it('discards a delayed cell from a chart registry that changed during loading', async () => {
        let done!: (value: unknown) => void;
        state.load.mockReturnValue(
            new Promise((resolve) => {
                done = resolve;
            }),
        );
        const { queryChartLookahead } = await import('../services/underway/ChartLookaheadQuery');
        const pending = queryChartLookahead(cone, 2, 0.5);
        state.version++;
        done({ datum: 'LAT', hazards: [area(1)] });
        expect(await pending).toEqual({ hit: null, coverage: 'none' });
    });
    it('discards an old chart answer when the registry changes while the tide lookup awaits', async () => {
        state.load.mockResolvedValue({ datum: 'LAT', hazards: [area(1)] });
        let done!: (value: unknown) => void;
        state.tide.mockReturnValue(
            new Promise((resolve) => {
                done = resolve;
            }),
        );
        const { queryChartLookahead } = await import('../services/underway/ChartLookaheadQuery');
        const pending = queryChartLookahead(cone, 2, 0.5);
        await vi.waitFor(() => expect(state.tide).toHaveBeenCalledOnce());
        state.version++;
        done({ datum: 'LAT', heightAt: () => 0 });
        expect(await pending).toEqual({ hit: null, coverage: 'none' });
    });
    it('never claims complete coverage after the bounded eight-cell limit was reached', async () => {
        state.cells = Array.from({ length: 9 }, (_, i) => ({ id: `TEST_${i}`, bbox: [-151, 29, -149, 32] }));
        state.load.mockResolvedValue({ datum: 'MLLW', hazards: [area(20)] });
        const { queryChartLookahead } = await import('../services/underway/ChartLookaheadQuery');
        expect(await queryChartLookahead(cone, 2, 0.5)).toEqual({ hit: null, coverage: 'partial' });
    });
});
