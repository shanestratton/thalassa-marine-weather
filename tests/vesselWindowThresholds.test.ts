/**
 * Tests for vessel-aware weather-window thresholds. A wrong scale here tells a
 * small boat a dangerous day is fine (or nags a big boat about a benign one),
 * so pin the priority order, the units, and "bigger boat tolerates more".
 */
import { describe, it, expect } from 'vitest';
import { vesselWindowThresholds, polarPowerPeakTws, MODERATE_WINDOW } from '../services/vesselWindowThresholds';
import type { VesselProfile } from '../types/vessel';
import type { PolarData } from '../types/navigation';

const boat = (over: Partial<VesselProfile>): VesselProfile =>
    ({
        name: 'Test',
        type: 'sail',
        length: 38,
        beam: 12,
        draft: 6,
        displacement: 18000,
        maxWaveHeight: 13.3, // ft (38 * 0.35)
        cruisingSpeed: 7,
        ...over,
    }) as VesselProfile;

describe('polarPowerPeakTws', () => {
    it('finds the wind where best boatspeed peaks', () => {
        const polar: PolarData = {
            windSpeeds: [6, 10, 15, 20, 25],
            angles: [90],
            matrix: [[3, 5, 6.5, 6.8, 6.2]], // peaks at 20 kt then declines
        };
        expect(polarPowerPeakTws(polar)).toBe(20);
    });
    it('is null for an empty polar', () => {
        expect(polarPowerPeakTws(null)).toBeNull();
        expect(polarPowerPeakTws({ windSpeeds: [], angles: [], matrix: [] })).toBeNull();
    });
});

describe('vesselWindowThresholds', () => {
    it('falls back to MODERATE with no vessel', () => {
        expect(vesselWindowThresholds(null, null)).toEqual(MODERATE_WINDOW);
    });

    it('prefers the boat stated maxWindSpeed for wind/gust', () => {
        const t = vesselWindowThresholds(boat({ maxWindSpeed: 30 }), null);
        // comfort ceiling 30*0.78 ≈ 23 → poor ~23, good ~16
        expect(t.wind.poor).toBeGreaterThanOrEqual(22);
        expect(t.wind.poor).toBeLessThanOrEqual(24);
        expect(t.wind.good).toBeLessThan(t.wind.poor);
    });

    it('uses the learned polar power peak when no maxWindSpeed', () => {
        const polar: PolarData = {
            windSpeeds: [6, 10, 15, 20, 25],
            angles: [90],
            matrix: [[3, 5, 6.5, 6.8, 6.2]], // peak 20
        };
        const t = vesselWindowThresholds(boat({ maxWindSpeed: undefined }), polar);
        expect(t.wind.poor).toBe(20);
        expect(t.wind.good).toBe(Math.round(20 * 0.68));
    });

    it('scales wave to the boat stated maxWaveHeight (feet)', () => {
        const t = vesselWindowThresholds(boat({ maxWaveHeight: 13.3 }), null);
        expect(t.wave.good).toBeCloseTo(4.0, 1); // 13.3 * 0.3
        expect(t.wave.poor).toBeCloseTo(8.0, 1); // 13.3 * 0.6
    });

    it('a bigger/heavier boat tolerates more than a small one', () => {
        const big = vesselWindowThresholds(boat({ length: 55, maxWaveHeight: 19.25, maxWindSpeed: 40 }), null);
        const small = vesselWindowThresholds(boat({ length: 28, maxWaveHeight: 9.8, maxWindSpeed: 22 }), null);
        expect(big.wind.poor).toBeGreaterThan(small.wind.poor);
        expect(big.wave.poor).toBeGreaterThan(small.wave.poor);
        expect(big.gust.poor).toBeGreaterThan(small.gust.poor);
    });

    it('uses length as a last resort when nothing else is set', () => {
        const t = vesselWindowThresholds(boat({ length: 55, maxWindSpeed: undefined, maxWaveHeight: 0 }), null);
        // sizeComfortWind(55) = 13 + 25*0.28 = 20
        expect(t.wind.poor).toBe(20);
        // maxWaveHeight 0 ⇒ wave falls back to MODERATE
        expect(t.wave).toEqual(MODERATE_WINDOW.wave);
    });
});
