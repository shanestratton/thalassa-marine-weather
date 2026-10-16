import { describe, expect, it } from 'vitest';
import { gustSpread } from '../services/weather/gustSpread';
import type { AtmosVar, SpreadBlock } from '../services/weather/ModelSpreadService';
const block = (): SpreadBlock<AtmosVar> => ({
    times: [0, 3_600_000, 7_200_000],
    models: [
        ['ecmwf_ifs025', [20, 25, 90]],
        ['dwd_icon', [28, 30, 80]],
        ['ukmo_global_deterministic_10km', [100, 120, 140]],
    ].map(([id, gusts]) => ({
        id: id as string,
        label: id as string,
        provider: id as string,
        hex: '#000',
        values: { wind_gusts_10m: gusts } as Record<AtmosVar, (number | null)[]>,
    })),
});
describe('HUD gust spread from the already-loaded comparison', () => {
    it('uses exactly the displayed day/window and excludes UKMO numeric derivatives', () => {
        expect(gustSpread(block(), 0, 7_200_000)).toEqual([25, 30]);
    });
    it('never calls a single model agreement or fills missing/absurd gusts with zero', () => {
        const data = block();
        data.models[0].values.wind_gusts_10m[1] = null;
        expect(gustSpread(data, 0, 7_200_000)).toBeNull();
        data.models[0].values.wind_gusts_10m[1] = 500;
        expect(gustSpread(data, 0, 7_200_000)).toBeNull();
    });
    it('refuses display-only members and an empty window', () => {
        const data = block();
        data.models[0].displayOnly = true;
        expect(gustSpread(data, 0, 7_200_000)).toBeNull();
        expect(gustSpread(block(), 8_000_000, 9_000_000)).toBeNull();
    });
});
