/**
 * The AIS ship-type classifier must never throw, whatever the feed sends.
 *
 * Shane 2026-09-02: "the public page is not working, it looks like it has
 * hung." It was a blank page: `(shipType ?? '').toLowerCase()` with shipType
 * = 36 (the raw AIS code for a sailing vessel). `??` does not catch numbers.
 * One bad marker took the whole voyage log down inside render.
 */
import { describe, expect, it } from 'vitest';
import { shipCategory, shipTypeLabel, vesselColor } from '../src/aisShipType';

describe('AIS ship type', () => {
    it('accepts the raw integer codes the pond actually stores', () => {
        expect(shipCategory(36)).toBe('sailing');
        expect(shipCategory(37)).toBe('pleasure');
        expect(shipCategory(30)).toBe('fishing');
        expect(shipCategory(52)).toBe('service'); // tug
        expect(shipCategory(60)).toBe('passenger');
        expect(shipCategory(70)).toBe('cargo');
        expect(shipCategory(89)).toBe('tanker');
        expect(shipCategory(35)).toBe('military');
        expect(shipCategory(40)).toBe('hsc');
    });

    it('accepts numeric strings and descriptive strings from older feeds', () => {
        expect(shipCategory('70')).toBe('cargo');
        expect(shipCategory('Cargo ship')).toBe('cargo');
        expect(shipCategory('Sailing')).toBe('sailing');
        expect(shipCategory('Pilot vessel')).toBe('service');
    });

    it('NEVER throws — the exact input that blanked the page, and worse', () => {
        for (const raw of [36, 0, -1, NaN, '', '   ', null, undefined, {}, [], true, 1e9]) {
            expect(() => vesselColor(raw)).not.toThrow();
            expect(() => shipTypeLabel(raw)).not.toThrow();
        }
        expect(vesselColor(36)).toBe('#a78bfa');
        expect(vesselColor(null)).toBe('#94a3b8');
        expect(vesselColor({})).toBe('#94a3b8');
    });

    it('labels are words a punter can read, never the raw code', () => {
        expect(shipTypeLabel(36)).toBe('Sailing');
        expect(shipTypeLabel(70)).toBe('Cargo');
        expect(shipTypeLabel(null)).toBeNull();
        expect(shipTypeLabel('')).toBeNull();
        // An unknown-but-present code still gets a word, not a number.
        expect(shipTypeLabel(99)).toBe('Vessel');
    });
});
