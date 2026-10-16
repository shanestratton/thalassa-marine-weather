import { describe, expect, it } from 'vitest';
import { INSHORE_HOP_NM, isochroneRoutingContext, vesselIsochroneConfig } from '../services/routing/isochronePolicy';
describe('per-vessel routing policy', () => {
    it('uses each account vessel, including an explicit zero wind threshold', () => {
        expect(vesselIsochroneConfig({ minWindSpeed: 0, motoringSpeed: 7.2, cruisingSpeed: 6 }, 200)).toEqual({
            minWindSpeed: 0,
            motoringSpeed: 7.2,
            timeStepHours: 3,
        });
        expect(vesselIsochroneConfig({ minWindSpeed: 8, motoringSpeed: 4.5 }, 500).motoringSpeed).toBe(4.5);
    });
    it('rejects invalid settings and uses the vessel cruising-speed fallback', () => {
        expect(vesselIsochroneConfig({ minWindSpeed: NaN, motoringSpeed: -2, cruisingSpeed: 6.8 }, 500)).toEqual({
            minWindSpeed: 4,
            motoringSpeed: 6.8,
            timeStepHours: 6,
        });
    });
    it('bounds coastal resolution while leaving the six-hour ocean default unchanged', () => {
        expect(INSHORE_HOP_NM).toBe(15);
        expect([25, 75, 200, 1000].map((nm) => vesselIsochroneConfig(null, nm).timeStepHours)).toEqual([0.5, 1, 3, 6]);
    });
    it('binds cached results to departure, motor choices, draft, comfort and network policy', () => {
        const settings = {
            vessel: { draft: 7, minWindSpeed: 4, motoringSpeed: 5 },
            comfortParams: { maxWaveM: 2 },
            satelliteMode: false,
        };
        const key = isochroneRoutingContext('2026-10-17T12:00:00Z', settings);
        for (const changed of [
            { ...settings, vessel: { ...settings.vessel, motoringSpeed: 6 } },
            { ...settings, vessel: { ...settings.vessel, draft: 8 } },
            { ...settings, comfortParams: { maxWaveM: 3 } },
            { ...settings, satelliteMode: true },
        ])
            expect(isochroneRoutingContext('2026-10-17T12:00:00Z', changed)).not.toBe(key);
        expect(isochroneRoutingContext('2026-10-18T12:00:00Z', settings)).not.toBe(key);
    });
});
