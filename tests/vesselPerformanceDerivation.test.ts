import { describe, expect, it } from 'vitest';
import { vesselCruisingSpeedKts, vesselMaxWaveHeightFt } from '../services/units';

/**
 * `maxWaveHeight` and `cruisingSpeed` are the settings panel's
 * "Performance (Auto)" pair. They have no column in `boat_profiles`, so a
 * profile restored from the vessel fleet arrives without them — and the
 * fleet normaliser used to coerce that absence to 0, which is what put
 * "0 kts / 0 ft" on screen for a boat with a perfectly good LOA.
 */
describe('derived vessel performance figures', () => {
    const SERENE_SUMMER = { name: 'Serene Summer', type: 'sail', hullType: 'monohull', length: 55 };

    it('derives both figures from LOA when the profile carries neither', () => {
        // The exact shape that comes back from boat_profiles.profile.
        expect(vesselCruisingSpeedKts(SERENE_SUMMER)).toBeCloseTo(Math.sqrt(55) * 1.2, 4);
        expect(vesselMaxWaveHeightFt(SERENE_SUMMER)).toBeCloseTo(55 * 0.35, 4);
    });

    it('never reports zero for a hull with a usable length', () => {
        // isochroneEnhancer gates its survivability ceiling on
        // `vessel.maxWindSpeed || vessel.maxWaveHeight`. A zero here does not
        // tighten that limit — it removes it. This is the safety-relevant
        // half of the bug, so assert the property directly.
        expect(vesselMaxWaveHeightFt(SERENE_SUMMER)).toBeGreaterThan(0);
        expect(vesselCruisingSpeedKts(SERENE_SUMMER)).toBeGreaterThan(0);
    });

    it('scales the wave ceiling by hull type', () => {
        const at = (hullType: string) => vesselMaxWaveHeightFt({ ...SERENE_SUMMER, hullType });
        expect(at('monohull')).toBeCloseTo(55 * 0.35, 4);
        expect(at('catamaran')).toBeCloseTo(55 * 0.45, 4);
        expect(at('trimaran')).toBeCloseTo(55 * 0.5, 4);
        // An unknown or absent hull type must fall back to the monohull
        // ratio rather than to zero.
        expect(at('proa')).toBeCloseTo(55 * 0.35, 4);
        expect(vesselMaxWaveHeightFt({ length: 55 })).toBeCloseTo(55 * 0.35, 4);
    });

    it('gives power boats the planing coefficient, not hull speed', () => {
        expect(vesselCruisingSpeedKts({ ...SERENE_SUMMER, type: 'power' })).toBeCloseTo(Math.sqrt(55) * 3, 4);
    });

    it('treats an explicitly stored positive value as an override', () => {
        // A skipper who has tuned these by hand must not have the derivation
        // silently overwrite their numbers.
        expect(vesselCruisingSpeedKts({ ...SERENE_SUMMER, cruisingSpeed: 7.5 })).toBe(7.5);
        expect(vesselMaxWaveHeightFt({ ...SERENE_SUMMER, maxWaveHeight: 12 })).toBe(12);
    });

    it('ignores a stored zero or negative rather than propagating it', () => {
        // 0 is exactly what the old fleet normaliser wrote, so it must be
        // read as "absent", not as a deliberate choice.
        expect(vesselCruisingSpeedKts({ ...SERENE_SUMMER, cruisingSpeed: 0 })).toBeCloseTo(Math.sqrt(55) * 1.2, 4);
        expect(vesselMaxWaveHeightFt({ ...SERENE_SUMMER, maxWaveHeight: -3 })).toBeCloseTo(55 * 0.35, 4);
    });

    it('falls back only when there is no length to derive from', () => {
        // Observer accounts and never-configured profiles genuinely have
        // nothing to work with; the caller's own default takes over there.
        expect(vesselCruisingSpeedKts({ type: 'sail' })).toBe(0);
        expect(vesselMaxWaveHeightFt({ hullType: 'monohull' })).toBe(0);
        expect(vesselCruisingSpeedKts(undefined, 6)).toBe(6);
        expect(vesselMaxWaveHeightFt(null, 3)).toBe(3);
        expect(vesselCruisingSpeedKts({ length: 0 }, 6)).toBe(6);
        expect(vesselMaxWaveHeightFt({ length: Number.NaN }, 3)).toBe(3);
    });
});
