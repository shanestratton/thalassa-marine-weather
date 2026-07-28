import { describe, expect, it } from 'vitest';
import {
    vesselCruisingSpeedKts,
    vesselDraftIsAssumed,
    vesselMaxWaveHeightFt,
    vesselMaxWaveHeightMetres,
} from '../services/units';

/**
 * The profile stores maxWaveHeight in FEET; every routing consumer works in
 * metres and several name the field so (`maxWaveM`, `max_wave_m`). Feeding
 * feet into a metre field makes the survivability ceiling ~3.3x too
 * permissive — the opposite direction to every other safety default here —
 * and the edge validator accepts 0.1-30, so 19.25 ft sails through as 19.25 m.
 */
describe('vesselMaxWaveHeightMetres', () => {
    it('converts the stored feet to metres', () => {
        expect(vesselMaxWaveHeightMetres({ maxWaveHeight: 19.25 })).toBeCloseTo(19.25 / 3.28084, 4);
        expect(vesselMaxWaveHeightMetres({ maxWaveHeight: 10 })).toBeCloseTo(3.048, 3);
    });

    it('is always smaller than the feet value — the error direction that matters', () => {
        // If this ever inverts, the ceiling has become MORE permissive than
        // the boat can take, which is how a route gets planned through seas
        // that would break it.
        const v = { maxWaveHeight: 19.25 };
        expect(vesselMaxWaveHeightMetres(v)).toBeLessThan(vesselMaxWaveHeightFt(v));
    });

    it('derives from LOA when unset, then converts', () => {
        // Same derivation as the feet helper, so a fleet-restored profile with
        // no stored ceiling still gets a real one rather than zero.
        expect(vesselMaxWaveHeightMetres({ length: 55, hullType: 'monohull' })).toBeCloseTo((55 * 0.35) / 3.28084, 4);
    });

    it('falls back only when there is nothing to derive from', () => {
        expect(vesselMaxWaveHeightMetres(undefined)).toBe(0);
        expect(vesselMaxWaveHeightMetres({ maxWaveHeight: 0 }, 4)).toBe(4);
        expect(vesselMaxWaveHeightMetres(null, 3)).toBe(3);
    });
});

/**
 * `draftAssumed` is the app's honesty channel — threaded through the ENC
 * popup, the depth-style state, the vector layer and the tracer's share path
 * so a chart drawn against an unknown keel says so.
 *
 * It used to test `draft > 0` alone, and onboarding back-filled a missing
 * draft as `length * 0.16` — a plausible POSITIVE number. So the channel
 * reported "verified" for a guess and the safety contour shaded unsafe water
 * as safe. Only estimatedFields knew, and it reached two settings badges.
 */
describe('vesselDraftIsAssumed', () => {
    it('reports an entered draft as known', () => {
        expect(vesselDraftIsAssumed({ draft: 7.874 })).toBe(false);
    });

    it('reports a missing draft as assumed', () => {
        expect(vesselDraftIsAssumed({ draft: 0 })).toBe(true);
        expect(vesselDraftIsAssumed({})).toBe(true);
        expect(vesselDraftIsAssumed(undefined)).toBe(true);
        expect(vesselDraftIsAssumed(null)).toBe(true);
        expect(vesselDraftIsAssumed({ draft: Number.NaN })).toBe(true);
        expect(vesselDraftIsAssumed({ draft: -3 })).toBe(true);
    });

    it('reports a FABRICATED draft as assumed even though it is positive', () => {
        // The whole point. Existing profiles still carry a back-filled draft
        // with estimatedFields recording it, so this branch has to keep
        // working long after onboarding stopped fabricating.
        expect(vesselDraftIsAssumed({ draft: 6.4, estimatedFields: ['draft'] })).toBe(true);
        expect(vesselDraftIsAssumed({ draft: 6.4, estimatedFields: ['length', 'beam', 'draft'] })).toBe(true);
    });

    it('does not fire for other estimated dimensions', () => {
        // Beam or displacement being guessed says nothing about the keel, and
        // over-firing would train the skipper to ignore the warning.
        expect(vesselDraftIsAssumed({ draft: 7.874, estimatedFields: ['beam', 'displacement'] })).toBe(false);
        expect(vesselDraftIsAssumed({ draft: 7.874, estimatedFields: [] })).toBe(false);
    });
});

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
