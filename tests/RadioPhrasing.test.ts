/**
 * How the app says numbers over a radio.
 *
 * Shane 2026-08-28: "we need a pause after saying the words mmsi before
 * rolling into the number. it would be nice to do the numbers in 3's as the
 * human brain loves threes, so a pause after each 3 numbers. 2ndly the lat
 * and long needs to be slowed down as well, and the SOG, if it is Negative,
 * then it should say stationary."
 *
 * Everything in this module exists to be COPIED DOWN by someone with a
 * pencil, on a bad channel, once. That is a different job from sounding
 * natural, and where the two conflict, copying wins.
 */
import { describe, expect, it } from 'vitest';
import {
    formatSpokenPosition,
    spellDigits,
    spokenBearing,
    spokenCallSign,
    spokenMmsi,
    spokenSpeedOverGround,
} from '../services/voice/radioPhrasing';

describe('spellDigits', () => {
    it('groups a nine-digit MMSI into threes, with a full stop between groups', () => {
        // Serene Summer's own MMSI.
        expect(spellDigits('503101240')).toBe('5, 0, 3. 1, 0, 1. 2, 4, 0');
    });

    it('separates digits with commas, never spaces', () => {
        // A space is not a pause to any engine — it reads "5 0 3" as "five
        // hundred and three", or races the run together.
        expect(spellDigits('503101240')).not.toMatch(/\d \d/);
    });

    it('leaves a short run ungrouped', () => {
        // A four-digit UTC time chunked into threes reads "two, two, four.
        // two" — worse than not grouping at all.
        expect(spellDigits('2242')).toBe('2, 2, 4, 2');
        expect(spellDigits('153')).toBe('1, 5, 3');
    });

    it('handles a call sign of letters and digits', () => {
        expect(spellDigits('VJN4123')).toBe('V, J, N. 4, 1, 2, 3');
    });

    it('never strands a single digit after a full stop', () => {
        // "four, one, two. three" sounds like the end of the number followed
        // by an afterthought. Seven characters read 3 then 4, not 3, 3, 1.
        expect(spellDigits('1234567')).toBe('1, 2, 3. 4, 5, 6, 7');
        expect(spellDigits('1234567')).not.toMatch(/\.\s*\w$/);
    });

    it('survives empty and padded input rather than emitting stray punctuation', () => {
        expect(spellDigits('')).toBe('');
        expect(spellDigits('   ')).toBe('');
        expect(spellDigits(' 503 101 240 ')).toBe('5, 0, 3. 1, 0, 1. 2, 4, 0');
    });
});

describe('labels get their own beat', () => {
    it('puts a full stop after MMSI before the number starts', () => {
        // The listener is still parsing the word when the first digit goes
        // past. The stop is where the pencil starts moving.
        expect(spokenMmsi('503101240')).toBe('M M S I. 5, 0, 3. 1, 0, 1. 2, 4, 0. ');
    });

    it('does the same for the call sign', () => {
        expect(spokenCallSign('VJN4123')).toBe('Call sign. V, J, N. 4, 1, 2, 3. ');
    });
});

describe('formatSpokenPosition', () => {
    const spoken = formatSpokenPosition(-27.19508, 153.10555);

    it('spells the degrees digit by digit', () => {
        // ElevenLabs has been caught reading "153 degrees" as "53 degrees".
        expect(spoken).toContain('1, 5, 3, degrees');
        expect(spoken).toContain('2, 7, degrees');
    });

    it('spells the minutes too, with the radio word for the point', () => {
        // A tenth of a minute is 185 m — the same stakes as the degrees.
        expect(spoken).toContain('1, 1, decimal, 7, minutes');
        expect(spoken).toContain('6, decimal, 3, minutes');
    });

    it('breaks between latitude and longitude with a full stop', () => {
        // That gap is where the listener finishes the first line.
        expect(spoken).toContain('South. ');
    });

    it('gets the hemispheres from the signs, both ways', () => {
        expect(formatSpokenPosition(-27.5, 153.5)).toContain('South');
        expect(formatSpokenPosition(-27.5, 153.5)).toContain('East');
        expect(formatSpokenPosition(27.5, -153.5)).toContain('North');
        expect(formatSpokenPosition(27.5, -153.5)).toContain('West');
    });

    it('never runs two numbers together without a break', () => {
        expect(spoken).not.toMatch(/\d \d/);
    });
});

describe('spokenSpeedOverGround', () => {
    it('says stationary rather than reading a negative speed aloud', () => {
        // A vessel cannot make negative way over the ground. "Minus one point
        // nine knots" on a distress call is worse than useless.
        expect(spokenSpeedOverGround(-1.9)).toBe('Stationary. ');
    });

    it('says stationary at a standstill too', () => {
        expect(spokenSpeedOverGround(0)).toBe('Stationary. ');
        expect(spokenSpeedOverGround(0.1)).toBe('Stationary. ');
    });

    it('reads a real speed normally', () => {
        expect(spokenSpeedOverGround(6.42)).toBe('Speed over ground 6.4 knots. ');
    });

    it('admits it when there is no speed at all', () => {
        // Distinct from stationary: this is the GPS having no solution, not
        // the boat sitting still.
        expect(spokenSpeedOverGround(Number.NaN)).toBe('Speed over ground unavailable. ');
    });
});

describe('spokenBearing', () => {
    it('spells a course out and pads it to three figures, as a bearing is written', () => {
        expect(spokenBearing(105)).toBe('1, 0, 5, degrees true');
        expect(spokenBearing(5)).toBe('0, 0, 5, degrees true');
    });

    it('normalises anything out of range rather than reading it back raw', () => {
        expect(spokenBearing(365)).toBe('0, 0, 5, degrees true');
        expect(spokenBearing(-10)).toBe('3, 5, 0, degrees true');
    });
});
