/**
 * The clock's voice.
 *
 * Shane 2026-09-04: "we need the bells to work on the clock claude. at the
 * moment they dont???" They didn't — striking was never built. This pins the
 * two things about it that are not cosmetic.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const getIsPlaying = vi.fn();
vi.mock('../services/AlarmAudioService', () => ({
    AlarmAudioService: { getIsPlaying: () => getIsPlaying() },
}));

import { ShipsBellChime } from '../services/ShipsBellChime';

const chime = readFileSync('services/ShipsBellChime.ts', 'utf8');
const page = readFileSync('components/nmea/TheGlassPage.tsx', 'utf8');

describe("the ship's bell chime", () => {
    beforeEach(() => vi.clearAllMocks());

    it('REFUSES to ring over a sounding alarm', () => {
        // AlarmAudioService hands out leases precisely so "a short Calypso
        // chime can never silence an active Anchor Watch alarm". A clock that
        // chimes across a drag alarm is a dangerous cute feature.
        getIsPlaying.mockReturnValue(true);
        expect(ShipsBellChime.strike(5)).toBe(false);
    });

    it('reports silence rather than pretending it rang', () => {
        // No AudioContext in jsdom, so this also covers a device with no audio
        // route: strike() must return false so the caller can say so.
        getIsPlaying.mockReturnValue(false);
        expect(ShipsBellChime.strike(3)).toBe(false);
    });

    it('is a struck body, not a beep — inharmonic partials with their own decays', () => {
        // A bell reads as a bell because its overtones are NOT whole multiples
        // of the fundamental and the bright ones die first. Whole-number
        // ratios with one shared decay would be an organ pipe.
        expect(chime).toMatch(/ratio: 1\.19/); // the minor third that gives it its voice
        expect(chime).toMatch(/ratio: 2\.66/);
        expect(chime).toMatch(/exponentialRampToValueAtTime/);
        expect(chime).not.toMatch(/linearRampToValueAtTime/);
    });

    it('strikes in pairs, off the same pattern the face draws', () => {
        expect(chime).toMatch(/for \(const group of bellPattern\(bells\)\)/);
    });
});

describe('the clock strikes itself', () => {
    it('rings what the FACE shows, not the device clock', () => {
        // They differ in the 30- and 45-minute-offset zones, and a bell clock
        // that rings at a time its own hands do not show is simply wrong.
        expect(page).toMatch(/ShipsBellChime\.strike\(bellsAt\(zoneClock\.hour, zoneClock\.minute\)\)/);
    });

    it('claims the half hour even when silent, so enabling it does not backfire', () => {
        // Otherwise switching the bells on at :05 would immediately strike the
        // half hour that had already passed.
        const effect = page.slice(page.indexOf('const lastStruckRef'), page.indexOf('const [bellAlarms'));
        const claim = effect.indexOf('lastStruckRef.current = slot;');
        const gate = effect.indexOf('if (!bellsOn) return;');
        expect(claim).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(claim);
    });

    it('is off by default, and Test works regardless of the toggle', () => {
        expect(page).toMatch(/localStorage\.getItem\('thalassa_clock_bells'\) === 'on'/);
        // Test must not be gated on bellsOn: hearing it is how you decide.
        const test = page.slice(page.indexOf('aria-label={`Test the bell'), page.indexOf('Test\n'));
        expect(test).not.toMatch(/bellsOn/);
    });
});
