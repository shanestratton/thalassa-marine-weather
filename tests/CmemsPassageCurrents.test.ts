/**
 * cmemsPassageCurrents — the passage briefing's PRIMARY current source
 * samples the app's own verified CMEMS frames, and answers null on any
 * doubt so OceanCurrentService can fall through to NOAA.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchCurrentsManifest, fetchCurrentsGrid } = vi.hoisted(() => ({
    fetchCurrentsManifest: vi.fn(),
    fetchCurrentsGrid: vi.fn(),
}));
vi.mock('../services/weather/api/currentsGrid', () => ({ fetchCurrentsManifest, fetchCurrentsGrid }));

import {
    CMEMS_PASSAGE_MAX_FRAME_SKEW_MS,
    CMEMS_PASSAGE_MAX_VECTORS,
    sampleCmemsPassageCurrents,
} from '../services/weather/api/cmemsPassageCurrents';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const BBOX = { north: -24, south: -27, west: 152, east: 154 };

function manifestFixture(dataTimes: string[]) {
    return {
        dataset: { key: 'currents', id: 'cmems_mod_glo_phy_anfc_merged-uv_PT1H-i' },
        generation: 'g-test',
        files: dataTimes.map((data_time, step) => ({ step, data_time, offset_hours: step })),
    };
}

/** Sparse grid at `step`: width×height row-major, row 0 = NORTH edge. */
function gridFixture(step: number, width = 40, height = 40, land?: Set<number>) {
    const cells = width * height;
    const u = new Float32Array(cells).fill(0.3);
    const v = new Float32Array(cells).fill(-0.1);
    const landMask = new Uint8Array(cells);
    for (const index of land ?? []) landMask[index] = 1;
    const uPlanes: Array<Float32Array | undefined> = new Array(13);
    const vPlanes: Array<Float32Array | undefined> = new Array(13);
    uPlanes[step] = u;
    vPlanes[step] = v;
    const north = -20;
    const south = -30;
    const west = 150;
    const east = 156;
    return {
        u: uPlanes,
        v: vPlanes,
        width,
        height,
        lats: Array.from({ length: height }, (_, row) => north + (row * (south - north)) / (height - 1)),
        lons: Array.from({ length: width }, (_, col) => west + (col * (east - west)) / (width - 1)),
        north,
        south,
        west,
        east,
        landMask,
    };
}

beforeEach(() => {
    fetchCurrentsManifest.mockReset();
    fetchCurrentsGrid.mockReset();
});

describe('sampleCmemsPassageCurrents', () => {
    it('picks the frame nearest now and samples only inside the bbox, capped', async () => {
        const times = Array.from({ length: 13 }, (_, i) => new Date(NOW + (i - 6) * 3_600_000).toISOString());
        fetchCurrentsManifest.mockResolvedValue(manifestFixture(times));
        fetchCurrentsGrid.mockResolvedValue(gridFixture(6));

        const sample = await sampleCmemsPassageCurrents(BBOX, NOW);

        expect(fetchCurrentsGrid).toHaveBeenCalledWith(6); // step 6 = exactly now
        expect(sample).not.toBeNull();
        expect(sample!.dataTime).toBe(times[6]);
        expect(sample!.datasetId).toBe('cmems_mod_glo_phy_anfc_merged-uv_PT1H-i');
        expect(sample!.vectors.length).toBeGreaterThan(0);
        expect(sample!.vectors.length).toBeLessThanOrEqual(CMEMS_PASSAGE_MAX_VECTORS);
        for (const vector of sample!.vectors) {
            expect(vector.lat).toBeLessThanOrEqual(BBOX.north);
            expect(vector.lat).toBeGreaterThanOrEqual(BBOX.south);
            expect(vector.lon).toBeGreaterThanOrEqual(BBOX.west);
            expect(vector.lon).toBeLessThanOrEqual(BBOX.east);
            expect(Number.isFinite(vector.u)).toBe(true);
            expect(Number.isFinite(vector.v)).toBe(true);
        }
    });

    it('skips land-masked cells', async () => {
        const times = [new Date(NOW).toISOString()];
        fetchCurrentsManifest.mockResolvedValue(manifestFixture(times));
        const width = 40;
        const land = new Set<number>();
        for (let index = 0; index < width * 40; index += 1) land.add(index);
        fetchCurrentsGrid.mockResolvedValue(gridFixture(0, width, 40, land));

        // Everything masked → nothing to brief → null, not a zero-current field.
        expect(await sampleCmemsPassageCurrents(BBOX, NOW)).toBeNull();
    });

    it('a stale pipeline (frame skew beyond the guard) falls back', async () => {
        const stale = new Date(NOW - CMEMS_PASSAGE_MAX_FRAME_SKEW_MS - 3_600_000).toISOString();
        fetchCurrentsManifest.mockResolvedValue(manifestFixture([stale]));

        expect(await sampleCmemsPassageCurrents(BBOX, NOW)).toBeNull();
        expect(fetchCurrentsGrid).not.toHaveBeenCalled();
    });

    it('a missing decoded plane falls back', async () => {
        fetchCurrentsManifest.mockResolvedValue(manifestFixture([new Date(NOW).toISOString()]));
        fetchCurrentsGrid.mockResolvedValue(gridFixture(5)); // plane at 5, frame asked is 0

        expect(await sampleCmemsPassageCurrents(BBOX, NOW)).toBeNull();
    });

    it('no manifest, a thrown fetch, and an antimeridian bbox all fall back', async () => {
        fetchCurrentsManifest.mockResolvedValue(null);
        expect(await sampleCmemsPassageCurrents(BBOX, NOW)).toBeNull();

        fetchCurrentsManifest.mockRejectedValue(new Error('offline'));
        expect(await sampleCmemsPassageCurrents(BBOX, NOW)).toBeNull();

        fetchCurrentsManifest.mockResolvedValue(manifestFixture([new Date(NOW).toISOString()]));
        expect(await sampleCmemsPassageCurrents({ north: -10, south: -20, west: 170, east: -170 }, NOW)).toBeNull();
    });
});
