/**
 * The helm grammar's job is to be narrow and certain.
 *
 * Two failures matter, and they are not symmetric. Missing a command costs a
 * round trip to Calypso — annoying. ANSWERING THE WRONG QUESTION costs the
 * skipper's trust and possibly more, because a confident spoken answer gives
 * them no way to tell it was the wrong one. These tests spend most of their
 * effort on the second kind.
 */
import { describe, expect, it } from 'vitest';
import { normaliseUtterance, parseHelmCommand } from '../services/voice/helmGrammar';

const query = (text: string) => parseHelmCommand(text)?.query ?? null;

describe('parseHelmCommand — what it must catch', () => {
    it('reads depth however a busy skipper says it', () => {
        for (const phrase of [
            'depth',
            "what's the depth",
            'depth?',
            'how deep is it',
            'water under us',
            'uh depth again',
            'DEPTH',
        ]) {
            expect(query(phrase), phrase).toBe('depth');
        }
    });

    it('covers the rest of the instrument set', () => {
        expect(query('heading')).toBe('heading');
        expect(query("what's my heading")).toBe('heading');
        expect(query('course over ground')).toBe('course');
        expect(query('cog')).toBe('course');
        expect(query('speed')).toBe('speed');
        expect(query('how fast are we')).toBe('speed');
        expect(query('wind')).toBe('wind');
        expect(query("what's the breeze doing")).toBe('wind');
        expect(query('where are we')).toBe('position');
        expect(query('position')).toBe('position');
        expect(query('water temperature')).toBe('water-temp');
        expect(query('barometer')).toBe('pressure');
        expect(query("what's the glass")).toBe('pressure');
        expect(query('anchor')).toBe('anchor');
        expect(query('are we dragging')).toBe('anchor');
        expect(query('what time is it')).toBe('time');
    });
});

describe('parseHelmCommand — what it must NOT claim', () => {
    it('refuses anything asking for judgement, however instrument-shaped', () => {
        // Every one of these contains a word the loose matcher would other-
        // wise grab. All of them want an opinion, which this grammar has none
        // of — they belong to Calypso.
        for (const phrase of [
            'is the depth safe here',
            'should I anchor here tonight',
            'is it ok to anchor in this wind',
            'do you think the wind will drop',
            'why is the depth changing so fast',
            'is there enough water at low tide',
            'what will the wind be tomorrow',
            'explain the pressure trend',
            'would you recommend this anchorage',
            'is the wind going to back later',
        ]) {
            expect(parseHelmCommand(phrase), phrase).toBeNull();
        }
    });

    it('refuses a rambling sentence — a helm command is short because the skipper is busy', () => {
        expect(parseHelmCommand('so I was wondering about the depth around the point over there')).toBeNull();
    });

    it('refuses ordinary conversation outright', () => {
        for (const phrase of [
            'good morning',
            'thanks calypso',
            'play some music',
            'log an entry about the dolphins',
            '',
            '   ',
        ]) {
            expect(parseHelmCommand(phrase), phrase).toBeNull();
        }
    });

    it('does not let an anchoring QUESTION read as an anchoring reading', () => {
        // "anchor" is a loose keyword on purpose, so this is the exact case
        // where looseness could bite. The judgement guard has to win.
        expect(parseHelmCommand('should we drop the anchor')).toBeNull();
        expect(query('are we dragging')).toBe('anchor');
    });
});

describe('ordering and normalisation', () => {
    it('prefers the more specific reading when two keywords collide', () => {
        // Contains both "wind" and "anchor"; anchor state is the more specific
        // thing being asked about and is checked first.
        expect(query('anchor swing')).toBe('anchor');
        // "true wind" must not be captured by the bare 'course'/'track' rules.
        expect(query('true wind')).toBe('wind');
    });

    it('strips punctuation, case and curly apostrophes', () => {
        expect(normaliseUtterance("What's the DEPTH?!")).toBe('whats the depth');
        expect(normaliseUtterance('  wind…  ')).toBe('wind');
        expect(query('What’s the depth?')).toBe('depth');
    });

    it('matches tokens in order, not merely present', () => {
        // "water under us" is depth. "us under water" is not a helm command,
        // and an unordered bag-of-words matcher would claim it.
        expect(query('water under us')).toBe('depth');
        expect(parseHelmCommand('us under water')).toBeNull();
    });
});
