import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    datum: 'LAT' as string | null,
    responseDatum: 'LAT',
    hold: null as Promise<void> | null,
}));
vi.mock('../services/enc/readChartDatum', () => ({
    readChartDatumForBounds: vi.fn(async () => state.datum),
}));
vi.mock('../services/weather/api/worldtides', () => ({
    fetchWorldTides: vi.fn(async () => {
        if (state.hold) await state.hold;
        const dt = Math.floor(Date.now() / 1000);
        return {
            status: 200,
            responseDatum: state.responseDatum,
            extremes: [
                { dt, date: '', height: 0.1, type: 'Low' },
                { dt: dt + 21600, date: '', height: 2.1, type: 'High' },
            ],
        };
    }),
}));
import { fetchTideCurve, clearTideCache } from '../services/TideHeightService';
import { fetchWorldTides } from '../services/weather/api/worldtides';
import { readChartDatumForBounds } from '../services/enc/readChartDatum';

describe('routing and live-depth datum guard', () => {
    beforeEach(() => {
        state.datum = 'LAT';
        state.responseDatum = 'LAT';
        state.hold = null;
        clearTideCache();
        vi.clearAllMocks();
    });
    const fetchCurve = () => {
        const now = Date.now();
        return fetchTideCurve(38, -76, now, now + 3600000);
    };
    it('accepts explicit matching LAT and records the source datum', async () => {
        expect((await fetchCurve())?.datum).toBe('LAT');
        expect(readChartDatumForBounds).toHaveBeenCalledWith([-76.125, 37.875, -75.875, 38.125]);
    });
    it('rechecks chart metadata before cache hits; unknown and other datums get no tide credit', async () => {
        expect(await fetchCurve()).not.toBeNull();
        for (const datum of ['MLLW', 'LLWLT', 'MSL', null]) {
            state.datum = datum;
            expect(await fetchCurve()).toBeNull();
        }
        expect(fetchWorldTides).toHaveBeenCalledTimes(1);
    });
    it('never relabels a non-LAT provider curve to match the chart', async () => {
        state.responseDatum = 'MLLW';
        expect(await fetchCurve()).toBeNull();
    });
    it('refuses a curve when chart data changes while the upstream request is pending', async () => {
        let release!: () => void;
        state.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const pending = fetchCurve();
        await vi.waitFor(() => expect(fetchWorldTides).toHaveBeenCalledTimes(1));
        state.datum = 'MLLW';
        release();
        expect(await pending).toBeNull();
    });
    it('proves the caller whole-route bounds when one curve will serve several gates', async () => {
        const now = Date.now();
        const bounds: [number, number, number, number] = [-77, 37, -75, 39];
        await fetchTideCurve(38, -76, now, now + 3600000, { chartBounds: bounds });
        expect(readChartDatumForBounds).toHaveBeenCalledWith(bounds);
    });
});
