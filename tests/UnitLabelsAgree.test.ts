/**
 * A number and the unit printed beside it must come from the same conversion.
 *
 * The 2026-09-02 audit found four dashboard sites where they did not: raw
 * feet under the user's wave unit, a wave value converted with the LENGTH unit
 * but labelled with the WAVE unit, rain converted by the length unit (so
 * Fahrenheit users saw millimetres under "in"), and a wind badge that
 * converted to m/s and said "kts". Source-pinned because each is a one-token
 * regression away from coming back.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');

describe('units agree with their labels', () => {
    it('WeatherGrid converts the wave height before printing it', () => {
        const src = read('components/dashboard/WeatherGrid.tsx');
        expect(src).toMatch(/convertLength\(current\.waveHeight, units\.waveHeight \|\| 'm'\)/);
        expect(src).not.toMatch(/String\(current\.waveHeight\)/);
    });
    it('the pinned WAVE metric converts with the unit it labels', () => {
        const src = read('components/dashboard/metricDisplayHelpers.ts');
        expect(src).toMatch(/const waveUnit = units\.waveHeight \|\| 'm';/);
        expect(src).toMatch(/convertLength\(w, waveUnit\)/);
        expect(src).not.toMatch(/convertLength\(w, units\.length\)/);
    });
    it('rain conversion is keyed on the temperature unit, as convertPrecip requires', () => {
        const src = read('components/dashboard/hero/heroSlideHelpers.ts');
        expect(src).not.toMatch(/convertPrecip\([^)]*units\.length\)/);
        expect((src.match(/convertPrecip\([^)]*units\.temp\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
    it('the radar wind badge knows metres per second', () => {
        const src = read('components/dashboard/hero/EssentialMapSlide.tsx');
        expect(src).toMatch(/units\?\.speed === 'mps' \? 'm\/s'/);
    });
    it('the Essential Rain cell shows an amount, never a percentage of millimetres', () => {
        const src = read('components/dashboard/CurrentConditionsCard.tsx');
        expect(src).not.toMatch(/Math\.round\(data\.precipitation\)\}%/);
        expect(src).toMatch(/convertPrecip\(data\.precipitation, units\.temp\)/);
    });
});
