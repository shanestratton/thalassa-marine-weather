/**
 * The comfort word (build 130, 130-04, beta): Comfortable, Lively,
 * Uncomfortable or Hard going, with the one input that set it. Provisional,
 * uncalibrated thresholds (calibration is 141-06); comfort, never safety.
 *
 * Every sea here is made up for the test.
 */
import { describe, expect, it } from 'vitest';
import {
    COMFORT_NEEDS_PERIOD,
    GENERIC_BOAT_LABEL,
    GENERIC_LWL_M,
    formatWavePower,
    seaComfort,
    waterlineM,
    wavePowerKwPerM,
} from '../utils/seaComfort';
import type { VesselProfile } from '../types';

const part = (hM: number, periodS: number | null, fromDeg: number | null = 90) => ({ hM, periodS, fromDeg });
/** A total sea with a long period (no pitching against 10 m) and nothing else. */
const totalOnly = (hM: number, periodS = 8) => ({ total: part(hM, periodS), windSea: null, swell: null });

const vessel = (over: Partial<VesselProfile>): VesselProfile => ({
    name: 'Fixture',
    type: 'sail',
    length: 38,
    beam: 12,
    draft: 6,
    displacement: 15000,
    maxWaveHeight: 10,
    cruisingSpeed: 6,
    ...over,
});

describe('the boat it judges for', () => {
    it('no profile: a labelled generic 38 ft boat, waterline 10 m', () => {
        const c = seaComfort(totalOnly(0.3));
        expect(c?.generic).toBe(true);
        expect(c?.lwlM).toBe(GENERIC_LWL_M);
        expect(GENERIC_LWL_M).toBe(10);
        expect(GENERIC_BOAT_LABEL).toBe('generic 38 ft boat');
    });

    it("an observer's profile is no boat: the generic one", () => {
        expect(seaComfort(totalOnly(0.3), vessel({ type: 'observer', length: 60 }))?.generic).toBe(true);
    });

    it('a profile: 0.85 × her length overall (feet) as the waterline, in metres', () => {
        expect(waterlineM(vessel({ length: 40 }))).toBeCloseTo(40 * 0.85 * 0.3048, 6);
        expect(seaComfort(totalOnly(0.3), vessel({ length: 40 }))?.generic).toBe(false);
    });

    it('a catamaran is judged on her own waterline, never the generic boat', () => {
        const cat = vessel({ name: 'Ōtaki', hullType: 'catamaran', length: 45 });
        const c = seaComfort(totalOnly(1.0), cat)!;
        expect(c.generic).toBe(false);
        expect(c.lwlM).toBeCloseTo(45 * 0.85 * 0.3048, 6);
        // 1.0 / 11.66 = 0.086: Lively (the generic 10 m boat would read the same band, by its own sum).
        expect(c.word).toBe('Lively');
    });
});

describe('Hs against her waterline', () => {
    it.each([
        [0.59, 'Comfortable'],
        [0.6, 'Lively'],
        [1.19, 'Lively'],
        [1.2, 'Uncomfortable'],
        [1.99, 'Uncomfortable'],
        [2.0, 'Hard going'],
    ] as const)('%s m on 10 m: %s', (hM, word) => {
        const c = seaComfort(totalOnly(hM))!;
        expect(c.word).toBe(word);
        expect(c.reason).toMatch(/for her length/);
    });
});

describe('a steep wind sea', () => {
    // L = 1.56 T²: at 2.8 s, 12.23 m.
    it.each([
        [0.6, 'Lively'], // 0.049: not steep; 0.7/10 = Lively by size
        [0.62, 'Uncomfortable'], // 0.0507
        [0.86, 'Hard going'], // 0.0703
    ] as const)('%s m at 2.8 s: %s', (windM, word) => {
        const c = seaComfort({ total: part(0.7, 8), windSea: part(windM, 2.8, 70), swell: null })!;
        expect(c.word).toBe(word);
        if (word !== 'Lively') expect(c.reason).toBe('short, steep wind sea');
    });

    it('a wind sea under 0.1 m is none, and sets nothing', () => {
        const c = seaComfort({ total: part(0.3, 6), windSea: part(0.08, 1.2), swell: null })!;
        expect(c.word).toBe('Comfortable');
    });
});

