/**
 * IALA region resolution — the red/green sides of the world.
 *
 * Field bug 2026-07-09: the desktop builder registers cloud cells with
 * the 'cloud' sourceHO placeholder; the old prefix-match read 'CL' =
 * Chile = IALA B and SWAPPED every lateral colour in Mooloolaba
 * ("VQG under the Red and QR under the Green" — Shane, who has sailed
 * that channel more times than we have commits). HO codes are exactly
 * two letters; anything else must default to region A, and the colour
 * mapping must stay light-consistent in both regions.
 */
import { describe, expect, it } from 'vitest';
import { ialaRegionForSourceHO, lateralMarkColour } from '../../services/enc/types';

describe('ialaRegionForSourceHO', () => {
    it('resolves real region-A HOs', () => {
        expect(ialaRegionForSourceHO('AU')).toBe('A');
        expect(ialaRegionForSourceHO('GB')).toBe('A');
        expect(ialaRegionForSourceHO('NZ')).toBe('A');
    });

    it('resolves real region-B HOs', () => {
        expect(ialaRegionForSourceHO('US')).toBe('B');
        expect(ialaRegionForSourceHO('us')).toBe('B');
        expect(ialaRegionForSourceHO('CL')).toBe('B');
        expect(ialaRegionForSourceHO('JP')).toBe('B');
    });

    it("never prefix-matches sentinels — 'cloud' is not Chile", () => {
        expect(ialaRegionForSourceHO('cloud')).toBe('A');
        expect(ialaRegionForSourceHO('CLOUD')).toBe('A');
        expect(ialaRegionForSourceHO('??')).toBe('A');
        expect(ialaRegionForSourceHO('')).toBe('A');
        expect(ialaRegionForSourceHO(undefined)).toBe('A');
    });

    it('keeps lateral colours light-consistent per region', () => {
        // Region A: port-hand (CATLAM 1) = red, starboard (2) = green.
        expect(lateralMarkColour(1, 'A')).toBe('#dc2626');
        expect(lateralMarkColour(2, 'A')).toBe('#16a34a');
        // Region B inverts.
        expect(lateralMarkColour(1, 'B')).toBe('#16a34a');
        expect(lateralMarkColour(2, 'B')).toBe('#dc2626');
        // Preferred-channel variants follow their base hand.
        expect(lateralMarkColour(3, 'A')).toBe('#dc2626');
        expect(lateralMarkColour(4, 'A')).toBe('#16a34a');
    });
});