describe('the pitching band: waves 0.75 to 1.5 times her waterline', () => {
    it('+1 level when Hs/LWL is 0.05 or more', () => {
        // λ = 1.56 × 2.8² = 12.2 m, inside 7.5–15 m; 0.55 / 10 = 0.055.
        const c = seaComfort(totalOnly(0.55, 2.8))!;
        expect(c.word).toBe('Lively');
        expect(c.reason).toMatch(/pitching/);
    });

    it('past Hard going it raises nothing, and the size keeps the reason', () => {
        // 2.2 / 10 is Hard going by size; λ 12.2 m is in the band.
        expect(seaComfort(totalOnly(2.2, 2.8))).toMatchObject({ word: 'Hard going', input: 'size' });
    });

    it('nothing under 0.05, or outside the band', () => {
        expect(seaComfort(totalOnly(0.45, 2.8))!.word).toBe('Comfortable');
        expect(seaComfort(totalOnly(0.55, 4.5))!.word).toBe('Comfortable'); // λ 31.6 m
    });
});

describe('a cross sea: wind sea and swell each 0.5 m or more, 45° or more apart', () => {
    it('+1 level', () => {
        const c = seaComfort({ total: part(0.7, 6), windSea: part(0.5, 4, 70), swell: part(0.5, 9, 10) })!;
        expect(c.word).toBe('Uncomfortable'); // Lively by size, +1
        expect(c.reason).toBe('cross sea');
    });

    it('past Hard going it raises nothing, so the reason stays the input that set the word', () => {
        // The generic boat: 2.4 m on 10 m is Hard going by size; the 1.8 m wind sea at 6 s is not steep (0.032).
        const sea = (swellFromDeg: number) =>
            seaComfort({ total: part(2.4, 7), windSea: part(1.8, 6, 90), swell: part(1.2, 11, swellFromDeg) })!;
        const hard = { word: 'Hard going', reason: 'big sea for her length', input: 'size' };
        expect(sea(90)).toMatchObject(hard);
        expect(sea(180)).toMatchObject(hard); // 90° apart: a cross sea, and still the size that set it
    });

    it('across north: 350° and 30° are 40° apart, not a cross sea', () => {
        const c = seaComfort({ total: part(0.7, 6), windSea: part(0.5, 4, 350), swell: part(0.5, 9, 30) })!;
        expect(c.word).toBe('Lively');
    });

    it('a 0.49 m swell is not one', () => {
        const c = seaComfort({ total: part(0.7, 6), windSea: part(0.5, 4, 70), swell: part(0.49, 9, 10) })!;
        expect(c.word).toBe('Lively');
    });
});

describe('the WMO 3700 floors', () => {
    const ship = vessel({ length: 120 }); // waterline 31 m: small by size

    it('Rough (2.5 m or more) is never better than Uncomfortable', () => {
        const c = seaComfort(totalOnly(2.5, 10), ship)!;
        expect(c.word).toBe('Uncomfortable');
        expect(c.reason).toMatch(/rough sea/i);
        expect(seaComfort(totalOnly(2.49, 10), ship)!.word).toBe('Lively');
    });

    it('Very rough or worse (4 m or more) is always Hard going', () => {
        const c = seaComfort(totalOnly(4.0, 11), ship)!;
        expect(c.word).toBe('Hard going');
        expect(c.reason).toMatch(/very rough sea/i);
    });
});

describe('never a false calm', () => {
    it('no total: no word at all', () => {
        expect(seaComfort({ total: null, windSea: null, swell: null })).toBeNull();
    });

    it('an unknown period: no word, and it says why', () => {
        const c = seaComfort({ total: part(1.0, null), windSea: null, swell: null })!;
        expect(c.word).toBeNull();
        expect(c.reason).toBe(COMFORT_NEEDS_PERIOD);
        expect(COMFORT_NEEDS_PERIOD).toBe('Comfort needs a wave period');
        // A wind sea with no period could be steep: no word either.
        expect(seaComfort({ total: part(1.0, 6), windSea: part(0.6, null), swell: null })!.word).toBeNull();
    });
});

describe('wave power, deep water: P ≈ 0.49 · Hs² · T kW/m', () => {
    it('from the total height and the mean period', () => {
        expect(wavePowerKwPerM(part(2, 10))).toBeCloseTo(19.6, 6);
        expect(wavePowerKwPerM(part(1, null))).toBeNull();
        expect(wavePowerKwPerM(null)).toBeNull();
    });

    it('whole kW/m, one decimal under 10, marked approximate', () => {
        expect(formatWavePower(19.6)).toBe('≈ 20 kW/m wave power (approx.)');
        expect(formatWavePower(1.33)).toBe('≈ 1.3 kW/m wave power (approx.)');
        expect(formatWavePower(9.96)).toBe('≈ 10 kW/m wave power (approx.)');
        // A trickle is not written as a zero.
        expect(formatWavePower(0.03)).toBe('< 0.1 kW/m wave power (approx.)');
    });
});
